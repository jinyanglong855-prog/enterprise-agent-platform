/**
 * 融合层 P1 数据通道（2026-11-01，融合架构方案 §4/§5）：agent 只读平台工具的后端面。
 * 原则（方案 §2 设计原则 3）：平台数据只读拉取、查询时取、不建影子库；一切写路径仍走内核。
 * 唯一的本地持久化=审批定义登记册（app_meta 单键 JSON）——定义列表 API 缺
 * `approval:approval:readonly` scope 时（2026-11-01 真机探针实证 99991663），老板在飞书
 * 审批页复制 code 由管理员登记一次，agent 就能查实例；scope 批下来后 live 列表自动优先。
 *
 * 能力边界（同日真机只读探针钉住，别按假设契约写代码——契约坑 15/19 教训）：
 * - GET /contact/v3/departments/0/children?fetch_child=true：通（部门名在 base 权限里，坑 18）。
 *   注意 items 同时含 department_id（自定义短 ID）与 open_department_id（od- 前缀）——
 *   成员接口只认 od- 形状，对外一律给 open_department_id（坑 21）。
 * - GET /contact/v3/users/find_by_department?department_id=<od-…>&department_id_type=open_department_id：通（姓名可见）。
 * - GET /approval/v4/instances?approval_code=…：通（任意 code；不存在的 code 返回 1390002 而非权限错）。
 * - GET /approval/v4/instances/:code：通（生产补抓已长期在用）。
 * - GET /approval/v4/approvals（定义列表）：缺 scope，99991663——如实降级到登记册。
 * - 实例列表 API 红线：单次查询窗口 ≤10 小时（补抓同款，官方文档逐字核订）；毫秒时间戳字符串。
 * 全部只读：本服务不产生任何对平台的 POST。
 */
import type { DB } from '../db/database.js'
import { nowIso } from '../db/database.js'
import type { AuditService } from '../audit/audit.service.js'
import { BadRequestError } from '../errors.js'
import { FeishuApiError, FeishuClient } from './feishu-client.js'

/** 实例列表 API 单次查询窗口红线（官方文档：不要超过 10 小时；与补抓同款常量）。 */
const WINDOW_MS = 10 * 3600 * 1000
/** 单次查询的最大回看跨度：7 天（168h）。再长让调用方分次问——防一次工具调用打几十个分段请求。 */
const MAX_RANGE_MS = 7 * 24 * 3600 * 1000
/** 单次实例查询的返回上限：只读问答场景 50 条足够，超出截断如实标注（卡片/令牌纪律）。 */
const INSTANCES_CAP = 50
/** 通讯录分页页大小（两接口官方上限 100 内取稳）。 */
const CONTACT_PAGE_SIZE = 50
/** 通讯录条目上限（对抗审查 P1-2/P2-5：大组织全量倒进对话上下文=爆炸面；超出如实标 truncated）。 */
const CONTACT_CAP = 500
/** 通讯录翻页上限（防 has_more 异常死循环——审查 P1-2；先撞条目 cap 则到不了这里）。 */
const CONTACT_MAX_PAGES = 40
/** 实例列表单段翻页上限（同 P1-2；撞上=truncated 如实标注）。 */
const INSTANCES_MAX_PAGES = 20
/** 定义列表单次上限（offset 翻页，官方分页上限 100）。 */
const DEFINITIONS_PAGE_SIZE = 100
/** 定义列表翻页上限（防 has_more 异常死循环；契约坑 10：定义删不掉只会积多，超限必须亮 truncated，不许静默截断）。 */
const DEFINITIONS_MAX_PAGES = 2
/** 审批表单单值的服务端截断长度（审查 P2-5：结构化结果也封顶，插件端展示截断是第二道）。 */
const FORM_VALUE_MAX = 200

/** 审批定义登记册条目（本地持久化，scope 缺失时的实例查询入口）。 */
export interface RegisteredApprovalDef {
  code: string
  name: string
  note?: string
}

const REGISTRY_KEY = 'platform.approval_defs'

export interface PlatformDepartment {
  department_id: string
  open_department_id: string
  name: string
  /** 平台没给出（字段级权限缺失，坑 19：返回空不报错）时为 undefined——渲染"人数未知"，不许把"查不到"说成"0 人"。 */
  member_count: number | undefined
  parent_department_id: string
}

export interface PlatformMember {
  name: string
  open_id: string
  department_ids: string[]
}

export interface ApprovalDefinitionsResult {
  /** 定义列表是否来自平台 live API；false=缺 scope，definitions 来自本地登记册。 */
  live: boolean
  /** live=false 时的人话原因（透给 agent 转述"待查"）。 */
  reason?: string
  definitions: Array<{ approval_code: string; approval_name: string }>
  /** live 列表撞翻页上限被截断（审查 P1-1：静默截断=谎报全量）。 */
  truncated?: boolean
}

export interface ApprovalInstancesResult {
  approval_code: string
  from: string
  to: string
  instances: string[]
  truncated: boolean
}

export interface ContactListResult<T> {
  list: T[]
  truncated: boolean
}

export interface ApprovalDetailResult {
  instance_code: string
  status: string
  approval_code?: string
  open_id?: string
  start_time?: string
  form: Array<{ field: string; value: string }>
}

/** 飞书部门树 children 接口的条目形状（真机探针 2026-11-01 核订）。 */
interface DepartmentItem {
  department_id?: unknown
  open_department_id?: unknown
  name?: unknown
  member_count?: unknown
  parent_department_id?: unknown
}

/** 飞书成员接口条目（data.items[].name/open_id/department_ids）。 */
interface MemberItem {
  name?: unknown
  open_id?: unknown
  department_ids?: unknown
}

export class PlatformDataService {
  private client: FeishuClient

  constructor(
    private readonly db: DB,
    private readonly audit: AuditService,
    opts: { fetchFn?: typeof fetch } = {},
  ) {
    this.client = new FeishuClient(opts.fetchFn ?? fetch.bind(globalThis))
  }

  /** 测试接缝：HTTP 级测试在起服务后整体替换 fetch（重建 client；token 缓存随之清零）。 */
  setFetchFn(fn: typeof fetch): void {
    this.client = new FeishuClient(fn)
  }

  // ---------- 通讯录（只读 live） ----------

  async departments(actor: { username: string; source: string }): Promise<{ departments: PlatformDepartment[]; truncated: boolean }> {
    const items: PlatformDepartment[] = []
    let pageToken = ''
    let truncated = false
    try {
      for (let page = 0; page < CONTACT_MAX_PAGES; page++) {
        const j = await this.client.call<{ data?: { items?: unknown; page_token?: unknown; has_more?: unknown } }>(
          'GET',
          `/contact/v3/departments/0/children?department_id_type=open_department_id&fetch_child=true` +
            `&page_size=${CONTACT_PAGE_SIZE}${pageToken === '' ? '' : `&page_token=${encodeURIComponent(pageToken)}`}`,
        )
        for (const it of Array.isArray(j.data?.items) ? (j.data?.items as DepartmentItem[]) : []) {
          const open = typeof it.open_department_id === 'string' ? it.open_department_id : ''
          const custom = typeof it.department_id === 'string' ? it.department_id : ''
          if (open === '' && custom === '') continue
          if (items.length >= CONTACT_CAP) {
            truncated = true
            break
          }
          items.push({
            // 对外只给 od- 形状：成员接口只认它（坑 21）；custom ID 仅随行留档
            open_department_id: open !== '' ? open : custom,
            department_id: custom,
            name: typeof it.name === 'string' && it.name !== '' ? it.name : '（无部门名权限）',
            // 坑 19（审查 P2-2）：字段级权限缺失=静默空值不报错——保留 undefined 让上层说"人数未知"，不当 0
            member_count: typeof it.member_count === 'number' ? it.member_count : undefined,
            parent_department_id: typeof it.parent_department_id === 'string' ? it.parent_department_id : '0',
          })
        }
        if (items.length >= CONTACT_CAP) truncated = true
        if (truncated) break
        pageToken = j.data?.has_more === true && typeof j.data?.page_token === 'string' ? j.data.page_token : ''
        if (pageToken === '') break
      }
      if (pageToken !== '') truncated = true // 翻页上限耗尽仍有下一页：如实标注（审查 P1-2）
    } catch (error) {
      this.auditFailure(actor, 'platform.read.departments', error)
      throw this.humanize(error, '查部门树')
    }
    this.audit.log({
      username: actor.username,
      source: actor.source,
      action: 'platform.read.departments',
      targetId: '-',
      detail: { count: items.length, truncated },
    })
    return { departments: items, truncated }
  }

  async members(
    actor: { username: string; source: string },
    departmentId: string,
  ): Promise<{ members: PlatformMember[]; truncated: boolean }> {
    const id = departmentId.trim()
    if (id === '') throw new BadRequestError('department_id 必填（od- 开头的 open_department_id，先查 departments）。')
    const items: PlatformMember[] = []
    let pageToken = ''
    let truncated = false
    try {
      for (let page = 0; page < CONTACT_MAX_PAGES; page++) {
        const j = await this.client.call<{ data?: { items?: unknown; page_token?: unknown; has_more?: unknown } }>(
          'GET',
          `/contact/v3/users/find_by_department?department_id=${encodeURIComponent(id)}` +
            `&department_id_type=open_department_id&page_size=${CONTACT_PAGE_SIZE}` +
            `${pageToken === '' ? '' : `&page_token=${encodeURIComponent(pageToken)}`}`,
        )
        for (const it of Array.isArray(j.data?.items) ? (j.data?.items as MemberItem[]) : []) {
          if (typeof it.open_id !== 'string' || it.open_id === '') continue
          if (items.length >= CONTACT_CAP) {
            truncated = true
            break
          }
          items.push({
            name: typeof it.name === 'string' && it.name !== '' ? it.name : '（姓名无权限）',
            open_id: it.open_id,
            department_ids: Array.isArray(it.department_ids)
              ? it.department_ids.filter((x): x is string => typeof x === 'string')
              : [],
          })
        }
        if (items.length >= CONTACT_CAP) truncated = true
        if (truncated) break
        pageToken = j.data?.has_more === true && typeof j.data?.page_token === 'string' ? j.data.page_token : ''
        if (pageToken === '') break
      }
      if (pageToken !== '') truncated = true
    } catch (error) {
      this.auditFailure(actor, 'platform.read.members', error)
      throw this.humanize(error, '查部门成员')
    }
    this.audit.log({
      username: actor.username,
      source: actor.source,
      action: 'platform.read.members',
      targetId: id,
      detail: { count: items.length, truncated },
    })
    return { members: items, truncated }
  }

  /** 读取失败也留痕（审查 P2-4：方案 §6"数据读取都留痕"——权限探测行为必须可见）。 */
  private auditFailure(actor: { username: string; source: string }, action: string, error: unknown): void {
    this.audit.log({
      username: actor.username,
      source: actor.source,
      action,
      targetId: '-',
      detail: { error: error instanceof Error ? error.message : String(error) },
      ok: false,
    })
  }

  // ---------- 审批（live 优先，scope 缺失降级登记册） ----------

  /**
   * 审批定义列表：先试平台 live（分页 offset 取尽）；缺 scope（99991663 等）如实降级
   * 返回登记册内容，live=false + reason 透传——agent 按"明说待查"转述，不假装修好了。
   */
  async approvalDefinitions(actor: { username: string; source: string }): Promise<ApprovalDefinitionsResult> {
    try {
      const all: Array<{ approval_code?: unknown; approval_name?: unknown }> = []
      let offset = 0
      let truncated = false
      for (let page = 0; page < DEFINITIONS_MAX_PAGES; page++) {
        const j = await this.client.call<{ data?: { approval_list?: unknown; has_more?: unknown } }>(
          'GET',
          `/approval/v4/approvals?page_size=${DEFINITIONS_PAGE_SIZE}&offset=${offset}`,
        )
        const list = Array.isArray(j.data?.approval_list) ? (j.data?.approval_list as Array<{ approval_code?: unknown; approval_name?: unknown }>) : []
        all.push(...list)
        if (j.data?.has_more !== true || list.length === 0) {
          offset = -1 // 取尽了
          break
        }
        offset += DEFINITIONS_PAGE_SIZE
      }
      // 审查 P1-1：翻页上限耗尽还有下一页=静默截断会谎报全量，必须亮 truncated
      if (offset !== -1) truncated = true
      const definitions = all
        .filter((d): d is { approval_code: string; approval_name: string } =>
          typeof d.approval_code === 'string' && d.approval_code !== '' && typeof d.approval_name === 'string')
        .map((d) => ({ approval_code: d.approval_code, approval_name: d.approval_name }))
      this.audit.log({
        username: actor.username,
        source: actor.source,
        action: 'platform.read.approval_definitions',
        targetId: '-',
        detail: { live: true, count: definitions.length, truncated },
      })
      return { live: true, definitions, ...(truncated ? { truncated: true } : {}) }
    } catch (error) {
      const reason = this.humanizeReason(error, '拉审批定义列表（缺 approval:approval:readonly scope 的典型表现）')
      const registered = this.listRegistry().map((d) => ({ approval_code: d.code, approval_name: d.name }))
      this.audit.log({
        username: actor.username,
        source: actor.source,
        action: 'platform.read.approval_definitions',
        targetId: '-',
        detail: { live: false, reason, registered: registered.length },
        ok: true,
      })
      return { live: false, reason, definitions: registered }
    }
  }

  async approvalInstances(
    actor: { username: string; source: string },
    codeInput: unknown,
    hoursInput: unknown,
  ): Promise<ApprovalInstancesResult> {
    const code = typeof codeInput === 'string' ? codeInput.trim() : ''
    if (code === '') throw new BadRequestError('code 必填（审批定义 approval_code，definitions 或登记册里拿）。')
    const hours = hoursInput === undefined || hoursInput === null || hoursInput === '' ? 24 : Number(hoursInput)
    if (!Number.isFinite(hours) || hours <= 0 || hours > 168) {
      throw new BadRequestError('hours 需在 1–168（回看小时数，上限 7 天）。')
    }
    const toMs = Date.now()
    const fromMs = toMs - hours * 3600 * 1000
    const seen = new Set<string>() // 审查 P2-3：边界毫秒的实例跨段重复入列会虚高计数，按 code 去重
    const instances: string[] = []
    let truncated = false
    try {
      let segStart = fromMs
      while (segStart < toMs) {
        const segEnd = Math.min(segStart + WINDOW_MS, toMs)
        let pageToken = ''
        for (let page = 0; page < INSTANCES_MAX_PAGES; page++) {
          const j = await this.client.call<{ data?: { instance_code_list?: unknown; page_token?: unknown; has_more?: unknown } }>(
            'GET',
            `/approval/v4/instances?approval_code=${encodeURIComponent(code)}&start_time=${String(segStart)}` +
              `&end_time=${String(segEnd)}&page_size=100${pageToken === '' ? '' : `&page_token=${encodeURIComponent(pageToken)}`}`,
          )
          const list = j.data?.instance_code_list
          for (const c of Array.isArray(list) ? list : []) {
            if (typeof c !== 'string' || c === '' || seen.has(c)) continue
            if (instances.length >= INSTANCES_CAP) {
              truncated = true
              break
            }
            seen.add(c)
            instances.push(c)
          }
          if (truncated) break
          pageToken = j.data?.has_more === true && typeof j.data?.page_token === 'string' ? j.data.page_token : ''
          if (pageToken === '') break
        }
        if (pageToken !== '') truncated = true // 单段翻页上限耗尽（审查 P1-2：has_more 异常不做无限请求）
        if (truncated) break
        segStart = segEnd
      }
    } catch (error) {
      this.auditFailure(actor, 'platform.read.approval_instances', error)
      throw this.humanize(error, '查审批实例')
    }
    this.audit.log({
      username: actor.username,
      source: actor.source,
      action: 'platform.read.approval_instances',
      targetId: code,
      detail: { hours, count: instances.length, truncated },
    })
    return {
      approval_code: code,
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      instances,
      truncated,
    }
  }

  async approvalDetail(actor: { username: string; source: string }, codeInput: string): Promise<ApprovalDetailResult> {
    const code = codeInput.trim()
    if (code === '') throw new BadRequestError('instance_code 必填。')
    let inst: { status?: unknown; approval_code?: unknown; open_id?: unknown; start_time?: unknown; form?: unknown }
    try {
      const j = await this.client.call<{ data?: typeof inst }>(
        'GET',
        `/approval/v4/instances/${encodeURIComponent(code)}?user_id_type=open_id`,
      )
      // 审查 P2-1：平台返回 data:null 不挡会炸 TypeError，绕过"一切异常转 400 人话"的不变量
      if (j.data === undefined || j.data === null || typeof j.data !== 'object') throw new Error('实例详情为空')
      inst = j.data
    } catch (error) {
      this.auditFailure(actor, 'platform.read.approval_detail', error)
      throw this.humanize(error, '查审批实例详情')
    }
    const form: Array<{ field: string; value: string }> = []
    if (typeof inst.form === 'string' && inst.form !== '') {
      try {
        const widgets = JSON.parse(inst.form) as Array<{ id?: unknown; custom_id?: unknown; value?: unknown }>
        for (const w of Array.isArray(widgets) ? widgets : []) {
          const field = typeof w.custom_id === 'string' && w.custom_id !== '' ? w.custom_id : typeof w.id === 'string' ? w.id : ''
          if (field === '') continue
          // 审查 P2-5：单值服务端截断（插件展示层截断是第二道，结构化结果也封顶）
          form.push({ field, value: truncateValue(summarizeValue(w.value)) })
        }
      } catch {
        form.push({ field: '(表单解析失败)', value: '原始内容暂不可读，待查' })
      }
    }
    this.audit.log({
      username: actor.username,
      source: actor.source,
      action: 'platform.read.approval_detail',
      targetId: code,
      detail: { status: typeof inst.status === 'string' ? inst.status : '?' },
    })
    return {
      instance_code: code,
      status: typeof inst.status === 'string' ? inst.status : 'UNKNOWN',
      approval_code: typeof inst.approval_code === 'string' ? inst.approval_code : undefined,
      open_id: typeof inst.open_id === 'string' ? inst.open_id : undefined,
      start_time: (typeof inst.start_time === 'string' || typeof inst.start_time === 'number') &&
          Number.isFinite(Number(inst.start_time)) // 审查 P2-1：非数字别进 new Date(NaN) 炸 RangeError
        ? new Date(Number(inst.start_time) * 1000).toISOString()
        : undefined,
      form,
    }
  }

  // ---------- 审批定义登记册（本地；scope 批下来前的过渡入口） ----------

  listRegistry(): RegisteredApprovalDef[] {
    const row = this.db.prepare('SELECT value FROM app_meta WHERE key = ?').get(REGISTRY_KEY) as { value: string } | undefined
    if (row === undefined) return []
    try {
      const parsed: unknown = JSON.parse(row.value)
      if (!Array.isArray(parsed)) return []
      return parsed.filter(
        (d): d is RegisteredApprovalDef =>
          typeof d === 'object' && d !== null &&
          typeof (d as RegisteredApprovalDef).code === 'string' && (d as RegisteredApprovalDef).code !== '' &&
          typeof (d as RegisteredApprovalDef).name === 'string',
      )
    } catch {
      return []
    }
  }

  setRegistry(actor: { username: string; source: string }, input: unknown): { definitions: RegisteredApprovalDef[] } {
    if (!Array.isArray(input)) throw new BadRequestError('definitions 需要数组。')
    const cleaned: RegisteredApprovalDef[] = []
    const seen = new Set<string>()
    for (const d of input) {
      if (typeof d !== 'object' || d === null) throw new BadRequestError('definitions 条目需要对象 {code, name, note?}。')
      const code = (d as RegisteredApprovalDef).code
      const name = (d as RegisteredApprovalDef).name
      const note = (d as RegisteredApprovalDef).note
      if (typeof code !== 'string' || code.trim() === '') throw new BadRequestError('code 必填（审批定义 approval_code）。')
      if (typeof name !== 'string' || name.trim() === '') throw new BadRequestError('name 必填（如：报销审批）。')
      if (note !== undefined && typeof note !== 'string') throw new BadRequestError('note 需要字符串。')
      const key = code.trim()
      if (seen.has(key)) continue
      seen.add(key)
      cleaned.push({ code: key, name: name.trim(), ...(note !== undefined && note.trim() !== '' ? { note: note.trim() } : {}) })
    }
    this.db
      .prepare(
        `INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(REGISTRY_KEY, JSON.stringify(cleaned), nowIso())
    this.audit.log({
      username: actor.username,
      source: actor.source,
      action: 'platform.registry.set',
      targetId: REGISTRY_KEY,
      detail: { count: cleaned.length, codes: cleaned.map((d) => d.code) },
    })
    return { definitions: cleaned }
  }

  // ---------- 错误翻译（agent 按"明说待查"转述，不许编） ----------

  private humanize(error: unknown, doing: string): Error {
    if (error instanceof FeishuApiError) {
      const hint = feishuHint(error.code)
      return new BadRequestError(`${doing}失败：飞书 code=${error.code} ${error.msg}${hint === '' ? '' : `（${hint}）`}`)
    }
    // 非业务码异常=平台连接层（取不到 token/网络/超时）：原文带上转 400，让 agent 能
    // 如实转述"平台暂不可用"，而不是一条吞掉原因的 500（插件端"明说待查"契约的数据源）
    const m = error instanceof Error ? error.message : String(error)
    return new BadRequestError(`${doing}失败（平台连接异常）：${m}`)
  }

  private humanizeReason(error: unknown, context: string): string {
    if (error instanceof FeishuApiError) {
      const hint = feishuHint(error.code)
      return `平台返回 code=${error.code} ${error.msg}${hint === '' ? '' : `（${hint}）`}`
    }
    return `${context}失败：${error instanceof Error ? error.message : String(error)}`
  }
}

/** 飞书常见业务码的人话提示（契约文档坑 14/16/19/21，真机实证）。 */
function feishuHint(code: number): string {
  switch (code) {
    case 99991663:
      return '应用缺 API 权限 scope，开发者后台开通并发新版本后生效'
    case 40004:
      return '缺部门数据权限：通讯录权限范围/应用可用范围要覆盖目标部门'
    case 1390002:
      return '审批定义 code 不存在：核对 code，或先查 definitions/登记册'
    case 99992357:
      return '部门 ID 形状不对：成员接口要 od- 开头的 open_department_id（先查 departments）'
    case 99992351:
      return '字段值形状错或 ID 不存在'
    default:
      return ''
  }
}

/** 表单控件值摘要：飞书 value 有纯文本/数组/嵌套对象多种形状，递归拍平成一行人话。 */
function summarizeValue(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return v.map(summarizeValue).filter((s) => s !== '').join('、')
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (typeof o.text === 'string') return o.text
    if (o.value !== undefined) return summarizeValue(o.value)
    try {
      return JSON.stringify(o)
    } catch {
      return '(不可序列化)'
    }
  }
  return String(v)
}

/** 服务端单值截断（FORM_VALUE_MAX），截断处带省略号明示不是全文。 */
function truncateValue(s: string): string {
  return s.length > FORM_VALUE_MAX ? `${s.slice(0, FORM_VALUE_MAX)}…` : s
}

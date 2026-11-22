/**
 * 飞书 OA 审批进场（2026-10-29 用户拍板第一期）：
 * 员工在飞书审批中心发起《智能体系统账号开通》→ 审批人（老板）通过 → 飞书推审批事件
 * （长连接，与消息/卡片同通道）→ 这里自动完成开通：建新系统账号（随机初始密码）→
 * 绑飞书号（bridge_identities allowed=1）→ 按部门映射落角色 → 私聊把初始密码发给员工 → 审计。
 *
 * 职责边界（平台特定文件，bridge.service 不出现平台名）：
 * - 部门→角色映射（职能型，feishu_org_rules）的 CRUD 也在这里（REST 面挂 bridge 管理域）；
 *   scope 列是小组型数据地盘的占位（二期启用），一期恒 '*' 不参与任何判定。
 * - 权限模型（用户拍板）：审批通过一律【新建账号】，一人一号一飞书，不绑已有账号——
 *   绑谁谁的角色权限生效的多人占位由"映射规则+角色"承担。
 * - 审批定义：API 创建（表单/审批人可控、企业落地零手工）。官方警告：API 创建的定义
 *   无法停用/删除（创建即生效），所以本服务幂等只建一次（approval_code 存 app_meta），
 *   改表单=删 app_meta 键后重启（旧定义在飞书侧留档但不再接收——事件按 approval_code 过滤）。
 *   待真机验证：创建后是否免发布直接可发起；若审批中心搜不到单，补发布接口调用。
 * - 安全：事件体只当触发器（拿 instance_code），审批结果/发起人/表单一律回查实例详情 API
 *   （防伪造事件字段）；approval_code 必须匹配本服务建的定义才处理。
 * - 断线补抓（2026-10-30 第2层，用户拍板"事件驱动+对账，不做定时轮询"）：长连接断开/
 *   进程停机期间错过的审批事件，在重连（adapter onReconnect）与启动（main.ts）时按
 *   实例列表 API 对账补处理。checkpoint（app_meta）记上次扫到的时间，每次只补增量；
 *   幂等靠既有的实例占坑键，已处理过的实例在查详情前就被跳过。实例列表 API 红线
 *   （官方文档逐字核订）：单次查询窗口 ≤10 小时 → 按 10h 分段；start_time/end_time
 *   是毫秒时间戳字符串；返回 instance_code_list + page_token/has_more；限频 100 次/分。
 * - HTTP：不走 SDK client（接口面窄、测试好替换），直接 fetch + tenant_access_token 自管。
 */
import { randomBytes } from 'node:crypto'
import bcrypt from 'bcryptjs'
import type { DB } from '../db/database.js'
import { nowIso } from '../db/database.js'
import { config } from '../config.js'
import type { AuditService } from '../audit/audit.service.js'
import type { RbacService } from '../rbac/rbac.service.js'
import { TECHNICAL_ROLES } from '../rbac/rbac.service.js'
import { BadRequestError, ForbiddenError } from '../errors.js'
import type { ApprovalNotice } from './bridge.types.js'
import type { ApprovalPostingHook } from '../finance/finance-posting.service.js'

/** 审批单名：飞书审批中心里员工搜这个名字发起。bridge.service 的指路文案与此人工同源
 *  （平台无关文件不能 import 平台特定文件），改这里必须同步那边（见适配契约文档）。 */
export const FEISHU_APPROVAL_NAME = '智能体系统账号开通'
/** 权限变更审批单名（2026-10-30 执行计划 P3）：员工自助申请给自己的账号加角色，老板单审。 */
export const FEISHU_PERM_APPROVAL_NAME = '智能体系统权限变更'

const APPROVAL_CODE_KEY = 'feishu.approval_code'
/** 权限变更定义的 approval_code 键（P3：双定义并存，事件按 code 分流到开通/改权两条链路）。 */
const APPROVAL_PERM_CODE_KEY = 'feishu.approval_code.permchange'
const APPROVAL_USER_NAME = 'user_name'
const APPROVAL_DISPLAY_NAME = 'display_name'
/** 权限变更表单的目标角色字段：自由文本（定义建了删不掉、表单不可改，角色清单会演化——
 *  不能用单选固化选项；角色不存在时按"永久拒绝"处理并私聊说明，不进重试）。 */
const APPROVAL_TARGET_ROLE = 'target_role'
/** 补抓 checkpoint：上次已对账到的时间点（毫秒时间戳字符串）。 */
const BACKFILL_UNTIL_KEY = 'feishu.approval.backfill_until'
/** 补抓失败重试队列：JSON 数组 [{code, attempts}]（详情拉取/开通等单实例失败不阻塞
 *  checkpoint 推进，改走队列在下一轮触发时重试，3 次不成功弃追并留审计）。 */
const BACKFILL_RETRY_KEY = 'feishu.approval.backfill_retry'
/** 实例列表 API 单次窗口红线（官方文档：单次查询时间范围不要超过10小时）。 */
const BACKFILL_WINDOW_MS = 10 * 3600 * 1000
/** 无 checkpoint 时（首次补抓）回看多久。审批功能上线（2026-10-29）晚于该值，全量覆盖。 */
const BACKFILL_DEFAULT_LOOKBACK_MS = 7 * 24 * 3600 * 1000
/** 相邻两次补抓窗口的重叠：防客户端时钟/边界切分的缝隙漏单（已处理过的实例跳过成本≈0）。 */
const BACKFILL_OVERLAP_MS = 10 * 60 * 1000
/** 单轮补抓实例处理上限（限频 100 次/分的保护 + 防大积压长时间占住事件循环）。截断时
 *  checkpoint 不推进，下一轮触发接着扫。 */
const BACKFILL_MAX_INSTANCES = 200
/** 重试队列单实例尝试上限：永久性失败（表单坏/重名等）重试再多次也不会成，3 次后弃追
 *  （审计留痕 + 老板通知已在失败当时发过）；防毒实例每轮重复吵老板。 */
const BACKFILL_MAX_ATTEMPTS = 3
/** 登录用户名形状：字母开头 3-32 位字母/数字/下划线（与现有 boss/agent 命名习惯一致）。 */
const USERNAME_SHAPE = /^[a-zA-Z][a-zA-Z0-9_]{2,31}$/

/** handleEvent 的处理结果（补抓靠它决定跳过/重试；长连接路径忽略返回值不受影响）。
 *  posted=审批落账插槽处理完（2026-11-01 P2；统计里与"新开通"分开计数）。 */
export type HandleEventStatus = 'ok' | 'posted' | 'rejected' | 'duplicate' | 'ignored' | 'closed' | 'pending' | 'failed'

export interface OrgRule {
  id: number
  department_id: string
  department_name: string
  role: string
  scope: string
  created_at: string
  updated_at: string | null
}

/** 飞书部门（组织架构镜像行）。 */
export interface FeishuDepartment {
  department_id: string
  name: string
  parent_id: string
  member_count: number
  synced_at: string
}

/** 映射角色重算统计（P4 调岗自动同步；挂组织同步尾部跑）。 */
export interface OrgRecalcResult {
  users: number
  added: number
  removed: number
  failures: number
  guardSkipped: number
  /** 部门接口返回空数组的账号数（审查 D1：空与字段权限缺失故障不可区分，跳过不摘）。 */
  noDept: number
}

/** 审批实例详情（只声明用到的字段；GET /approval/v4/instances/:code?user_id_type=open_id）。
 *  serial_number=飞书单号、end_time=最近状态变更毫秒时间戳——审批落账插槽（2026-11-01 P2）
 *  拿它们当提案的单号与记账日期。 */
export interface InstanceDetail {
  status?: string
  approval_code?: string
  open_id?: string
  form?: string
  serial_number?: unknown
  end_time?: unknown
}

interface FormWidget {
  id?: unknown
  /** API 建定义时写的 id（user_name 等）在实例表单里落在这个字段（2026-10-30 真机实证：
   *  实例里 id 是平台生成的 widget…，自定义标识挪进 custom_id）。 */
  custom_id?: unknown
  value?: unknown
}

/** 通知出口：生产=BridgeService（按平台用户直发单聊），测试收集数组断言。 */
export interface ApprovalNotifier {
  sendUserTo(platform: string, openId: string, text: string): Promise<void>
}

export class FeishuApprovalService {
  private readonly fetchFn: typeof fetch
  private readonly platform: string
  private readonly backfillMaxInstances: number
  /** 审批落账插槽（2026-11-01 P2）：装配处注入；未注入=只走开通/权限两条链路 */
  private readonly posting: ApprovalPostingHook | undefined
  private token: { value: string; expiresAt: number } | undefined
  private backfillRunning = false
  /** 最近一次审批事件订阅是否成功（契约坑 20 自愈信号，见 subscribeApproval）。 */
  private subscribeHealthy = true
  private backfillPending = false

  constructor(
    private readonly db: DB,
    private readonly audit: AuditService,
    private readonly rbac: RbacService,
    private readonly notifier: ApprovalNotifier,
    opts: { fetchFn?: typeof fetch; platform?: string; backfillMaxInstances?: number; posting?: ApprovalPostingHook } = {},
  ) {
    this.fetchFn = opts.fetchFn ?? fetch.bind(globalThis)
    this.platform = opts.platform ?? 'feishu'
    this.backfillMaxInstances = opts.backfillMaxInstances ?? BACKFILL_MAX_INSTANCES
    this.posting = opts.posting
  }

  // ---------- 审批定义（幂等各建一次；P3 起双定义共用同一创建体） ----------

  /**
   * 建审批定义公共体：表单/审批人（boss 单审）/节点配置同构，只有名称、描述、表单字段不同。
   * 幂等：codeKey 已有即跳过。失败只告警不抛（审批功能降级不可用，不拖垮服务）：
   * 典型原因=开发者后台没配 approval:approval / contact 权限，或老板还没有平台绑定——
   * main.ts 周期重试（审查 P2-3：boss 晚绑定/权限后配也能自动激活，不用重启）。
   */
  private async ensureDefinitionByCode(
    codeKey: string,
    name: string,
    desc: string,
    widgets: Array<{ id: string; label: string }>,
  ): Promise<boolean> {
    try {
      const existingCode = this.getMeta(codeKey)
      if (existingCode !== undefined) {
        // 重启/周期重试路径：定义已在，只补订阅（契约坑 20 双层订阅的第二层，幂等自愈）
        await this.subscribeApproval(existingCode, name)
        return true
      }
      const bossOpenId = this.bossOpenId()
      if (bossOpenId === undefined) {
        console.warn(
          '[feishu-approval] 老板在 bridge_identities 还没有本平台绑定，建不了审批定义——' +
            '请管理员先给 boss 账号绑定飞书身份（POST /api/bridge/identities），绑定后会自动重试。',
        )
        return false
      }
      const i18n = (key: string, value: string) => ({ key, value })
      const formContent = widgets.map((w, i) => ({ id: w.id, type: 'input', required: true, name: `@i18n@w_${i}` }))
      const r = await this.call<{ data?: { approval_code?: string } }>('POST', '/approval/v4/approvals', {
        approval_name: '@i18n@ap_name',
        description: '@i18n@ap_desc',
        viewers: [{ viewer_type: 'TENANT' }],
        form: { form_content: JSON.stringify(formContent) },
        node_list: [
          { id: 'START' },
          {
            id: 'node1',
            name: '@i18n@ap_node',
            node_type: 'AND',
            // 审批人节点 user_id 字段实证填 open_id（ou_ 开头）：官方创建定义 API 对该字段按
            // open_id 校验（2026-10-30 真机：填通讯录短 ID 被 99992351 拒，报 "not a valid
            // {open_id}"——早期"要 6 位短 ID"的理解是反的，此前假 fetch 按错误契约写死）。
            approver: [{ type: 'Personal', user_id: bossOpenId }],
            privilege_field: {
              writable: widgets.map((w) => w.id),
              readable: widgets.map((w) => w.id),
            },
          },
          { id: 'END' },
        ],
        settings: { revert_interval: 0, revert_option: 0, reject_option: 0, quick_approval_option: 1 },
        config: { can_update_viewer: false, can_update_form: false, can_update_process: false, can_update_revert: false },
        icon: 0,
        i18n_resources: [
          {
            locale: 'zh-CN',
            is_default: true,
            texts: [
              i18n('@i18n@ap_name', name),
              i18n('@i18n@ap_desc', desc),
              i18n('@i18n@ap_node', '管理员审批'),
              ...widgets.map((w, i) => i18n(`@i18n@w_${i}`, w.label)),
            ],
          },
        ],
      })
      const code = r.data?.approval_code ?? ''
      if (code === '') throw new Error('创建审批定义成功但没返回 approval_code')
      this.setMeta(codeKey, code)
      this.audit.log({
        username: '-',
        source: 'feishu-approval',
        action: 'approval.definition.created',
        targetId: code,
        detail: { name },
      })
      console.log(`[feishu-approval] 审批定义《${name}》已创建（${code}），员工可在飞书审批中心发起`)
      await this.subscribeApproval(code, name)
      return true
    } catch (error) {
      const m = error instanceof Error ? error.message : String(error)
      console.warn(`[feishu-approval] 审批定义《${name}》创建失败，该审批暂不可用（其余功能不受影响；会自动重试）：${m}`)
      return false
    }
  }

  /** 《智能体系统账号开通》：员工发起，boss 单审，表单=用户名+姓名。 */
  async ensureDefinition(): Promise<boolean> {
    return this.ensureDefinitionByCode(APPROVAL_CODE_KEY, FEISHU_APPROVAL_NAME, '申请开通智能体管理系统账号：审批通过后系统自动创建账号并绑定当前飞书账号，初始密码将私聊发送给你。', [
      { id: APPROVAL_USER_NAME, label: '登录用户名（字母开头，字母/数字/下划线）' },
      { id: APPROVAL_DISPLAY_NAME, label: '姓名' },
    ])
  }

  /** 《智能体系统权限变更》（执行计划 P3）：员工自助申请给自己的账号加角色，boss 单审。
   *  表单一次设计好（API 建的定义删不掉，契约坑 10）：目标角色用自由文本不用单选——
   *  表单不可改而角色清单会演化；角色不存在时按永久拒绝私聊说明，不进重试。 */
  async ensurePermDefinition(): Promise<boolean> {
    return this.ensureDefinitionByCode(
      APPROVAL_PERM_CODE_KEY,
      FEISHU_PERM_APPROVAL_NAME,
      '申请给自己的系统账号加角色：审批通过后系统自动把角色加到你绑定的账号上并私聊通知。只能给自己申请；收权限找管理员在「系统权限」页操作。',
      [
        { id: APPROVAL_USER_NAME, label: '你的登录用户名（必须是自己绑定的账号）' },
        { id: APPROVAL_TARGET_ROLE, label: '想加的角色名（需系统里已存在，找管理员确认）' },
      ],
    )
  }

  /** 审批单是否已建（REST 状态面/测试用）。 */
  approvalCode(): string | undefined {
    return this.getMeta(APPROVAL_CODE_KEY)
  }

  /** 权限变更定义的 approval_code（P3；未建=undefined）。 */
  approvalPermCode(): string | undefined {
    return this.getMeta(APPROVAL_PERM_CODE_KEY)
  }

  /**
   * 存量权限变更定义只订阅不新建（2026-10-31 方案 B）：生产库里已有该定义（API 建的删不掉，
   * 契约坑 10），员工还能往里递单——订阅它的事件，让 handleEvent 走 closePermChannel 即时
   * 礼貌拒绝，否则递单要等下次重启/重连的对账补抓才被拒。全新部署没有该定义就什么都不做
   * （方案 B 不再给新企业造这条员工通道）。
   */
  async ensurePermSubscription(): Promise<boolean> {
    const code = this.approvalPermCode()
    if (code === undefined) return false
    await this.subscribeApproval(code, `${FEISHU_PERM_APPROVAL_NAME}（通道已关闭，仅播报拒绝）`)
    return true
  }

  /** 审批落账规则里的定义逐个订阅事件（2026-11-01 P2）：这些定义是企业在飞书后台自己建的
   *  （报销/付款等），不由本服务创建，只订阅——契约坑 20 的双层订阅同样适用，不订就只有
   *  补抓能追到。规则保存后与启动/定时自愈时各跑一次；重复订阅 1390007 按成功处理。 */
  async ensurePostingSubscriptions(): Promise<number> {
    const codes = this.posting?.codes() ?? []
    for (const c of codes) await this.subscribeApproval(c.code, `${c.name}（审批落账）`)
    return codes.length
  }

  /** 回查实例详情（审批落账规则页"预览解析"用：管理员贴实例码看金额/事由按当前规则解析成什么）。 */
  async fetchInstanceDetail(instanceCode: string): Promise<InstanceDetail> {
    if (instanceCode.trim() === '') throw new BadRequestError('需要 instance_code（审批实例码）。')
    const j = await this.call<{ data?: InstanceDetail }>('GET', `/approval/v4/instances/${encodeURIComponent(instanceCode.trim())}?user_id_type=open_id`)
    if (j.data === undefined) throw new Error('实例详情为空')
    return j.data
  }

  /** 最近一次订阅尝试是否全部成功（main.ts 定时器据此决定停还是留：失败时 10 分钟一轮低频重订，方案B 审查 P2-1）。 */
  subscriptionHealthy(): boolean {
    return this.subscribeHealthy
  }

  /**
   * 订阅审批事件（契约坑 20，2026-10-31 实证）：飞书审批事件是**双层订阅**——开发者后台
   * 「事件与回调」加 approval/approval_task 事件只是第一层，还必须调本接口按审批定义 Code
   * 逐个订阅，该定义的事件才会经长连接推送（此前只做了第一层：消息事件正常、实例列表 API
   * 正常、审批事件三个月不达）。⭐ 重复订阅**不是幂等返回 0**：真机实证返回错误码
   * 1390007 "subscription existed"——语义=订阅已在、推送正常，按成功处理。
   * 真失败只告警不抛（定义在、对账补抓兜底）且把 subscribeHealthy 置 false——main.ts
   * 定时器见 false 会留 10 分钟一轮低频重订（方案B 审查 P2-1：自愈不能只靠重启），
   * 成功（0 或 1390007）即翻回 true、定时器停。
   */
  private async subscribeApproval(code: string, name: string): Promise<void> {
    try {
      await this.call('POST', `/approval/v4/approvals/${encodeURIComponent(code)}/subscribe`)
      this.subscribeHealthy = true
      this.audit.log({
        username: '-',
        source: 'feishu-approval',
        action: 'approval.subscribed',
        targetId: code,
        detail: { name },
      })
      console.log(`[feishu-approval] 审批事件已订阅（${name} ${code}）——实时推送生效`)
    } catch (error) {
      const m = error instanceof Error ? error.message : String(error)
      // 1390007 "subscription existed"：重复订阅返回错误码而非幂等 0（真机实证）——订阅已在、
      // 推送正常，按成功处理；否则每次重启都误报失败，定时器还会 10 分钟一轮空转
      if (m.includes('1390007')) {
        this.subscribeHealthy = true
        this.audit.log({
          username: '-',
          source: 'feishu-approval',
          action: 'approval.subscribed',
          targetId: code,
          detail: { name, note: '已在订阅中（1390007 subscription existed），推送正常' },
        })
        console.log(`[feishu-approval] 审批事件已在订阅中（${name} ${code}）——实时推送正常`)
        return
      }
      this.subscribeHealthy = false
      this.audit.log({
        username: '-',
        source: 'feishu-approval',
        action: 'approval.subscribe.failed',
        targetId: code,
        detail: { error: m },
        ok: false,
      })
      console.warn(`[feishu-approval] 审批事件订阅失败（${name}）：${m}——实时推送暂不可达（对账补抓兜底），10 分钟一轮自动重订`)
    }
  }

  // ---------- 审批事件（adapter 长连接转发进来） ----------

  /** 事件只当触发器：详情回查 API，approval_code 匹配本服务两个定义之一才处理
   *  （P3：开通/权限变更按 code 分流，各自走 provision / applyPermChange）。
   *  返回处理结果：补抓用 'failed' 判定"要进重试队列"、'duplicate'/'ignored' 等判定
   *  "已完成不再管"；长连接路径忽略返回值，行为不变。 */
  async handleEvent(notice: ApprovalNotice): Promise<HandleEventStatus> {
    const instanceCode = notice.instanceCode
    if (instanceCode === '') return 'ignored'
    try {
      const j = await this.call<{ data?: InstanceDetail }>('GET', `/approval/v4/instances/${instanceCode}?user_id_type=open_id`)
      const inst = j.data
      if (inst === undefined) throw new Error('实例详情为空')
      const provisionCode = this.getMeta(APPROVAL_CODE_KEY)
      const permCode = this.getMeta(APPROVAL_PERM_CODE_KEY)
      // 分流顺序：本服务自建的两个定义优先；否则看审批落账规则（2026-11-01 P2，企业自建的报销/付款等定义）
      const postingHook = this.posting
      const postingRule = postingHook !== undefined && inst.approval_code !== undefined && inst.approval_code !== '' ? postingHook.ruleFor(inst.approval_code) : undefined
      const kind: 'permchange' | 'provision' | 'posting' | undefined =
        provisionCode !== undefined && inst.approval_code === provisionCode
          ? 'provision'
          : permCode !== undefined && inst.approval_code === permCode
            ? 'permchange'
            : postingRule !== undefined
              ? 'posting'
              : undefined
      if (kind === undefined) {
        // 停用的落账规则：落坑再 ignored（审查 P2-1）——补抓把停用定义也扫，checkpoint 卡住
        // （列表失败/200 截断）时这些实例会每轮重吃处理额度；完全不相干的 code（公司里其他
        // 审批）不落坑，免得 app_meta 按全公司审批量膨胀
        const disabledRule =
          postingHook !== undefined && inst.approval_code !== undefined && inst.approval_code !== '' && postingHook.hasRule(inst.approval_code)
        if (disabledRule) this.claimInstance(instanceCode)
        this.audit.log({
          username: '-',
          source: 'feishu-approval',
          action: 'approval.event.ignored',
          targetId: instanceCode,
          detail: { reason: disabledRule ? 'approval_code 在落账规则里但规则已停用（已落坑）' : 'approval_code 不匹配本服务的任何定义，也不在审批落账规则里' },
        })
        return 'ignored'
      }
      if (inst.status === 'APPROVED') {
        // 幂等+并发：原子占坑（INSERT OR IGNORE 看 changes），抢到才处理；失败放坑
        // （审查 P2-1：不吞重试机会——失败不落永久标记，事件重推或人工重触发可再跑）
        if (!this.claimInstance(instanceCode)) {
          // 撞坑要留痕（对抗审查 P2-2）：坑值 processing=在途或中途崩溃遗留，ISO 时间=已成功处理
          this.audit.log({
            username: '-',
            source: 'feishu-approval',
            action: 'approval.event.duplicate',
            targetId: instanceCode,
            detail: { claimValue: this.getMeta(`feishu.approval.instance.${instanceCode}`) },
          })
          return 'duplicate'
        }
        // 权限变更通道已关闭（2026-10-31 用户拍板）：角色由管理员统一配置，员工自助申请口子取消；
        // 已建定义删不掉（契约坑 10），批了的单在此礼貌拒绝+占坑。applyPermChange 保留未删，
        // 恢复员工自助通道时接回（测试钉着机制）。返回 'rejected'（方案B 审查 P3-1：
        // 补抓统计里与"新开通"分开计数，审计数字不失真）
        if (kind === 'permchange') {
          await this.closePermChannel(instanceCode, inst)
          this.setMeta(`feishu.approval.instance.${instanceCode}`, nowIso())
          return 'rejected'
        }
        // 审批落账（2026-11-01 P2）：插槽自己兜错（审计+老板通知），恒 true；
        // false 只留给"重试可能成"的基础设施失败——放坑让事件重推/补抓再来
        if (kind === 'posting' && postingHook !== undefined && postingRule !== undefined) {
          const posted = await postingHook.onApproved(instanceCode, inst, postingRule)
          if (posted) {
            this.setMeta(`feishu.approval.instance.${instanceCode}`, nowIso())
            return 'posted'
          }
          this.releaseInstance(instanceCode)
          return 'failed'
        }
        const ok = await this.provision(instanceCode, inst)
        // 成功把坑值从 processing 换成完成时间（P2-2：撞坑审计要能区分"已成功"与"崩溃遗留"）；
        // 失败放坑留重试机会
        if (ok) {
          this.setMeta(`feishu.approval.instance.${instanceCode}`, nowIso())
          return 'ok'
        }
        this.releaseInstance(instanceCode)
        return 'failed'
      }
      if (inst.status === 'REJECTED' || inst.status === 'CANCELED' || inst.status === 'DELETED') {
        // 终态也落占坑标记：补抓靠"没占坑"重扫，不标记的话终态实例每轮重吃处理额度，
        // 截断续扫场景会饿死排后面的实例（同 P2-1 占坑机制，复用同一个键）
        if (!this.claimInstance(instanceCode)) return 'duplicate'
        this.audit.log({
          username: '-',
          source: 'feishu-approval',
          action: 'approval.instance.closed',
          targetId: instanceCode,
          detail: { status: inst.status },
        })
        return 'closed'
      }
      return 'pending' // PENDING：等后续状态变更事件，不理
    } catch (error) {
      const m = error instanceof Error ? error.message : String(error)
      this.audit.log({
        username: '-',
        source: 'feishu-approval',
        action: 'approval.event.failed',
        targetId: instanceCode,
        detail: { error: m },
        ok: false,
      })
      console.warn(`[feishu-approval] 审批事件处理失败（单 ${instanceCode}）：${m}`)
      return 'failed'
    }
  }

  // ---------- 断线补抓（2026-10-30 第2层） ----------

  /**
   * 对账补抓：把长连接断开/进程停机期间错过的审批实例补处理。触发点=长连接重连
   * （'reconnect'，adapter 挂点）与进程启动（'startup'，main.ts）；不做定时轮询。
   * 流程：先重试上轮遗留的失败队列 → 从 checkpoint（默认回看 7 天）按 10h 分段拉
   * 实例列表 → 已占坑的跳过（不查详情），新实例走 handleEvent → 全部扫完才推进 checkpoint。
   * 单实例失败不阻塞推进（进重试队列，3 次弃追）；列表 API 层失败/截断则 checkpoint
   * 原地不动，等下次触发续扫。全程 try/catch，绝不向触发方抛错（重连路径里抛错会打断监督器）。
   */
  async backfillMissed(trigger: 'startup' | 'reconnect'): Promise<void> {
    if (this.backfillRunning) {
      // 对抗审查 P1-5：并发触发（启动补抓进行中又断而复连）不静默丢，本轮结束后补跑一轮
      this.backfillPending = true
      return
    }
    this.backfillRunning = true
    const stats = { scanned: 0, provisioned: 0, posted: 0, permRejected: 0, duplicate: 0, skipped: 0, closedOrIgnored: 0, retried: 0, failed: 0, deadLettered: 0, watched: 0 }
    try {
      // 全部定义都扫（P3 双定义 + 2026-11-01 审批落账规则里的定义）：每个 approval_code 各拉一遍
      // 同一时间窗，checkpoint 是全定义共享的
      const scanCodes = [
        ...new Set(
          [this.getMeta(APPROVAL_CODE_KEY), this.getMeta(APPROVAL_PERM_CODE_KEY), ...(this.posting?.codes() ?? []).map((c) => c.code)].filter(
            (x): x is string => typeof x === 'string' && x !== '',
          ),
        ),
      ]
      if (scanCodes.length === 0) return // 审批定义还没建成且无落账规则：无可补对象（ensureDefinition 会自动建）
      const now = Date.now()
      this.releaseStaleProcessingClaims(now)
      const checkpointMs = Number(this.getMeta(BACKFILL_UNTIL_KEY))
      const fromMs =
        Number.isFinite(checkpointMs) && checkpointMs > 0
          ? checkpointMs - BACKFILL_OVERLAP_MS
          : now - BACKFILL_DEFAULT_LOOKBACK_MS
      const claimed = (code: string) => this.getMeta(`feishu.approval.instance.${code}`) !== undefined
      const maxHandled = this.backfillMaxInstances
      const attempted = new Set<string>() // 本轮已处理过的实例：队列与窗口重叠段不二次跑（免同轮重复通知老板）
      const attemptsByCode = new Map<string, number>() // attempt 计数跨轮保留：窗口重扫不把失败实例的次数清零（对抗审查 P2-10）
      const queue: Array<{ code: string; attempts: number }> = []

      // 1) 上轮遗留队列先重试/复查：终态落地即出队；失败 attempts+1（3 次弃追）；
      //    PENDING 不算失败、不涨次数，留队每轮复查（P0-2：审批通过若发生在断线期间，
      //    状态变更事件丢了，唯一能追回它的就是这条复查路）
      for (const entry of this.readRetryQueue()) {
        if (attempted.has(entry.code)) continue // 队列里意外重复的码只处理一次
        attempted.add(entry.code)
        attemptsByCode.set(entry.code, entry.attempts)
        if (entry.attempts >= BACKFILL_MAX_ATTEMPTS) {
          stats.deadLettered += 1
          continue
        }
        stats.retried += 1
        const st = await this.handleEvent({ instanceCode: entry.code })
        if (st === 'failed') {
          stats.failed += 1
          queue.push({ code: entry.code, attempts: entry.attempts + 1 })
        } else {
          this.countStatus(stats, st)
          if (st === 'pending') queue.push({ code: entry.code, attempts: entry.attempts })
        }
      }

      // 2) 从 checkpoint 分段扫到 now（10h 红线分段；列表分页取尽）。单轮处理上限只数
      //    真正调了 handleEvent 的实例：已处理的跳过近零成本不该吃额度；超限时已处理的
      //    都已落占坑/队列，checkpoint 不推进、下轮从 checkpoint 快进重扫（跳过已处理），
      //    自然续扫不活锁（对抗审查 P1-3）
      let segStart = fromMs
      let completed = true
      let handled = 0
      while (segStart < now) {
        const segEnd = Math.min(segStart + BACKFILL_WINDOW_MS, now)
        const codes: string[] = []
        try {
          for (const scanCode of scanCodes) {
            let pageToken = ''
            do {
              const j = await this.call<{ data?: { instance_code_list?: unknown; page_token?: unknown; has_more?: unknown } }>(
                'GET',
                `/approval/v4/instances?approval_code=${encodeURIComponent(scanCode)}&start_time=${String(segStart)}` +
                  `&end_time=${String(segEnd)}&page_size=100${pageToken === '' ? '' : `&page_token=${encodeURIComponent(pageToken)}`}`,
              )
              const list = j.data?.instance_code_list
              codes.push(...(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []))
              pageToken = j.data?.has_more === true && typeof j.data?.page_token === 'string' ? j.data.page_token : ''
            } while (pageToken !== '')
          }
        } catch (error) {
          // 列表 API 失败=这段的边界不可信：checkpoint 不动，下次触发从头再扫（已处理的跳过，成本≈0）
          const m = error instanceof Error ? error.message : String(error)
          console.warn(`[feishu-approval] 补抓拉实例列表失败（窗口 ${segStart}-${segEnd}）：${m}，checkpoint 不推进`)
          completed = false
          break
        }
        for (const code of codes) {
          stats.scanned += 1
          if (claimed(code) || attempted.has(code)) {
            stats.skipped += 1
            continue // 已处理过（事件路径/此前补抓/本轮重试段）：查详情都省了
          }
          if (handled >= maxHandled) {
            console.warn(`[feishu-approval] 补抓单轮处理达到上限 ${maxHandled}，本轮截断（checkpoint 不推进，下轮续扫）`)
            completed = false
            break
          }
          handled += 1
          attempted.add(code)
          const st = await this.handleEvent({ instanceCode: code })
          if (st === 'failed') {
            stats.failed += 1
            queue.push({ code, attempts: attemptsByCode.get(code) ?? 0 })
          } else {
            this.countStatus(stats, st)
            if (st === 'pending') {
              stats.watched += 1
              queue.push({ code, attempts: 0 })
            }
          }
        }
        if (!completed) break
        segStart = segEnd
      }

      this.writeRetryQueue(queue) // 旧队列在第 1 步已被整体消费，这里写回新一轮的失败/PENDING 集合
      if (completed) this.setMeta(BACKFILL_UNTIL_KEY, String(now))
      this.audit.log({
        username: '-',
        source: 'feishu-approval',
        action: 'approval.backfill',
        targetId: scanCodes.join(','), // P3 双定义：一次补抓扫多个 code，审计里都留痕
        detail: {
          trigger,
          from: new Date(fromMs).toISOString(),
          to: new Date(now).toISOString(),
          checkpointAdvanced: completed,
          ...stats,
        },
      })
      console.log(
        `[feishu-approval] 补抓完成（${trigger}）：扫描 ${stats.scanned}、新开通 ${stats.provisioned}、落账提案 ${stats.posted}、权限拒（通道已关闭） ${stats.permRejected}、` +
          `跳过 ${stats.skipped}、重试 ${stats.retried}、失败 ${stats.failed}、PENDING 观察 ${stats.watched}、弃追 ${stats.deadLettered}；` +
          `checkpoint ${completed ? '已推进' : '未推进'}`,
      )
    } catch (error) {
      // 兜底（重连回调里抛错会被 SDK 吞掉难排查）：记录后吞掉
      console.warn(`[feishu-approval] 补抓异常（${trigger}）：${error instanceof Error ? error.message : error}`)
    } finally {
      this.backfillRunning = false
      if (this.backfillPending) {
        this.backfillPending = false
        void this.backfillMissed(trigger)
      }
    }
  }

  /** 崩溃遗留占坑清理（对抗审查 P1-4）：开通是秒级操作，processing 停留超阈值=进程在中途
   *  被杀（kill -9/OOM/断电），坑永远不会被正常路径释放 → 该实例被 claimed() 永久跳过
   *  （最坏形态：账号已建、密码无人知晓）。放坑后补抓按正常路径重处理（占坑→开通或失败重试）。 */
  private releaseStaleProcessingClaims(now: number): void {
    const cutoff = new Date(now - 30 * 60 * 1000).toISOString()
    const r = this.db
      .prepare("DELETE FROM app_meta WHERE key LIKE 'feishu.approval.instance.%' AND value = 'processing' AND updated_at < ?")
      .run(cutoff)
    if (r.changes > 0) {
      console.warn(`[feishu-approval] 释放 ${r.changes} 个崩溃遗留的 processing 占坑（>30 分钟），补抓将重新处理这些实例`)
    }
  }

  private countStatus(stats: { provisioned: number; posted: number; permRejected: number; duplicate: number; closedOrIgnored: number }, st: HandleEventStatus): void {
    if (st === 'ok') stats.provisioned += 1
    else if (st === 'posted') stats.posted += 1 // 审批落账插槽处理完（提案已建或已如实通知老板）
    else if (st === 'rejected') stats.permRejected += 1 // 方案B：权限变更通道关闭拒绝，不是新开通
    else if (st === 'duplicate') stats.duplicate += 1
    else stats.closedOrIgnored += 1 // ignored/closed/pending：都不需要再管
  }

  private readRetryQueue(): Array<{ code: string; attempts: number }> {
    const raw = this.getMeta(BACKFILL_RETRY_KEY)
    if (raw === undefined) return []
    try {
      const arr = JSON.parse(raw) as unknown
      if (!Array.isArray(arr)) return []
      return arr
        .filter((x): x is { code: string; attempts: number } => typeof (x as { code?: unknown })?.code === 'string')
        .map((x) => ({ code: x.code, attempts: typeof x.attempts === 'number' ? x.attempts : 0 }))
    } catch {
      return []
    }
  }

  private writeRetryQueue(queue: Array<{ code: string; attempts: number }>): void {
    // 队列长度护栏（对抗审查）：失败+PENDING 观察超长说明系统性故障或超大在途积压，
    // 截断保命，审计里的 failed/watched 计数能看出来丢了多少
    const capped = queue.slice(0, 500)
    if (queue.length > capped.length) console.warn(`[feishu-approval] 补抓重试队列超 500，截断（本轮多 ${queue.length - capped.length} 条）`)
    if (capped.length === 0) {
      this.db.prepare('DELETE FROM app_meta WHERE key = ?').run(BACKFILL_RETRY_KEY)
      return
    }
    this.setMeta(BACKFILL_RETRY_KEY, JSON.stringify(capped))
  }

  /**
   * 开通：解析表单 → 校验 → 查发起人部门 → 映射角色 → 建号+绑定+配权（单事务）→ 私聊初始密码。
   * 返回 true=开通完成；false=失败（已审计 ok=0 并通知老板；调用方放掉处理标记，留重试机会）。
   * 员工密码私聊失败则回滚建号（员工拿不到密码登不了，留着只会变成死账号）。
   */
  async provision(instanceCode: string, inst: InstanceDetail): Promise<boolean> {
    const applicant = inst.open_id ?? ''
    let userName = ''
    try {
      const form = this.parseForm(inst.form)
      userName = (form.get(APPROVAL_USER_NAME) ?? '').trim()
      const displayName = (form.get(APPROVAL_DISPLAY_NAME) ?? '').trim()
      if (applicant === '') throw new BadRequestError('审批实例缺发起人 open_id')
      if (!USERNAME_SHAPE.test(userName)) {
        throw new BadRequestError(`用户名 "${userName}" 形状不对：要字母开头、3-32 位字母/数字/下划线`)
      }
      if (displayName === '') throw new BadRequestError('表单缺姓名')
      if (this.rbac.findUser(userName) !== undefined) {
        throw new BadRequestError(`用户名 "${userName}" 已被占用`)
      }
      // 一人一号一飞书的正确强制点（对抗审查 P1-2）：已有绑定直接拒，不靠半途撞主键
      const existing = this.db
        .prepare('SELECT username FROM bridge_identities WHERE platform = ? AND platform_userid = ?')
        .get(this.platform, applicant) as { username: string } | undefined
      if (existing !== undefined) {
        throw new BadRequestError(`该飞书账号已绑定系统账号 "${existing.username}"，不能重复开通（一人一号）`)
      }
      const password = randomBytes(12).toString('base64url')
      // 建号+绑定单事务（对抗审查 P1-2）：任何一步撞库整体不落，杜绝孤儿账号。
      // 2026-10-31 用户拍板方案 B：开通一律零权限（默认配置=空白，看不到任何公司数据），
      // 角色由管理员在「系统权限」页按预定义岗位配置+顺手批单独权限——不再按部门映射自动配
      const provisionTx = this.db.transaction(() => {
        this.db
          .prepare('INSERT INTO users (username, password_hash, display_name, is_service, created_at) VALUES (?, ?, ?, 0, ?)')
          .run(userName, bcrypt.hashSync(password, 10), displayName, nowIso())
        this.db
          .prepare(
            `INSERT INTO bridge_identities (platform, platform_userid, username, display_name, allowed, created_at, updated_at)
             VALUES (?, ?, ?, ?, 1, ?, ?)`,
          )
          .run(this.platform, applicant, userName, displayName, nowIso(), nowIso())
      })
      provisionTx()
      this.audit.log({
        username: '-',
        source: 'feishu-approval',
        action: 'approval.provision',
        targetId: instanceCode,
        detail: { username: userName, displayName, roles: [], openId: applicant },
      })

      try {
        await this.notifier.sendUserTo(
          this.platform,
          applicant,
          `你的系统账号已开通 ✅\n用户名：${userName}\n初始密码：${password}\n` +
            `账号当前是默认配置（零权限，看不到公司数据）——管理员会给你配置岗位权限，配置好后重新登录即可。请尽快登录管理后台修改密码。`,
        )
      } catch (error) {
        this.rollback(userName, applicant)
        const m = error instanceof Error ? error.message : String(error)
        this.audit.log({
          username: '-',
          source: 'feishu-approval',
          action: 'approval.provision.rolled_back',
          targetId: instanceCode,
          detail: { username: userName, reason: `初始密码私聊发送失败：${m}` },
          ok: false,
        })
        await this.notifyBoss(
          `审批单 ${instanceCode} 开通后初始密码私聊发送失败，账号已回滚（${userName}）——系统会在收到重推事件时自动重试；若没有重推，请让对方重新发起申请。`,
        ).catch(() => {})
        return false
      }
      // 配权提醒（2026-10-31 方案 B）：每单都提醒——开通即零权限，配角色是管理员的必做动作
      await this.notifyBoss(
        `员工账号已开通：${displayName}（用户名 ${userName}），当前零权限。` +
          `请到管理后台「系统权限」页为其绑定预定义岗位角色，并顺手检查是否需要单独调整权限。`,
      ).catch((e) => {
        console.warn('[feishu-approval] 配权提醒发送失败：', e instanceof Error ? e.message : e)
      })
      return true
    } catch (error) {
      const m = error instanceof Error ? error.message : String(error)
      this.audit.log({
        username: '-',
        source: 'feishu-approval',
        action: 'approval.provision.failed',
        targetId: instanceCode,
        detail: { error: m, userName, applicant },
        ok: false,
      })
      await this.notifyBoss(`审批单 ${instanceCode} 开通失败：${m}`).catch(() => {})
      return false
    }
  }

  /**
   * 权限变更通道关闭后的统一处理（2026-10-31 用户拍板方案 B）：审批定义删不掉（契约坑 10），
   * 员工仍能看到并提单、boss 仍可能批——系统侧不执行，礼貌告知申请人+让老板知道自己批的单
   * 不会生效。恒返回 true（占坑落地，不进重试——单子内容再对也不会被执行）。
   */
  private async closePermChannel(instanceCode: string, inst: InstanceDetail): Promise<boolean> {
    await this.rejectPermPermanent(
      instanceCode,
      inst.open_id ?? '',
      '权限变更申请通道已关闭——系统已改为管理员统一配置权限：开通后请联系管理员在「系统权限」页为你配置角色',
    )
    return true
  }

  /**
   * 权限变更（执行计划 P3，**2026-10-31 起休眠**：通道关闭，handleEvent 不再派发到这里。
   * 方法保留+测试钉着机制——用户明示"他们具体有明确需求了我们再改"，恢复时把
   * closePermChannel 换回本方法即可）：解析表单（用户名+目标角色）→ 校验 → 给已有账号加角色
   * → 私聊结果。返回 true=处理完成（含"内容不合法被永久拒绝"——占坑落地不重试）；
   * false=瞬时失败（API/DB 异常，已审计 ok=0，调用方放坑留重试）。
   * 边界（执行计划拍板）：审批只管加权限，收回是管理员动作；申请者必须是本人（一人一号
   * 绑定校验，防替别人申请）；技术角色不可申请。
   */
  async applyPermChange(instanceCode: string, inst: InstanceDetail): Promise<boolean> {
    const applicant = inst.open_id ?? ''
    try {
      const form = this.parseForm(inst.form)
      const userName = (form.get(APPROVAL_USER_NAME) ?? '').trim()
      const targetRole = (form.get(APPROVAL_TARGET_ROLE) ?? '').trim()
      if (applicant === '') throw new BadRequestError('审批实例缺发起人 open_id')
      // 一人一号：申请人必须已绑定系统账号，且只能给自己的账号申请
      // allowed=1（P3 审查 D2）：撤销的绑定不是身份证明——管理员软离职处置后，
      // 该飞书号不能拿旧绑定冒充本人发起权限变更
      const bound = this.db
        .prepare('SELECT username FROM bridge_identities WHERE platform = ? AND platform_userid = ? AND allowed = 1')
        .get(this.platform, applicant) as { username: string } | undefined
      if (bound === undefined) {
        return this.rejectPermPermanent(instanceCode, applicant, '你的飞书账号还没绑定系统账号——先走《智能体系统账号开通》审批')
      }
      if (bound.username !== userName) {
        return this.rejectPermPermanent(
          instanceCode,
          applicant,
          `只能给自己的账号（${bound.username}）申请权限，表单里填的是 "${userName}"`,
        )
      }
      // 停用闸（P3 审查 D1）：与 applyOrgRules 同一护栏口径——停用账号加角色会收到
      // "已生效"的假通知，且复启用后角色静默在位，审计与事实不符
      const account = this.rbac.findUser(bound.username)
      if (account === undefined) {
        return this.rejectPermPermanent(instanceCode, applicant, `账号 "${userName}" 不存在——先走《智能体系统账号开通》审批`)
      }
      if (account.disabled_at !== null) {
        return this.rejectPermPermanent(instanceCode, applicant, `账号 "${userName}" 已停用——找管理员恢复账号后重新申请`)
      }
      if ((TECHNICAL_ROLES as readonly string[]).includes(targetRole)) {
        return this.rejectPermPermanent(instanceCode, applicant, `角色 "${targetRole}" 是系统技术角色，不能通过审批申请`)
      }
      const roleExists =
        this.db.prepare('SELECT 1 FROM roles WHERE name = ?').get(targetRole) !== undefined
      if (!roleExists) {
        return this.rejectPermPermanent(
          instanceCode,
          applicant,
          `角色 "${targetRole}" 还不存在——找管理员在系统「系统权限」页先建角色（角色名要完全一致）`,
        )
      }
      const already = this.rbac.rolesOf(bound.username).includes(targetRole)
      // 来源=manual（执行计划 P4 拍板）：审批是对个体的单独决定，不随部门映射重算变动
      this.rbac.assignRole(bound.username, targetRole, 'manual')
      this.audit.log({
        username: '-',
        source: 'feishu-approval',
        action: 'approval.permchange.applied',
        targetId: instanceCode,
        detail: { username: bound.username, role: targetRole, openId: applicant, alreadyHad: already },
      })
      // 私聊结果给申请人（独立 catch：通知失败不改变"权限已加"的事实与审计语义）
      await this.notifier
        .sendUserTo(
          this.platform,
          applicant,
          already
            ? `你的账号 ${bound.username} 本来就有角色「${targetRole}」，无需变更 ✅`
            : `权限变更已生效 ✅\n账号 ${bound.username} 已加上角色「${targetRole}」。\n收权限请找管理员操作。`,
        )
        .catch((e: unknown) => {
          console.warn('[feishu-approval] 权限变更结果私聊发送失败：', e instanceof Error ? e.message : e)
        })
      return true
    } catch (error) {
      // 瞬时失败（API 抖动/库异常）：审计留痕 + 放坑重试；表单级永久问题在上面已按拒绝处理。
      // 老板知情（P3 审查 D3）：重试 3 次耗尽弃追后这单实质永不了结——boss 亲手批的单
      // 无声丢失最伤信任，每次失败都喊一声（比照 provision 失败通知模式）
      const m = error instanceof Error ? error.message : String(error)
      this.audit.log({
        username: '-',
        source: 'feishu-approval',
        action: 'approval.permchange.failed',
        targetId: instanceCode,
        detail: { error: m, applicant },
        ok: false,
      })
      console.warn(`[feishu-approval] 权限变更审批处理失败（单 ${instanceCode}）：${m}`)
      await this.notifyBoss(`审批单 ${instanceCode}（权限变更）执行失败，系统会自动重试：${m}`).catch(() => {})
      return false
    }
  }

  /** 内容不合法的永久拒绝：占坑落地（不再重试）+ 审计 ok=0 + 私聊说明。审批是 boss 亲手批的，
   *  批了但系统执行不了要让他知道为什么——所以同时给老板发一条简要原因。 */
  private async rejectPermPermanent(instanceCode: string, applicant: string, reason: string): Promise<boolean> {
    this.audit.log({
      username: '-',
      source: 'feishu-approval',
      action: 'approval.permchange.rejected',
      targetId: instanceCode,
      detail: { reason, applicant },
      ok: false,
    })
    await this.notifier.sendUserTo(this.platform, applicant, `权限变更申请没有生效 ❌\n原因：${reason}`).catch(() => {})
    await this.notifyBoss(`审批单 ${instanceCode}（权限变更）无法执行：${reason}`).catch(() => {})
    return true
  }

  // ---------- 部门 → 角色映射（职能型；REST 面在 BridgeController） ----------

  listOrgRules(): OrgRule[] {
    return this.db.prepare('SELECT * FROM feishu_org_rules ORDER BY id').all() as OrgRule[]
  }

  /** 映射列表带部门显示名（join 组织镜像；部门已从通讯录消失的显示提示）。 */
  listOrgRulesWithNames(): Array<OrgRule & { displayName: string; departmentExists: boolean }> {
    return this.listOrgRules().map((r) => {
      const d = this.db
        .prepare('SELECT name FROM feishu_departments WHERE department_id = ?')
        .get(r.department_id) as { name: string } | undefined
      return {
        ...r,
        displayName: d?.name ?? (r.department_name !== '' ? r.department_name : r.department_id),
        departmentExists: d !== undefined,
      }
    })
  }

  /** 可配角色（映射下拉用）：roles 表全部角色名。 */
  availableRoles(): string[] {
    return (this.db.prepare('SELECT name FROM roles ORDER BY name').all() as { name: string }[]).map((r) => r.name)
  }

  // ---------- 组织架构同步（飞书部门树 → 本地镜像） ----------

  listDepartments(): { departments: FeishuDepartment[]; syncedAt: string | null } {
    const departments = this.db.prepare('SELECT * FROM feishu_departments ORDER BY parent_id, department_id').all() as FeishuDepartment[]
    const last = departments[0]?.synced_at ?? null
    return { departments, syncedAt: last }
  }

  /**
   * 拉飞书部门树落库（GET /contact/v3/departments/0/children，0=根，fetch_child=true 一次
   * 拉全子树，分页取尽）。表=全量替换的快照（同步即镜像，映射规则不级联删）；触发方式
   * （startup/schedule/ui）进审计。失败抛给调用方（启动/定时的 catch 只 warn 降级）。
   */
  async syncFromFeishu(trigger: 'startup' | 'schedule' | 'ui', caller = '-'): Promise<{ count: number }> {
    interface RawDept {
      // 真机契约（2026-10-30 实证）：query 声明 open_department_id 时，items 里 ID 字段名是
      // open_department_id（不是 department_id）——按后者的防御解析把全部条目当坏数据跳过，
      // 同步永远 0 条且界面无错。两种字段名都兜。
      department_id?: unknown
      open_department_id?: unknown
      name?: unknown
      parent_department_id?: unknown
      member_count?: unknown
    }
    const all: FeishuDepartment[] = []
    const syncedAt = nowIso()
    let pageToken = ''
    let pages = 0
    do {
      // 翻页上限（对抗审查 P3-2）：正常企业远到不了；对端异常回环时截断不无限拉
      if (++pages > 200) {
        console.warn(`[feishu-approval] 组织同步翻页超过 200 页，异常截断（已收 ${all.length} 个部门）`)
        break
      }
      const j = await this.call<{ data?: { items?: unknown; page_token?: unknown; has_more?: unknown } }>(
        'GET',
        `/contact/v3/departments/0/children?department_id_type=open_department_id&fetch_child=true&page_size=50${
          pageToken === '' ? '' : `&page_token=${encodeURIComponent(pageToken)}`
        }`,
      )
      const items = Array.isArray(j.data?.items) ? (j.data!.items as RawDept[]) : []
      for (const it of items) {
        const id =
          typeof it.open_department_id === 'string' && it.open_department_id !== ''
            ? it.open_department_id
            : typeof it.department_id === 'string'
              ? it.department_id
              : undefined
        if (id === undefined) continue
        // 部门名不在基础权限里（2026-10-30 实证：contact:contact.base:readonly 只有 ID 骨架，
        // 部门名要 contact:department.base:readonly）——缺名时用 ID 占位，别把条目整体吞掉
        const name = typeof it.name === 'string' && it.name !== '' ? it.name : id
        all.push({
          department_id: id,
          name,
          parent_id: typeof it.parent_department_id === 'string' ? it.parent_department_id : '',
          member_count: typeof it.member_count === 'number' ? it.member_count : 0,
          synced_at: syncedAt,
        })
      }
      pageToken = j.data?.has_more === true && typeof j.data?.page_token === 'string' ? j.data.page_token : ''
    } while (pageToken !== '')
    // 空响应护栏：正常企业不会零部门，拉到空更可能是权限/接口异常——不清镜像，避免误清显示名
    if (all.length > 0) {
      const tx = this.db.transaction(() => {
        this.db.prepare('DELETE FROM feishu_departments').run()
        const ins = this.db.prepare(
          'INSERT OR REPLACE INTO feishu_departments (department_id, name, parent_id, member_count, synced_at) VALUES (?, ?, ?, ?, ?)',
        )
        for (const d of all) ins.run(d.department_id, d.name, d.parent_id, d.member_count, d.synced_at)
      })
      tx()
    }
    this.audit.log({
      username: caller,
      source: trigger === 'ui' ? 'ui' : 'system',
      action: 'bridge.org.sync',
      detail: { count: all.length, trigger, applied: all.length > 0 },
    })
    // 调岗自动重算已随权限变更审批一并休眠（2026-10-31 方案 B：角色全部走管理员在
    // 「系统权限」页手动配置，部门映射数据保留但不再驱动任何角色变更）。恢复=在同步
    // 落库成功后调 this.recalcOrgRoles(trigger) 即可，方法与测试都保留。
    return { count: all.length }
  }

  createOrgRule(caller: string, input: { departmentId?: unknown; departmentName?: unknown; role?: unknown }): OrgRule {
    const departmentId = typeof input.departmentId === 'string' ? input.departmentId.trim() : ''
    const departmentName = typeof input.departmentName === 'string' ? input.departmentName.trim() : ''
    const role = typeof input.role === 'string' ? input.role.trim() : ''
    if (departmentId === '' || role === '') {
      throw new BadRequestError('departmentId（飞书部门 ID，od- 开头）和 role（系统角色名）都不能为空。')
    }
    // 形状闸（对抗审查 P3-4）：贴错 ID 的规则永不匹配，只会产出零权限账号
    if (!departmentId.startsWith('od-')) {
      throw new BadRequestError(`departmentId 要是飞书 open_department_id（od- 开头），收到 "${departmentId}"。`)
    }
    const exists = this.db.prepare('SELECT 1 FROM roles WHERE name = ?').get(role)
    if (exists === undefined) {
      const available = (this.db.prepare('SELECT name FROM roles ORDER BY name').all() as { name: string }[])
        .map((r) => r.name)
        .join('、')
      throw new BadRequestError(`角色 "${role}" 不存在。可用角色：${available}（要新角色先在「系统权限」页或 POST /api/rbac/roles 建角色；样例库可跑 scripts/sample/seed-sample）。`)
    }
    // 技术角色不进部门映射（对抗审查 P1-2 采纳）：映射到 boss 等于把全权发给整个部门每个新开通账号。
    if ((TECHNICAL_ROLES as readonly string[]).includes(role)) {
      this.audit.log({
        username: caller,
        source: 'ui',
        action: 'rbac.guard.rejected',
        targetId: `${departmentId}/${role}`,
        detail: { rule: 'technical-role', note: '技术角色不能配部门映射' },
        ok: false,
      })
      throw new ForbiddenError(`角色 "${role}" 是技术角色，不能配部门映射。`)
    }
    const dup = this.db.prepare('SELECT id FROM feishu_org_rules WHERE department_id = ?').get(departmentId)
    if (dup !== undefined) throw new BadRequestError(`部门 ${departmentId} 已有映射规则，先删旧的再加。`)
    this.db
      .prepare('INSERT INTO feishu_org_rules (department_id, department_name, role, scope, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(departmentId, departmentName, role, '*', nowIso())
    this.audit.log({
      username: caller,
      source: 'ui',
      action: 'bridge.org.rule.create',
      targetId: departmentId,
      detail: { role, departmentName },
    })
    return this.db.prepare('SELECT * FROM feishu_org_rules WHERE department_id = ?').get(departmentId) as OrgRule
  }

  deleteOrgRule(caller: string, id: number): void {
    const row = this.db.prepare('SELECT * FROM feishu_org_rules WHERE id = ?').get(id) as OrgRule | undefined
    if (row === undefined) throw new BadRequestError(`没有 id=${id} 的映射规则。`)
    this.db.prepare('DELETE FROM feishu_org_rules WHERE id = ?').run(id)
    this.audit.log({
      username: caller,
      source: 'ui',
      action: 'bridge.org.rule.delete',
      targetId: row.department_id,
      detail: { role: row.role },
    })
  }

  /**
   * 按当前部门映射给已有账号补配角色（对抗审查 P2-2：映射规则只在开通时落一次角色，
   * "先开通后配映射"或通讯录当时抖动过的账号由此补上——幂等，重复调用无副作用）。
   */
  async applyOrgRules(caller: string, username: string): Promise<{ count: number; roles: string[] }> {
    const name = username.trim()
    // 不能给自己补配（对抗审查 P1-2 采纳）：补配=给自己加角色，与拼装台面"自己改自己的权限拒绝"同一套利口
    if (name === caller) {
      this.audit.log({
        username: caller,
        source: 'ui',
        action: 'rbac.guard.rejected',
        targetId: name,
        detail: { rule: 'self-change', note: '给自己按映射补配角色' },
        ok: false,
      })
      throw new ForbiddenError('不能给自己按映射补配角色；自己的权限找其他管理员操作。')
    }
    const user = this.rbac.findUser(name)
    if (user === undefined || user.disabled_at !== null) throw new BadRequestError(`用户 "${name}" 不存在或已停用。`)
    if (user.is_service === 1) throw new BadRequestError('服务账号不参与组织映射。')
    const binding = this.db
      .prepare('SELECT platform_userid FROM bridge_identities WHERE platform = ? AND username = ? AND allowed = 1 ORDER BY created_at LIMIT 1')
      .get(this.platform, name) as { platform_userid: string } | undefined
    if (binding === undefined) throw new BadRequestError(`用户 "${name}" 没有本平台绑定，拿不到部门。`)
    // HTTP 查部门在事务外（better-sqlite3 事务必须是同步体），落角色才进事务
    const departments = await this.departmentsOf(binding.platform_userid)
    const apply = this.db.transaction(() => {
      const roles = this.rolesForDepartments(departments)
      // 来源=mapping（执行计划 P4）：补配/重刷都随部门映射走——setRoleSource 把存量
      // （加列前落的 manual 默认行）一并刷成 mapping，纳入调岗重算
      for (const role of roles) {
        this.rbac.assignRole(name, role, 'mapping')
        this.rbac.setRoleSource(name, role, 'mapping')
      }
      this.audit.log({
        username: caller,
        source: 'ui',
        action: 'bridge.org.rule.apply',
        targetId: name,
        detail: { roles, departments },
      })
      return { count: roles.length, roles }
    })
    return apply()
  }

  // ---------- P4 调岗自动同步：组织同步后的映射角色重算（2026-10-31 方案 B 起休眠：
  //  syncFromFeishu 不再调用，角色全走管理员手动配置；方法与测试保留，恢复时接回同步链） ----------

  /** 重算统计（REST 响应/日志/审计共用）。 */
  async recalcOrgRoles(trigger: 'startup' | 'schedule' | 'ui'): Promise<OrgRecalcResult> {
    const stats: OrgRecalcResult = { users: 0, added: 0, removed: 0, failures: 0, guardSkipped: 0, noDept: 0 }
    try {
      // 全员=有本平台绑定（allowed=1）的非服务账号；没绑定的拿不到部门，重算无从谈起。
      // 同一 username 只取最早的一条绑定（审查 D2：绑定表无 username 唯一约束，一人多绑
      // 是已知状态——不去重会双倍计数+两号部门不同时结果随行序摆动；取最早与 applyOrgRules
      // 的 ORDER BY created_at LIMIT 1 同口径）
      const bindings = this.db
        .prepare(
          `SELECT bi.username AS username, bi.platform_userid AS openId
           FROM bridge_identities bi JOIN users u ON u.username = bi.username
           WHERE bi.platform = ? AND bi.allowed = 1 AND u.is_service = 0
             AND bi.created_at = (SELECT MIN(b2.created_at) FROM bridge_identities b2
                                  WHERE b2.platform = bi.platform AND b2.username = bi.username AND b2.allowed = 1)
           ORDER BY bi.username`,
        )
        .all(this.platform) as Array<{ username: string; openId: string }>
      // HTTP（每人的部门接口）在事务外逐个拉：单人失败只记 failures 不阻塞其他人
      // （下轮同步自然重试）；全部算完后一个事务落库+审计
      const plans: Array<{ username: string; add: string[]; remove: string[] }> = []
      for (const b of bindings) {
        stats.users += 1
        let departments: string[]
        try {
          departments = await this.departmentsOf(b.openId)
        } catch {
          stats.failures += 1
          continue
        }
        if (departments.length === 0) {
          // 空部门不摘（审查 D1）：department_ids 返回空与字段权限缺失故障不可区分（契约坑 19
          // 实证过缺 contact:user.department:readonly 时成功返回空）——按"调岗到无部门"摘光
          // mapping 会把权限故障放大成全员失权且零告警。保守跳过（真离职/无部门场景随离职
          // 处理增量一起设计），单独计数让审计能看见这个信号
          stats.noDept += 1
          continue
        }
        const target = this.rolesForDepartments(departments)
        const rows = this.db
          .prepare(
            `SELECT r.name AS name, ur.source AS source
             FROM user_roles ur JOIN users u ON u.id = ur.user_id JOIN roles r ON r.id = ur.role_id
             WHERE u.username = ?`,
          )
          .all(b.username) as Array<{ name: string; source: string }>
        const held = new Set(rows.map((r) => r.name))
        // 多退少补都只看 mapping 来源：manual 是管理员/审批的个体决定，重算不碰
        // （已在角色不重复加——manual 持有时也不翻成 mapping，手动绑定保持手动语义）
        const add = target.filter((t) => !held.has(t))
        const remove = rows.filter((r) => r.source === 'mapping' && !target.includes(r.name)).map((r) => r.name)
        if (add.length > 0 || remove.length > 0) plans.push({ username: b.username, add, remove })
      }
      const apply = this.db.transaction(() => {
        for (const p of plans) {
          let removals = p.remove
          if (removals.length > 0 && !this.lastAdminSurvivesRecalc(p.username, removals)) {
            stats.guardSkipped += 1
            removals = [] // 守卫只拦摘除（加权限不产生锁死风险），该加的照加
          }
          for (const role of removals) {
            this.db
              .prepare(
                `DELETE FROM user_roles WHERE user_id = (SELECT id FROM users WHERE username = ?)
                 AND role_id = (SELECT id FROM roles WHERE name = ?) AND source = 'mapping'`,
              )
              .run(p.username, role)
            stats.removed += 1
          }
          for (const role of p.add) {
            this.rbac.assignRole(p.username, role, 'mapping')
            stats.added += 1
          }
        }
        this.audit.log({
          username: '-',
          source: 'system',
          action: 'bridge.org.recalc',
          detail: { trigger, ...stats },
        })
      })
      try {
        apply()
      } catch (error) {
        // 事务原子回滚但 stats 是内存对象（审查附注）：清零已应用计数，别让日志/REST 打假数字
        stats.added = 0
        stats.removed = 0
        stats.guardSkipped = 0
        throw error
      }
      if (stats.added > 0 || stats.removed > 0 || stats.guardSkipped > 0 || stats.failures > 0 || stats.noDept > 0) {
        console.log(
          `[feishu-approval] 映射角色重算（${trigger}）：${stats.users} 人，+${stats.added}/-${stats.removed}` +
            `，接口失败 ${stats.failures}，空部门跳过 ${stats.noDept}，最后管理员守卫拦下 ${stats.guardSkipped}`,
        )
      }
    } catch (error) {
      // 重算挂在同步尾部：出任何异常都不能打断同步链（启动路径里抛错会拖垮启动序列）
      console.warn('[feishu-approval] 映射角色重算失败（不影响组织同步本身）：', error instanceof Error ? error.message : error)
    }
    return stats
  }

  /** 重算摘除的最后管理员守卫：把 username 的 removals 摘掉后，全库是否仍有活跃的
   *  admin:manage 持有者。拼装台面允许把 admin:manage 拼进普通角色（技术角色闸不拦组合），
   *  映射把这种角色从最后一个管理员身上摘走=全员锁死门外——拦下，宁可少退不锁门。 */
  private lastAdminSurvivesRecalc(username: string, removals: string[]): boolean {
    const placeholders = removals.map(() => '?').join(',')
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT u.id) AS n
         FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN roles r ON r.id = ur.role_id
         JOIN role_permissions rp ON rp.role_id = ur.role_id
         JOIN permissions p ON p.id = rp.permission_id
         WHERE p.code = 'admin:manage' AND u.disabled_at IS NULL
           AND NOT (u.username = ? AND r.name IN (${placeholders}))`,
      )
      .get(username, ...removals) as { n: number }
    return row.n > 0
  }

  // ---------- 内部 ----------

  private parseForm(form: string | undefined): Map<string, string> {
    const map = new Map<string, string>()
    if (typeof form !== 'string' || form === '') return map
    let arr: FormWidget[]
    try {
      arr = JSON.parse(form) as FormWidget[]
    } catch {
      return map
    }
    for (const w of Array.isArray(arr) ? arr : []) {
      // 键取 custom_id 优先、id 兜底（假数据/旧形状）：真机实例表单里自定义 id 在 custom_id（见 FormWidget 注）
      const key = typeof w.custom_id === 'string' && w.custom_id !== '' ? w.custom_id : w.id
      if (typeof key === 'string' && typeof w.value === 'string') map.set(key, w.value)
    }
    return map
  }

  /** 发起人所在飞书部门（open_department_id 列表）。失败抛错（对抗审查 P2-2）：接口抖动时
   *  宁可开通失败等重试，也不静默产出"零权限账号+补配也没用"的死路。
   *  响应层级同 ensureDefinition：字段在 data.user 里（2026-10-30 真机实证修正）。 */
  private async departmentsOf(openId: string): Promise<string[]> {
    const j = await this.call<{ data?: { user?: { department_ids?: unknown } } }>(
      'GET',
      `/contact/v3/users/${openId}?user_id_type=open_id&department_id_type=open_department_id`,
    )
    const ids = j.data?.user?.department_ids
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []
  }

  /**
   * 直接部门 → 含全部祖先的链（对抗审查 P1-1：飞书 department_ids 只含直接所属部门，
   * 映射配在上级部门也要覆盖子部门员工——沿镜像 parent 链展开；镜像缺失的祖先容忍截断，
   * 防环上限 20 层）。
   */
  private withAncestors(departmentIds: string[]): string[] {
    const all = new Set<string>()
    for (const id of departmentIds) {
      let cur: null | string = id
      for (let depth = 0; cur !== null && depth < 20; depth++) {
        if (all.has(cur)) break
        all.add(cur)
        const row = this.db.prepare('SELECT parent_id FROM feishu_departments WHERE department_id = ?').get(cur) as
          | { parent_id: string }
          | undefined
        cur = row?.parent_id !== undefined && row.parent_id !== '0' && row.parent_id !== '' ? row.parent_id : null
      }
    }
    return [...all]
  }

  private rolesForDepartments(departmentIds: string[]): string[] {
    if (departmentIds.length === 0) return []
    const expanded = this.withAncestors(departmentIds)
    const rules = this.listOrgRules().filter((r) => expanded.includes(r.department_id))
    return [...new Set(rules.map((r) => r.role))]
  }

  private bossOpenId(): string | undefined {
    const boss = this.rbac.bossUsername()
    if (boss === undefined) return undefined
    const row = this.db
      .prepare(
        'SELECT platform_userid FROM bridge_identities WHERE platform = ? AND username = ? AND allowed = 1 ORDER BY created_at LIMIT 1',
      )
      .get(this.platform, boss) as { platform_userid: string } | undefined
    return row?.platform_userid
  }

  /** 开通失败收尾的老板通知（boss 没绑定时静默放弃——审计里已有全量记录）。 */
  private async notifyBoss(text: string): Promise<void> {
    const openId = this.bossOpenId()
    if (openId === undefined) return
    await this.notifier.sendUserTo(this.platform, openId, text)
  }

  /** 回滚半开通的账号（员工没拿到初始密码）：删除顺序=先引用后本体。 */
  private rollback(userName: string, openId: string): void {
    this.db
      .prepare('DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE username = ?)')
      .run(userName)
    this.db.prepare("DELETE FROM bridge_identities WHERE platform = ? AND platform_userid = ?").run(this.platform, openId)
    this.db.prepare('DELETE FROM users WHERE username = ?').run(userName)
  }

  private getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value
  }

  /** 原子占坑（对抗审查 P2-1）：抢到=首次处理；抢不到=已处理过/并发在处理。 */
  private claimInstance(instanceCode: string): boolean {
    const r = this.db
      .prepare('INSERT OR IGNORE INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)')
      .run(`feishu.approval.instance.${instanceCode}`, 'processing', nowIso())
    return r.changes === 1
  }

  /** 放坑：开通失败时释放，事件重推或人工重触发可再跑。 */
  private releaseInstance(instanceCode: string): void {
    this.db.prepare('DELETE FROM app_meta WHERE key = ?').run(`feishu.approval.instance.${instanceCode}`)
  }

  private setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, nowIso())
  }

  private async accessToken(): Promise<string> {
    if (this.token !== undefined && Date.now() < this.token.expiresAt) return this.token.value
    const r = await this.fetchFn('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: config.feishuAppId, app_secret: config.feishuAppSecret }),
      signal: AbortSignal.timeout(10_000), // 网络黑洞防挂死（对抗审查 P3-5；下同）
    })
    const j = (await r.json()) as { code?: number; msg?: string; tenant_access_token?: string; expire?: number }
    if (typeof j.tenant_access_token !== 'string' || j.tenant_access_token === '') {
      throw new Error(`拿不到 tenant_access_token：${j.msg ?? `code=${j.code ?? '?'}`}（检查 ADMIN_FEISHU_APP_ID/SECRET）`)
    }
    this.token = { value: j.tenant_access_token, expiresAt: Date.now() + Math.max(60, (j.expire ?? 7200) - 60) * 1000 }
    return this.token.value
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const token = await this.accessToken()
    const r = await this.fetchFn(`https://open.feishu.cn/open-apis${path}`, {
      method,
      headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    const j = (await r.json()) as { code?: number; msg?: string }
    if (j.code !== 0) throw new Error(`飞书 API ${path} 失败 code=${j.code}: ${j.msg}`)
    return j as T
  }
}

/** 审批→落账通用插槽（融合方案 §5 P2，2026-11-01 用户拍板"你就做报销啊什么的"）。
 *  飞书审批实例 APPROVED → 按规则映射成一笔私有提案（默认 type=reimburse）→ 提案卡直发
 *  老板单聊 → 老板点「确认入账」走既有 proposals.confirm（落账 source='confirm'，approved_by=
 *  确认人）；卡片推不出去或超 24h，待办中心的"提案待确认"扫描器与网页「提案」页兜底。
 *  报销/付款/采购/借款同一套代码，只是规则不同：规则集存 app_meta `finance.approval_posting_rules`
 *  （JSON 数组，code 唯一），哪张审批定义批了就记哪类账。
 *  金额/事由解析：规则 field_map 指定 widget 的 custom_id（或 id）最稳；没配走启发式——
 *  首个 amount/number 型取金额，首个名字含"事由/原因/说明/用途"的文本取事由。金额解析不出
 *  不假成功：提案不建、老板收文本通知手工登记、审计 approval.posting.unresolved。
 *  幂等双保险：事件占坑键沿用 feishu.approval.instance.*（与开通/权限变更共用，崩溃遗留
 *  30 分钟后被清理重跑）；提案侧再带 origin=`feishu-approval:<instance_code>` 查重——
 *  建完提案崩在标记前，重跑也不会建出第二笔。 */
import type { DB } from '../db/database.js'
import { nowIso } from '../db/database.js'
import { BadRequestError } from '../errors.js'
import type { AuditService } from '../audit/audit.service.js'
import type { RbacService } from '../rbac/rbac.service.js'
import type { FinanceProposalsService } from './finance-proposals.service.js'
import { parseAmount } from './finance.util.js'
import { TYPE_VALUES, type Actor } from './finance.types.js'
import type { BridgeService } from '../bridge/bridge.service.js'
import type { ProposalCardView } from '../bridge/bridge.types.js'

/** 一条落账规则：哪个审批定义（code）批了以后，按什么口径记哪笔账。 */
export interface PostingRule {
  /** 飞书审批定义 approval_code（飞书管理后台该定义详情页可查） */
  code: string
  /** 人话名：订阅日志与卡片文案用 */
  name: string
  /** 落账 type，默认 reimburse */
  type: string
  /** 账本分类，默认 报销 */
  category: string
  /** 默认入账账户（须已在「账户」页建档；空=落账时老板自己补） */
  account: string
  enabled: boolean
  /** 表单字段映射（widget 的 custom_id 或 id）；不配走启发式 */
  field_map: { amount?: string; reason?: string }
}

export interface RulesInput {
  rules?: unknown
}

/** 飞书实例详情里本插槽消费的形状（feishu-approval 回查实例详情后原样透传）。 */
export interface PostingInstance {
  status?: string
  approval_code?: string
  open_id?: string
  form?: string
  serial_number?: unknown
  end_time?: unknown
}

/** feishu-approval 持有的钩子：类型只依赖本文件，避免 bridge→finance 运行时环。 */
export interface ApprovalPostingHook {
  ruleFor(approvalCode: string): PostingRule | undefined
  /** 该 code 登记过规则（不管停没停）——停用规则的实例要在事件侧落坑，防补抓反复重吃 */
  hasRule(approvalCode: string): boolean
  onApproved(instanceCode: string, inst: PostingInstance, rule: PostingRule): Promise<boolean>
  /** 需要订阅的审批定义（code+人话名）；事件订阅与补抓扫描都用它（不过滤 enabled） */
  codes(): Array<{ code: string; name: string }>
}

export interface PostingPreview {
  instance_code: string
  rule: Pick<PostingRule, 'code' | 'name' | 'type' | 'category' | 'account'>
  amount: number | null
  amount_source: string
  reason: string
  counterparty: string
  date: string
  serial_number: string
  note: string
}

/** postProposal 的来源描述：谁建的提案（actor）、审计记成谁（auditActor，审批链路沿用 '-'/feishu-approval）、
 *  审计动作前缀（approval.posting / payroll.posting）、卡片来源标签与两种失败的老板话术模板。 */
export interface PostSource {
  origin: string
  actor: Actor
  auditActor: { username: string; source: string }
  auditPrefix: string
  targetId: string
  createdByLabel: string
  /** `{error}` 占位 */
  failText: string
  /** `{proposal}` `{error}` 占位 */
  cardFailText: string
}

export type PostOutcome =
  | { status: 'created'; proposal: string; summary: string; card: 'sent' | 'failed' }
  | { status: 'duplicate'; proposal: string; proposalStatus: string }
  | { status: 'failed'; error: string }

interface Widget {
  id: string
  customId: string
  name: string
  type: string
  value: unknown
  /** 0=表单顶层；≥1=明细表（fieldList）子行里的控件。启发式只看顶层：子行摊平后"首个金额"
   *  会是第一条明细的金额，多条明细时错拿局部数当整单（2026-11-02 真机定义结构核出的坑）。 */
  depth: number
}

const RULES_KEY = 'finance.approval_posting_rules'
const REASON_HINT = /事由|原因|说明|用途/
/** 启发式认作金额的控件类型：amount/number 之外加 formula——飞书自带报销模板的总额是公式控件
 *  （「费用汇总」），顶层根本没有 amount 型字段。 */
const AMOUNT_TYPES = new Set(['amount', 'number', 'formula'])
const trunc = (v: string, n: number): string => (v.length <= n ? v : `${v.slice(0, n)}…`)

export class FinancePostingService {
  constructor(
    private readonly db: DB,
    private readonly audit: AuditService,
    private readonly proposals: FinanceProposalsService,
    private readonly rbac: RbacService,
    private readonly bridge: BridgeService,
    private readonly opts: { platform: string },
  ) {}

  // ---------- 规则管理 ----------

  listRules(): PostingRule[] {
    const raw = this.db.prepare('SELECT value FROM app_meta WHERE key = ?').get(RULES_KEY) as { value: string } | undefined
    if (raw === undefined) return []
    try {
      const arr = JSON.parse(raw.value) as unknown
      if (!Array.isArray(arr)) return []
      return arr.filter((x): x is PostingRule => typeof x === 'object' && x !== null && typeof (x as PostingRule).code === 'string')
    } catch {
      return []
    }
  }

  /** 整表覆盖式保存（与平台登记册同模式）。code 唯一；type 必须是账本类型；账户填了必须
   *  已建档且未停用（与 requireAccount 同口径，别等审批批完才在确认卡上炸）。 */
  setRules(actor: { username: string; source: string }, input: RulesInput): { rules: PostingRule[] } {
    if (!Array.isArray(input.rules)) throw new BadRequestError('rules 应为数组。')
    const seen = new Set<string>()
    const rules: PostingRule[] = input.rules.map((r) => {
      if (typeof r !== 'object' || r === null) throw new BadRequestError('rules 里必须是对象。')
      const x = r as Record<string, unknown>
      const code = typeof x.code === 'string' ? x.code.trim() : ''
      if (code === '') throw new BadRequestError('每条规则都要有 code（飞书审批定义 approval_code）。')
      if (seen.has(code)) throw new BadRequestError(`审批定义 ${code} 重复出现，一条定义一条规则。`)
      seen.add(code)
      const name = typeof x.name === 'string' && x.name.trim() !== '' ? x.name.trim() : `审批 ${trunc(code, 8)}…`
      const type = typeof x.type === 'string' && x.type.trim() !== '' ? x.type.trim() : 'reimburse'
      if (!(TYPE_VALUES as readonly string[]).includes(type)) {
        throw new BadRequestError(`type "${type}" 不是账本类型（${TYPE_VALUES.join('/')}）。`)
      }
      const category = typeof x.category === 'string' && x.category.trim() !== '' ? x.category.trim() : '报销'
      const account = typeof x.account === 'string' ? x.account.trim() : ''
      if (account !== '') {
        const row = this.db.prepare('SELECT archived_at FROM finance_accounts WHERE name = ?').get(account) as
          | { archived_at: string | null }
          | undefined
        if (row === undefined || row.archived_at !== null) {
          throw new BadRequestError(`账户"${account}"未建档或已停用。先在「账户」页添加，不挂账户就留空。`)
        }
      }
      const fm = (typeof x.field_map === 'object' && x.field_map !== null ? x.field_map : {}) as Record<string, unknown>
      const fieldMap: { amount?: string; reason?: string } = {}
      for (const key of ['amount', 'reason'] as const) {
        const v = fm[key]
        if (v !== undefined && (typeof v !== 'string' || v.trim() === '')) {
          throw new BadRequestError(`field_map.${key} 须为非空字符串（widget 的 custom_id 或 id）。`)
        }
        if (typeof v === 'string') fieldMap[key] = v.trim()
      }
      return { code, name, type, category, account, enabled: x.enabled === undefined ? true : x.enabled === true, field_map: fieldMap }
    })
    this.db
      .prepare(
        `INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(RULES_KEY, JSON.stringify(rules), nowIso())
    this.audit.log({
      username: actor.username,
      source: actor.source,
      action: 'approval.posting.rules',
      targetId: RULES_KEY,
      detail: { count: rules.length, codes: rules.map((r) => r.code) },
    })
    return { rules }
  }

  // ---------- feishu-approval 钩子 ----------

  hook(): ApprovalPostingHook {
    return {
      ruleFor: (code) => this.listRules().find((r) => r.code === code && r.enabled),
      hasRule: (code) => this.listRules().some((r) => r.code === code),
      codes: () => this.listRules().map((r) => ({ code: r.code, name: r.name })),
      onApproved: (instanceCode, inst, rule) => this.onApproved(instanceCode, inst, rule),
    }
  }

  /** APPROVED 且抢到占坑后进来：建提案 + 推卡给老板。恒返回 true（失败已如实处置：
   *  审计+老板通知），false 只该留给"基础设施性失败、重试可能成"的场景，本插槽没有。 */
  async onApproved(instanceCode: string, inst: PostingInstance, rule: PostingRule): Promise<boolean> {
    const dup = this.findByOrigin(`feishu-approval:${instanceCode}`)
    if (dup !== undefined) {
      this.audit.log({
        username: '-',
        source: 'feishu-approval',
        action: 'approval.posting.duplicate',
        targetId: instanceCode,
        detail: { proposal: dup.id },
      })
      return true
    }
    const widgets = parseWidgets(inst.form)
    const amountSource = this.pickAmount(widgets, rule)
    const reason = this.pickReason(widgets, rule)
    const endMs = typeof inst.end_time === 'string' || typeof inst.end_time === 'number' ? Number(inst.end_time) : NaN
    const endKnown = Number.isFinite(endMs) && endMs > 0
    const date = localDateFromMs(endKnown ? endMs : undefined)
    const serial = typeof inst.serial_number === 'string' || typeof inst.serial_number === 'number' ? String(inst.serial_number) : ''
    const applicant = await this.applicantName(inst.open_id)
    if (amountSource.amount === null) {
      // 不假成功：金额读不出来就别建提案。审计已落，老板收文本通知手工登记；
      // 老板没绑平台也无所谓（审计里有全量记录，同 FAS notifyBoss 纪律）
      this.audit.log({
        username: '-',
        source: 'feishu-approval',
        action: 'approval.posting.unresolved',
        targetId: instanceCode,
        detail: { rule: rule.code, amount_source: amountSource.source, reason: trunc(reason, 60), applicant, date },
      })
      await this.notifyBoss(
        `【${rule.name}】审批已通过，但表单里读不到金额（${amountSource.source}），请手工登记。\n` +
          `单号 ${serial || instanceCode} · 申请人 ${applicant} · 事由 ${trunc(reason, 40) || '（无）'}`,
      ).catch(() => undefined)
      return true
    }
    const amount = amountSource.amount // 走到这里必非 null（上面已挡）；闭包内取属性会丢窄化，先落地
    await this.postProposal(
      {
        origin: `feishu-approval:${instanceCode}`,
        auditActor: { username: '-', source: 'feishu-approval' },
        auditPrefix: 'approval.posting',
        targetId: instanceCode,
        actor: { username: 'system:feishu-approval', source: 'bridge' },
        createdByLabel: `${rule.name}（审批落账）`,
        failText: `【${rule.name}】审批通过但生成记账提案失败：{error}\n单号 ${serial || instanceCode}，请手工处理。`,
        cardFailText: `审批【${rule.name}】已生成记账提案 {proposal}，但飞书卡片发失败了（{error}），请到网页「提案」页确认。`,
      },
      {
        type: rule.type,
        amount,
        date,
        counterparty: applicant,
        category: rule.category,
        account: rule.account,
        note: `飞书审批【${rule.name}】${serial !== '' ? `#${serial} ` : ''}${trunc(reason, 80)}（${instanceCode}）`,
      },
      { rule: rule.code, amount_source: amountSource.source, applicant, date, end_time_missing: !endKnown },
    )
    return true
  }

  /** 来源无关的落账公共体（审批/工资单共用，2026-11-02）：origin 查重 → 建提案与写 origin 同事务 →
   *  审计 → 老板单聊卡。调用方负责"该不该建、金额是多少"，这里只负责"建得住、推得到、失败如实"：
   *  - 被账本校验挡下（账户未建档/该月已出数等）：审计 `<prefix>.failed` ok=0 + 老板文本通知，不抛
   *    （重试也无解的场景不该进重试队列无限吵）；
   *  - 卡片发不出：不回滚提案（提案已落库，网页「提案」页/24h 待办兜底），审计 `<prefix>.card_failed`。 */
  async postProposal(
    src: PostSource,
    draft: { type: string; amount: number; date: string; counterparty: string; category: string; account: string; note: string },
    auditDetail: Record<string, unknown>,
  ): Promise<PostOutcome> {
    const dup = this.findByOrigin(src.origin)
    if (dup !== undefined) {
      this.audit.log({ ...src.auditActor, action: `${src.auditPrefix}.duplicate`, targetId: src.targetId, detail: { proposal: dup.id, status: dup.status } })
      return { status: 'duplicate', proposal: dup.id, proposalStatus: dup.status }
    }
    let created: { id: string; summary: string; created_at: string }
    try {
      // 建提案与写 origin 查重标同事务（审查 P2-3）：两步之间被杀会让重跑的 origin 查重落空、
      // 建出第二笔——这层存在的唯一目的就是覆盖这个崩溃窗口
      created = this.db.transaction((): { id: string; summary: string; created_at: string } => {
        const proposal = this.proposals.create(src.actor, draft)
        this.db.prepare('UPDATE finance_proposals SET origin = ? WHERE id = ?').run(src.origin, proposal.id)
        return { id: proposal.id, summary: proposal.summary, created_at: proposal.created_at }
      })()
      this.audit.log({
        ...src.auditActor,
        action: `${src.auditPrefix}.created`,
        targetId: src.targetId,
        detail: { proposal: created.id, amount: draft.amount, ...auditDetail },
      })
    } catch (error) {
      const m = error instanceof Error ? error.message : String(error)
      this.audit.log({ ...src.auditActor, action: `${src.auditPrefix}.failed`, targetId: src.targetId, detail: { error: m, ...auditDetail }, ok: false })
      await this.notifyBoss(src.failText.replace('{error}', m)).catch(() => undefined)
      return { status: 'failed', error: m }
    }
    let card: 'sent' | 'failed' = 'sent'
    try {
      const bossOpenId = await this.bossOpenId()
      if (bossOpenId === undefined) throw new Error(`老板（${this.rbac.bossUsername() ?? 'boss'}）还没绑定 ${this.opts.platform} 身份`)
      const view: ProposalCardView = {
        id: created.id,
        summary: created.summary,
        createdBy: src.createdByLabel,
        createdAt: created.created_at.slice(0, 16).replace('T', ' '),
      }
      await this.bridge.sendProposalCardToUser(this.opts.platform, bossOpenId, view)
    } catch (error) {
      card = 'failed'
      const m = error instanceof Error ? error.message : String(error)
      this.audit.log({ ...src.auditActor, action: `${src.auditPrefix}.card_failed`, targetId: src.targetId, detail: { proposal: created.id, error: m }, ok: false })
      await this.notifyBoss(src.cardFailText.replace('{proposal}', created.id).replace('{error}', m)).catch(() => undefined)
    }
    return { status: 'created', proposal: created.id, summary: created.summary, card }
  }

  /** origin 查重：rejected 的不算（老板拒过的单允许重跑重建，见 README 取舍）。 */
  /** origin 查重：排除 rejected；confirmed 但账本那笔已被冲销的也不算在场——冲销是出数后唯一的修正路径，
   *  冲掉即视为这次落账作废，允许同一 origin 重新生成（工资单改数重出靠这条；审批单重跑同理）。
   *  entry_id 一并返回，工资单落账的状态条与守卫拿它展示/判断。 */
  findByOrigin(origin: string): { id: string; status: string; entry_id: string } | undefined {
    const row = this.db
      .prepare(
        `SELECT p.id, p.status, p.entry_id FROM finance_proposals p
           LEFT JOIN finance_entries e ON e.id = p.entry_id
          WHERE p.origin = ? AND p.status != 'rejected'
            AND NOT (p.status = 'confirmed' AND e.reversed_by IS NOT NULL AND e.reversed_by != '')
          ORDER BY p.created_at DESC LIMIT 1`,
      )
      .get(origin) as { id: string; status: string; entry_id: string | null } | undefined
    return row === undefined ? undefined : { id: row.id, status: row.status, entry_id: row.entry_id ?? '' }
  }

  /** 预览：不建提案不落库，把某张实例按当前规则解析给管理员看（配 field_map 前后核对用）。 */
  async preview(instanceCode: string, inst: PostingInstance): Promise<PostingPreview> {
    const rule = this.listRules().find((r) => r.code === inst.approval_code)
    if (rule === undefined) throw new BadRequestError(`实例 ${instanceCode} 的 approval_code 不在任何落账规则里（先在规则里登记这个审批定义）。`)
    const widgets = parseWidgets(inst.form)
    const amountSource = this.pickAmount(widgets, rule)
    return {
      instance_code: instanceCode,
      rule: { code: rule.code, name: rule.name, type: rule.type, category: rule.category, account: rule.account },
      amount: amountSource.amount,
      amount_source: amountSource.source,
      reason: this.pickReason(widgets, rule),
      counterparty: await this.applicantName(inst.open_id),
      date: localDateFromMs(inst.end_time),
      serial_number: typeof inst.serial_number === 'string' || typeof inst.serial_number === 'number' ? String(inst.serial_number) : '',
      note: '预览不建提案不落账；确认链路以真正批准事件为准。',
    }
  }

  // ---------- 内部 ----------

  private pickAmount(widgets: Widget[], rule: PostingRule): { amount: number | null; source: string } {
    const mapped = rule.field_map.amount
    if (mapped !== undefined) {
      // 映射指名的字段不在表单里=规则失效，fail-loud 走金额缺失分支（审查 P2-2）——
      // 静默退回启发式会产出金额错误的提案（启发式可能错拿定金/单价），比不建更糟
      const w = findWidget(widgets, mapped)
      if (w === undefined) {
        return { amount: null, source: `field_map.amount=${mapped} 指名的字段不在表单里（规则失效，不退回启发式）` }
      }
      const n = toAmount(w.value)
      return n === null
        ? { amount: null, source: `field_map.amount=${mapped}「${w.name}」的值读不出数字` }
        : { amount: n, source: `field_map.amount「${w.name}」` }
    }
    const w = widgets.find((x) => x.depth === 0 && AMOUNT_TYPES.has(x.type))
    if (w === undefined) return { amount: null, source: '没配 field_map.amount 且表单顶层没有 amount/number/formula 型字段（明细表子行不算）' }
    const n = toAmount(w.value)
    return n === null
      ? { amount: null, source: `启发式命中「${w.name}」（${w.type}）但值读不出数字` }
      : { amount: n, source: `启发式 ${w.type}「${w.name}」` }
  }

  private pickReason(widgets: Widget[], rule: PostingRule): string {
    const mapped = rule.field_map.reason
    if (mapped !== undefined) {
      // 与金额不同口径（有意）：事由只是备注文案，映射落空退启发式，不为它拦下整笔落账
      const w = findWidget(widgets, mapped)
      if (w !== undefined && typeof w.value === 'string') return w.value.trim()
    }
    const w = widgets.find((x) => REASON_HINT.test(x.name) && typeof x.value === 'string' && x.value.trim() !== '')
    return w === undefined ? '' : (w.value as string).trim()
  }

  /** 申请人：名册 open_id → 平台绑定 username → 原样 open_id（两头都对不上就亮 open_id，
   *  不编名字）。 */
  private async applicantName(openId: string | undefined): Promise<string> {
    if (openId === undefined || openId === '') return '（审批单没带申请人）'
    const emp = this.db.prepare('SELECT name FROM finance_employees WHERE open_id = ? AND archived_at IS NULL').get(openId) as
      | { name: string }
      | undefined
    if (emp !== undefined) return emp.name
    const ident = this.db
      .prepare('SELECT username FROM bridge_identities WHERE platform = ? AND platform_userid = ? AND allowed = 1')
      .get(this.opts.platform, openId) as { username: string } | undefined
    return ident?.username ?? openId
  }

  private async bossOpenId(): Promise<string | undefined> {
    const boss = this.rbac.bossUsername()
    if (boss === undefined) return undefined
    const row = this.db
      .prepare('SELECT platform_userid FROM bridge_identities WHERE platform = ? AND username = ? AND allowed = 1 ORDER BY created_at LIMIT 1')
      .get(this.opts.platform, boss) as { platform_userid: string } | undefined
    return row?.platform_userid
  }

  /** 老板没绑定时静默放弃（审计里有全量记录，同 feishu-approval notifyBoss 纪律）。 */
  private async notifyBoss(text: string): Promise<void> {
    const openId = await this.bossOpenId()
    if (openId === undefined) return
    await this.bridge.sendUserTo(this.opts.platform, openId, text)
  }
}

/** 实例表单 JSON → 扁平 widget 列表（含明细行里的子字段）。总价通常是独立字段；
 *  明细求和等真模板出现再做，不做没见过的形状。 */
export function parseWidgets(form: string | undefined): Widget[] {
  if (form === undefined || form.trim() === '') return []
  let raw: unknown
  try {
    raw = JSON.parse(form)
  } catch {
    return []
  }
  const out: Widget[] = []
  const walk = (node: unknown, depth: number): void => {
    if (!Array.isArray(node)) return
    for (const w of node) {
      if (typeof w !== 'object' || w === null) continue
      const x = w as Record<string, unknown>
      out.push({
        id: typeof x.id === 'string' ? x.id : '',
        customId: typeof x.custom_id === 'string' ? x.custom_id : '',
        name: typeof x.name === 'string' ? x.name : '',
        type: typeof x.type === 'string' ? x.type : '',
        value: x.value,
        depth,
      })
      if (Array.isArray(x.value)) for (const child of x.value) walk(child, depth + 1)
    }
  }
  walk(raw, 0)
  return out
}

function findWidget(widgets: Widget[], key: string): Widget | undefined {
  return widgets.find((w) => w.customId === key || w.id === key)
}

function toAmount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    try {
      return parseAmount(value, 'amount')
    } catch {
      return null
    }
  }
  return null
}

function localDateFromMs(ms: unknown): string {
  const n = typeof ms === 'string' || typeof ms === 'number' ? Number(ms) : NaN
  if (!Number.isFinite(n) || n <= 0) {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  const d = new Date(n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

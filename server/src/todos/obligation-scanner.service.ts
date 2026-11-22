/** 义务扫描与推送服务（2026-10-31 待办预警方案 P1/P3；同日二批加核实式完成）：每日定时全量扫描后端系统状态，
 *  把"时间驱动的义务"投影成 obligations（事件驱动的进场——审批到达等——仍走原实时链路，
 *  日扫是对账层，两者幂等去重）。职责：
 *  - 九个扫描器（§五 + 2026-11-01 生产域 v0 两枚 + v0.5 批次临期一枚）：合规征期 / 应收到期 / 应付到期 / 提案积压 /
 *    零角色账号 / 月度缺票 / 库存安全线 / 采购到货逾期 / 批次临期；
 *  - upsert 纪律：dedupe_key 幂等，重复扫描只刷新标题与到期口径（人改过到期/严重度的行不覆盖）；
 *    源头消失自动闭合（resolved）；
 *  - 核实式完成（completeDerived）：推导型按「已完成」= 现跑一遍该扫描器看源头还在不在——
 *    不在=resolved；还在=不关、恢复提醒；无法核实（征期）/强制确认=必填备注落 dismissed；
 *  - 逾期升级（P3）：到期未闭合 open→escalated，第 3/7 天阶梯重推，「暂不处理」静音该项推送
 *    （核实发现源头仍在时静音解除）；
 *  - 晨报双通道（§六）：个人晨报（我的+岗位池）+ 老板企业晨报（加昨日全员动作切片），
 *    每天一轮（默认 08:30，调度在 main.ts），防骚扰优先：无 warn/critical 项不打扰。
 *  诚实边界：征期日=常规 15 日推算（遇法定节假日顺延，以当年官方通知为准），不是权威征期表；
 *  扫描器只做提醒，不做申报、不做核算（persona 硬规则三）。 */
import type { DB } from '../db/database.js'
import { nowIso } from '../db/database.js'
import { config } from '../config.js'
import { BadRequestError } from '../errors.js'
import type { RbacService } from '../rbac/rbac.service.js'
import type { FinanceService } from '../finance/finance.service.js'
import type { FinanceInvoicesService } from '../finance/finance-invoices.service.js'
import type { FinanceProposalsService } from '../finance/finance-proposals.service.js'
import type { BridgeService } from '../bridge/bridge.service.js'
import type { SupplyService } from '../supply/supply.service.js'
import type { SupplyBitableService } from '../supply/supply-bitable.service.js'
import type { FinanceRosterService } from '../finance/finance-roster.service.js'
import { centsToYuan, localDate, localMonth } from '../finance/finance.util.js'
import { fmtQty } from '../supply/supply.types.js'
import { addDaysISO, TodosService } from './todos.service.js'
import type { CompleteResult, ObligationCandidate, ObligationRow, RecurringItem, RecurringMonth, ScannerDef, TodoCardView } from './todos.types.js'

/** source_type → 人话标签（卡片 note 与扫描器 label 共用）。 */
export const SOURCE_LABELS: Record<string, string> = {
  'scan.filing': '合规日历',
  'scan.receivable': '应收账款',
  'scan.payable': '应付账款',
  'scan.proposal_pending': '记账提案',
  'scan.zero_role_account': '账号治理',
  'scan.missing_invoice': '缺票清单',
  'scan.supply.below_safety': '库存安线',
  'scan.supply.po_overdue': '到货逾期',
  'scan.supply.expiry_near': '批次临期',
  // 不是扫描器：扫描前的多维表格自动同步；失败也记 scan_runs，晨报【扫描告警】按这个标签汇总
  'supply.bitable.presync': '多维表格预同步',
  'scan.payroll.roster': '名册与通讯录',
  'scan.payroll.social': '社保增减员',
  'scan.finance.profile': '建档参数',
  manual: '手工待办',
}

/** 扫描前自动同步在 scan_runs 里的名字（与扫描器同表留痕：机器动作的对账层）。 */
export const PRESYNC_KEY = 'supply.bitable.presync'
/** 自动同步的操作者：username '-' 与桥接/定时任务同款——不是人做的，不进「昨日全员」动作统计。 */
const PRESYNC_ACTOR = { username: '-', source: 'scan' }

/** filingDeadlinesOfMonth 的枚举面：scanFiling 按类限月份（社保仅当月、按月类仅当月+次月、季度类仅季度月×两年），全月历投影全开。 */
interface FilingClasses {
  cit?: boolean
  pitQ?: boolean
  social?: boolean
  vatMonthly?: boolean
  vatQuarterly?: boolean
  withholding?: boolean
}

/** filingDeadlinesOfMonth 的条目：临期窗口过滤（scanFiling）与全月历投影（recurringMonth）共用。 */
interface FilingDeadline {
  name: string
  due: string
  period: string
  dedupe: string
  channel: string
}

export interface ScannerRunResult {
  scanner: string
  label: string
  found: number
  created: number
  deduped: number
  autoResolved: number
  error?: string
  durationMs: number
  /** 路由开关 enabled=0：本轮没跑（scan_runs 不记行，路由配置页可见状态）。 */
  skipped?: true
}

/** 扫描前多维表格自动同步的结果（通道 B 没登记时整个字段不出现）。 */
export interface PresyncResult {
  /** 三类表拉到的记录数合计。 */
  fetched: number
  /** 落库新增+更新合计（表没变=0）。 */
  changed: number
  /** 任一类失败的人话原因（按类拼接）；成功时没有。本轮扫描照常跑，用库里现有读数。 */
  error?: string
  durationMs: number
}

export interface RunSummary {
  trigger: 'schedule' | 'startup' | 'manual'
  ranAt: string
  scanners: ScannerRunResult[]
  escalated: number
  repushed: number
  digest: 'sent' | 'already' | 'no-bridge' | 'skipped'
  presync?: PresyncResult
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** 采购到货扫描单轮行数上限（与 listPos 页长同量级）；超限整轮报错而不是截断。 */
const PO_SCAN_LIMIT = 500

/** 建档参数变化提醒（扫描器十二）盯的四项=征期扫描器据以排日历的那四项（filingDeadlinesOfMonth 读的）：
 *  改一项，税种/税率/申报周期跟着变，人得核对本期申报口径。快照存 app_meta，首轮只记基线。 */
const PROFILE_SNAPSHOT_KEY = 'finance.profile_snapshot'
const PROFILE_WATCHED_KEYS = ['主体类型', '纳税人身份', '征收方式', '纳税期限'] as const
const PROFILE_KEY_HINTS: Record<string, string> = {
  主体类型: '个体户与公司不同：个体户交经营所得个税（季预缴），公司交企业所得税（季预缴+年度汇算）。',
  纳税人身份: '小规模与一般纳税人不同：增值税税率、进项能否抵扣、按季还是按月申报都变。',
  征收方式: '查账与核定不同：核定按核定额/率交、查账按实际利润交；定期定额的个体户不出季度预缴提醒。',
  纳税期限: '小规模增值税默认按季，备案为按月申报后每月 15 日都有征期。',
}

/** sourceRef 的身份字段：判定"同一条源头换了口径"用（到期日/金额这类口径字段不算身份）。
 *  itemId/poId（2026-11-01 生产域）：物料/采购单行主键——快照补数换仓、采购单改承诺日都算同源换口径。
 *  batchNo（2026-11-01 S5）：批次三元组（物料+仓库+批次）——同批次补数/改效期算同源换口径，
 *  换批次=另一条义务（旧批次处置完闭合、新批次自己的行进场）。 */
const SOURCE_IDENTITY_KEYS = ['entryId', 'proposalId', 'username', 'month', 'itemId', 'poId', 'batchNo', 'employeeId', 'openId'] as const

function sameSourceIdentity(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  // 采购单行主键在场时只认它：同一物料会有多张单，itemId 在这类 ref 里是父级属性不是身份——
  // 否则 A 单改期后核实会被同物料 B 单的候选冒认（并进 B 的键、拿 B 的标题对人说话）
  if (a.poId !== undefined || b.poId !== undefined) return a.poId !== undefined && a.poId === b.poId
  // 批次三元组在场时只认三元组：同物料的安线条目（ref 只有 itemId）不能冒认批次条目
  if (a.batchNo !== undefined || b.batchNo !== undefined) {
    return (
      a.batchNo !== undefined && b.batchNo !== undefined && a.itemId === b.itemId && a.warehouse === b.warehouse && a.batchNo === b.batchNo
    )
  }
  return SOURCE_IDENTITY_KEYS.some((k) => a[k] !== undefined && a[k] === b[k])
}

function diffDays(fromYmd: string, toYmd: string): number {
  const [fy, fm, fd] = fromYmd.split('-').map(Number) as [number, number, number]
  const [ty, tm, td] = toYmd.split('-').map(Number) as [number, number, number]
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000)
}

export class ObligationScannerService {
  private readonly scanners: ScannerDef[]
  /** 重入锁：定时/启动补跑/REST 手动三路可能撞轮；同一轮进行中再触发直接共用结果，
   *  避免两路都过完 existing 检查后 INSERT 撞 dedupe_key UNIQUE 把整轮打断。 */
  private inFlight: Promise<RunSummary> | undefined

  constructor(
    private readonly db: DB,
    private readonly rbac: RbacService,
    private readonly finance: FinanceService,
    private readonly invoices: FinanceInvoicesService,
    private readonly proposals: FinanceProposalsService,
    private readonly bridge: BridgeService,
    private readonly todos: TodosService,
    private readonly supply: SupplyService,
    private readonly roster: FinanceRosterService,
    /** 通道 B（可缺省：单测直接 new 不接）：扫描前自动拉一次多维表格，让扫描基于最新读数。 */
    private readonly bitable?: SupplyBitableService,
  ) {
    this.scanners = [
      // 合规征期：系统无从得知"已申报/已缴"，只靠人填备注确认完成关闭——不随窗口滑出自动闭合
      { key: 'scan.filing', label: SOURCE_LABELS['scan.filing']!, scan: (n) => this.scanFiling(n), closeOnAbsence: false },
      { key: 'scan.receivable', label: SOURCE_LABELS['scan.receivable']!, scan: (n) => this.scanArAp('income', n) },
      { key: 'scan.payable', label: SOURCE_LABELS['scan.payable']!, scan: (n) => this.scanArAp('expense', n) },
      { key: 'scan.proposal_pending', label: SOURCE_LABELS['scan.proposal_pending']!, scan: (n) => this.scanProposalPending(n) },
      { key: 'scan.zero_role_account', label: SOURCE_LABELS['scan.zero_role_account']!, scan: (n) => this.scanZeroRole(n) },
      { key: 'scan.missing_invoice', label: SOURCE_LABELS['scan.missing_invoice']!, scan: (n) => this.scanMissingInvoice(n) },
      // 库存安全线 / 采购到货逾期（2026-11-01 生产域 v0，scan.supply.* 自域前缀；mes.* 留外部 MES 适配器）：
      // 源头都在自家表里（补货/收货=数据变化，系统查得到），缺席=真的处理完——用缺省 closeOnAbsence=true
      { key: 'scan.supply.below_safety', label: SOURCE_LABELS['scan.supply.below_safety']!, scan: (n) => this.scanSupplyBelowSafety(n) },
      { key: 'scan.supply.po_overdue', label: SOURCE_LABELS['scan.supply.po_overdue']!, scan: (n) => this.scanSupplyPoOverdue(n) },
      // 批次临期（2026-11-01 S5）：效期 ≤ 今天+临期窗口进场，过期 critical；窗口是域设置（缺省 90 天，GET/PUT /api/supply/settings）
      { key: 'scan.supply.expiry_near', label: SOURCE_LABELS['scan.supply.expiry_near']!, scan: (n) => this.scanSupplyExpiryNear(n) },
      // 名册与通讯录差异 / 社保增减员（2026-11-02 财务线残余 A4/A5）：前者源头在平台+名册，缺席即闭合；
      // 后者办没办只有人知道（closeOnAbsence=false），与征期同款只靠人确认完成
      { key: 'scan.payroll.roster', label: SOURCE_LABELS['scan.payroll.roster']!, scan: (n) => this.scanPayrollRoster(n) },
      { key: 'scan.payroll.social', label: SOURCE_LABELS['scan.payroll.social']!, scan: (n) => this.scanPayrollSocial(n), closeOnAbsence: false },
      // 建档参数变化（2026-11-02 财务线残余 A6 最小版）：看没看核对没核对只有人知道，同款只靠人确认完成
      { key: 'scan.finance.profile', label: SOURCE_LABELS['scan.finance.profile']!, scan: (n) => this.scanFinanceProfile(n), closeOnAbsence: false },
    ]
    this.todos.knownSourceTypes = this.scanners.map((s) => s.key)
    // 人工待办"新指派"即时卡（§六）：建待办的写入口在 TodosService，推送通道在这里，用钩子接上避免循环依赖
    this.todos.onCreated = (row, actor) => this.notifyManualCreated(row, actor)
  }

  /** 全量扫一轮。trigger=startup（启动对账）/ schedule（每日定时）/ manual（REST 手动）。
   *  扫描本身幂等可重入；晨报每天只发一轮（app_meta 标记，启动补跑不会重发）。 */
  runAll(trigger: RunSummary['trigger'], now = new Date()): Promise<RunSummary> {
    if (this.inFlight !== undefined) return this.inFlight
    this.inFlight = this.runAllInner(trigger, now).finally(() => {
      this.inFlight = undefined
    })
    return this.inFlight
  }

  private async runAllInner(trigger: RunSummary['trigger'], now: Date): Promise<RunSummary> {
    // 先拉后扫（2026-11-02）：扫描基于旧数是全图 §0.5「拉」列的失败模式——拉到旧数/静默失败都要大声
    const presync = await this.presyncBitable(now)
    const results: ScannerRunResult[] = []
    for (const def of this.scanners) {
      if (!this.routeEnabled(def.key)) {
        results.push({ scanner: def.key, label: def.label, found: 0, created: 0, deduped: 0, autoResolved: 0, durationMs: 0, skipped: true })
        continue
      }
      results.push(await this.runScanner(def, now))
    }
    const { escalated, repushed } = await this.escalateOverdue(now)
    const digest = trigger === 'manual' ? 'skipped' : await this.pushDigestIfDue(now)
    return { trigger, ranAt: nowIso(), scanners: results, escalated, repushed, digest, ...(presync !== undefined ? { presync } : {}) }
  }

  /** 扫描前先同步多维表格（通道 B 登记了才跑，只拉登记了 table_id 的类；对飞书只读，真落库不是试跑）。
   *  失败不打断扫描（用库里现有读数总比不扫强），但必须留痕：写 scan_runs 一行（errors 非空），
   *  晨报【扫描告警】近 3 天汇总会把它亮出来——预警系统自己拉不到数必须有人知道。 */
  private async presyncBitable(now: Date): Promise<PresyncResult | undefined> {
    const kinds = this.bitable?.configuredKinds() ?? []
    if (this.bitable === undefined || kinds.length === 0) return undefined
    const t0 = Date.now()
    let fetched = 0
    let changed = 0
    let error = ''
    try {
      const { results } = await this.bitable.sync(PRESYNC_ACTOR, { kinds }, now)
      for (const r of results) {
        fetched += r.fetched
        changed += (r.created ?? 0) + (r.updated ?? 0)
      }
      const failed = results.filter((r) => r.error !== undefined)
      if (failed.length > 0) error = failed.map((r) => `${r.kindLabel}：${r.error}`).join('；')
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
    const durationMs = Date.now() - t0
    this.db
      .prepare(
        `INSERT INTO scan_runs (scanner, ran_at, found, created, deduped, auto_resolved, errors, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(PRESYNC_KEY, nowIso(), fetched, changed, 0, 0, error.slice(0, 500), durationMs)
    return { fetched, changed, ...(error !== '' ? { error } : {}), durationMs }
  }

  // ---------- 单扫描器执行与落库 ----------

  private async runScanner(def: ScannerDef, now: Date): Promise<ScannerRunResult> {
    const t0 = Date.now()
    const today = localDate(now)
    let candidates: ObligationCandidate[] = []
    let error: string | undefined
    try {
      candidates = await def.scan(now)
    } catch (e) {
      error = (e instanceof Error ? e.message : String(e)).slice(0, 500)
    }
    let found = candidates.length
    let created = 0
    let deduped = 0
    let autoResolved = 0
    if (error === undefined) {
      const route = this.routeFor(def.key)
      const existing = this.db
        .prepare('SELECT id, status, dedupe_key, user_edited FROM obligations WHERE source_type = ?')
        .all(def.key) as { id: number; status: string; dedupe_key: string; user_edited: number }[]
      const byKey = new Map(existing.map((r) => [r.dedupe_key, r]))
      const seenKeys: string[] = []
      for (const c of candidates) {
        seenKeys.push(c.dedupeKey)
        const prev = byKey.get(c.dedupeKey)
        if (prev !== undefined) {
          // 已闭合行源头重现（典型=应收又变回未清）：重开为新活跃行——静默/强制确认（dismissed）是
          // 人给过的"别再报"，不翻案；resolved/done 只是当时源头消失了，现在回来了就得重见。
          // 重开=新一次发生：人上次改过的到期/严重度与完成备注一并清掉，回到扫描器口径
          if (prev.status === 'resolved' || prev.status === 'done') {
            this.db
              .prepare(
                `UPDATE obligations SET status = 'open', resolved_at = NULL, done_at = NULL, done_by = '', done_note = '', user_edited = 0,
                   title = ?, detail = ?, severity = ?, due_date = ?, source_ref = ? WHERE id = ?`,
              )
              .run(c.title, c.detail, c.severity, c.dueDate ?? '', JSON.stringify(c.sourceRef ?? {}), prev.id)
            created++
            if (c.severity !== 'info') {
              const row = this.db.prepare('SELECT * FROM obligations WHERE id = ?').get(prev.id) as ObligationRow
              await this.notifyRow(row, `new:${today}`, now)
            }
          } else {
            deduped++
            // 幂等刷新：口径变了（剩余金额/缺票数/到期日——进键的除外）照搬到活跃行，静默行不动
            if (prev.status === 'open' || prev.status === 'escalated') {
              this.refreshFromCandidate(prev.id, c, prev.user_edited === 1)
            }
          }
          continue
        }
        const ts = nowIso()
        const r = this.db
          .prepare(
            `INSERT INTO obligations
               (source_type, source_ref, dedupe_key, title, detail, owner_type, owner_id, due_date,
                severity, status, origin, first_seen_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 'scan', ?, ?)`,
          )
          .run(
            c.sourceType,
            JSON.stringify(c.sourceRef ?? {}),
            c.dedupeKey,
            c.title,
            c.detail,
            route.owner_type,
            route.owner_id,
            c.dueDate ?? '',
            c.severity,
            ts,
            ts,
          )
        created++
        // 状态跃迁即时卡（§六）：warn/critical 进场就推，info 只进待办中心
        if (c.severity !== 'info') {
          const row = this.db.prepare('SELECT * FROM obligations WHERE id = ?').get(r.lastInsertRowid) as ObligationRow
          await this.notifyRow(row, `new:${today}`, now)
        }
      }
      // 源头消失自动闭合：该扫描器本轮没再看到的活跃行 → resolved（dedupe 含 due_date，
      // 账期改动=旧键消失新键进场，旧行自动闭合不残留）。closeOnAbsence=false 的来源
      // （征期）跳过——系统不知道"办没办"，缺席不等于办完，只能人填备注确认完成
      if (def.closeOnAbsence !== false) {
        const activeRows = existing.filter((r) => r.status === 'open' || r.status === 'escalated')
        const gone = activeRows.filter((r) => !seenKeys.includes(r.dedupe_key))
        if (gone.length > 0) {
          const upd = this.db.prepare("UPDATE obligations SET status = 'resolved', resolved_at = ? WHERE id = ?")
          for (const g of gone) upd.run(nowIso(), g.id)
        }
        autoResolved = gone.length
      }
    }
    this.db
      .prepare(
        `INSERT INTO scan_runs (scanner, ran_at, found, created, deduped, auto_resolved, errors, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(def.key, nowIso(), found, created, deduped, autoResolved, error ?? '', Date.now() - t0)
    return {
      scanner: def.key,
      label: def.label,
      found,
      created,
      deduped,
      autoResolved,
      error,
      durationMs: Date.now() - t0,
    }
  }

  private routeFor(sourceType: string): { owner_type: 'user' | 'role'; owner_id: string } {
    const row = this.db.prepare('SELECT owner_type, owner_id FROM obligation_routes WHERE source_type = ?').get(sourceType) as
      | { owner_type: 'user' | 'role'; owner_id: string }
      | undefined
    if (row !== undefined) return row
    return { owner_type: 'user', owner_id: this.rbac.bossUsername() ?? 'boss' }
  }

  /** 路由开关：没配置默认开（配置只做"企业落地数据"，机制在代码里）。 */
  private routeEnabled(sourceType: string): boolean {
    const row = this.db.prepare('SELECT enabled FROM obligation_routes WHERE source_type = ?').get(sourceType) as
      | { enabled: number }
      | undefined
    return row === undefined || row.enabled === 1
  }

  /** 活跃行按最新候选刷新：标题/说明/深链永远跟源头走；到期/严重度是人可改的三项之二，
   *  改过（user_edited）就不覆盖——否则人刚延期一天，下一轮扫描又给拨回去。 */
  private refreshFromCandidate(id: number, c: ObligationCandidate, userEdited: boolean): void {
    if (userEdited) {
      this.db
        .prepare('UPDATE obligations SET title = ?, detail = ?, source_ref = ? WHERE id = ?')
        .run(c.title, c.detail, JSON.stringify(c.sourceRef ?? {}), id)
      return
    }
    this.db
      .prepare('UPDATE obligations SET title = ?, detail = ?, severity = ?, due_date = ?, source_ref = ? WHERE id = ?')
      .run(c.title, c.detail, c.severity, c.dueDate ?? '', JSON.stringify(c.sourceRef ?? {}), id)
  }

  // ---------- 核实式完成（二批：推导型「已完成」） ----------

  /** 核实一条推导型待办的源头现状：现跑一遍它所属的扫描器，看同一 dedupe_key 还在不在候选里。
   *  present=还在（顺手把最新口径刷到行上）；gone=候选里整类消失（真处理完）；
   *  merged=键不在但同身份的源头换了口径（典型=账目改期，钱还欠着）——把本条并进新口径继续跟，不闭合；
   *  unverifiable=这类事系统无从得知办没办（征期 closeOnAbsence=false），或扫描器本身出错。
   *  身份匹配是必须的：dedupe_key 含 due_date，账期一改键就换——只按键判"处理完"会把没收回的款谎报成已核实。 */
  private async verifyRow(row: ObligationRow, now: Date): Promise<{
    message: string
    moved?: ObligationCandidate
    state: 'gone' | 'merged' | 'present' | 'unverifiable'
  }> {
    const def = this.scanners.find((s) => s.key === row.source_type)
    if (def === undefined) {
      return { state: 'unverifiable', message: `系统里已没有「${row.source_type}」这类扫描器，无法核实源头。确认已办请填备注提交。` }
    }
    if (def.closeOnAbsence === false) {
      return {
        state: 'unverifiable',
        message: `${def.label}的事项是否已办（申报/缴费发生在系统外），系统无从核实。确认已办请填备注（如"已在电子税务局申报"）提交。`,
      }
    }
    let candidates: ObligationCandidate[]
    try {
      candidates = await def.scan(now)
    } catch (e) {
      const reason = (e instanceof Error ? e.message : String(e)).slice(0, 120)
      return { state: 'unverifiable', message: `核实源头时出错（${reason}），暂时无法确认。确认已办请填备注提交。` }
    }
    const hit = candidates.find((c) => c.dedupeKey === row.dedupe_key)
    if (hit !== undefined) {
      this.refreshFromCandidate(row.id, hit, row.user_edited === 1)
      return {
        state: 'present',
        message: `核实结果：源头还在——${hit.title}。这条暂不能标记完成，已恢复提醒；如确认已在系统外处理完（例如收了现金没记账），请填备注强制确认完成。`,
      }
    }
    // 键不在候选 ≠ 办完了：dedupe_key 含口径（典型=到期日），源头被改口径键就换——先按身份字段找同源
    let rowRef: Record<string, unknown> = {}
    try {
      rowRef = JSON.parse(row.source_ref) as Record<string, unknown>
    } catch {
      rowRef = {}
    }
    const moved = candidates.find((c) => sameSourceIdentity(c.sourceRef, rowRef))
    if (moved === undefined) {
      return {
        state: 'gone',
        message: `已核实：${def.label}里这条源头已不在预警清单——已处理完，或口径改期到了以后（到新到期日会再提醒）。待办闭合。`,
      }
    }
    const conflict = this.db
      .prepare('SELECT id, status FROM obligations WHERE dedupe_key = ? AND id != ?')
      .get(moved.dedupeKey, row.id) as { id: number; status: string } | undefined
    if (conflict !== undefined) {
      // 新口径已有自己的行（不管活跃还是历史）：本条闭合并入，如实说明"不是处理完"
      return {
        state: 'merged',
        message: `核实结果：这笔源头还在，但口径已被改动（${moved.title}）——待办中心已有按新口径在跟的一条，本条闭合并入（不是处理完）。`,
      }
    }
    // 并进新口径：换 dedupe_key + 按最新候选刷新（人改过的到期/严重度仍不覆盖），继续跟这一条
    this.db.prepare('UPDATE obligations SET dedupe_key = ? WHERE id = ?').run(moved.dedupeKey, row.id)
    this.refreshFromCandidate(row.id, moved, row.user_edited === 1)
    return {
      state: 'present',
      moved,
      message: `核实结果：这笔源头还在，口径有变化（${moved.title}），已并入本条继续跟进。确认已处理完请先到源头核对；如确实已在系统外处理完，请填备注强制确认完成。`,
    }
  }

  /** 推导型「已完成」（controller POST :id/done 对 origin=scan 的行走这里）：
   *  1. 先核实源头：没了→resolved（记谁按的+备注）；同源换了口径→并进口径继续跟（pending 告知）；
   *     新口径另有行在跟→本条闭合并入（resolved，如实说明不是处理完）；
   *  2. 还在→不关，清掉「暂不处理」的静音让提醒恢复，把现状告诉人（outcome=pending）；
   *  3. 无法核实→告诉人要备注（outcome=unverifiable）；
   *  4. force=true（人坚持已完成）：仍先核实——源头真没了照样 resolved；否则必填备注落 dismissed
   *     （永久，源头重现不再建），审计 forced=true。
   *  可见性/活跃态守卫沿用 TodosService（不可见=404，已关闭=400）。 */
  async completeDerived(actor: string, rawId: unknown, opts: { note?: unknown; force?: boolean }, now = new Date()): Promise<CompleteResult> {
    const row = this.todos.getVisible(actor, rawId)
    if (row.origin !== 'scan') throw new BadRequestError('只有系统推导的待办才走核实流程。')
    this.todos.requireActive(row)
    const v = await this.verifyRow(row, now)
    if (v.state === 'gone') {
      return { outcome: 'resolved', message: v.message, item: this.todos.resolveVerified(actor, row.id, opts.note) }
    }
    if (v.state === 'merged') {
      return { outcome: 'resolved', message: v.message, item: this.todos.resolveVerified(actor, row.id) }
    }
    if (opts.force === true) {
      return { outcome: 'forced', item: this.todos.dismiss(actor, row.id, opts.note, true) }
    }
    if (v.state === 'present') {
      this.todos.resumeReminders(row.id)
      return { outcome: 'pending', message: v.message, item: this.todos.getVisible(actor, row.id) }
    }
    return { outcome: 'unverifiable', message: v.message, item: row }
  }

  // ---------- 扫描器一：合规征期 ----------

  private scanFiling(now: Date): ObligationCandidate[] {
    const today = localDate(now)
    // 窗口=进场口径：提前 7 天预告，到期后 60 天内持续刷新"已逾期"。滑出窗口的行不会被闭合
    // （closeOnAbsence=false），只是不再刷新——到期未办的义务一直在场直到人填备注确认完成
    const window = (due: string): boolean => due >= addDaysISO(today, -60) && due <= addDaysISO(today, 7)
    const critBefore = addDaysISO(today, 3)
    const y = now.getFullYear()
    const m = now.getMonth() + 1
    // 枚举面按类给出、与旧扫描逐类一致（过去月份不重推，逾期噪音口径不变）：
    // 增值税按月/个税代扣=本月+次月；季度类=今明两年的季度月；社保=仅本月。全月历投影（recurringMonth）不在此约束内。
    const cur = `${y}-${pad2(m)}`
    const nxt = m === 12 ? `${y + 1}-01` : `${y}-${pad2(m + 1)}`
    const quarters = [1, 4, 7, 10].flatMap((mm) => [`${y}-${pad2(mm)}`, `${y + 1}-${pad2(mm)}`])
    const out: ObligationCandidate[] = []
    const emit = (ym: string, classes: FilingClasses): void => {
      const [yy, mm] = ym.split('-').map(Number) as [number, number]
      for (const d of this.filingDeadlinesOfMonth(yy, mm, classes)) {
        if (!window(d.due)) continue
        out.push({
          sourceType: 'scan.filing',
          dedupeKey: d.dedupe,
          title: `${d.name}（${d.period}）${d.due < today ? '已逾期' : `${d.due} 截止`}`,
          detail: `常规征期 ${d.due}（15 日规则推算，遇法定节假日顺延，以当年官方"申报纳税期限通知"为准）。申报渠道：${d.channel}。数字备料见财务「征期数据包」。申报/缴费完成后系统不会自动知道：请在待办中心点「已完成」并填备注（如"已申报"）确认关闭本条。`,
          sourceRef: { due: d.due, period: d.period },
          dueDate: d.due,
          severity: d.due <= critBefore ? ('critical' as const) : ('warn' as const),
        })
      }
    }
    const monthlyClasses = (ym: string): FilingClasses => ({
      vatMonthly: true,
      vatQuarterly: false, // 季度类只走 quarters 循环（已覆盖今明两年全部季度月）：这里再开会同轮同键重复、撞 UNIQUE 崩轮
      withholding: true,
      cit: false,
      pitQ: false,
      social: ym === cur, // 社保只枚举当月：过去月份不重推（旧口径）
    })
    for (const ym of [cur, nxt]) emit(ym, monthlyClasses(ym))
    for (const ym of quarters) emit(ym, { vatMonthly: false, vatQuarterly: true, withholding: false, cit: true, pitQ: true, social: false })
    return out
  }

  /** 某月到期的全部常规征期（15 日规则推算）：scanFiling 的临期窗口过滤与 recurringMonth 的
   *  全月历投影共用这一份枚举——口径漂移在这里必然同时可见。身份分支与 finance-filing 一致；
   *  classes 是枚举面开关（scanFiling 按类限月份，全月历投影全开），不传=全开。 */
  private filingDeadlinesOfMonth(dueYear: number, dueMonth: number, classes: FilingClasses = {}): FilingDeadline[] {
    const ETAX = '宁波市电子税务局 etax.ningbo.chinatax.gov.cn'
    const profile = this.finance.profileGet().profile
    const entity = (profile['主体类型'] ?? '').trim()
    const taxpayer = (profile['纳税人身份'] ?? '').trim()
    const method = (profile['征收方式'] ?? '').trim()
    const taxPeriod = (profile['纳税期限'] ?? '').trim()
    const { cit = true, pitQ = true, social = true, vatMonthly = true, vatQuarterly = true, withholding = true } = classes
    const mm = dueMonth
    const due15 = `${dueYear}-${pad2(mm)}-15`
    const prev = mm === 1 ? { y: dueYear - 1, m: 12 } : { y: dueYear, m: mm - 1 }
    const prevLabel = `${prev.y} 年 ${prev.m} 月`
    const isQuarterMonth = [1, 4, 7, 10].includes(mm)
    const q = mm === 1 ? { y: dueYear - 1, q: 4 } : { y: dueYear, q: Math.ceil(mm / 3) - 1 }
    const qLabel = `${q.y} 年第 ${q.q} 季度`
    const out: FilingDeadline[] = []
    // 增值税：小规模默认按季；档案「纳税期限=按月申报」才按月；一般纳税人按月；身份没填不猜
    if (taxpayer.includes('小规模')) {
      if (taxPeriod.includes('月')) {
        if (vatMonthly) out.push({ name: '增值税及附加申报（小规模按月，档案备案）', due: due15, period: prevLabel, dedupe: `scan.filing:vat-m:${due15}`, channel: ETAX })
      } else if (isQuarterMonth && vatQuarterly) {
        out.push({ name: '增值税及附加申报（小规模按季）', due: due15, period: qLabel, dedupe: `scan.filing:vat-q:${due15}`, channel: ETAX })
      }
    } else if (taxpayer.includes('一般')) {
      if (vatMonthly) out.push({ name: '增值税及附加申报（一般纳税人按月）', due: due15, period: prevLabel, dedupe: `scan.filing:vat-m:${due15}`, channel: ETAX })
    }
    // 企业所得税季度预缴（公司）；个体户经营所得个税季预缴（个体 + 查账/核定非定期定额）
    if (entity.includes('公司') && isQuarterMonth && cit) {
      out.push({ name: '企业所得税季度预缴', due: due15, period: qLabel, dedupe: `scan.filing:cit:${due15}`, channel: ETAX })
    }
    if (entity.includes('个体') && !method.includes('定期定额') && isQuarterMonth && pitQ) {
      out.push({ name: '个体户经营所得个税季预缴', due: due15, period: qLabel, dedupe: `scan.filing:pit-q:${due15}`, channel: ETAX })
    }
    // 个税代扣代缴（次月 15 日）：报上个月工资——上一月有工资记录才列（与 scanFiling 同一口径）
    if (withholding && this.payrollOfMonth(`${prev.y}-${pad2(prev.m)}`) > 0) {
      out.push({ name: '个税代扣代缴（工资）', due: due15, period: prevLabel, dedupe: `scan.filing:withholding:${prev.y}-${pad2(prev.m)}`, channel: '自然人电子税务局（扣缴端）' })
    }
    // 社保公积金月度缴纳：当月申报当月缴，常规按 15 日推算
    if (social) out.push({ name: '社保公积金月度缴纳', due: due15, period: `${dueYear} 年 ${mm} 月`, dedupe: `scan.filing:social:${dueYear}-${pad2(mm)}`, channel: '电子税务局社保费模块 / 12333' })
    return out
  }

  private payrollOfMonth(month: string): number {
    return (
      this.db
        .prepare(
          `SELECT COALESCE(SUM(CASE WHEN reverses = '' THEN amount_cents ELSE -amount_cents END), 0) AS s
           FROM finance_entries
           WHERE type = 'payroll' AND deleted_at IS NULL AND status != 'cancelled' AND substr(date, 1, 7) = ?`,
        )
        .get(month) as { s: number }
    ).s
  }

  /** 全月历投影（2026-11-01 用户定稿：企业每月固定事项整月显示）：某月全部常规征期，
   *  不做临期窗口过滤——提早=提示，当天/已逾期=预警，进临期窗口才由扫描生成正式待办。
   *  已有同 dedupe_key 义务行的不重复列（活跃项日历上另有真待办；已闭合=人确认办过）。 */
  recurringMonth(month: string, today: string = localDate(new Date())): RecurringMonth {
    const match = /^(\d{4})-(\d{2})$/.exec(month)
    if (!match || Number(match[2]!) < 1 || Number(match[2]!) > 12) throw new BadRequestError('month 格式应为 YYYY-MM。')
    const deadlines = this.filingDeadlinesOfMonth(Number(match[1]!), Number(match[2]!))
    const critBefore = addDaysISO(today, 3)
    const existing = new Set<string>(
      deadlines.length === 0
        ? []
        : (
            this.db
              .prepare(`SELECT dedupe_key FROM obligations WHERE dedupe_key IN (${deadlines.map(() => '?').join(',')})`)
              .all(...deadlines.map((d) => d.dedupe)) as { dedupe_key: string }[]
          ).map((r) => r.dedupe_key),
    )
    const items: RecurringItem[] = deadlines
      .filter((d) => !existing.has(d.dedupe))
      .map((d) => ({
        key: d.dedupe,
        title: `${d.name}（${d.period}）`,
        due: d.due,
        channel: d.channel,
        phase: d.due > today ? ('early' as const) : d.due === today ? ('today' as const) : ('overdue' as const),
        severity: d.due <= critBefore ? ('critical' as const) : ('warn' as const),
      }))
    items.sort((a, b) => a.due.localeCompare(b.due) || a.key.localeCompare(b.key))
    return { month, items }
  }

  // ---------- 扫描器二/三：应收 / 应付到期 ----------
  private scanArAp(kind: 'income' | 'expense', now: Date): ObligationCandidate[] {
    const today = localDate(now)
    // 只设"未来预告"上限（3 天）；过期不设下限——仍未结清就一直在场，候选缺席才真的等于"付掉/作废/冲销了"
    const to = addDaysISO(today, 3)
    const rows = this.db
      .prepare(
        `SELECT id, due_date, counterparty, amount_cents - paid_amount_cents AS remaining_cents
         FROM finance_entries
         WHERE type = ? AND deleted_at IS NULL AND status IN ('unpaid', 'partial')
           AND reverses = '' AND reversed_by = '' AND due_date != ''
           AND due_date <= ?`,
      )
      .all(kind, to) as { id: string; due_date: string; counterparty: string; remaining_cents: number }[]
    const label = kind === 'income' ? '应收到期' : '应付到期'
    const sourceType = kind === 'income' ? 'scan.receivable' : 'scan.payable'
    return rows
      .filter((r) => r.remaining_cents > 0)
      .map((r) => {
        const yuan = centsToYuan(r.remaining_cents)
        const overdue = r.due_date < today
        const who = r.counterparty === '' ? '未填对方' : r.counterparty
        return {
          sourceType,
          dedupeKey: `${sourceType}:${r.id}:${r.due_date}`,
          title: `${label}：${who} ${yuan} 元${overdue ? '（已逾期）' : ''}`,
          detail: `到期日 ${r.due_date}，剩余 ${yuan} 元（编号 ${r.id}）。源头处理：收款/付款核销后本条自动闭合。`,
          sourceRef: { entryId: r.id, dueDate: r.due_date, remainingYuan: yuan },
          dueDate: r.due_date,
          severity: overdue ? ('critical' as const) : ('warn' as const),
        }
      })
  }

  // ---------- 扫描器四：提案积压 ----------

  private scanProposalPending(now: Date): ObligationCandidate[] {
    const cutoff = new Date(now.getTime() - 24 * 3600 * 1000).toISOString()
    return this.proposals
      .list('pending')
      .proposals.filter((p) => p.created_at <= cutoff)
      .map((p) => ({
        sourceType: 'scan.proposal_pending',
        dedupeKey: `scan.proposal_pending:${p.id}`,
        title: `记账提案 ${p.id} 待确认超过 24 小时`,
        detail: p.summary,
        sourceRef: { proposalId: p.id, createdAt: p.created_at },
        severity: 'warn' as const,
      }))
  }

  // ---------- 扫描器五：零角色账号 ----------

  private scanZeroRole(_now: Date): ObligationCandidate[] {
    const rows = this.db
      .prepare(
        `SELECT username FROM users u
         WHERE u.is_service = 0 AND u.disabled_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id)`,
      )
      .all() as { username: string }[]
    return rows.map((r) => ({
      sourceType: 'scan.zero_role_account',
      dedupeKey: `scan.zero_role_account:${r.username}`,
      title: `账号 ${r.username} 没有任何角色`,
      detail: '这个账号登录后什么都做不了：到管理后台「系统权限」给它配角色，或停用账号后本条自动闭合。',
      sourceRef: { username: r.username },
      severity: 'warn' as const,
    }))
  }

  // ---------- 扫描器六：月度缺票 ----------

  private scanMissingInvoice(now: Date): ObligationCandidate[] {
    const month = localMonth(now)
    // limit 只裁返回行；真实笔数在 total（count 是本页条数，不能拿来当数字给人看）
    const r = this.invoices.listMissing({ month, limit: 1 })
    if (r.total === 0) return []
    return [
      {
        sourceType: 'scan.missing_invoice',
        dedupeKey: `scan.missing_invoice:${month}`,
        title: `${month} 有 ${r.total} 笔支出/报销缺票`,
        detail: '到财务「票夹 → 缺票清单」逐笔核对：挂上在手发票或补票。清单每天刷新，处理完自动闭合。',
        sourceRef: { month, count: r.total },
        severity: 'info',
      },
    ]
  }

  // ---------- 扫描器七：库存安全线（2026-11-01 生产域 v0） ----------

  /** 状态驱动的义务（无到期日）：物料全仓合计 < 安全线就在场（2026-11-01 用户拍板"按物料合计比"——
   *  分仓调拨不误报，真缺货才响）。dedupe_key 不含数量与仓库——数量变化只刷新标题（人看到的永远是
   *  最新读数），补到线上候选消失→自动闭合。合计≤0 视为 critical。 */
  private scanSupplyBelowSafety(_now: Date): ObligationCandidate[] {
    return this.supply.belowSafetyRows().map((r) => {
      const critical = r.total_milli <= 0
      return {
        sourceType: 'scan.supply.below_safety',
        dedupeKey: `scan.supply.below_safety:${r.item_id}`,
        title: `${r.name} 低于安全线：合计 ${fmtQty(r.total_milli)}${r.unit}（${r.warehouses}）/ 安全线 ${fmtQty(r.safety_milli)}${r.unit}`,
        detail: `物料编码 ${r.code}，各仓最新读数合计 ${fmtQty(r.total_milli)}（${r.warehouses}；快照 ${r.snapshot_date}），低于安全线 ${fmtQty(r.safety_milli)}。补货入库后重新导入库存快照，本条自动闭合。`,
        sourceRef: { itemId: r.item_id },
        severity: critical ? ('critical' as const) : ('warn' as const),
      }
    })
  }

  // ---------- 扫描器八：采购到货逾期（2026-11-01 生产域 v0） ----------

  /** 时间驱动的义务：未到货且承诺日 ≤ 今天+3 进场（与应收/应付同窗），过期 critical。
   *  dedupe_key 含承诺日——供应商改期=旧键消失新键进场（旧行自动闭合，不是假闭合：改期事实在自家表里）。
   *  收货/取消（采购台账改状态）→ 候选消失 → 自动闭合。 */
  private scanSupplyPoOverdue(now: Date): ObligationCandidate[] {
    const today = localDate(now)
    const opts = { status: 'open', promisedBy: addDaysISO(today, 3) } as const
    // 截断不是"少报几条"：没进候选的在场行会被 closeOnAbsence 当成消失而假闭合——超限整轮报错（scan_runs 留痕、老板晨报亮红），不出半截结果
    const total = this.supply.countPos(opts)
    if (total > PO_SCAN_LIMIT) {
      throw new Error(`未到货且 3 天内到期的采购单行有 ${total} 行，超过单轮扫描上限 ${PO_SCAN_LIMIT}：本轮不扫以免漏报/假闭合，请先收货/取消清理或联系管理员调高上限。`)
    }
    const rows = this.supply.listPos({ ...opts, limit: PO_SCAN_LIMIT })
    return rows.map((p) => {
      const overdue = p.promised_date < today
      return {
        sourceType: 'scan.supply.po_overdue',
        dedupeKey: `scan.supply.po_overdue:${p.id}:${p.promised_date}`,
        title: `采购单 ${p.po_no} ${overdue ? '到货已逾期' : `${p.promised_date} 到货`}：${p.name} ×${fmtQty(p.qty_milli)}${p.unit}`,
        detail: `供应商 ${p.supplier === '' ? '未填' : p.supplier}，物料编码 ${p.code}，承诺到货 ${p.promised_date}。收货或取消后本条自动闭合（采购台账改该行状态）。`,
        sourceRef: { poId: p.id, poNo: p.po_no, itemId: p.item_id },
        dueDate: p.promised_date,
        severity: overdue ? ('critical' as const) : ('warn' as const),
      }
    })
  }

  // ---------- 扫描器九：批次临期（2026-11-01 S5 批次/效期） ----------

  /** 时间驱动的义务：有批次号的最新读数、数量>0、效期 ≤ 今天+临期窗口（域设置 supply.settings.expiryWarnDays，缺省 90 天；v0.5 曾为常量 30）进场，已过期 critical。
   *  dedupe_key=物料+仓库+批次（不含效期）——效期改判（补录真实效期）算同源换口径刷标题；
   *  批次清零/删行后候选消失→自动闭合。 */
  private scanSupplyExpiryNear(now: Date): ObligationCandidate[] {
    const today = localDate(now)
    return this.supply.expiringRows(today).map((r) => {
      const expired = r.expiry_date < today
      return {
        sourceType: 'scan.supply.expiry_near',
        dedupeKey: `scan.supply.expiry_near:${r.item_id}:${r.warehouse}:${r.batch_no}`,
        title: `批次 ${r.batch_no} ${expired ? '已过期' : `${r.expiry_date} 到期`}：${r.name}（${r.warehouse}）×${fmtQty(r.qty_milli)}${r.unit}`,
        detail: `物料编码 ${r.code}，仓库「${r.warehouse}」批次 ${r.batch_no} 效期 ${r.expiry_date}${expired ? '（已过期，优先处置）' : `（还剩 ${diffDays(today, r.expiry_date)} 天）`}。批次用完/处置后重新导入库存快照（该批次数量更新），本条自动闭合。`,
        sourceRef: { itemId: r.item_id, warehouse: r.warehouse, batchNo: r.batch_no },
        dueDate: r.expiry_date,
        severity: expired ? ('critical' as const) : ('warn' as const),
      }
    })
  }

  // ---------- 扫描器十/十一：名册与通讯录差异 / 社保增减员（2026-11-02 财务线残余 A4/A5） ----------

  /** 通讯录 vs 名册（源头=平台+名册，缺席即闭合）：平台查无此人→核实离职；平台新面孔→建档；同名待绑定。
   *  每天一次平台读取（部门树+各部门成员），凭据/权限缺失时整轮报错不闭合旧行。 */
  private async scanPayrollRoster(_now: Date): Promise<ObligationCandidate[]> {
    // 凭据没配就别去撞网（测试环境/未接飞书的部署）：整轮报错、已有行不闭合，与平台读失败同口径
    if (config.feishuAppId === '' || config.feishuAppSecret === '') {
      throw new Error('飞书凭据未配置（ADMIN_FEISHU_APP_ID/SECRET），本轮不比对通讯录')
    }
    const diff = await this.roster.platformDiff({ username: 'system:scan', source: 'scan' })
    // 平台视图不完整（翻页/容量截断、根部门直属成员拉不到）时"查无此人"不可信：整轮报错不比对、不闭合
    // （审查 P2-1：吞掉这两个旗标会把根部门的人天天误判成已离职，旗标恢复又静默闭合，往返制造噪声）。
    // 长期拉不到根部门=应用缺通讯录权限：补权限，或在待办路由把本扫描器关掉
    const gaps = [
      ...(diff.truncated ? ['通讯录超出单轮读取上限被截断'] : []),
      ...(diff.rootMembers === 'unavailable' ? ['根部门直属成员拉不到（应用缺通讯录权限或平台拒绝）'] : []),
    ]
    if (gaps.length > 0) {
      throw new Error(`通讯录读取不完整：${gaps.join('；')}——本轮不比对，避免把这些人误判为已不在通讯录；长期如此请补应用权限或在待办路由关掉本扫描器`)
    }
    const out: ObligationCandidate[] = []
    for (const m of diff.missing) {
      out.push({
        sourceType: 'scan.payroll.roster',
        dedupeKey: `scan.payroll.roster:missing:${m.open_id}`,
        title: `${m.name} 已不在飞书通讯录：核实是否离职`,
        detail:
          '工资名册里这个人还在册（有工资参数）。离职→到「工资 › 名册」填离职日期（会另出社保减员提醒），出完最后一月工资单后归档；' +
          '换号/权限不可见→名册更新 open_id 或检查应用通讯录权限范围。通讯录重新出现或名册归档后本条自动闭合。',
        sourceRef: { employeeId: m.id, openId: m.open_id },
        severity: 'warn',
      })
    }
    for (const f of diff.fresh) {
      out.push({
        sourceType: 'scan.payroll.roster',
        dedupeKey: `scan.payroll.roster:new:${f.open_id}`,
        title: `新面孔 ${f.name}${f.department !== '' ? `（${f.department}）` : ''} 未进工资名册`,
        detail:
          '飞书通讯录有此人、工资名册没有：「工资 › 名册」点「从飞书同步」自动建档，再补默认应发/社保/专项附加；' +
          '若是新入职，填入职日期后会另出"入职 30 日内办社保增员"提醒。名册出现该 open_id 后本条自动闭合。',
        sourceRef: { openId: f.open_id },
        severity: 'warn',
      })
    }
    for (const b of diff.pendingBind) {
      out.push({
        sourceType: 'scan.payroll.roster',
        dedupeKey: `scan.payroll.roster:bind:${b.open_id}`,
        title: `${b.name} 疑似名册里的同名手工行：填 open_id 完成绑定`,
        detail: '平台有个同名的人，名册里那条是手工登记（没 open_id）；没有自动建第二条防双算工资。到名册编辑那个人、填上 open_id 即绑定，本条随之自动闭合。',
        sourceRef: { openId: b.open_id },
        severity: 'info',
      })
    }
    return out
  }

  /** 社保公积金增减员（源头=名册的入职/离职日期；办没办系统无从得知 → closeOnAbsence=false 只靠人确认完成）：
   *  离职→次月缴费节点前减员（常规 15 日推算，以社保局通知为准）；入职→30 日内增员。
   *  进场窗口：离职 90 天内、入职 60 天内；已归档的人不再进场（减员提醒在"办完→归档"后由人确认完成关闭）。 */
  private scanPayrollSocial(now: Date): ObligationCandidate[] {
    const today = localDate(now)
    const rows = this.db
      .prepare(`SELECT id, name, hire_date, leave_date FROM finance_employees WHERE archived_at IS NULL AND (leave_date != '' OR hire_date != '')`)
      .all() as { id: number; name: string; hire_date: string; leave_date: string }[]
    const out: ObligationCandidate[] = []
    for (const r of rows) {
      if (r.leave_date !== '' && r.leave_date >= addDaysISO(today, -90) && r.leave_date <= addDaysISO(today, 31)) {
        const [y, m] = r.leave_date.split('-').map(Number) as [number, number]
        const due = m === 12 ? `${y + 1}-01-15` : `${y}-${pad2(m + 1)}-15`
        out.push({
          sourceType: 'scan.payroll.social',
          dedupeKey: `scan.payroll.social:leave:${r.id}`,
          title: `${r.name} ${r.leave_date} 离职：办社保公积金减员 + 出最后一月工资单`,
          detail:
            `减员在离职次月缴费节点（常规 ${due}，以社保局/公积金中心通知为准）前办理，晚了多交一个月；` +
            '最后一月工资单在「工资」页生成确认；办完后把名册里这个人「归档」，再在这里填备注确认完成（系统无从得知社保局那边办没办）。',
          sourceRef: { employeeId: r.id },
          dueDate: due,
          severity: today > due ? 'critical' : 'warn',
        })
      }
      if (r.hire_date !== '' && r.hire_date >= addDaysISO(today, -60) && r.hire_date <= today) {
        const due = addDaysISO(r.hire_date, 30)
        out.push({
          sourceType: 'scan.payroll.social',
          dedupeKey: `scan.payroll.social:hire:${r.id}`,
          title: `${r.name} ${r.hire_date} 入职：办社保公积金增员（入职 30 日内）`,
          detail: `增员截止 ${due}（入职之日起 30 日内，以社保局/公积金中心通知为准）；办完在这里填备注确认完成。名册里的默认应发/社保/专项附加也顺手核一遍。`,
          sourceRef: { employeeId: r.id },
          dueDate: due,
          severity: today > due ? 'critical' : 'warn',
        })
      }
    }
    return out
  }

  // ---------- 扫描器十二：建档参数变化（2026-11-02 财务线残余 A6 最小版） ----------

  /** 建档四项（主体类型/纳税人身份/征收方式/纳税期限——征期扫描器据以排日历的那四项）与 app_meta 快照比对：
   *  变了出一条 warn（closeOnAbsence=false：核对过没有只有人知道，填备注确认完成）；首轮只记基线不报。
   *  比对完即更新快照——同一处改动只报一次；同键隔日再改另起一行（键含当日），当日多改并进同行刷新口径。 */
  private scanFinanceProfile(now: Date): ObligationCandidate[] {
    const today = localDate(now)
    const current = this.finance.profileGet().profile
    const watched = PROFILE_WATCHED_KEYS.map((k) => [k, (current[k] ?? '').trim()] as const)
    const raw = (this.db.prepare('SELECT value FROM app_meta WHERE key = ?').get(PROFILE_SNAPSHOT_KEY) as { value: string } | undefined)?.value
    const save = (): void => {
      this.db
        .prepare(
          `INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(PROFILE_SNAPSHOT_KEY, JSON.stringify(Object.fromEntries(watched)), nowIso())
    }
    if (raw === undefined) {
      save()
      return []
    }
    let snapshot: Record<string, unknown> | null = null
    try {
      const parsed = JSON.parse(raw) as unknown
      if (typeof parsed === 'object' && parsed !== null) snapshot = parsed as Record<string, unknown>
    } catch {
      snapshot = null
    }
    if (snapshot === null) {
      // 快照坏了=比对基准丢失：按首轮处理重建基线、不报（否则四项全报"（空）→ X"的假告警，审查 P3-3）
      save()
      return []
    }
    const show = (v: string): string => (v === '' ? '（空）' : v)
    const out: ObligationCandidate[] = []
    for (const [key, to] of watched) {
      const prev = snapshot[key]
      const from = typeof prev === 'string' ? prev : ''
      if (from === to) continue
      out.push({
        sourceType: 'scan.finance.profile',
        dedupeKey: `scan.finance.profile:${key}:${today}`,
        title: `建档参数「${key}」改了：${show(from)} → ${show(to)}，核对本期申报口径`,
        detail:
          `${PROFILE_KEY_HINTS[key] ?? ''}征期提醒从下一轮扫描起按新参数排；本期已按旧口径申报过的要不要更正，问代账会计或税务局。` +
          '核对过后在这里填备注确认完成（看没看系统无从得知）。',
        sourceRef: { profileKey: key, from, to },
        severity: 'warn',
      })
    }
    if (out.length > 0) save()
    return out
  }

  // ---------- 逾期升级（P3：1/3/7 阶梯；升级链 责任人→老板） ----------

  private async escalateOverdue(now: Date): Promise<{ escalated: number; repushed: number }> {
    const today = localDate(now)
    let escalated = 0
    let repushed = 0
    // open 且到期已过 → escalated + 即时推（第 1 天）；升级推送抄送老板（方案 §1.5 第二层）
    const toEscalate = this.db
      .prepare("SELECT * FROM obligations WHERE status = 'open' AND due_date != '' AND due_date < ?")
      .all(today) as ObligationRow[]
    for (const row of toEscalate) {
      this.db
        .prepare("UPDATE obligations SET status = 'escalated', escalated_at = ? WHERE id = ?")
        .run(now.toISOString(), row.id)
      escalated++
      await this.notifyRow({ ...row, status: 'escalated' }, `esc:1:${today}`, now, { copyBoss: true })
    }
    // 已升级项第 3/7 天阶梯重推；「暂不处理」（last_notified 以 ack: 开头）静音——核实发现源头仍在时会清掉
    const staged = this.db.prepare("SELECT * FROM obligations WHERE status = 'escalated'").all() as ObligationRow[]
    for (const row of staged) {
      if (row.last_notified.startsWith('ack:')) continue
      const base = localDate(new Date(row.escalated_at ?? row.first_seen_at))
      const days = diffDays(base, today)
      const dueStage = days >= 7 ? 7 : days >= 3 ? 3 : 0
      if (dueStage === 0) continue
      const done = row.last_notified.match(/^esc:s(\d):/)
      if (done !== null && Number(done[1]) >= dueStage) continue
      repushed++
      await this.notifyRow(row, `esc:s${dueStage}:${today}`, now, { copyBoss: true })
    }
    return { escalated, repushed }
  }

  // ---------- 晨报（双通道） ----------

  /** 每天一轮（app_meta 标记）；先落标再推送：半途崩了少发不重发（防骚扰优先于必达）。 */
  private async pushDigestIfDue(now: Date): Promise<RunSummary['digest']> {
    const today = localDate(now)
    const key = 'todos.last_digest_date'
    const last = (this.db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key) as { value: string } | undefined)?.value
    if (last === today) return 'already'
    const platform = config.bridgeAdapter
    if (!config.bridgeEnabled || !this.bridge.isConnected(platform)) return 'no-bridge'
    this.db
      .prepare(
        `INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, today, nowIso())
    const users = this.db
      .prepare('SELECT username FROM users WHERE is_service = 0 AND disabled_at IS NULL')
      .all() as { username: string }[]
    for (const { username } of users) {
      if (!this.rbac.hasPermission(username, 'todo:read')) continue
      const card = this.digestCardFor(username, now)
      if (card === undefined) continue
      await this.sendCardToUser(platform, username, card)
    }
    return 'sent'
  }

  /** 个人晨报卡：我的+岗位池的 warn/critical 活跃项 + 昨日回顾一行；没有项就不打扰（返回 undefined）。
   *  老板额外带企业总览、昨日全员动作切片与扫描告警（方案 §六/§十 ③）——老板自己盘子干净时
   *  企业总览仍要到：只要全员还有未闭合项或扫描出过错，老板卡照发。 */
  private digestCardFor(username: string, now: Date): TodoCardView | undefined {
    const rows = this.db
      .prepare(
        `SELECT * FROM obligations
         WHERE status IN ('open', 'escalated') AND severity != 'info'
           AND ((owner_type = 'user' AND owner_id = ?)
             OR (owner_type = 'role' AND owner_id IN (SELECT r.name FROM user_roles ur
                 JOIN roles r ON r.id = ur.role_id JOIN users u ON u.id = ur.user_id
                 WHERE u.username = ?)))
         ORDER BY (due_date = '') ASC, due_date ASC,
           CASE severity WHEN 'critical' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END ASC`,
      )
      .all(username, username) as ObligationRow[]
    const boss = this.rbac.bossUsername()
    const isBoss = username === boss
    const today = localDate(now)
    const lines: string[] = []
    for (const row of rows.slice(0, 10)) {
      const days = row.due_date === '' ? undefined : diffDays(row.due_date, today)
      const when =
        row.due_date === ''
          ? ''
          : days !== undefined && days < 0
            ? `（已逾期 ${-days} 天）`
            : days === 0
              ? '（今天到期）'
              : `（${row.due_date} 前）`
      lines.push(`- ${row.title}${when}`)
    }
    if (rows.length > 10) lines.push(`……另有 ${rows.length - 10} 条，见待办中心`)
    // 昨日切片的时间范围：本地日历昨天 [00:00, 24:00)
    const yesterday = addDaysISO(today, -1)
    const from = new Date(`${yesterday}T00:00:00`).toISOString()
    const to = new Date(`${today}T00:00:00`).toISOString()
    const actionLine = (rowsOf: { action: string; n: number }[]): string =>
      rowsOf
        // 只给经营动作：登录/桥接/审批事件/会话管理这类系统动作不进"昨日做了什么"
        .filter((a) => !/^(agent\.session|auth\.|bridge\.|approval\.|rbac\.guard)/.test(a.action))
        .map((a) => `${ACTION_PHRASES[a.action] ?? a.action} ${a.n}`)
        .slice(0, 3)
        .join(' · ')
    // 个人昨日回顾一行（§六）：本人昨日成功动作计数
    const mine = this.db
      .prepare(
        `SELECT action, COUNT(*) AS n FROM audit_log
         WHERE ts >= ? AND ts < ? AND username = ? AND ok = 1
         GROUP BY action ORDER BY n DESC LIMIT 8`,
      )
      .all(from, to, username) as { action: string; n: number }[]
    const mineLine = actionLine(mine)
    if (mineLine !== '') lines.push(`【昨日回顾】${mineLine}`)

    let bossSignal = false
    if (isBoss) {
      const ent = this.db
        .prepare(
          `SELECT COUNT(*) AS total,
             SUM(CASE WHEN due_date != '' AND due_date < ? THEN 1 ELSE 0 END) AS overdue
           FROM obligations WHERE status IN ('open', 'escalated')`,
        )
        .get(today) as { total: number; overdue: number | null }
      lines.push('')
      lines.push(`【企业总览】全员未闭合 ${ent.total} 条（逾期 ${ent.overdue ?? 0}）`)
      // 生产切片（2026-11-01 R1）：供应链一句话（低于安线/到货逾期/临期批次/今日应到）；没接入生产数据或全零则整行不出
      const slice = this.supply.briefingSlice(today)
      if (slice !== '') lines.push(`【生产切片】${slice}`)
      const acts = this.db
        .prepare(
          `SELECT action, COUNT(*) AS n FROM audit_log
           WHERE ts >= ? AND ts < ? AND username != '-' AND ok = 1
           GROUP BY action ORDER BY n DESC LIMIT 8`,
        )
        .all(from, to) as { action: string; n: number }[]
      const allLine = actionLine(acts)
      if (allLine !== '') lines.push(`【昨日全员】${allLine}`)
      // 失败纪律（方案 §五）：近 3 天扫描器出错在老板晨报顶部汇总一行——预警系统自己失明必须有人知道
      const alerts = this.db
        .prepare(
          `SELECT scanner, COUNT(*) AS n, MAX(errors) AS last_error FROM scan_runs
           WHERE errors != '' AND ran_at >= ? GROUP BY scanner ORDER BY n DESC`,
        )
        .all(new Date(now.getTime() - 3 * 86_400_000).toISOString()) as { scanner: string; n: number; last_error: string }[]
      if (alerts.length > 0) {
        const brief = alerts
          .slice(0, 3)
          .map((a) => `${SOURCE_LABELS[a.scanner] ?? a.scanner} ${a.n} 次（${a.last_error.slice(0, 60)}）`)
          .join('；')
        lines.unshift(`【扫描告警】近 3 天有扫描器失败：${brief}——该来源的预警可能不全`)
      }
      bossSignal = ent.total > 0 || alerts.length > 0
    }
    if (rows.length === 0 && !bossSignal) return undefined
    const hasCritical = rows.slice(0, 10).some((r) => r.severity === 'critical')
    return {
      kind: 'todo-digest',
      title: `今日待办 ${today.slice(5)}（${rows.length} 条）`,
      template: hasCritical ? 'red' : 'orange',
      lines,
      note: `每日扫描自动生成；推导型待办去源头处理后自动闭合，明细见系统「待办中心」。`,
    }
  }

  // ---------- 推送通道 ----------

  /** 人工待办新指派即时卡（§六）：建给别人才推（自己给自己建不打扰）；岗位待办推给全体持岗人。 */
  private async notifyManualCreated(row: ObligationRow, actor: string): Promise<void> {
    if (row.owner_type === 'user' && row.owner_id === actor) return
    await this.notifyRow(row, `new:${localDate()}`, new Date())
  }

  /** 单条跃迁即时卡：先落推送标记（同轮重扫不重发），再按责任人展开收件人直发单聊。
   *  桥未连/无身份时这张卡就丢了不补——与晨报同一"少发不重发"口径（下一级阶梯会再推）。 */
  private async notifyRow(row: ObligationRow, marker: string, now: Date, opts: { copyBoss?: boolean } = {}): Promise<void> {
    this.db.prepare('UPDATE obligations SET last_notified = ? WHERE id = ?').run(marker, row.id)
    const platform = config.bridgeAdapter
    if (!config.bridgeEnabled || !this.bridge.isConnected(platform)) return
    const recipients = this.recipientsOf(row)
    if (opts.copyBoss === true) {
      const boss = this.rbac.bossUsername()
      if (boss !== undefined && !recipients.includes(boss)) recipients.push(boss)
    }
    for (const username of recipients) {
      await this.sendCardToUser(platform, username, this.itemCard(row, now))
    }
  }

  private recipientsOf(row: ObligationRow): string[] {
    if (row.owner_type === 'user') return [row.owner_id]
    return (
      this.db
        .prepare(
          `SELECT u.username FROM users u
           JOIN user_roles ur ON ur.user_id = u.id
           JOIN roles r ON r.id = ur.role_id
           WHERE r.name = ? AND u.is_service = 0 AND u.disabled_at IS NULL`,
        )
        .all(row.owner_id) as { username: string }[]
    ).map((r) => r.username)
  }

  private async sendCardToUser(platform: string, username: string, card: TodoCardView): Promise<boolean> {
    const ident = this.db
      .prepare(
        'SELECT platform_userid FROM bridge_identities WHERE platform = ? AND username = ? AND allowed = 1 ORDER BY updated_at DESC LIMIT 1',
      )
      .get(platform, username) as { platform_userid: string } | undefined
    if (ident === undefined) return false
    try {
      await this.bridge.sendUserCardTo(platform, ident.platform_userid, card)
      return true
    } catch (e) {
      console.warn('[todos] 待办卡推送失败：', e instanceof Error ? e.message : e)
      return false
    }
  }

  /** 跃迁即时卡（§六）：严重度定色，人工待办才有「完成」按钮（推导型卡上只有「暂不处理」，
   *  核实式完成要填备注、在待办中心做）。 */
  private itemCard(row: ObligationRow, now: Date): TodoCardView {
    const today = localDate(now)
    const overdue = row.due_date !== '' && row.due_date < today
    const lines = [row.detail, row.due_date === '' ? '无固定到期日' : `到期：${row.due_date}${overdue ? '（已逾期）' : ''}`].filter(
      (l) => l !== '',
    )
    return {
      kind: 'todo-item',
      title: row.title,
      template: row.severity === 'critical' ? 'red' : 'orange',
      lines,
      note: `来源：${SOURCE_LABELS[row.source_type] ?? row.source_type} · 推导型待办去源头处理后自动闭合，或到待办中心点「已完成」由系统核实；手工待办可直接完成`,
      todoId: row.id,
      canDone: row.origin === 'manual',
    }
  }
}

/** 每日扫描时刻解析（env ADMIN_DAILY_SCAN_AT）：只认 HH:MM；非法值回退 08:30 并告警——
 *  不校验会得到 Invalid Date → setTimeout(NaN)=0ms 立即触发并无限重排，变成持续空转全量扫描。 */
export function parseDailyScanAt(raw: string | undefined, fallback = '08:30'): { hour: number; minute: number; invalid?: string } {
  const parse = (s: string): { hour: number; minute: number } | undefined => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
    if (m === null) return undefined
    const hour = Number(m[1])
    const minute = Number(m[2])
    if (hour > 23 || minute > 59) return undefined
    return { hour, minute }
  }
  const ok = parse(raw ?? fallback)
  if (ok !== undefined) return ok
  return { ...parse(fallback)!, invalid: raw ?? '' }
}

/** 昨日动作切片的人话映射（晨报里给人看的短语；键=审计 action 真实值，没收录的动作原样显示）。 */
const ACTION_PHRASES: Record<string, string> = {
  'finance.create': '记账',
  'finance.update': '改账',
  'finance.delete': '删账',
  'finance.reverse': '冲销',
  'finance.import': '批量导入',
  'proposal.confirm': '确认入账',
  'proposal.reject': '退回提案',
  'agent.chat': '对话',
  'todo.created': '建待办',
  'todo.updated': '改待办',
  'todo.done': '完成待办',
  'todo.dismissed': '备注确认完成',
  'todo.acked': '暂不处理',
  'invoice.create': '登记发票',
  'invoice.link': '挂票',
  'attachment.upload': '传附件',
  'banklines.import': '导流水',
  'banklines.match': '对流水',
  'cashcount.create': '盘点现金',
  'supply.import': '导生产数据',
  'supply.item.created': '建物料',
  'supply.item.updated': '改物料',
  'supply.item.archived': '归档物料',
  'supply.aliases.set': '改物料别名',
  'supply.po.updated': '改采购单',
}

/** 工资单接落账（2026-11-02 财务线残余，finance README 第三审查触发点兑现）：
 *  某月工资单全部确认后 → 一笔 type=payroll 提案（金额=实发合计，钱真正出账的数；个税/社保在
 *  缴纳时另按 tax 类登记，不在这里拆三笔——现金口径账本不做权责发生制）→ 老板飞书单聊卡 →
 *  老板点「确认入账」走既有 proposals.confirm 落账。与审批落账共用 FinancePostingService.postProposal
 *  （origin 查重/同事务/不假成功/卡片降级一套纪律），origin=`payroll:<YYYY-MM>`。
 *
 *  一致性（工资单与提案两头都会变）：
 *  - 该月提案已 confirmed（进账本）→ 工资单锁死：不许撤回确认、不许再生成新人单（要改先冲销账本再来）；
 *  - 该月提案还 pending（老板没点）→ 工资单一变（撤回确认/生成了新人单）就把旧提案作废（reject，留审计），
 *    全部重新确认后再生成一张新的——老板永远只看得到与当前工资单一致的数；
 *  - 触发：确认某张工资单后该月不再有草稿即自动生成（控制器层 awaited，前端立刻知道）；也可手动触发。
 *  附带两件：工资条推送（按名册 open_id 私聊每位员工本人的数，显式动作+逐人审计）、CSV 导出（Excel 可开）。 */
import type { DB } from '../db/database.js'
import { BadRequestError } from '../errors.js'
import type { AuditService } from '../audit/audit.service.js'
import type { BridgeService } from '../bridge/bridge.service.js'
import type { Actor } from './finance.types.js'
import type { FinancePostingService, PostOutcome } from './finance-posting.service.js'
import type { FinanceProposalsService } from './finance-proposals.service.js'
import type { PayrollPostingGuard } from './finance-payslips.service.js'
import { centsToYuan, localDate, parseMonth } from './finance.util.js'

interface SlipRow {
  id: number
  employee_id: number
  month: string
  gross_cents: number
  social_cents: number
  extra_deduct_cents: number
  relief_cents: number
  tax_cents: number
  net_cents: number
  status: string
  note: string
  name: string
  open_id: string
  department: string
}

export interface PayrollPostingStatus {
  month: string
  payslips: { total: number; confirmed: number; draft: number; draft_names: string[] }
  totals: { gross: number; social: number; tax: number; net: number }
  /** 该月落账提案（不含 rejected）：pending=等老板确认；confirmed=已进账本（entry_id） */
  proposal: { id: string; status: string; entry_id: string } | null
  /** 现在能不能生成提案；不能时 reason 说人话 */
  postable: boolean
  reason: string
}

export type PayrollPostOutcome = PostOutcome | { status: 'skipped'; reason: string }

export interface PayslipPushResult {
  month: string
  sent: string[]
  skipped: Array<{ name: string; reason: string }>
}

const ORIGIN = (month: string): string => `payroll:${month}`
const yuan = (cents: number): string => centsToYuan(cents).toFixed(2)

export class FinancePayrollPostingService {
  constructor(
    private readonly db: DB,
    private readonly audit: AuditService,
    private readonly posting: FinancePostingService,
    private readonly proposals: FinanceProposalsService,
    private readonly bridge: BridgeService,
    private readonly opts: { platform: string },
  ) {}

  /** 给工资单服务的守卫（装配处 payslips.setPostingGuard(payrollPosting.guard())）。 */
  guard(): PayrollPostingGuard {
    return {
      assertMonthOpen: (month, verb) => {
        const p = this.proposalOf(month)
        if (p !== null && p.status === 'confirmed') {
          throw new BadRequestError(`${month} 的工资已确认落账（提案 ${p.id} → 账本 ${p.entry_id}），不能再${verb}；要改先在台账冲销那笔工资（冲销后本月自动解锁，可撤回确认改数重出）。`)
        }
      },
      invalidatePending: (actor, month, reason) => {
        const p = this.proposalOf(month)
        if (p === null || p.status !== 'pending') return
        this.proposals.reject(actor, p.id, reason)
        this.audit.log({ username: actor.username, source: actor.source, action: 'payroll.posting.invalidated', targetId: month, detail: { proposal: p.id, reason } })
      },
    }
  }

  status(rawMonth: string): PayrollPostingStatus {
    const month = parseMonth(rawMonth, 'month')
    const rows = this.rows(month)
    const drafts = rows.filter((r) => r.status !== 'confirmed')
    const proposal = this.proposalOf(month)
    let postable = true
    let reason = ''
    if (rows.length === 0) {
      postable = false
      reason = '该月还没有工资单。'
    } else if (drafts.length > 0) {
      postable = false
      reason = `还有 ${drafts.length} 张草稿未确认（${drafts.map((r) => r.name).join('、')}），全部确认后自动生成落账提案。`
    } else if (proposal !== null) {
      postable = false
      reason = proposal.status === 'confirmed' ? `该月工资已落账（提案 ${proposal.id} → 账本 ${proposal.entry_id}）。` : `落账提案 ${proposal.id} 已生成，等老板在飞书卡片或「提案」页确认。`
    }
    return {
      month,
      payslips: { total: rows.length, confirmed: rows.length - drafts.length, draft: drafts.length, draft_names: drafts.map((r) => r.name) },
      totals: this.totals(rows),
      proposal,
      postable,
      reason,
    }
  }

  /** 生成该月落账提案。auto=true（确认工资单后的自动触发）时"不该建"的情形静默返回 skipped；
   *  手动触发时同样的情形 400 说人话。建不建都不改工资单。 */
  async postMonth(actor: Actor, rawMonth: string, opts: { auto?: boolean } = {}): Promise<PayrollPostOutcome> {
    const st = this.status(rawMonth)
    if (!st.postable) {
      if (opts.auto === true) return { status: 'skipped', reason: st.reason }
      throw new BadRequestError(st.reason)
    }
    const rows = this.rows(st.month).filter((r) => r.status === 'confirmed')
    const names = rows.map((r) => r.name)
    const counterparty = names.length <= 3 ? names.join('、') : `${names[0]}等 ${names.length} 人`
    const t = st.totals
    return this.posting.postProposal(
      {
        origin: ORIGIN(st.month),
        actor,
        auditActor: { username: actor.username, source: 'payroll' },
        auditPrefix: 'payroll.posting',
        targetId: st.month,
        createdByLabel: `${st.month} 工资单（${opts.auto === true ? '自动' : actor.username}）`,
        failText: `【工资单落账】${st.month} 工资落账提案生成失败：{error}\n请到网页「工资」页处理。`,
        cardFailText: `${st.month} 工资落账提案 {proposal} 已生成，但飞书卡片发失败了（{error}），请到网页「提案」页确认。`,
      },
      {
        type: 'payroll',
        amount: t.net,
        date: localDate(),
        counterparty,
        category: '工资',
        account: '',
        note: `${st.month} 工资单 ${rows.length} 人：应发 ${t.gross.toFixed(2)}｜个人社保公积金 ${t.social.toFixed(2)}｜个税 ${t.tax.toFixed(2)}｜实发 ${t.net.toFixed(2)}（实发口径；个税/社保缴纳时另记）`,
      },
      { month: st.month, people: rows.length, gross: t.gross, social: t.social, tax: t.tax, net: t.net, auto: opts.auto === true },
    )
  }

  /** 工资条：按名册 open_id 私聊每人自己的数。显式动作（前端二次确认）；只发已确认的单；
   *  没 open_id 的人跳过点名。逐人审计（不记金额明细，工资是敏感面）。 */
  async pushPayslips(actor: Actor, rawMonth: string): Promise<PayslipPushResult> {
    const month = parseMonth(rawMonth, 'month')
    const rows = this.rows(month)
    if (rows.length === 0) throw new BadRequestError('该月还没有工资单。')
    const sent: string[] = []
    const skipped: Array<{ name: string; reason: string }> = []
    for (const r of rows) {
      if (r.status !== 'confirmed') {
        skipped.push({ name: r.name, reason: '草稿未确认' })
        continue
      }
      if (r.open_id === '') {
        skipped.push({ name: r.name, reason: '名册没有飞书 open_id' })
        continue
      }
      const text =
        `【工资条】${month}\n` +
        `应发 ${yuan(r.gross_cents)}｜个人社保公积金 ${yuan(r.social_cents)}｜专项附加扣除 ${yuan(r.extra_deduct_cents)}` +
        (r.relief_cents > 0 ? `｜减免 ${yuan(r.relief_cents)}` : '') +
        `\n个税 ${yuan(r.tax_cents)}｜实发 ${yuan(r.net_cents)}` +
        (r.note !== '' ? `\n备注：${r.note}` : '') +
        '\n（有疑问请联系财务）'
      try {
        await this.bridge.sendUserTo(this.opts.platform, r.open_id, text)
        sent.push(r.name)
        this.audit.log({ username: actor.username, source: actor.source, action: 'payroll.payslip.push', targetId: String(r.id), detail: { month, employee: r.name } })
      } catch (error) {
        const m = error instanceof Error ? error.message : String(error)
        skipped.push({ name: r.name, reason: `发送失败：${m}` })
        this.audit.log({ username: actor.username, source: actor.source, action: 'payroll.payslip.push', targetId: String(r.id), detail: { month, employee: r.name, error: m }, ok: false })
      }
    }
    return { month, sent, skipped }
  }

  /** CSV（UTF-8 BOM，Excel 直接开）：一人一行 + 合计行。 */
  exportCsv(rawMonth: string): { month: string; filename: string; csv: string } {
    const month = parseMonth(rawMonth, 'month')
    const rows = this.rows(month)
    const header = ['姓名', '部门', '月份', '应发', '个人社保公积金', '专项附加扣除', '减免税额', '个税', '实发', '状态', '备注']
    const lines = [header.map(csvCell).join(',')]
    for (const r of rows) {
      lines.push(
        [
          csvText(r.name), csvText(r.department), csvCell(r.month),
          csvCell(yuan(r.gross_cents)), csvCell(yuan(r.social_cents)), csvCell(yuan(r.extra_deduct_cents)), csvCell(yuan(r.relief_cents)), csvCell(yuan(r.tax_cents)), csvCell(yuan(r.net_cents)),
          csvCell(r.status === 'confirmed' ? '已确认' : '草稿'), csvText(r.note),
        ].join(','),
      )
    }
    // 合计行六个金额列齐全（审查 P3-2：专项附加/减免不能空着）
    const sum = (pick: (r: SlipRow) => number): string => yuan(rows.reduce((n, r) => n + pick(r), 0))
    lines.push(
      ['合计', '', month, sum((r) => r.gross_cents), sum((r) => r.social_cents), sum((r) => r.extra_deduct_cents), sum((r) => r.relief_cents), sum((r) => r.tax_cents), sum((r) => r.net_cents), `${rows.length} 人`, '']
        .map(csvCell)
        .join(','),
    )
    return { month, filename: `payroll-${month}.csv`, csv: `\ufeff${lines.join('\r\n')}\r\n` }
  }

  // ---------- 内部 ----------

  private rows(month: string): SlipRow[] {
    return this.db
      .prepare(
        `SELECT p.id, p.employee_id, p.month, p.gross_cents, p.social_cents, p.extra_deduct_cents, p.relief_cents,
                p.tax_cents, p.net_cents, p.status, p.note, e.name, e.open_id, e.department
         FROM finance_payslips p JOIN finance_employees e ON e.id = p.employee_id
         WHERE p.month = ? ORDER BY e.name, p.id`,
      )
      .all(month) as SlipRow[]
  }

  private totals(rows: SlipRow[]): { gross: number; social: number; tax: number; net: number } {
    const sum = (f: (r: SlipRow) => number): number => centsToYuan(rows.reduce((a, r) => a + f(r), 0))
    return { gross: sum((r) => r.gross_cents), social: sum((r) => r.social_cents), tax: sum((r) => r.tax_cents), net: sum((r) => r.net_cents) }
  }

  /** 该月在场的落账提案：排除 rejected 与"已确认但账本那笔已冲销"——口径只在 posting.findByOrigin 定义一处。 */
  private proposalOf(month: string): { id: string; status: string; entry_id: string } | null {
    return this.posting.findByOrigin(ORIGIN(month)) ?? null
  }
}

/** CSV 单元格：引号/逗号/换行按 RFC 4180 转义。 */
function csvCell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

/** 人填的文本列（姓名/部门/备注）：以 = + - @ 开头的前置制表符，防 Excel 当公式执行（审查 P3-1）；数字列不走这里。 */
function csvText(v: string): string {
  return csvCell(/^[=+\-@]/.test(v) ? `\t${v}` : v)
}

/** 银行对账（口袋维，任务全图 §4-5 / B1 银行流水核对）：按账户出"账面余额 vs 对账单余额"的对照。
 *  不接网银 API：对账单余额由人从网银/手机银行抄过来；系统只负责把截止日口径的账面余额算准、
 *  算出差额、列出截止日后已记账的流水，并用人话说清差额该怎么去核。报告即时算，不落库。
 *  账面余额口径与账户页完全一致（finance-flow.ts 单源），只多一个"截止到 as_of"的日期窗口。 */
import type { DB } from '../db/database.js'
import { BadRequestError, NotFoundError } from '../errors.js'
import { OUT_TYPES, type EntryType } from './finance.types.js'
import { flowByAccountCents } from './finance-flow.js'
import { centsToYuan, localDate, parseDate, parseSignedAmount, r2 } from './finance.util.js'

export interface ReconciliationInput {
  account?: string
  as_of?: string
  statement_balance?: number | string
}

export interface ReconciliationFlow {
  id: string
  date: string
  type: EntryType
  /** 条目金额（元） */
  amount: number
  /** 实际动钱数（元，正数）：已收付全额或部分收付额；冲销条目方向取反体现在 direction */
  moved: number
  direction: 'in' | 'out'
  counterparty: string
  note: string
  reverses: string
}

export interface ReconciliationReport {
  account: string
  account_archived: boolean
  as_of: string
  /** 截止 as_of（含）账面余额=期初+Σ已收付 */
  book_balance: number
  /** 今天的账面余额（全时段，与账户页一致） */
  book_balance_current: number
  statement_balance: number
  /** 账面 − 对账单：0=对上了；正=账面比银行多；负=账面比银行少 */
  difference: number
  /** 截止日之后已记账且动了钱的流水（不参与本次对账，解释 book_balance 与 book_balance_current 的差） */
  flows_after: ReconciliationFlow[]
  /** flows_after 净影响（元，收为正付为负） */
  net_after: number
  hint: string
}

export class FinanceReconciliationService {
  constructor(private readonly db: DB) {}

  preview(input: ReconciliationInput): ReconciliationReport {
    const name = (input.account ?? '').trim()
    if (name === '') throw new BadRequestError('需要 account（账户名，与账户页一致）。')
    const account = this.db
      .prepare('SELECT name, opening_balance_cents, archived_at FROM finance_accounts WHERE name = ?')
      .get(name) as { name: string; opening_balance_cents: number; archived_at: string | null } | undefined
    if (account === undefined) throw new NotFoundError(`找不到账户"${name}"。先在账户页建档再对账。`)
    const asOf = parseDate(input.as_of, 'as_of') ?? localDate()
    if (input.statement_balance === undefined || String(input.statement_balance).trim() === '') {
      throw new BadRequestError('需要 statement_balance（对账单/网银显示的截止日余额，元）。')
    }
    const statement = parseSignedAmount(input.statement_balance, 'statement_balance')

    const bookCents = account.opening_balance_cents + (flowByAccountCents(this.db, asOf).get(name) ?? 0)
    const currentCents = account.opening_balance_cents + (flowByAccountCents(this.db).get(name) ?? 0)
    const book = r2(centsToYuan(bookCents))
    const difference = r2(book - statement)
    const flowsAfter = this.flowsAfter(name, asOf)
    const netAfter = r2(flowsAfter.reduce((sum, f) => sum + (f.direction === 'in' ? f.moved : -f.moved), 0))

    return {
      account: name,
      account_archived: account.archived_at !== null,
      as_of: asOf,
      book_balance: book,
      book_balance_current: r2(centsToYuan(currentCents)),
      statement_balance: statement,
      difference,
      flows_after: flowsAfter,
      net_after: netAfter,
      hint: buildHint(asOf, difference, flowsAfter.length, netAfter),
    }
  }

  /** 截止日之后、已动钱的该账户流水（口径与 finance-flow 一致：已付全额/部分付部分额、作废跳过、发票不动钱）。 */
  private flowsAfter(name: string, asOf: string): ReconciliationFlow[] {
    const rows = this.db
      .prepare(
        `SELECT id, date, type, amount_cents, paid_amount_cents, status, counterparty, note, reverses
         FROM finance_entries
         WHERE deleted_at IS NULL AND status != 'cancelled' AND account = ? AND date > ?
         ORDER BY date ASC, id ASC`,
      )
      .all(name, asOf) as {
      id: string
      date: string
      type: EntryType
      amount_cents: number
      paid_amount_cents: number
      status: string
      counterparty: string
      note: string
      reverses: string
    }[]
    const out: ReconciliationFlow[] = []
    for (const row of rows) {
      if (row.type === 'invoice') continue
      const settled = row.status === 'paid'
      const partial = row.status === 'partial' || (row.paid_amount_cents > 0 && !settled)
      const movedCents = settled ? row.amount_cents : partial ? row.paid_amount_cents : 0
      if (movedCents === 0) continue
      const isOut = (OUT_TYPES as readonly string[]).includes(row.type)
      // 冲销条目把原方向反过来（收的冲销=钱出去，付的冲销=钱回来）
      const direction: 'in' | 'out' = (isOut ? 'out' : 'in') === 'in' ? (row.reverses !== '' ? 'out' : 'in') : row.reverses !== '' ? 'in' : 'out'
      out.push({
        id: row.id,
        date: row.date,
        type: row.type,
        amount: centsToYuan(row.amount_cents),
        moved: centsToYuan(movedCents),
        direction,
        counterparty: row.counterparty,
        note: row.note,
        reverses: row.reverses,
      })
    }
    return out
  }
}

function buildHint(asOf: string, difference: number, afterCount: number, netAfter: number): string {
  const fmt = (n: number) => n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const parts: string[] = []
  if (difference === 0) {
    parts.push(`截止 ${asOf} 账面与银行对上了。`)
  } else {
    const side = difference > 0 ? '账面比银行多' : '账面比银行少'
    parts.push(
      `截止 ${asOf} ${side} ${fmt(Math.abs(difference))} 元。差额通常来自两头：一是账本记了、银行还没到账（在途，如对方刚打的款、刚付出去还没扣）；二是银行扣了/进了、账本还没记（常见：银行手续费、利息、代扣费用）。请下载该账户 ${asOf} 前的回单逐笔核对，银行有而账本没有的补记一笔，账本有而银行没有的确认是否真发生。`,
    )
  }
  if (afterCount > 0) {
    parts.push(
      `另外截止日之后还有 ${afterCount} 笔已记账流水（净影响 ${netAfter >= 0 ? '+' : ''}${fmt(netAfter)} 元），不参与本次对账，但会让今天的账面余额与截止日账面不同。`,
    )
  }
  return parts.join('')
}

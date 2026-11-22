/** 现金/账户盘点域（口袋维，任务全图 B2，2026-10-26）：
 *  盘点=某刻"实盘多少 vs 账面多少"的快照：账面用 finance-flow 单源口径（期初+截止 as_of 已收−已付），
 *  差额=实盘−账面只记录不调平（§0.5：差异必须出清单，调平走记账/冲销正常路径——
 *  盘盈盘亏真要入账，就正常记一笔并写明盘点原因，盘点记录留作凭证）。
 *  主要给 kind=cash 的账户用，但不限：微信/支付宝余额对不上时同样可以盘一次留痕。 */
import type { DB } from '../db/database.js'
import { nowIso } from '../db/database.js'
import type { AuditService } from '../audit/audit.service.js'
import { BadRequestError, NotFoundError } from '../errors.js'
import type { Actor } from './finance.types.js'
import { flowByAccountCents } from './finance-flow.js'
import { centsToYuan, localDate, parseDate, parseSignedAmount, r2 } from './finance.util.js'

export interface CashCountRecord {
  id: number
  account: string
  as_of: string
  counted: number
  book: number
  diff: number
  note: string
  created_by: string
  created_at: string
}

export class FinanceCashCountsService {
  constructor(
    private readonly db: DB,
    private readonly audit: AuditService,
  ) {}

  create(actor: Actor, input: { account?: unknown; counted?: unknown; as_of?: unknown; note?: unknown }): CashCountRecord {
    const account = typeof input.account === 'string' ? input.account.trim() : ''
    if (account === '') throw new BadRequestError('需要 account（账户名，与账户页一致）。')
    const accRow = this.db.prepare('SELECT opening_balance_cents FROM finance_accounts WHERE name = ?').get(account) as
      | { opening_balance_cents: number }
      | undefined
    if (accRow === undefined) throw new NotFoundError(`找不到账户"${account}"。先在账户页建档。`)
    if (typeof input.counted === 'undefined' || String(input.counted).trim() === '') {
      throw new BadRequestError('需要 counted（实际盘到的余额，元，可为负）。')
    }
    const counted = parseSignedAmount(input.counted as number | string, 'counted')
    const asOf = parseDate(typeof input.as_of === 'string' ? input.as_of : undefined, 'as_of') ?? localDate()
    const note = typeof input.note === 'string' ? input.note.trim().slice(0, 200) : ''

    // 账面口径与账户页/对账完全同源：期初 + 截止 as_of（含当天）动钱净额
    const bookCents = accRow.opening_balance_cents + (flowByAccountCents(this.db, asOf).get(account) ?? 0)
    const book = r2(centsToYuan(bookCents))
    const diff = r2(counted - book)

    const info = this.db
      .prepare(
        'INSERT INTO finance_cash_counts (account, as_of, counted_cents, book_cents, diff_cents, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(account, asOf, Math.round(counted * 100), Math.round(book * 100), Math.round(diff * 100), note, actor.username, nowIso())
    this.audit.log({
      username: actor.username,
      source: actor.source,
      action: 'cashcount.create',
      targetId: String(info.lastInsertRowid),
      detail: { account, as_of: asOf, counted, book, diff },
    })
    return this.getOne(Number(info.lastInsertRowid))
  }

  list(filter: { account?: string; limit?: number }): { count: number; records: CashCountRecord[] } {
    const clauses: string[] = []
    const params: unknown[] = []
    if (filter.account !== undefined && filter.account.trim() !== '') {
      clauses.push('account = ?')
      params.push(filter.account.trim())
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const limit = Math.max(1, filter.limit ?? 50)
    const rows = this.db
      .prepare(`SELECT * FROM finance_cash_counts ${where} ORDER BY id DESC LIMIT ?`)
      .all(...params, limit) as CashCountRow[]
    return { count: rows.length, records: rows.map(toRecord) }
  }

  private getOne(id: number): CashCountRecord {
    if (!Number.isInteger(id) || id <= 0) throw new BadRequestError('盘点记录 id 应为正整数。')
    const row = this.db.prepare('SELECT * FROM finance_cash_counts WHERE id = ?').get(id) as CashCountRow | undefined
    if (row === undefined) throw new NotFoundError(`找不到盘点记录 #${id}。`)
    return toRecord(row)
  }
}

interface CashCountRow {
  id: number
  account: string
  as_of: string
  counted_cents: number
  book_cents: number
  diff_cents: number
  note: string
  created_by: string
  created_at: string
}

function toRecord(row: CashCountRow): CashCountRecord {
  return {
    id: row.id,
    account: row.account,
    as_of: row.as_of,
    counted: centsToYuan(row.counted_cents),
    book: centsToYuan(row.book_cents),
    diff: centsToYuan(row.diff_cents),
    note: row.note,
    created_by: row.created_by,
    created_at: row.created_at,
  }
}

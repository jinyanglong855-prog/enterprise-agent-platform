/** 账户流量共享计算（口袋维唯一口径）：
 *  账户余额=期初+Σ已收−Σ已付（按 paid_amount 口径，未收付的应收应付不动余额——
 *  这才是"微信里还剩多少"）；冲销条目按负计入；作废跳过；发票登记不动钱。
 *  账户页（finance-accounts.service）与银行对账（finance-reconciliation.service）共用，
 *  口径改动只许改这里，两边不许各写一份。asOf 给出时只统计 date <= asOf 的流水。 */
import type { DB } from '../db/database.js'
import { OUT_TYPES, type EntryType } from './finance.types.js'

export function flowByAccountCents(db: DB, asOf?: string): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT account, type, amount_cents, paid_amount_cents, status, reverses, date
       FROM finance_entries
       WHERE deleted_at IS NULL AND status != 'cancelled' AND account != ''${asOf !== undefined ? ' AND date <= ?' : ''}`,
    )
    .all(...(asOf !== undefined ? [asOf] : [])) as {
    account: string
    type: EntryType
    amount_cents: number
    paid_amount_cents: number
    status: string
    reverses: string
    date: string
  }[]
  const flows = new Map<string, number>()
  for (const row of rows) {
    if (row.type === 'invoice') continue // 开票登记不动钱
    const settled = row.status === 'paid'
    const partial = row.status === 'partial' || (row.paid_amount_cents > 0 && !settled)
    const moved = settled ? row.amount_cents : partial ? row.paid_amount_cents : 0
    if (moved === 0) continue
    const signed = (OUT_TYPES as readonly string[]).includes(row.type) ? -moved : moved
    const sign = row.reverses !== '' ? -1 : 1
    flows.set(row.account, (flows.get(row.account) ?? 0) + sign * signed)
  }
  return flows
}

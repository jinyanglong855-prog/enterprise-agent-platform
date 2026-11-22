/** 票-账自动核对域（证据维，任务全图 A5/A6，2026-10-26）：
 *  按金额一致、对方吻合、日期邻近给"这张票可能该挂哪笔账 / 这笔账可能该收哪张票"的猜测清单。
 *  只出建议不自动挂联：挂联仍是人（或确认卡片）的写动作——§0.5"对=差异必须出清单，不许顺手改平"。
 *  打分：金额精确相等 4 分（主信号）；日期差 ≤7 天 +2 / ≤31 天 +1；对方完全相同 +2；对方互相包含（≥2 字）+1。
 *  建议阈值 ≥2 分，最多 8 条；已挂联的候选不重复出。 */
import type { DB } from '../db/database.js'
import { BadRequestError, NotFoundError } from '../errors.js'
import { ID_PATTERN, type EntryType, type InvoiceKind } from './finance.types.js'
import { centsToYuan } from './finance.util.js'

export interface MatchSuggestion {
  date: string
  number: string
  amount: number
  counterparty: string
  status: string
  score: number
  reason: string
}

export interface InvoiceMatchSuggestion extends MatchSuggestion {
  entry_id: string
  type: EntryType
}

export interface EntryMatchSuggestion extends MatchSuggestion {
  invoice_id: string
  kind: InvoiceKind
}

const DAY_MS = 24 * 3600 * 1000

export class FinanceMatchesService {
  constructor(private readonly db: DB) {}

  /** 给一张票猜该挂的账。方向过滤：销项↔收入/开票登记，进项↔支出/报销，内部凭证↔全部。 */
  forInvoice(rawId: string): { invoice_id: string; suggestions: InvoiceMatchSuggestion[] } {
    const invoice = this.requireInvoice(rawId)
    const linked = new Set(
      (this.db.prepare('SELECT entry_id FROM finance_invoice_links WHERE invoice_id = ?').all(invoice.id) as { entry_id: string }[]).map((l) => l.entry_id),
    )
    const types = invoice.kind === 'sales' ? ['income', 'invoice'] : invoice.kind === 'purchase' ? ['expense', 'reimburse'] : null
    const clauses = ['deleted_at IS NULL', "status != 'cancelled'", "reverses = ''", "reversed_by = ''"]
    const params: unknown[] = []
    if (types !== null) {
      clauses.push(`type IN (${types.map(() => '?').join(',')})`)
      params.push(...types)
    }
    const rows = this.db
      .prepare(`SELECT id, date, type, amount_cents, counterparty, status FROM finance_entries WHERE ${clauses.join(' AND ')}`)
      .all(...params) as EntryRow[]
    const suggestions = rank(
      rows.filter((r) => !linked.has(r.id)).map((r) => ({ row: r, ...scoreRow(invoice.amount_cents, invoice.date, invoice.counterparty, r) })),
    )
    return {
      invoice_id: invoice.id,
      suggestions: suggestions.map(({ row, score, reason }) => ({
        entry_id: row.id,
        date: row.date,
        type: row.type,
        number: '',
        amount: centsToYuan(row.amount_cents),
        counterparty: row.counterparty,
        status: row.status,
        score,
        reason,
      })),
    }
  }

  /** 给一笔账猜该收的票。方向过滤与 forInvoice 对称；废票（作废/红冲）不算证据不出建议。 */
  forEntry(rawId: string): { entry_id: string; suggestions: EntryMatchSuggestion[] } {
    const entry = this.requireEntry(rawId)
    const linked = new Set(
      (this.db.prepare('SELECT invoice_id FROM finance_invoice_links WHERE entry_id = ?').all(entry.id) as { invoice_id: string }[]).map((l) => l.invoice_id),
    )
    const kinds = entry.type === 'income' || entry.type === 'invoice' ? ['sales'] : ['purchase']
    const rows = this.db
      .prepare(
        `SELECT id, kind, number, date, amount_cents, counterparty, status FROM finance_invoices
         WHERE deleted_at IS NULL AND status = 'held' AND kind IN (${kinds.map(() => '?').join(',')})`,
      )
      .all(...kinds) as InvoiceRow[]
    const suggestions = rank(
      rows.filter((r) => !linked.has(r.id)).map((r) => ({ row: r, ...scoreRow(entry.amount_cents, entry.date, entry.counterparty, r) })),
    )
    return {
      entry_id: entry.id,
      suggestions: suggestions.map(({ row, score, reason }) => ({
        invoice_id: row.id,
        date: row.date,
        kind: row.kind,
        number: row.number,
        amount: centsToYuan(row.amount_cents),
        counterparty: row.counterparty,
        status: row.status,
        score,
        reason,
      })),
    }
  }

  // --------------------------------------------------------------- 内部

  private requireInvoice(rawId: string): { id: string; kind: InvoiceKind; amount_cents: number; date: string; counterparty: string } {
    const id = (rawId ?? '').trim()
    if (!/^INV-\d{8}-\d{3}$/.test(id)) throw new BadRequestError(`票编号格式应为 INV-YYYYMMDD-NNN，收到："${rawId ?? ''}"。`)
    const row = this.db.prepare('SELECT id, kind, amount_cents, date, counterparty FROM finance_invoices WHERE id = ? AND deleted_at IS NULL').get(id) as
      | { id: string; kind: InvoiceKind; amount_cents: number; date: string; counterparty: string }
      | undefined
    if (row === undefined) throw new NotFoundError(`找不到票 ${id}。`)
    return row
  }

  private requireEntry(rawId: string): { id: string; amount_cents: number; date: string; counterparty: string; type: EntryType } {
    const id = (rawId ?? '').trim()
    if (!ID_PATTERN.test(id)) throw new BadRequestError(`账目编号格式应为 FIN-YYYYMMDD-NNN，收到："${rawId ?? ''}"。`)
    // 冲销对（冲销行/被冲销行）不在挂联语义里：它们是红字更正，不该再收票——与 forInvoice 候选口径对齐
    const row = this.db
      .prepare(
        "SELECT id, amount_cents, date, counterparty, type FROM finance_entries WHERE id = ? AND deleted_at IS NULL AND status != 'cancelled' AND reverses = '' AND reversed_by = ''",
      )
      .get(id) as { id: string; amount_cents: number; date: string; counterparty: string; type: EntryType } | undefined
    if (row === undefined) throw new NotFoundError(`找不到在账的账目 ${id}。`)
    return row
  }
}

interface EntryRow {
  id: string
  date: string
  type: EntryType
  amount_cents: number
  counterparty: string
  status: string
}

interface InvoiceRow {
  id: string
  kind: InvoiceKind
  number: string
  date: string
  amount_cents: number
  counterparty: string
  status: string
}

/** 打分纯函数：金额/日期/对方三信号，分项拼成人话 reason。 */
function scoreRow(
  amountA: number,
  dateA: string,
  cpA: string,
  row: { amount_cents: number; date: string; counterparty: string },
): { score: number; reason: string } {
  const parts: string[] = []
  let s = 0
  if (amountA === row.amount_cents) {
    s += 4
    parts.push('金额一致')
  }
  const days = Math.abs(Date.parse(dateA) - Date.parse(row.date)) / DAY_MS
  if (days <= 7) {
    s += 2
    parts.push(days === 0 ? '同一天' : `日期差 ${Math.round(days)} 天`)
  } else if (days <= 31) {
    s += 1
    parts.push(`日期差 ${Math.round(days)} 天`)
  }
  const a = cpA.trim()
  const b = row.counterparty.trim()
  if (a !== '' && b !== '') {
    if (a === b) {
      s += 2
      parts.push('对方相同')
    } else if ((a.includes(b) || b.includes(a)) && Math.min(a.length, b.length) >= 2) {
      s += 1
      parts.push('对方名吻合')
    }
  }
  return { score: s, reason: parts.length > 0 ? parts.join('；') : '弱相关' }
}

/** 阈值过滤 + 排序 + 截断（≥2 分才值得人看一眼；最多 8 条防刷屏）。 */
function rank<T>(candidates: { row: T; score: number; reason: string }[]): { row: T; score: number; reason: string }[] {
  return candidates
    .filter((c) => c.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
}

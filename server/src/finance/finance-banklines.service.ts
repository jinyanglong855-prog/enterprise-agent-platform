/** 银行流水逐笔比对域（口袋维，任务全图 B1，2026-10-26）：
 *  网银导出的流水明细（CSV）导入本表（不是账本——账本事实源仍只有 finance_entries），与账本
 *  "动了钱的流水"逐笔比对：对上的、银行有账本没有的、账本有银行没有的，三张清单。
 *  §0.5 守门：比对只出清单不调平——银行有的要补记走正常记账，账本多的要人确认在途/记错；
 *  自动配对只是建议（金额相等+方向相同+日期差 ≤3 天贪心最近），人工确认（matched_entry_id）优先于自动。
 *  同一账户同一流水指纹幂等：重复导入整份对账单不会翻倍。 */
import { createHash } from 'node:crypto'
import type { DB } from '../db/database.js'
import { nowIso } from '../db/database.js'
import type { AuditService } from '../audit/audit.service.js'
import { BadRequestError, NotFoundError } from '../errors.js'
import { OUT_TYPES, type Actor, type EntryType } from './finance.types.js'
import { centsToYuan, localDate, parseDate, parseAmount, r2, yuanToCents } from './finance.util.js'
import { IMPORT_MAX_BYTES, IMPORT_MAX_ROWS, parseDelimited, resolveDelimiter } from './finance-imports.service.js'

/** 固定模板（v1）：网银导出后照列头整理，或直接在弹窗里粘两列以上的文本。 */
export const BANK_TEMPLATE_HEADER = ['日期', '方向', '金额', '对方', '流水号', '备注'] as const
export const BANK_TEMPLATE_EXAMPLE: string[][] = [
  ['2026-10-08', '收入', '12000.00', '甬城科技', 'BK20261008001', '10 月货款'],
  ['2026-10-09', '支出', '368.50', '顺丰速运', 'BK20261009002', '快递费'],
]

const DIRECTION_IN = new Set(['收入', '转入', '收款', '收', 'in'])
const DIRECTION_OUT = new Set(['支出', '转出', '付款', '支', 'out'])

/** 自动配对允许的最大日期差（天）：跨 3 天以上的同名同额大概率是两回事，留给人工。 */
const AUTO_MATCH_DAY_WINDOW = 3

export interface BankLineRecord {
  id: number
  account: string
  date: string
  direction: 'in' | 'out'
  amount: number
  counterparty: string
  ref: string
  note: string
  matched_entry_id: string
  batch: string
  created_by: string
  created_at: string
}

export class FinanceBankLinesService {
  constructor(
    private readonly db: DB,
    private readonly audit: AuditService,
  ) {}

  template(): { header: string[]; example: string[][]; csv: string } {
    const csv = [BANK_TEMPLATE_HEADER as readonly string[], ...BANK_TEMPLATE_EXAMPLE].map((r) => r.join(',')).join('\n')
    return { header: [...BANK_TEMPLATE_HEADER], example: BANK_TEMPLATE_EXAMPLE, csv }
  }

  /** 导入一批流水行：解析+逐行校验，指纹重复（库里已有）跳过并计数，其余插入。
   *  全部行都重复不算错（重复导入同一份对账单是正常操作），如实返回 skipped。 */
  importLines(
    actor: Actor,
    input: { account?: unknown; text?: unknown },
  ): { account: string; batch: string; inserted: number; skipped: number; total: number } {
    const account = typeof input.account === 'string' ? input.account.trim() : ''
    if (account === '') throw new BadRequestError('需要 account（账户名，与账户页一致）。')
    const acc = this.db.prepare('SELECT name FROM finance_accounts WHERE name = ?').get(account) as { name: string } | undefined
    if (acc === undefined) throw new NotFoundError(`找不到账户"${account}"。先在账户页建档再导流水。`)
    const text = input.text
    if (typeof text !== 'string' || text.trim() === '') throw new BadRequestError('需要 text（对账单 CSV 文本）。')
    if (Buffer.byteLength(text, 'utf8') > IMPORT_MAX_BYTES) {
      throw new BadRequestError(`导入内容超过 ${IMPORT_MAX_BYTES / 1024 / 1024} MB 上限，请按月拆分。`)
    }
    const delimiter = resolveDelimiter(text)
    const table = parseDelimited(text.replace(/^\uFEFF/, ''), delimiter)
    const lines = table.map((cells, i) => ({ line: i + 1, cells })).filter((r) => r.cells.some((c) => c.trim() !== ''))
    if (lines.length === 0) throw new BadRequestError('导入内容没有有效数据行。')
    const header = lines[0]!.cells.map((c) => c.trim())
    const missing = BANK_TEMPLATE_HEADER.filter((h) => !header.includes(h))
    if (missing.length > 0) {
      throw new BadRequestError(`列头缺 ${missing.join('、')}。第一行应为：${BANK_TEMPLATE_HEADER.join(',')}（金额恒正，方向列写 收入/支出）。`)
    }
    const dataLines = lines.slice(1)
    if (dataLines.length === 0) throw new BadRequestError('只有列头没有数据行。')
    if (dataLines.length > IMPORT_MAX_ROWS) {
      throw new BadRequestError(`单批最多 ${IMPORT_MAX_ROWS} 行，本次 ${dataLines.length} 行，请按月拆分。`)
    }
    const col = (name: string) => header.indexOf(name)

    const batch = `BK-${Date.now().toString(36)}`
    let inserted = 0
    let skipped = 0
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO finance_bank_lines
         (account, date, direction, amount_cents, counterparty, ref, note, fp, batch, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const { line, cells } of dataLines) {
      const date = (cells[col('日期')!] ?? '').trim()
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BadRequestError(`第 ${line} 行日期"${date}"不是 YYYY-MM-DD。`)
      parseDate(date, `第 ${line} 行日期`)
      const dirRaw = (cells[col('方向')!] ?? '').trim()
      const direction = DIRECTION_IN.has(dirRaw) ? 'in' : DIRECTION_OUT.has(dirRaw) ? 'out' : null
      if (direction === null) throw new BadRequestError(`第 ${line} 行方向"${dirRaw}"认不出（收入/支出/转入/转出/in/out）。`)
      const amountRaw = (cells[col('金额')!] ?? '').trim()
      const amount = parseAmount(amountRaw, `第 ${line} 行金额`)
      const counterparty = (cells[col('对方')!] ?? '').trim().slice(0, 100)
      const ref = (cells[col('流水号')!] ?? '').trim().slice(0, 100)
      const note = (cells[col('备注')!] ?? '').trim().slice(0, 300)
      const fp = createHash('sha1').update(`${account}|${date}|${direction}|${yuanToCents(amount)}|${ref}|${counterparty}`).digest('hex')
      const done = insert.run(account, date, direction, yuanToCents(amount), counterparty, ref, note, fp, batch, actor.username, nowIso())
      if (Number(done.changes) > 0) inserted += 1
      else skipped += 1
    }
    this.audit.log({
      username: actor.username,
      source: actor.source,
      action: 'banklines.import',
      targetId: batch,
      detail: { account, inserted, skipped, total: dataLines.length },
    })
    return { account, batch, inserted, skipped, total: dataLines.length }
  }

  list(filter: { account?: string; month?: string; matched?: string; limit?: number }): { count: number; lines: BankLineRecord[] } {
    const clauses: string[] = []
    const params: unknown[] = []
    if (filter.account !== undefined && filter.account.trim() !== '') {
      clauses.push('account = ?')
      params.push(filter.account.trim())
    }
    if (filter.month !== undefined) {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(filter.month)) throw new BadRequestError(`month 格式应为 YYYY-MM，收到："${filter.month}"。`)
      clauses.push('substr(date, 1, 7) = ?')
      params.push(filter.month)
    }
    if (filter.matched === 'yes') clauses.push("matched_entry_id != ''")
    if (filter.matched === 'no') clauses.push("matched_entry_id = ''")
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const limit = Math.max(1, filter.limit ?? 200)
    const rows = this.db
      .prepare(`SELECT * FROM finance_bank_lines ${where} ORDER BY date ASC, id ASC LIMIT ?`)
      .all(...params, limit) as BankLineRow[]
    return { count: rows.length, lines: rows.map(toRecord) }
  }

  /** 人工确认/解除配对：matched_entry_id='' 解除；否则账目必须存在且在账。
   *  只记结论不调平：金额对不上也允许确认（人可能故意配——部分收付/手续费差额），差异在报告里可见。 */
  setMatch(actor: Actor, rawId: number, matchedEntryId: string): BankLineRecord {
    const row = this.requireRow(rawId)
    const id = (matchedEntryId ?? '').trim()
    if (id !== '') {
      if (!/^FIN-\d{8}-\d{3}$/.test(id)) throw new BadRequestError(`账目编号格式应为 FIN-YYYYMMDD-NNN，收到："${matchedEntryId ?? ''}"。`)
      const entry = this.db
        .prepare('SELECT id, status, type FROM finance_entries WHERE id = ? AND deleted_at IS NULL')
        .get(id) as { id: string; status: string; type: EntryType } | undefined
      if (entry === undefined) throw new NotFoundError(`找不到账目 ${id}。可先在台账核对编号。`)
      if (entry.status === 'cancelled') throw new BadRequestError(`账目 ${id} 已作废（不计入统计），不给配对。`)
      if (entry.type === 'invoice') throw new BadRequestError(`账目 ${id} 是开票登记（不动钱），银行流水配到实际收付的那笔记。`)
    }
    this.db.prepare('UPDATE finance_bank_lines SET matched_entry_id = ? WHERE id = ?').run(id, row.id)
    this.audit.log({
      username: actor.username,
      source: actor.source,
      action: 'banklines.match',
      targetId: String(row.id),
      detail: { account: row.account, entry_id: id, previous: row.matched_entry_id },
    })
    return this.byRow(row.id)
  }

  remove(actor: Actor, rawId: number): void {
    const row = this.requireRow(rawId)
    this.db.prepare('DELETE FROM finance_bank_lines WHERE id = ?').run(row.id)
    this.audit.log({
      username: actor.username,
      source: actor.source,
      action: 'banklines.delete',
      targetId: String(row.id),
      detail: { account: row.account, date: row.date, amount: centsToYuan(row.amount_cents) },
    })
  }

  /** 逐笔比对报告：窗口内银行流水 vs 账本动钱流水，人工配对优先，剩余走自动建议，两头余量各成清单。 */
  report(input: { account?: unknown; from?: unknown; to?: unknown }): BankReport {
    const account = typeof input.account === 'string' ? input.account.trim() : ''
    if (account === '') throw new BadRequestError('需要 account（账户名）。')
    const acc = this.db.prepare('SELECT name FROM finance_accounts WHERE name = ?').get(account) as { name: string } | undefined
    if (acc === undefined) throw new NotFoundError(`找不到账户"${account}"。`)
    const from = typeof input.from === 'string' && input.from.trim() !== '' ? parseDate(input.from, 'from') : this.earliestLineDate(account)
    const to = typeof input.to === 'string' && input.to.trim() !== '' ? parseDate(input.to, 'to') : localDate()
    if (from === undefined || to === undefined || from > to) {
      throw new BadRequestError(`比对窗口不合法：from=${from ?? '（空）'} to=${to ?? '（空）'}。该账户还没有导入流水时请显式给 from。`)
    }

    const lineRows = this.db
      .prepare('SELECT * FROM finance_bank_lines WHERE account = ? AND date >= ? AND date <= ? ORDER BY date ASC, id ASC')
      .all(account, from, to) as BankLineRow[]
    const bookFlows = this.bookFlows(account, from, to)

    // 人工配对先落位；被人工认领的账目与流水退出自动候选
    const entryById = new Map(bookFlows.map((f) => [f.entry_id, f]))
    const claimedEntries = new Set<string>()
    const matched: BankMatch[] = []
    const pendingLines: BankLineRow[] = []
    for (const line of lineRows) {
      if (line.matched_entry_id !== '') {
        const flow = entryById.get(line.matched_entry_id)
        matched.push({ line: toRecord(line), entry_id: line.matched_entry_id, entry_date: flow?.date ?? '', how: 'manual' })
        if (flow !== undefined) claimedEntries.add(flow.entry_id)
      } else {
        pendingLines.push(line)
      }
    }

    // 自动建议：金额相等+方向相同，贪心取日期最近且未被认领的；日期差 ≤3 天才算自动猜中
    const remaining = bookFlows.filter((f) => !claimedEntries.has(f.entry_id))
    const taken = new Set<number>()
    const bankOnly: BankLineRecord[] = []
    for (const line of pendingLines) {
      let bestIdx = -1
      let bestDiff = Number.POSITIVE_INFINITY
      for (let i = 0; i < remaining.length; i++) {
        if (taken.has(i)) continue
        const flow = remaining[i]!
        if (flow.direction !== line.direction || flow.moved !== centsToYuan(line.amount_cents)) continue
        const diff = Math.abs(Date.parse(flow.date) - Date.parse(line.date)) / 86400000
        if (diff > AUTO_MATCH_DAY_WINDOW) continue
        if (diff < bestDiff) {
          bestIdx = i
          bestDiff = diff
        }
      }
      if (bestIdx >= 0) {
        const flow = remaining[bestIdx]!
        taken.add(bestIdx)
        matched.push({ line: toRecord(line), entry_id: flow.entry_id, entry_date: flow.date, how: 'auto' })
      } else {
        bankOnly.push(toRecord(line))
      }
    }
    const bookOnly = remaining.filter((_, i) => !taken.has(i))

    const lineRecords = lineRows.map(toRecord)
    const sum = (rows: BankLineRecord[], dir: 'in' | 'out') => r2(rows.filter((l) => l.direction === dir).reduce((s, l) => s + l.amount, 0))
    const bookSum = (rows: BookFlow[], dir: 'in' | 'out') => r2(rows.filter((f) => f.direction === dir).reduce((s, f) => s + f.moved, 0))
    const hint = buildBankHint(matched.length, bankOnly.length, bookOnly.length, from, to)
    return {
      account,
      from,
      to,
      matched,
      bank_only: bankOnly,
      book_only: bookOnly,
      totals: {
        bank_in: sum(lineRecords, 'in'),
        bank_out: sum(lineRecords, 'out'),
        book_in: bookSum(bookFlows, 'in'),
        book_out: bookSum(bookFlows, 'out'),
        matched: matched.length,
        manual: matched.filter((m) => m.how === 'manual').length,
        auto: matched.filter((m) => m.how === 'auto').length,
      },
      hint,
    }
  }

  // --------------------------------------------------------------- 内部

  private earliestLineDate(account: string): string | undefined {
    const row = this.db.prepare('SELECT MIN(date) AS d FROM finance_bank_lines WHERE account = ?').get(account) as { d: string | null }
    return row.d ?? undefined
  }

  /** 账本侧动钱流水：口径与 finance-flow/银行对账完全一致（已付全额/部分按已付、未收付不算、
   *  作废跳过、开票登记不动钱、冲销条目方向取反），外加窗口过滤。 */
  private bookFlows(account: string, from: string, to: string): BookFlow[] {
    const rows = this.db
      .prepare(
        `SELECT id, date, type, amount_cents, paid_amount_cents, status, counterparty, note, reverses
         FROM finance_entries
         WHERE deleted_at IS NULL AND status != 'cancelled' AND account = ? AND date >= ? AND date <= ?
         ORDER BY date ASC, id ASC`,
      )
      .all(account, from, to) as {
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
    const out: BookFlow[] = []
    for (const row of rows) {
      if (row.type === 'invoice') continue
      const settled = row.status === 'paid'
      const partial = row.status === 'partial' || (row.paid_amount_cents > 0 && !settled)
      const movedCents = settled ? row.amount_cents : partial ? row.paid_amount_cents : 0
      if (movedCents === 0) continue
      const baseOut = (OUT_TYPES as readonly string[]).includes(row.type)
      const direction: 'in' | 'out' = row.reverses !== '' ? (baseOut ? 'in' : 'out') : baseOut ? 'out' : 'in'
      out.push({
        entry_id: row.id,
        date: row.date,
        type: row.type,
        moved: centsToYuan(movedCents),
        direction,
        counterparty: row.counterparty,
        note: row.note,
        reverses: row.reverses,
      })
    }
    return out
  }

  private byRow(id: number): BankLineRecord {
    return toRecord(this.requireRow(id))
  }

  private requireRow(id: number): BankLineRow {
    if (!Number.isInteger(id) || id <= 0) throw new BadRequestError(`流水行 id 应为正整数，收到："${id}"。`)
    const row = this.db.prepare('SELECT * FROM finance_bank_lines WHERE id = ?').get(id) as BankLineRow | undefined
    if (row === undefined) throw new NotFoundError(`找不到流水行 #${id}。`)
    return row
  }
}

export interface BookFlow {
  entry_id: string
  date: string
  type: EntryType
  moved: number
  direction: 'in' | 'out'
  counterparty: string
  note: string
  reverses: string
}

export interface BankMatch {
  line: BankLineRecord
  entry_id: string
  entry_date: string
  how: 'manual' | 'auto'
}

export interface BankReport {
  account: string
  from: string
  to: string
  matched: BankMatch[]
  /** 银行有、账本没有（或没对上）：候选动作=补记账目，或人工配到金额不同的账（手续费/部分收付） */
  bank_only: BankLineRecord[]
  /** 账本动了钱、银行窗口内没有：候选动作=确认在途、记错账户，或漏导流水 */
  book_only: BookFlow[]
  totals: {
    bank_in: number
    bank_out: number
    book_in: number
    book_out: number
    matched: number
    manual: number
    auto: number
  }
  hint: string
}

interface BankLineRow {
  id: number
  account: string
  date: string
  direction: string
  amount_cents: number
  counterparty: string
  ref: string
  note: string
  fp: string
  matched_entry_id: string
  batch: string
  created_by: string
  created_at: string
}

function toRecord(row: BankLineRow): BankLineRecord {
  return {
    id: row.id,
    account: row.account,
    date: row.date,
    direction: row.direction as 'in' | 'out',
    amount: centsToYuan(row.amount_cents),
    counterparty: row.counterparty,
    ref: row.ref,
    note: row.note,
    matched_entry_id: row.matched_entry_id,
    batch: row.batch,
    created_by: row.created_by,
    created_at: row.created_at,
  }
}

function buildBankHint(matched: number, bankOnly: number, bookOnly: number, from: string, to: string): string {
  if (matched > 0 && bankOnly === 0 && bookOnly === 0) {
    return `${from} 至 ${to} 共 ${matched} 笔全部逐笔对上，银行与账本一致。`
  }
  const parts: string[] = [`${from} 至 ${to}：对上 ${matched} 笔。`]
  if (bankOnly > 0) {
    parts.push(`银行有而账本没有 ${bankOnly} 笔——通常是还没记账（手续费、利息、代扣最常见）或记到了别的账户，补记走正常记账，金额对不上可人工配对说明差异。`)
  }
  if (bookOnly > 0) {
    parts.push(`账本动了钱而银行没有 ${bookOnly} 笔——通常是在途（刚记还没到账/刚付还没扣）、记错账户或漏导流水；确认是哪种，别急着改账。`)
  }
  parts.push('比对只出清单不调平：补记与修正都走正常记账/冲销路径。')
  return parts.join('')
}

/** 报表与打包域（2026-10-26，任务全图 C4/A8/F5/E5 一次性补齐）：
 *  · 凭证对照清单（C4 归档维/证据维）：当月每笔账的票/附件/银行配对三路证据现状，人按清单整理单据；
 *  · 往来对账单（A8）：按对方出"期初未结→期间明细→期末未结"的对账单，口径与汇总页一致（截至期末累计未收付）；
 *  · 检查应答包（F5）：指定期间的账面数字+逐笔明细+票据对照打包成 md，专管员/代账要数时一份给出；
 *  · 年度归档导出（E5 归档维）：全年数据一个 JSON 包+逐节 sha256 清单——"不可变"靠哈希清单：
 *    复核=重新导出比对清单哈希；附件只出索引（文件名/大小/sha256），二进制随 attachments 目录另行备份。
 *  全部只读不落库；应答包与对账单是"账面口径"，声明写进包里。 */
import { createHash } from 'node:crypto'
import type { DB } from '../db/database.js'
import { BadRequestError } from '../errors.js'
import { OUT_TYPES, type EntryType } from './finance.types.js'
import { flowByAccountCents } from './finance-flow.js'
import { centsToYuan, localDate, parseDate, r2 } from './finance.util.js'
import type { FinanceService } from './finance.service.js'

const ENTRY_COLUMNS = `id, date, type, amount_cents, status, counterparty, category, account, invoice_no, due_date, paid_amount_cents, note, approved_by, reverses, reversed_by, created_by, updated_by, updated_at`
const ARCHIVE_MAX_BANK_LINES = 5000
const PACK_MAX_ROWS = 500

function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

interface EntryRowLite {
  id: string
  date: string
  type: EntryType
  amount_cents: number
  paid_amount_cents: number
  status: string
  counterparty: string
  category: string
  account: string
  invoice_no: string
  note: string
  reverses: string
  reversed_by: string
}

export class FinanceReportsService {
  constructor(
    private readonly db: DB,
    private readonly finance: FinanceService,
  ) {}

  // ------------------------------------------------------------- C4 凭证对照清单

  evidenceChecklist(rawMonth?: string) {
    const month = rawMonth === undefined || rawMonth.trim() === '' ? localDate().slice(0, 7) : requireMonth(rawMonth)
    const rows = this.db
      .prepare(
        `SELECT ${ENTRY_COLUMNS} FROM finance_entries
         WHERE deleted_at IS NULL AND status != 'cancelled' AND reverses = '' AND reversed_by = ''
           AND type != 'invoice' AND substr(date, 1, 7) = ?
         ORDER BY date ASC, id ASC`,
      )
      .all(month) as EntryRowLite[]
    const entries = rows.map((r) => {
      const linkedHeld = (
        this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM finance_invoice_links l JOIN finance_invoices i ON i.id = l.invoice_id
             WHERE l.entry_id = ? AND i.deleted_at IS NULL AND i.status = 'held'`,
          )
          .get(r.id) as { n: number }
      ).n
      const attachments = (
        this.db.prepare('SELECT COUNT(*) AS n FROM finance_attachments WHERE entry_id = ? AND deleted_at IS NULL').get(r.id) as { n: number }
      ).n
      const bankMatches = (
        this.db.prepare('SELECT COUNT(*) AS n FROM finance_bank_lines WHERE matched_entry_id = ?').get(r.id) as { n: number }
      ).n
      const missing: string[] = []
      if (r.invoice_no === '' && linkedHeld === 0) missing.push('票')
      if (attachments === 0) missing.push('附件')
      return {
        id: r.id,
        date: r.date,
        type: r.type,
        amount: centsToYuan(r.amount_cents),
        counterparty: r.counterparty,
        category: r.category,
        evidence: {
          invoice_no: r.invoice_no,
          linked_held_invoices: linkedHeld,
          attachments,
          bank_matches: bankMatches,
        },
        /** 凭证齐=有票（票号或挂"在手"票）或有附件；银行配对是核对信号不是单据 */
        voucher_ok: missing.length < 2,
        missing,
      }
    })
    const withVoucher = entries.filter((e) => e.voucher_ok).length
    const bankMatched = entries.filter((e) => e.evidence.bank_matches > 0).length
    return {
      month,
      count: entries.length,
      with_voucher: withVoucher,
      missing_voucher: entries.length - withVoucher,
      bank_matched: bankMatched,
      entries,
      hint:
        entries.length === 0
          ? `${month} 没有需要整理凭证的账目。`
          : `${month} 共 ${entries.length} 笔账，已有票或附件的 ${withVoucher} 笔、缺的 ${entries.length - withVoucher} 笔；其中 ${bankMatched} 笔已与银行流水对上。缺的按"整理一张补一张"来：回单/发票文件在台账详情里传附件，票在票夹登记挂联。`,
    }
  }

  // ------------------------------------------------------------- A8 往来对账单

  counterpartyStatement(input: { counterparty?: unknown; from?: unknown; to?: unknown }) {
    const cp = typeof input.counterparty === 'string' ? input.counterparty.trim() : ''
    if (cp === '') throw new BadRequestError('需要 counterparty（对方名称，支持部分匹配）。')
    const year = localDate().slice(0, 4)
    const from = parseDate(typeof input.from === 'string' ? input.from : undefined, 'from') ?? `${year}-01-01`
    const to = parseDate(typeof input.to === 'string' ? input.to : undefined, 'to') ?? localDate()
    if (from > to) throw new BadRequestError(`from（${from}）不能晚于 to（${to}）。`)

    const pattern = `%${escapeLike(cp)}%`
    const base = `FROM finance_entries WHERE deleted_at IS NULL AND status != 'cancelled' AND reverses = '' AND reversed_by = '' AND counterparty LIKE ? ESCAPE '\\'`
    const outstanding = (until: string, strictBefore: boolean) => {
      const rows = this.db
        .prepare(`SELECT type, amount_cents, paid_amount_cents, status ${base} AND date ${strictBefore ? '<' : '<='} ?`)
        .all(pattern, until) as { type: EntryType; amount_cents: number; paid_amount_cents: number; status: string }[]
      let receivable = 0
      let payable = 0
      for (const r of rows) {
        if (r.status === 'paid') continue
        const partial = r.status === 'partial' || r.paid_amount_cents > 0
        const balance = partial ? r.amount_cents - r.paid_amount_cents : r.amount_cents
        if (balance <= 0) continue
        if (r.type === 'income') receivable += balance
        else if ((OUT_TYPES as readonly string[]).includes(r.type)) payable += balance
      }
      return { receivable: r2(centsToYuan(receivable)), payable: r2(centsToYuan(payable)) }
    }

    const lineRows = this.db
      .prepare(`SELECT ${ENTRY_COLUMNS} ${base} AND date >= ? AND date <= ? ORDER BY date ASC, id ASC`)
      .all(pattern, from, to) as EntryRowLite[]
    const lines = lineRows.map((r) => ({
      id: r.id,
      date: r.date,
      type: r.type,
      counterparty: r.counterparty,
      category: r.category,
      amount: centsToYuan(r.amount_cents),
      paid: centsToYuan(r.paid_amount_cents),
      status: r.status,
      note: r.note,
    }))
    const sumOf = (pred: (t: EntryType) => boolean, field: 'amount' | 'paid') =>
      r2(lines.filter((l) => pred(l.type)).reduce((s, l) => s + l[field], 0))
    const opening = outstanding(from, true)
    const closing = outstanding(to, false)
    return {
      counterparty: cp,
      from,
      to,
      opening,
      closing,
      totals: {
        income: sumOf((t) => t === 'income' || t === 'invoice', 'amount'),
        outflow: sumOf((t) => (OUT_TYPES as readonly string[]).includes(t), 'amount'),
        received: sumOf((t) => t === 'income' || t === 'invoice', 'paid'),
        paid_out: sumOf((t) => (OUT_TYPES as readonly string[]).includes(t), 'paid'),
      },
      lines,
      hint: `口径：余额=截至该日累计未收付（未付全额/部分付算差额），不是当月发生额；作废账与冲销对不进对账单。totals.income 含"开票登记"账（type=invoice，只开了票还没收款的账），与对方核对金额时以明细为准。期间共 ${lines.length} 笔。与对方核对时按 id 下钻到台账明细。`,
    }
  }

  // ------------------------------------------------------------- F5 检查应答包

  inspectionPack(input: { from?: unknown; to?: unknown }) {
    const year = localDate().slice(0, 4)
    const from = parseDate(typeof input.from === 'string' ? input.from : undefined, 'from') ?? `${year}-01-01`
    const to = parseDate(typeof input.to === 'string' ? input.to : undefined, 'to') ?? localDate()
    if (from > to) throw new BadRequestError(`from（${from}）不能晚于 to（${to}）。`)

    const rows = this.db
      .prepare(
        `SELECT ${ENTRY_COLUMNS} FROM finance_entries
         WHERE deleted_at IS NULL AND status != 'cancelled' AND date >= ? AND date <= ?
         ORDER BY date ASC, id ASC`,
      )
      .all(from, to) as EntryRowLite[]
    const truncated = rows.length > PACK_MAX_ROWS
    const shown = truncated ? rows.slice(0, PACK_MAX_ROWS) : rows

    // 分型合计（冲销条目按负计入，与汇总页口径一致）
    const byType = new Map<string, { total: number; count: number }>()
    for (const r of rows) {
      const sign = r.reverses !== '' ? -1 : 1
      const e = byType.get(r.type) ?? { total: 0, count: 0 }
      e.total = r2(e.total + sign * centsToYuan(r.amount_cents))
      e.count += 1
      byType.set(r.type, e)
    }

    const profileRows = this.db.prepare('SELECT key, value FROM finance_profile ORDER BY key').all() as { key: string; value: string }[]
    const invoiceRows = this.db
      .prepare(
        `SELECT id, kind, number, date, amount_cents, counterparty, status FROM finance_invoices
         WHERE deleted_at IS NULL AND date >= ? AND date <= ? ORDER BY date ASC, id ASC`,
      )
      .all(from, to) as { id: string; kind: string; number: string; date: string; amount_cents: number; counterparty: string; status: string }[]

    const md: string[] = []
    md.push(`# 财务检查应答包（${from} 至 ${to}）`)
    md.push('')
    md.push(`- 生成时间：${new Date().toLocaleString('zh-CN')}（账面口径即时导出）`)
    md.push('- 口径声明：本包是账面记录的打包，不是会计核算结果；金额均为人民币元；作废账不列入，冲销条目按负计入并保留原账。')
    md.push('')
    md.push('## 一、期间合计')
    md.push('')
    md.push('| 类型 | 笔数 | 合计(元) |')
    md.push('| --- | ---: | ---: |')
    for (const t of ['income', 'expense', 'reimburse', 'payroll', 'tax', 'invoice']) {
      const e = byType.get(t)
      if (e === undefined) continue
      md.push(`| ${TYPE_LABELS[t] ?? t} | ${e.count} | ${e.total.toFixed(2)} |`)
    }
    md.push('')
    md.push('## 二、建档参数（档案概要）')
    md.push('')
    for (const p of profileRows) md.push(`- ${p.key}：${p.value === '' ? '（未填）' : p.value}`)
    md.push('')
    md.push('## 三、逐笔明细' + (truncated ? `（仅前 ${PACK_MAX_ROWS} 笔，全期 ${rows.length} 笔——需要完整明细请分期间导出）` : `（共 ${rows.length} 笔）`))
    md.push('')
    md.push('| 编号 | 日期 | 类型 | 对方 | 分类 | 金额(元) | 状态 | 冲销 |')
    md.push('| --- | --- | --- | --- | --- | ---: | --- | --- |')
    for (const r of shown) {
      md.push(
        `| ${r.id} | ${r.date} | ${TYPE_LABELS[r.type] ?? r.type} | ${r.counterparty || '—'} | ${r.category || '—'} | ${centsToYuan(r.amount_cents).toFixed(2)} | ${r.status} | ${r.reversed_by !== '' ? `被冲销(${r.reversed_by})` : r.reverses !== '' ? `冲销(${r.reverses})` : ''} |`,
      )
    }
    md.push('')
    md.push('## 四、票据对照（期间内票期）')
    md.push('')
    if (invoiceRows.length === 0) {
      md.push('（本期间没有登记票据）')
    } else {
      md.push('| 编号 | 方向 | 票号 | 日期 | 金额(元) | 对方 | 状态 |')
      md.push('| --- | --- | --- | --- | ---: | --- | --- |')
      for (const v of invoiceRows) {
        md.push(`| ${v.id} | ${v.kind} | ${v.number || '—'} | ${v.date} | ${centsToYuan(v.amount_cents).toFixed(2)} | ${v.counterparty || '—'} | ${v.status} |`)
      }
    }
    md.push('')
    md.push('> 每个数字可下钻：管理系统台账按编号查原账；票在票夹；附件索引见各账详情。')

    return { from, to, markdown: md.join('\n'), entry_count: rows.length, truncated, invoice_count: invoiceRows.length }
  }

  // ------------------------------------------------------------- E5 年度归档导出

  annualArchive(rawYear: unknown) {
    const year = typeof rawYear === 'string' || typeof rawYear === 'number' ? String(rawYear).trim() : ''
    if (!/^\d{4}$/.test(year)) throw new BadRequestError(`year 应为 4 位年份（如 2026），收到："${String(rawYear ?? '')}"。`)

    const entries = this.db
      .prepare(
        `SELECT ${ENTRY_COLUMNS} FROM finance_entries
         WHERE substr(date, 1, 4) = ? ORDER BY date ASC, id ASC`,
      )
      .all(year) as EntryRowLite[]
    const entryIds = entries.map((e) => e.id)
    const invoices = this.db
      .prepare('SELECT * FROM finance_invoices WHERE substr(date, 1, 4) = ? ORDER BY date ASC, id ASC')
      .all(year) as { id: string; kind: string; number: string; date: string; amount_cents: number; counterparty: string; status: string; note: string; created_at: string }[]
    const links =
      entryIds.length === 0
        ? []
        : (this.db
            .prepare(`SELECT invoice_id, entry_id FROM finance_invoice_links WHERE entry_id IN (${entryIds.map(() => '?').join(',')})`)
            .all(...entryIds) as { invoice_id: string; entry_id: string }[])
    const accounts = (this.db.prepare('SELECT * FROM finance_accounts ORDER BY id ASC').all() as { id: number; name: string; kind: string; opening_balance_cents: number; archived_at: string | null }[]).map(
      (a) => ({
        name: a.name,
        kind: a.kind,
        opening_balance: centsToYuan(a.opening_balance_cents),
        balance: r2(centsToYuan(a.opening_balance_cents + (flowByAccountCents(this.db).get(a.name) ?? 0))),
        archived: a.archived_at !== null,
      }),
    )
    const monthly = Array.from({ length: 12 }, (_, i) => this.finance.summary(`${year}-${String(i + 1).padStart(2, '0')}`))
    const cashCounts = this.db
      .prepare('SELECT * FROM finance_cash_counts WHERE substr(as_of, 1, 4) = ? ORDER BY as_of ASC, id ASC')
      .all(year) as { id: number; account: string; as_of: string; counted_cents: number; book_cents: number; diff_cents: number; note: string; created_by: string; created_at: string }[]
    const bankLineCount = (this.db.prepare('SELECT COUNT(*) AS n FROM finance_bank_lines WHERE substr(date, 1, 4) = ?').get(year) as { n: number }).n
    const bankLines = this.db
      .prepare('SELECT * FROM finance_bank_lines WHERE substr(date, 1, 4) = ? ORDER BY date ASC, id ASC LIMIT ?')
      .all(year, ARCHIVE_MAX_BANK_LINES) as { id: number; account: string; date: string; direction: string; amount_cents: number; counterparty: string; ref: string; note: string; matched_entry_id: string }[]
    const attachments =
      entryIds.length === 0
        ? []
        : (this.db
            .prepare(
              `SELECT a.entry_id, a.file_name, a.ext, a.size, a.sha256, a.created_at FROM finance_attachments a
               JOIN finance_entries e ON e.id = a.entry_id
               WHERE substr(e.date, 1, 4) = ? AND a.deleted_at IS NULL ORDER BY a.id ASC`,
            )
            .all(year) as { entry_id: string; file_name: string; ext: string; size: number; sha256: string; created_at: string }[])
    const profileRows = this.db.prepare('SELECT key, value FROM finance_profile ORDER BY key').all() as { key: string; value: string }[]

    const data = {
      entries: entries.map(toArchiveEntry),
      invoices: invoices.map((v) => ({ ...v, amount: centsToYuan(v.amount_cents), amount_cents: undefined })),
      invoice_links: links,
      accounts,
      monthly_summaries: monthly,
      cash_counts: cashCounts.map((c) => ({ ...c, counted: centsToYuan(c.counted_cents), book: centsToYuan(c.book_cents), diff: centsToYuan(c.diff_cents), counted_cents: undefined, book_cents: undefined, diff_cents: undefined })),
      bank_lines: bankLines.map((l) => ({ ...l, amount: centsToYuan(l.amount_cents), amount_cents: undefined })),
      bank_lines_meta: { total: bankLineCount, truncated: bankLineCount > ARCHIVE_MAX_BANK_LINES, max: ARCHIVE_MAX_BANK_LINES },
      attachments_index: attachments,
      profile: Object.fromEntries(profileRows.map((p) => [p.key, p.value])),
    }
    const manifest: Record<string, { count: number; sha256: string }> = {}
    for (const [name, value] of Object.entries(data)) {
      manifest[name] = { count: Array.isArray(value) ? value.length : Object.keys(value).length, sha256: sha256Json(value) }
    }
    const bundle = {
      year,
      generated_at: new Date().toISOString(),
      kind: 'finance-annual-archive',
      notes: [
        '本包是账面数据的年度归档导出：逐节 sha256 清单在此，复核=用管理系统同年度重新导出并比对清单哈希。',
        '附件二进制不在包内（本表只列文件名与 sha256），随服务器 attachments 目录另行备份。',
        '金额单位=元，行金额恒正；冲销对以 reverses/reversed_by 字段标记（reverses=冲销哪笔，reversed_by=被哪笔冲销），不复述负数行。',
        'accounts.balance 是导出时点快照（期初+全期收付，含以后月份），不是年末冻结数；月度口径看 monthly_summaries。',
        `银行流水全年 ${bankLineCount} 行${bankLineCount > ARCHIVE_MAX_BANK_LINES ? `，超过单节上限只收前 ${ARCHIVE_MAX_BANK_LINES} 行（bank_lines_meta.truncated=true），复核时按季度分导` : '，全量在包内'}。`,
      ],
      manifest: { sections: manifest, bundle_sha256: '' },
      data,
    }
    bundle.manifest.bundle_sha256 = sha256Json(bundle.manifest.sections)
    return bundle
  }
}

// ------------------------------------------------------------------- 工具

function toArchiveEntry(r: EntryRowLite) {
  return {
    id: r.id,
    date: r.date,
    type: r.type,
    amount: centsToYuan(r.amount_cents),
    status: r.status,
    counterparty: r.counterparty,
    category: r.category,
    account: r.account,
    invoice_no: r.invoice_no,
    paid_amount: centsToYuan(r.paid_amount_cents),
    /** 冲销对以字段标记：reverses=本笔冲销哪笔，reversed_by=本笔被哪笔冲销；行金额恒正 */
    reverses: r.reverses,
    reversed_by: r.reversed_by,
    note: r.note,
  }
}

function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function requireMonth(value: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value.trim())) throw new BadRequestError(`month 格式应为 YYYY-MM，收到："${value}"。`)
  return value.trim()
}

const TYPE_LABELS: Record<string, string> = {
  income: '收入',
  expense: '支出',
  reimburse: '报销',
  payroll: '工资社保',
  tax: '税费',
  invoice: '发票',
}

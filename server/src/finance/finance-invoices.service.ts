/** 票域服务（证据维，任务全图 §0.4-3 票实体化）：
 *  票=独立实体（销项 sales/进项 purchase/内部凭证 internal），与账目条目多对多挂联
 *  （一票多笔、分期开票都装得下）；票同时是义务维原料（销项=计税依据）。
 *  entry.invoice_no 单字段保留向后兼容，票夹视角从这里长出来。 */
import type { DB } from '../db/database.js'
import { nowIso } from '../db/database.js'
import type { AuditService } from '../audit/audit.service.js'
import { BadRequestError, NotFoundError } from '../errors.js'
import {
  INVOICE_KIND_VALUES,
  INVOICE_STATUS_VALUES,
  type Actor,
  type EntryType,
  type InvoiceKind,
  type InvoiceStatus,
} from './finance.types.js'
import { centsToYuan, localDate, parseAmount, parseDate, yuanToCents } from './finance.util.js'
import { ID_PATTERN } from './finance.types.js'

export interface InvoiceRecord {
  id: string
  kind: InvoiceKind
  number: string
  date: string
  amount: number
  counterparty: string
  status: InvoiceStatus
  /** 红冲执行日（status=red 时有值；义务维口径：红冲冲减执行当月）。老红票可能为空串。 */
  red_date: string
  note: string
  entry_ids: string[]
  created_by: string
  updated_by: string
  updated_at: string
}

export interface InvoiceInput {
  kind?: string
  number?: string
  amount?: number | string
  date?: string
  counterparty?: string
  status?: string
  note?: string
}

export interface InvoiceFilter {
  kind?: string
  status?: string
  counterparty?: string
  month?: string
  /** 票号精确过滤（台账抽屉/深链定位某张票用）。 */
  number?: string
  limit?: number
}

export class FinanceInvoicesService {
  constructor(
    private readonly db: DB,
    private readonly audit: AuditService,
  ) {}

  create(actor: Actor, input: InvoiceInput): InvoiceRecord {
    const kind = this.requireKind(input.kind)
    const amount = parseAmount(input.amount, 'amount')
    const date = parseDate(input.date, 'date') ?? localDate()
    const id = this.allocateId(date)
    this.db
      .prepare(
        `INSERT INTO finance_invoices (id, kind, number, date, amount_cents, counterparty, status, note,
           created_at, created_by, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, 'held', ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        kind,
        (input.number ?? '').trim(),
        date,
        yuanToCents(amount),
        (input.counterparty ?? '').trim(),
        (input.note ?? '').trim(),
        nowIso(),
        actor.username,
        nowIso(),
        actor.username,
      )
    this.audit.log({
      username: actor.username,
      source: actor.source,
      action: 'invoice.create',
      targetId: id,
      detail: { kind, amount, date },
    })
    return this.getOne(id)
  }

  update(actor: Actor, rawId: string, input: InvoiceInput): InvoiceRecord {
    const row = this.requireRow(rawId)
    if (input.kind !== undefined) throw new BadRequestError('票的方向（销项/进项）不可改；记错了作废重录。')
    if (input.amount !== undefined) throw new BadRequestError('票面金额不可改；记错了作废重录（红冲语义后续接）。')
    const sets: string[] = []
    const values: unknown[] = []
    if (input.number !== undefined) {
      sets.push('number = ?')
      values.push(input.number.trim())
    }
    if (input.date !== undefined) {
      const newDate = parseDate(input.date, 'date') ?? localDate()
      // 票期两头都不许碰已出数月份：改进去=改申报数（对抗审查 P1-4）；改出去=已申报月份的证据被抽走
      // （2026-10-26 补齐 P2-1，按 §0.4"出数后只许冲销不许改"同构原则定默认：要修正走红冲）
      // 口径差异（与 guardStatusChange 对照）：改期只看票自身的原月/新月，不含挂联账月——
      // 改期动的是票期归属，申报按票期走，挂联账的月份不随票动；而状态变化改变证据本身的有效性，
      // 有效性牵连所有挂联月份的申报依据，所以状态守门用"票期月∪挂联账月"两边都守。
      const targetMonth = newDate.slice(0, 7)
      if (targetMonth !== row.date.slice(0, 7)) {
        if (this.isReportedMonth(targetMonth)) {
          throw new BadRequestError(`不能把票 ${row.id} 改期到 ${targetMonth}：该月数字已出数（给过代账/申报），票期不许改进去。`)
        }
        if (this.isReportedMonth(row.date.slice(0, 7))) {
          throw new BadRequestError(`不能把票 ${row.id} 从已出数的 ${row.date.slice(0, 7)} 改期出去：票一动该月申报数就对不上证据。要修正请走红冲（状态改 red），红票记当期。`)
        }
      }
      sets.push('date = ?')
      values.push(newDate)
    }
    if (input.counterparty !== undefined) {
      sets.push('counterparty = ?')
      values.push(input.counterparty.trim())
    }
    if (input.status !== undefined) {
      const next = this.requireStatus(input.status)
      this.guardStatusChange(row, next)
      sets.push('status = ?')
      values.push(next)
      if (next !== row.status) {
        // 红冲执行日只在真状态转换时落——同状态重复提交（编辑弹窗总是带 status 字段）若重写会把
        // 原执行日刷成今天，销项汇总的红冲冲减月就被搬走了（对抗审查 P0-1）；转回在手/作废则清掉——
        // 那两种状态下票不再是红冲，红冲额不应挂在任何月份上
        sets.push('red_date = ?')
        values.push(next === 'red' ? localDate() : '')
      }
    }
    if (input.note !== undefined) {
      sets.push('note = ?')
      values.push(input.note.trim())
    }
    if (sets.length > 0) {
      sets.push('updated_at = ?', 'updated_by = ?')
      values.push(nowIso(), actor.username)
      this.db.prepare(`UPDATE finance_invoices SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`).run(...values, row.id)
      this.audit.log({
        username: actor.username,
        source: actor.source,
        action: 'invoice.update',
        targetId: row.id,
        detail: { fields: Object.keys(input) },
      })
    }
    return this.getOne(row.id)
  }

  /** 票状态守门（2026-10-26 补齐审查 P2-1"留用户拍板"项；2026-11-01 义务维聚合落地后按审查 P1-1/P2-2 补两向）：
   *  规则按任务全图 §0.4"出数后只许冲销不许改"的票世界同构定默认——
   *  · 已出数月份的票禁作废（作废=把证据抽走；要修正走红冲，红冲是票的冲销，历史不被覆盖）；
   *  · 已出数月份的**红票也禁改作废**（red→voided 会把红冲记录一起蒸发，该月申报数的冲减凭空消失——
   *    聚合落地前状态位不进钱数没暴露，现在进了）；
   *  · 已出数月份的废票禁"复活"回在手（出数后再把证据变有效=追溯造证），**也禁作废直变红冲**
   *    （voided→red=无开票凭空冲减申报数）；
   *  · 在手→红冲放行（红冲不覆盖历史，与账目冲销同构——唯一放行的已出数月修正路径）。
   *  "已出数月份"=票自身票期月份 ∪ 挂联账目的月份：挂到已出数账上的票是该月证据，同样守。
   *  要放开（比如允许已出数月作废）=改这里的守门，当前默认从严。 */
  private guardStatusChange(row: InvoiceRow, next: InvoiceStatus): void {
    if (row.status === next) return
    const months = new Set<string>([row.date.slice(0, 7)])
    for (const l of this.db.prepare(
      'SELECT e.date FROM finance_invoice_links l JOIN finance_entries e ON e.id = l.entry_id WHERE l.invoice_id = ? AND e.deleted_at IS NULL',
    ).all(row.id) as { date: string }[]) {
      months.add(l.date.slice(0, 7))
    }
    const reported = [...months].filter((m) => this.isReportedMonth(m))
    if (reported.length === 0) return
    const where = reported.length === 1 ? reported[0]! : reported.join('、')
    if (next === 'voided') {
      const from = row.status === 'held' ? '改作废' : '从已红冲改作废'
      const why = row.status === 'held'
        ? '作废会把该月申报数的证据抽走'
        : '作废会把红冲记录一起蒸发，该月申报数的冲减凭空消失（红冲执行日照样在案）'
      throw new BadRequestError(`票 ${row.id} 关联已出数的 ${where}，不能${from}——${why}。要修正请走红冲（状态改 red），红冲冲减执行当月。（这是"出数后只许冲销不许改"的默认口径，要放开请明确说）`)
    }
    if (row.status === 'voided' && next === 'red') {
      throw new BadRequestError(`票 ${row.id} 关联已出数的 ${where}，不能从已作废直改红冲——作废票没有开票效力，直变红冲等于凭空冲减该月申报数。要红冲请先确认票本身有效（重录）。`)
    }
    if (next === 'held') {
      throw new BadRequestError(`票 ${row.id} 关联已出数的 ${where}，不能从 ${row.status === 'voided' ? '已作废' : '已红冲'}改回在手——出数后再把证据变有效等于追溯造证。（要放开请明确说）`)
    }
  }

  getOne(rawId: string): InvoiceRecord {
    const row = this.requireRow(rawId)
    const links = this.db
      .prepare('SELECT entry_id FROM finance_invoice_links WHERE invoice_id = ? ORDER BY entry_id ASC')
      .all(row.id) as { entry_id: string }[]
    return this.toRecord(row, links.map((l) => l.entry_id))
  }

  list(filter: InvoiceFilter): { count: number; total: number; invoices: InvoiceRecord[] } {
    if (filter.month !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(filter.month)) {
      throw new BadRequestError(`month 格式应为 YYYY-MM，收到："${filter.month}"。`)
    }
    const clauses = ['deleted_at IS NULL']
    const params: unknown[] = []
    if (filter.kind !== undefined) {
      clauses.push('kind = ?')
      params.push(filter.kind)
    }
    if (filter.status !== undefined) {
      clauses.push('status = ?')
      params.push(filter.status)
    }
    if (filter.counterparty !== undefined && filter.counterparty.trim() !== '') {
      clauses.push('counterparty LIKE ? ESCAPE \'\\\'')
      params.push(`%${escapeLike(filter.counterparty.trim())}%`)
    }
    if (filter.month !== undefined) {
      clauses.push('substr(date, 1, 7) = ?')
      params.push(filter.month)
    }
    if (filter.number !== undefined && filter.number.trim() !== '') {
      clauses.push('number = ?')
      params.push(filter.number.trim())
    }
    const where = clauses.join(' AND ')
    const limit = Math.max(1, filter.limit ?? 20)
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM finance_invoices WHERE ${where}`).get(...params) as { n: number }).n
    const rows = this.db
      .prepare(`SELECT * FROM finance_invoices WHERE ${where} ORDER BY id DESC LIMIT ?`)
      .all(...params, limit) as InvoiceRow[]
    const linkRows = this.db.prepare('SELECT invoice_id, entry_id FROM finance_invoice_links').all() as {
      invoice_id: string
      entry_id: string
    }[]
    const links = new Map<string, string[]>()
    for (const l of linkRows) {
      const arr = links.get(l.invoice_id) ?? []
      arr.push(l.entry_id)
      links.set(l.invoice_id, arr)
    }
    return { count: rows.length, total, invoices: rows.map((r) => this.toRecord(r, links.get(r.id) ?? [])) }
  }

  /** 销项计税聚合（义务维，任务全图 A5 残余 2026-11-01）：按月看开出去的票（计税参考口径）。
   *  开票=kind=sales 且 status=held 按票期归月；红冲按红冲执行日（red_date）冲减执行当月——申报口径；
   *  老红票缺执行日的按票期归月（ disclosed_rows 提示哪些月因此含估算）；作废票与进项/内部凭证不进来。
   *  备料非核算：申报以电子税务局为准。 */
  outputSummary(yearInput: unknown): OutputSummary {
    if (yearInput !== undefined && yearInput !== null && typeof yearInput !== 'string') {
      throw new BadRequestError('year 只收一个 YYYY 值（重复传参不接受）。')
    }
    const year = typeof yearInput === 'string' && yearInput.trim() !== '' ? yearInput.trim() : localDate().slice(0, 4)
    if (!/^\d{4}$/.test(year)) throw new BadRequestError(`year 格式应为 YYYY，收到："${String(yearInput)}"。`)
    const rows = this.db
      .prepare(`SELECT date, amount_cents, status, red_date FROM finance_invoices WHERE kind = 'sales' AND deleted_at IS NULL`)
      .all() as { date: string; amount_cents: number; status: string; red_date: string }[]
    const issued = new Map<string, number>()
    const red = new Map<string, number>()
    let legacyRedMonths = new Set<string>()
    for (const r of rows) {
      const issueMonth = r.date.slice(0, 7)
      if (r.status === 'held') issued.set(issueMonth, (issued.get(issueMonth) ?? 0) + r.amount_cents)
      else if (r.status === 'red') {
        const hasExec = /^\d{4}-\d{2}-\d{2}$/.test(r.red_date)
        const execMonth = hasExec ? r.red_date.slice(0, 7) : issueMonth
        red.set(execMonth, (red.get(execMonth) ?? 0) + r.amount_cents)
        if (!hasExec) legacyRedMonths = new Set([...legacyRedMonths, issueMonth])
      }
    }
    const months = new Set<string>([...issued.keys(), ...red.keys()])
    const monthList = [...months].filter((m) => m.slice(0, 4) === year).sort()
    const rowList = monthList.map((m) => {
      const i = issued.get(m) ?? 0
      const r = red.get(m) ?? 0
      return { month: m, issued: centsToYuan(i), red: centsToYuan(r), net: centsToYuan(i - r), legacy_red: legacyRedMonths.has(m) }
    })
    const ti = monthList.reduce((s, m) => s + (issued.get(m) ?? 0), 0)
    const tr = monthList.reduce((s, m) => s + (red.get(m) ?? 0), 0)
    return {
      year,
      rows: rowList,
      total: { issued: centsToYuan(ti), red: centsToYuan(tr), net: centsToYuan(ti - tr) },
      note:
        '口径：开票=销项票（kind=sales）在手状态按票期归月；红冲按红冲执行日冲减执行当月（申报口径），票上没记执行日的老红票按票期归月，标"含估算"的月份有此情况；作废票与进项/内部凭证不计。净额是计税参考（备料非核算），申报以电子税务局为准。',
    }
  }

  /** 数电票额度跟踪（任务全图 A5 残余最小形态，2026-11-01）：额度在电子税务局侧（不接），
   *  这里只做"手工抄入总额度/已用 + 剩余与低额警示 + 票夹当月销项对照"。参考品，非权威数。 */
  getQuota(): InvoiceQuotaView {
    const row = this.db.prepare('SELECT value, updated_at FROM app_meta WHERE key = ?').get(QUOTA_KEY) as
      | { value: string; updated_at: string }
      | undefined
    const monthSales = this.salesIssuedInMonth(localDate().slice(0, 7))
    if (row === undefined) {
      return { configured: false, quota_total: 0, quota_used: 0, remaining: 0, warn: false, as_of: '', updated_at: '', month_sales: monthSales, note: QUOTA_NOTE }
    }
    let parsed: { quota_total_cents?: unknown; quota_used_cents?: unknown; as_of?: unknown } = {}
    let corrupted = false
    try {
      parsed = JSON.parse(row.value) as typeof parsed
    } catch {
      corrupted = true
    }
    if (
      corrupted ||
      typeof parsed.quota_total_cents !== 'number' ||
      typeof parsed.quota_used_cents !== 'number' ||
      !Number.isFinite(parsed.quota_total_cents) ||
      !Number.isFinite(parsed.quota_used_cents)
    ) {
      // 抄入的数据坏了就如实说"损坏"，绝不按 0/0 出数冒充正常（对抗审查 P3：坏数据被静默洗白）
      return {
        configured: false,
        quota_total: 0,
        quota_used: 0,
        remaining: 0,
        warn: false,
        as_of: '',
        updated_at: row.updated_at,
        month_sales: monthSales,
        note: '已抄入的额度数据损坏（无法解析），请重新抄入。' + QUOTA_NOTE,
      }
    }
    const totalCents = parsed.quota_total_cents
    const usedCents = parsed.quota_used_cents
    const remainingCents = totalCents - usedCents
    return {
      configured: true,
      quota_total: centsToYuan(totalCents),
      quota_used: centsToYuan(usedCents),
      remaining: centsToYuan(remainingCents),
      warn: totalCents > 0 && remainingCents / totalCents < 0.2,
      as_of: typeof parsed.as_of === 'string' ? parsed.as_of : '',
      updated_at: row.updated_at,
      month_sales: monthSales,
      note: QUOTA_NOTE,
    }
  }

  setQuota(actor: Actor, input: { quota_total?: unknown; quota_used?: unknown; as_of?: unknown }): InvoiceQuotaView {
    const total = parseAmount(input.quota_total as string | number | undefined, 'quota_total')
    // 新批额度还没开票时已用=0 合法；总额度抄 0 没意义走正数校验
    const used = parseAmount(input.quota_used as string | number | undefined, 'quota_used', true)
    if (used > total) throw new BadRequestError(`已用 ${used} 不能大于总额度 ${total}——抄错了吧？两个数都来自电子税务局。`)
    const asOf = parseDate(input.as_of as string | undefined, 'as_of') ?? localDate()
    this.db
      .prepare(
        `INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(QUOTA_KEY, JSON.stringify({ quota_total_cents: yuanToCents(total), quota_used_cents: yuanToCents(used), as_of: asOf }), nowIso())
    this.audit.log({
      username: actor.username,
      source: actor.source,
      action: 'invoice.quota.set',
      targetId: QUOTA_KEY,
      detail: { quota_total: total, quota_used: used, as_of: asOf },
    })
    return this.getQuota()
  }

  /** 票夹当月销项对照（按票期、在手）：额度横幅旁的参考数，帮老板核对抄入的"已用"没抄歪。 */
  private salesIssuedInMonth(month: string): number {
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS s FROM finance_invoices WHERE kind = 'sales' AND status = 'held' AND deleted_at IS NULL AND substr(date, 1, 7) = ?`)
      .get(month) as { s: number }
    return centsToYuan(row.s)
  }

  /** 挂联账目：幂等（重复挂联返回成功），双方都必须存在。 */
  link(actor: Actor, rawInvoiceId: string, entryId: string): InvoiceRecord {
    const invoice = this.requireRow(rawInvoiceId)
    const eid = this.requireEntryId(entryId)
    const entry = this.db
      .prepare('SELECT id, status FROM finance_entries WHERE id = ? AND deleted_at IS NULL')
      .get(eid) as { id: string; status: string } | undefined
    if (entry === undefined) throw new NotFoundError(`找不到账目 ${eid}。可先用 finance_lookup 核对编号。`)
    // 证据链不挂已作废的账：挂了等于给无效账背书（对抗审查 P2-4）
    if (entry.status === 'cancelled') {
      throw new BadRequestError(`账目 ${eid} 已作废（不计入统计），票不许挂到它上面。`)
    }
    this.db
      .prepare('INSERT OR IGNORE INTO finance_invoice_links (invoice_id, entry_id, created_at, created_by) VALUES (?, ?, ?, ?)')
      .run(invoice.id, eid, nowIso(), actor.username)
    this.audit.log({ username: actor.username, source: actor.source, action: 'invoice.link', targetId: invoice.id, detail: { entry_id: eid } })
    return this.getOne(invoice.id)
  }

  unlink(actor: Actor, rawInvoiceId: string, entryId: string): InvoiceRecord {
    const invoice = this.requireRow(rawInvoiceId)
    const eid = this.requireEntryId(entryId)
    this.db.prepare('DELETE FROM finance_invoice_links WHERE invoice_id = ? AND entry_id = ?').run(invoice.id, eid)
    this.audit.log({ username: actor.username, source: actor.source, action: 'invoice.unlink', targetId: invoice.id, detail: { entry_id: eid } })
    return this.getOne(invoice.id)
  }

  /** 缺票清单（B3 证据维）：expense/reimburse 中既没挂"在手"的票、也没填 invoice_no 的账目。
   *  payroll/tax 不纳入——工资单、完税凭证不是发票，纳入只会永远红。作废账与冲销对不算欠证据。
   *  已作废/已红冲的票不算证据（对抗审查 P2-2）：挂了废票的账照样列出来催。
   *  entries 受 limit 截断，total 是不截断的真实条数，前端据此提示"还有更多"。 */
  listMissing(filter: { month?: string; limit?: number }): {
    count: number
    total: number
    entries: {
      id: string
      date: string
      type: EntryType
      amount: number
      paid_amount: number
      counterparty: string
      category: string
      note: string
    }[]
  } {
    if (filter.month !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(filter.month)) {
      throw new BadRequestError(`month 格式应为 YYYY-MM，收到："${filter.month}"。`)
    }
    const limit = Math.max(1, filter.limit ?? 100)
    const clauses = [
      "deleted_at IS NULL",
      "status != 'cancelled'",
      "reverses = ''",
      "reversed_by = ''",
      "type IN ('expense', 'reimburse')",
      "invoice_no = ''",
      `NOT EXISTS (SELECT 1 FROM finance_invoice_links l JOIN finance_invoices i ON i.id = l.invoice_id
                   WHERE l.entry_id = finance_entries.id AND i.deleted_at IS NULL AND i.status = 'held')`,
    ]
    const params: unknown[] = []
    if (filter.month !== undefined) {
      clauses.push('substr(date, 1, 7) = ?')
      params.push(filter.month)
    }
    const where = clauses.join(' AND ')
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM finance_entries WHERE ${where}`).get(...params) as { n: number }).n
    const rows = this.db
      .prepare(
        `SELECT id, date, type, amount_cents, paid_amount_cents, counterparty, category, note
         FROM finance_entries WHERE ${where}
         ORDER BY date ASC, id ASC LIMIT ?`,
      )
      .all(...params, limit) as {
      id: string
      date: string
      type: EntryType
      amount_cents: number
      paid_amount_cents: number
      counterparty: string
      category: string
      note: string
    }[]
    return {
      count: rows.length,
      total,
      entries: rows.map((r) => ({
        id: r.id,
        date: r.date,
        type: r.type,
        amount: centsToYuan(r.amount_cents),
        paid_amount: centsToYuan(r.paid_amount_cents),
        counterparty: r.counterparty,
        category: r.category,
        note: r.note,
      })),
    }
  }

  // --------------------------------------------------------------- 内部

  private isReportedMonth(month: string): boolean {
    const row = this.db.prepare('SELECT month FROM finance_reported_months WHERE month = ?').get(month)
    return row !== undefined
  }

  private allocateId(date: string): string {
    const prefix = `INV-${date.replaceAll('-', '')}-`
    const row = this.db
      .prepare('SELECT MAX(CAST(substr(id, -3) AS INTEGER)) AS maxn FROM finance_invoices WHERE id LIKE ?')
      .get(`${prefix}%`) as { maxn: number | null }
    return `${prefix}${String((row.maxn ?? 0) + 1).padStart(3, '0')}`
  }

  private requireRow(rawId: string): InvoiceRow {
    const id = (rawId ?? '').trim()
    if (!/^INV-\d{8}-\d{3}$/.test(id)) {
      throw new BadRequestError(`票编号格式应为 INV-YYYYMMDD-NNN，收到："${rawId ?? ''}"。`)
    }
    const row = this.db.prepare('SELECT * FROM finance_invoices WHERE id = ? AND deleted_at IS NULL').get(id) as
      | InvoiceRow
      | undefined
    if (row === undefined) throw new NotFoundError(`找不到票 ${id}。`)
    return row
  }

  private requireEntryId(rawId: string): string {
    const id = (rawId ?? '').trim()
    if (!ID_PATTERN.test(id)) {
      throw new BadRequestError(`账目编号格式应为 FIN-YYYYMMDD-NNN，收到："${rawId ?? ''}"。`)
    }
    return id
  }

  private toRecord(row: InvoiceRow, entryIds: string[]): InvoiceRecord {
    return {
      id: row.id,
      kind: row.kind as InvoiceKind,
      number: row.number,
      date: row.date,
      amount: centsToYuan(row.amount_cents),
      counterparty: row.counterparty,
      status: row.status as InvoiceStatus,
      red_date: row.red_date,
      note: row.note,
      entry_ids: entryIds,
      created_by: row.created_by,
      updated_by: row.updated_by,
      updated_at: row.updated_at,
    }
  }

  private requireKind(value: string | undefined): InvoiceKind {
    if (value === undefined || !(INVOICE_KIND_VALUES as readonly string[]).includes(value)) {
      throw new BadRequestError(`kind 应为 ${INVOICE_KIND_VALUES.join('|')}（sales=开出去的销项，purchase=收进来的进项，internal=内部凭证），收到："${value ?? ''}"。`)
    }
    return value as InvoiceKind
  }

  private requireStatus(value: string): InvoiceStatus {
    if (!(INVOICE_STATUS_VALUES as readonly string[]).includes(value)) {
      throw new BadRequestError(`status 应为 ${INVOICE_STATUS_VALUES.join('|')}（held=在手，voided=已作废，red=已红冲），收到："${value}"。`)
    }
    return value as InvoiceStatus
  }
}

function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

interface InvoiceRow {
  id: string
  kind: string
  number: string
  date: string
  amount_cents: number
  counterparty: string
  status: string
  red_date: string
  note: string
  created_by: string
  updated_by: string
  updated_at: string
}

const QUOTA_KEY = 'finance.invoice_quota'
const QUOTA_NOTE = '数电票额度以电子税务局实时额度为准，这里只是手工抄入的参考跟踪；"票夹当月销项"按票期自动算，供核对抄入的已用数没抄歪。'

export interface OutputSummary {
  year: string
  rows: Array<{ month: string; issued: number; red: number; net: number; legacy_red: boolean }>
  total: { issued: number; red: number; net: number }
  note: string
}

export interface InvoiceQuotaView {
  configured: boolean
  quota_total: number
  quota_used: number
  remaining: number
  warn: boolean
  as_of: string
  updated_at: string
  /** 票夹当月销项（按票期、在手，自动算）——抄入数的对照参考。 */
  month_sales: number
  note: string
}

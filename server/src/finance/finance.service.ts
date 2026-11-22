/** 财务域服务：记账/查询/月度汇总/建档——与 dsh-finance-tools.mjs 语义逐条一致（含错误文案）。
 *  差异只有落点：md 文件 → SQLite（金额存分）；每笔写操作带 actor 并写审计。
 *  已知有意偏差见模块 README「与 md 工具的已知差异」。 */
import type { DB } from '../db/database.js'
import { nowIso } from '../db/database.js'
import type { AuditService } from '../audit/audit.service.js'
import {
  DEFAULT_STATUS,
  ID_PATTERN,
  OUT_TYPES,
  PROFILE_KEY_PATTERN,
  PROFILE_TEMPLATE_KEYS,
  STATUS_VALUES,
  TYPE_VALUES,
  type Actor,
  type EntryInput,
  type EntryStatus,
  type EntryType,
} from './finance.types.js'
import { centsToYuan, localDate, localMonth, parseAmount, parseDate, parseMonth, yuanToCents } from './finance.util.js'
import { BadRequestError, NotFoundError } from '../errors.js'

export interface EntryRecord {
  id: string
  date: string
  type: EntryType
  amount: number
  status: EntryStatus
  counterparty: string
  category: string
  account: string
  invoice_no: string
  due_date: string
  paid_amount: number
  note: string
  approved_by: string
  reverses: string
  reversed_by: string
  created_by: string
  updated_by: string
  updated_at: string
  followups?: { date: string; note: string; created_by: string }[]
}

export interface EntryFilter {
  id?: string
  type?: string
  status?: string
  counterparty?: string
  month?: string
  due_before?: string
  /** 按账户精确过滤（账户页/深链用）。 */
  account?: string
  /** 未结清=true：未取消、未收/付完、实收付<金额、不在冲销对里——与 summary 的 receivable/payable 口径对齐。 */
  outstanding?: boolean
  limit?: number
}

export class FinanceService {
  constructor(
    private readonly db: DB,
    private readonly audit: AuditService,
  ) {}

  // --------------------------------------------------------------- 记账（create）

  /** create 要素校验与归一（确认卡片提案复用：提案时就拦错，确认落库时不会再炸）。 */
  normalizeCreateInput(input: EntryInput): { type: EntryType; amount: number; date: string; status: EntryStatus; account: string } {
    const type = this.requireType(input.type, 'create')
    const amount = parseAmount(input.amount, 'amount')
    const date = parseDate(input.date, 'date') ?? localDate()
    const status = this.requireStatus(input.status ?? DEFAULT_STATUS[type])
    const account = clean(input.account)
    this.requireNotReported(date.slice(0, 7), `${date} 已出数（给过代账/申报），不能补录该月账目；记当期，要修正已出数的账请用冲销。`)
    this.requireAccount(account)
    return { type, amount, date, status, account }
  }

  create(actor: Actor, input: EntryInput, opts: { followupNote?: string } = {}): EntryRecord {
    const { type, amount, date, status, account } = this.normalizeCreateInput(input)
    const id = this.allocateId(date)

    this.db
      .prepare(
        `INSERT INTO finance_entries
           (id, date, type, amount_cents, status, counterparty, category, account, invoice_no,
            due_date, paid_amount_cents, note, created_at, created_by, updated_at, updated_by, approved_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        date,
        type,
        yuanToCents(amount),
        status,
        clean(input.counterparty),
        clean(input.category),
        account,
        clean(input.invoice_no),
        clean(input.due_date), // create 与 md 工具一致：due_date 原样存（trim），不校验格式；update 才校验
        input.paid_amount !== undefined ? yuanToCents(parseAmount(input.paid_amount, 'paid_amount', true)) : 0,
        clean(input.note),
        nowIso(),
        actor.username,
        nowIso(),
        actor.username,
        actor.username, // 谁认的：直通路径=操作者本人；确认卡片路径由 confirm 流程覆盖
      )
    this.appendFollowup(id, localDate(), opts.followupNote ?? '登记。', actor)
    this.audit.log({ username: actor.username, source: actor.source, action: 'finance.create', targetId: id, detail: { type, amount, date, status } })
    return this.getOne(id)
  }

  // --------------------------------------------------------------- 更新（行级语义 → 列级，带审计）

  update(actor: Actor, rawId: string, input: EntryInput): EntryRecord {
    const id = this.requireId(rawId)
    const existing = this.getRow(id)
    if (existing === undefined) {
      throw new NotFoundError(`找不到记录 ${id}。可先用 finance_lookup 核对编号。`)
    }
    // 冲销对（原条目 + 反向条目）都冻结：修正出数前的错账请改原路，出数后只许再冲销
    if (existing.reverses !== '') throw new BadRequestError(`${id} 是冲销条目，不可修改。`)
    if (existing.reversed_by !== '') throw new BadRequestError(`${id} 已被 ${existing.reversed_by} 冲销，不可修改。`)
    this.requireNotReported(existing.date.slice(0, 7), `${id} 属于 ${existing.date.slice(0, 7)}，该月数字已出数（给过代账/申报），只许冲销不许改；需要修正请用冲销。`)
    // 目标月份同样受守门：把日期搬进已出数月份=改了那个月的数字，与直改无异（对抗审查 P0-1）。
    // 空串 date 语义="重置为今天"，也是改期——按生效日期（解析结果或今天）守门，不留旁路（复验 P1-A）
    if (input.date !== undefined) {
      const effective = parseDate(input.date, 'date') ?? localDate()
      const targetMonth = effective.slice(0, 7)
      if (targetMonth !== existing.date.slice(0, 7)) {
        this.requireNotReported(targetMonth, `不能把 ${id} 改期到 ${targetMonth}：该月数字已出数（给过代账/申报），只许冲销不许补录。`)
      }
    }
    if (input.account !== undefined) this.requireAccount(clean(input.account))
    const sets: string[] = []
    const values: unknown[] = []

    if (input.type !== undefined) {
      sets.push('type = ?')
      values.push(this.requireType(input.type, 'update'))
    }
    if (input.status !== undefined) {
      sets.push('status = ?')
      values.push(this.requireStatus(input.status))
    }
    for (const key of ['counterparty', 'category', 'account', 'invoice_no', 'note'] as const) {
      if (input[key] !== undefined) {
        sets.push(`${key} = ?`)
        values.push(clean(input[key]))
      }
    }
    if (input.date !== undefined) {
      sets.push('date = ?')
      values.push(parseDate(input.date, 'date') ?? localDate())
    }
    if (input.due_date !== undefined) {
      sets.push('due_date = ?')
      values.push(parseDate(input.due_date, 'due_date') ?? '')
    }
    if (input.amount !== undefined) {
      sets.push('amount_cents = ?')
      values.push(yuanToCents(parseAmount(input.amount, 'amount')))
    }
    if (input.paid_amount !== undefined) {
      sets.push('paid_amount_cents = ?')
      values.push(yuanToCents(parseAmount(input.paid_amount, 'paid_amount', true)))
    }

    if (sets.length > 0) {
      sets.push('updated_at = ?', 'updated_by = ?')
      values.push(nowIso(), actor.username)
      this.db.prepare(`UPDATE finance_entries SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`).run(...values, id)
    }
    if (input.followup_note !== undefined && input.followup_note.trim() !== '') {
      this.appendFollowup(id, localDate(), input.followup_note.trim(), actor)
    }
    // 与 md 工具一致：无有效字段的 update 是成功空跑（返回现值），不报错
    this.audit.log({
      username: actor.username,
      source: actor.source,
      action: 'finance.update',
      targetId: id,
      detail: { fields: Object.keys(input).filter((k) => input[k as keyof EntryInput] !== undefined) },
    })
    return this.getOne(id)
  }

  /** 软删除（界面删除按钮用；agent 作废走 update status=cancelled，两回事并存）。 */
  softDelete(actor: Actor, rawId: string, reason: string): void {
    const id = this.requireId(rawId)
    const existing = this.getRow(id)
    if (existing === undefined) throw new NotFoundError(`找不到记录 ${id}。`)
    if (existing.reverses !== '' || existing.reversed_by !== '') throw new BadRequestError(`${id} 属于冲销对，不可删除。`)
    this.requireNotReported(existing.date.slice(0, 7), `${id} 属于 ${existing.date.slice(0, 7)}，该月数字已出数（给过代账/申报），只许冲销不许删。`)
    this.db
      .prepare('UPDATE finance_entries SET deleted_at = ?, updated_at = ?, updated_by = ? WHERE id = ?')
      .run(nowIso(), nowIso(), actor.username, id)
    this.appendFollowup(id, localDate(), `软删除：${reason || '（未填原因）'}`, actor)
    this.audit.log({ username: actor.username, source: actor.source, action: 'finance.delete', targetId: id, detail: { reason } })
  }

  // --------------------------------------------------------------- 冲销（出数后的唯一修正路径）

  /** 冲销：追加一条全额反向条目（date=冲销当天），原条目只补 reversed_by 标记不改业务历史；
   *  聚合（summary/账户余额）把冲销条目按负计入，两笔相抵、轨迹完整可追溯。 */
  reverse(actor: Actor, rawId: string, reason: string): EntryRecord {
    const id = this.requireId(rawId)
    const row = this.getRow(id)
    if (row === undefined) throw new NotFoundError(`找不到记录 ${id}。可先用 finance_lookup 核对编号。`)
    if (row.reverses !== '') throw new BadRequestError(`${id} 本身是冲销条目，不可再被冲销。`)
    if (row.reversed_by !== '') throw new BadRequestError(`${id} 已被 ${row.reversed_by} 冲销，不能重复冲销。`)
    // 作废账不进统计，冲销它只会造出一笔无中生有的负数（对抗审查 P1-1）
    if (row.status === 'cancelled') {
      throw new BadRequestError(`${id} 已作废（不计入统计），无需冲销；要恢复先把它改回在账状态。`)
    }
    const today = localDate()
    const reversalId = this.allocateId(today)
    // 冲销条目复制原 status/paid_amount：任何口径下（总额/已收付/未收付/账户余额）都与原条目精确相抵，
    // 部分收付的账冲销后不会出现"总额归零却还挂着未收"的自相矛盾（对抗审查 P1-2）
    this.db
      .prepare(
        `INSERT INTO finance_entries
           (id, date, type, amount_cents, status, counterparty, category, account, invoice_no,
            due_date, paid_amount_cents, note, created_at, created_by, updated_at, updated_by, approved_by, reverses)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        reversalId,
        today,
        row.type,
        row.amount_cents,
        row.status,
        row.counterparty,
        row.category,
        row.account,
        row.invoice_no,
        row.paid_amount_cents,
        `冲销 ${id}：${reason || '（未填原因）'}`,
        nowIso(),
        actor.username,
        nowIso(),
        actor.username,
        actor.username,
        id,
      )
    // 原条目唯一放行的"改"：补冲销标记（非业务字段），不走出数守门
    this.db
      .prepare('UPDATE finance_entries SET reversed_by = ?, updated_at = ?, updated_by = ? WHERE id = ?')
      .run(reversalId, nowIso(), actor.username, id)
    this.appendFollowup(id, today, `被冲销 ${reversalId}：${reason || '（未填原因）'}`, actor)
    this.audit.log({
      username: actor.username,
      source: actor.source,
      action: 'finance.reverse',
      targetId: reversalId,
      detail: { original: id, reason },
    })
    return this.getOne(reversalId)
  }

  // --------------------------------------------------------------- 查询（lookup）

  getOne(rawId: string): EntryRecord {
    const id = this.requireId(rawId)
    const row = this.getRow(id)
    if (row === undefined) throw new NotFoundError(`找不到记录 ${id}。`)
    return this.toRecord(row, this.followupsOf(id))
  }

  list(filter: EntryFilter): { count: number; records: EntryRecord[] } {
    if (filter.id !== undefined) {
      const record = this.getOne(filter.id)
      return { count: 1, records: [record] }
    }
    if (filter.month !== undefined) parseMonth(filter.month)
    // type/status 过滤值不校验：未知值在 WHERE 里自然匹配不到 → 返回空（与 md 工具"静默空结果"一致）
    if (filter.due_before !== undefined) parseDate(filter.due_before, 'due_before')

    const clauses = ['deleted_at IS NULL']
    const params: unknown[] = []
    if (filter.type !== undefined) {
      clauses.push('type = ?')
      params.push(filter.type)
    }
    if (filter.status !== undefined) {
      clauses.push('status = ?')
      params.push(filter.status)
    }
    if (filter.counterparty !== undefined && filter.counterparty.trim() !== '') {
      clauses.push("counterparty LIKE ? ESCAPE '\\'") // 模糊过滤（包含即命中），与工具一致
      params.push(`%${escapeLike(filter.counterparty.trim())}%`)
    }
    if (filter.account !== undefined && filter.account.trim() !== '') {
      clauses.push('account = ?')
      params.push(filter.account.trim())
    }
    if (filter.outstanding === true) {
      // 未结清（工作台应收/应付未收付深链）：冲销对双向剔除，与 summary 口径一致（2026-11-02）
      clauses.push(
        `status != 'cancelled' AND status != 'paid' AND paid_amount_cents < amount_cents
         AND reverses = '' AND id NOT IN (SELECT reverses FROM finance_entries WHERE reverses != '' AND deleted_at IS NULL)`,
      )
    }
    if (filter.month !== undefined) {
      clauses.push('substr(date, 1, 7) = ?')
      params.push(filter.month)
    }
    if (filter.due_before !== undefined) {
      // 催收清单剔除冲销对：债已被反向条目冲掉，不能再出现在"该催的账"里（复验 P1-B；
      // 反向条目 due_date 为空串天然不中，条件对称写防将来改动引入漏洞）
      clauses.push(`due_date != '' AND due_date < ? AND status != 'paid' AND status != 'cancelled' AND reverses = '' AND reversed_by = ''`)
      params.push(filter.due_before)
    }
    const limit = Math.max(1, filter.limit ?? 20)
    const rows = this.db
      .prepare(`SELECT * FROM finance_entries WHERE ${clauses.join(' AND ')} ORDER BY id DESC LIMIT ?`)
      .all(...params, limit) as EntryRow[]
    return { count: rows.length, records: rows.map((r) => this.toRecord(r)) }
  }

  // --------------------------------------------------------------- 汇总（summary 口径与工具一致）

  summary(rawMonth?: string): unknown {
    const month = parseMonth(rawMonth ?? localMonth())
    const rows = this.db
      .prepare(
        `SELECT id, type, status, category, amount_cents, paid_amount_cents, reverses
         FROM finance_entries
         WHERE deleted_at IS NULL AND substr(date, 1, 7) = ? AND status != 'cancelled'`,
      )
      .all(month) as { id: string; type: EntryType; status: string; category: string; amount_cents: number; paid_amount_cents: number; reverses: string }[]

    const byTypeMap = new Map<string, { type: string; count: number; total: number; paid: number; outstanding: number }>()
    const byCategoryMap = new Map<string, { category: string; count: number; total: number }>()
    for (const row of rows) {
      // 冲销条目按负计入（与原条目相抵）；笔数照算，轨迹真实
      const sign = row.reverses !== '' ? -1 : 1
      const amount = r2(sign * centsToYuan(row.amount_cents))
      const paidAmount = r2(sign * centsToYuan(row.paid_amount_cents))
      const entry = byTypeMap.get(row.type) ?? { type: row.type, count: 0, total: 0, paid: 0, outstanding: 0 }
      entry.count += 1
      entry.total = r2(entry.total + amount)
      // 发票登记不是现金收付，只计笔数与开票额，不进收付统计
      if (row.type !== 'invoice') {
        const balance = r2(amount - paidAmount)
        const settled = row.status === 'paid'
        const partial = row.status === 'partial' || (paidAmount > 0 && !settled)
        if (settled) {
          entry.paid = r2(entry.paid + amount)
        } else if (partial) {
          entry.paid = r2(entry.paid + paidAmount)
          entry.outstanding = r2(entry.outstanding + balance)
        } else {
          entry.outstanding = r2(entry.outstanding + amount)
        }
      }
      byTypeMap.set(row.type, entry)
      if ((OUT_TYPES as readonly string[]).includes(row.type) && row.category !== '') {
        const cat = byCategoryMap.get(row.category) ?? { category: row.category, count: 0, total: 0 }
        cat.count += 1
        cat.total = r2(cat.total + amount)
        byCategoryMap.set(row.category, cat)
      }
    }
    const byType = [...byTypeMap.values()].sort((a, b) => TYPE_VALUES.indexOf(a.type as EntryType) - TYPE_VALUES.indexOf(b.type as EntryType))
    const byCategory = [...byCategoryMap.values()].sort((a, b) => b.total - a.total)
    // 应收/应付余额=截至该月月底的累计未收付（"现在谁欠我"不随月份翻篇），不是当月发生额；
    // 冲销对在该口径下自动相抵：原条目被冲销即剔除，冲销条目不重复参与
    const until = `${month}-31` // SQLite 字符串比较，-31 兜住所有月份的月底
    const openRows = this.db
      .prepare(
        `SELECT id, type, status, amount_cents, paid_amount_cents, reverses
         FROM finance_entries
         WHERE deleted_at IS NULL AND date <= ? AND status != 'cancelled' AND type != 'invoice'`,
      )
      .all(until) as { id: string; type: EntryType; status: string; amount_cents: number; paid_amount_cents: number; reverses: string }[]
    const reversedIds = new Set(openRows.filter((r) => r.reverses !== '').map((r) => r.reverses))
    let receivableCents = 0
    let payableCents = 0
    for (const row of openRows) {
      if (row.reverses !== '' || reversedIds.has(row.id)) continue
      const settled = row.status === 'paid'
      if (settled) continue
      const partial = row.status === 'partial' || row.paid_amount_cents > 0
      const balanceCents = partial ? row.amount_cents - row.paid_amount_cents : row.amount_cents
      if (balanceCents <= 0) continue
      if (row.type === 'income') receivableCents += balanceCents
      else if ((OUT_TYPES as readonly string[]).includes(row.type)) payableCents += balanceCents
    }
    return {
      month,
      count: rows.length,
      byType,
      byCategory,
      receivableOutstanding: centsToYuan(receivableCents),
      payableOutstanding: centsToYuan(payableCents),
      badAmount: 0,
    }
  }

  // --------------------------------------------------------------- 建档（profile）

  profileGet(): { profile: Record<string, string> } {
    const rows = this.db.prepare('SELECT key, value FROM finance_profile').all() as { key: string; value: string }[]
    const map = new Map(rows.map((r) => [r.key, r.value]))
    const profile: Record<string, string> = {}
    for (const key of PROFILE_TEMPLATE_KEYS) profile[key] = map.get(key) ?? ''
    for (const [key, value] of map) {
      if (!(key in profile)) profile[key] = value // 人工新增键排后
    }
    return { profile }
  }

  profileSet(actor: Actor, key: string, value: string): { key: string; value: string } {
    const k = key.trim()
    const v = value.trim()
    if (k === '' || !PROFILE_KEY_PATTERN.test(k)) {
      throw new BadRequestError(`set 需要合法的参数名（中文/字母/数字，≤20 字），收到："${key ?? ''}"。`)
    }
    if (v === '' || v.includes('\n')) {
      // 尾句与 md 版不同是有意偏差：没有 PROFILE.md 可改，库世界里等价动作是 set 新值覆盖
      throw new BadRequestError('set 需要非空的单行参数值；如需覆盖请直接 set 新值。')
    }
    this.db
      .prepare(
        `INSERT INTO finance_profile (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      )
      .run(k, v, nowIso(), actor.username)
    this.audit.log({ username: actor.username, source: actor.source, action: 'profile.set', targetId: k, detail: { value: v } })
    return { key: k, value: v }
  }

  // --------------------------------------------------------------- 出数标记（按月冻结）

  /** 标记某月数字已出数（给过代账/申报）：该月账目随即冻结，只许冲销。 */
  markReported(actor: Actor, rawMonth: string): { month: string } {
    const month = parseMonth(rawMonth)
    this.db
      .prepare(
        `INSERT INTO finance_reported_months (month, reported_at, reported_by) VALUES (?, ?, ?)
         ON CONFLICT(month) DO NOTHING`,
      )
      .run(month, nowIso(), actor.username)
    this.audit.log({ username: actor.username, source: actor.source, action: 'finance.report', targetId: month, detail: {} })
    return { month }
  }

  /** 撤销出数标记（标错了的纠正口；controller 层限 admin:manage）。 */
  unmarkReported(actor: Actor, rawMonth: string): { month: string } {
    const month = parseMonth(rawMonth)
    const done = this.db.prepare('DELETE FROM finance_reported_months WHERE month = ?').run(month)
    if (Number(done.changes) === 0) throw new NotFoundError(`${month} 没有出数标记。`)
    this.audit.log({ username: actor.username, source: actor.source, action: 'finance.unreport', targetId: month, detail: {} })
    return { month }
  }

  listReported(): { months: { month: string; reported_at: string; reported_by: string }[] } {
    const months = this.db
      .prepare('SELECT month, reported_at, reported_by FROM finance_reported_months ORDER BY month DESC')
      .all() as { month: string; reported_at: string; reported_by: string }[]
    return { months }
  }

  // --------------------------------------------------------------- 内部

  private allocateId(date: string): string {
    const prefix = `FIN-${date.replaceAll('-', '')}-`
    const row = this.db
      .prepare(`SELECT MAX(CAST(substr(id, -3) AS INTEGER)) AS maxn FROM finance_entries WHERE id LIKE ?`)
      .get(`${prefix}%`) as { maxn: number | null }
    return `${prefix}${String((row.maxn ?? 0) + 1).padStart(3, '0')}`
  }

  private appendFollowup(entryId: string, date: string, note: string, actor: Actor): void {
    this.db
      .prepare('INSERT INTO finance_followups (entry_id, date, note, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(entryId, date, note, actor.username, nowIso())
  }

  private followupsOf(entryId: string): { date: string; note: string; created_by: string }[] {
    return this.db
      .prepare('SELECT date, note, created_by FROM finance_followups WHERE entry_id = ? ORDER BY id ASC')
      .all(entryId) as { date: string; note: string; created_by: string }[]
  }

  private getRow(id: string): EntryRow | undefined {
    return this.db.prepare('SELECT * FROM finance_entries WHERE id = ? AND deleted_at IS NULL').get(id) as EntryRow | undefined
  }

  private toRecord(row: EntryRow, followups?: { date: string; note: string; created_by: string }[]): EntryRecord {
    const record: EntryRecord = {
      id: row.id,
      date: row.date,
      type: row.type as EntryType,
      amount: centsToYuan(row.amount_cents),
      status: row.status as EntryStatus,
      counterparty: row.counterparty,
      category: row.category,
      account: row.account,
      invoice_no: row.invoice_no,
      due_date: row.due_date,
      paid_amount: centsToYuan(row.paid_amount_cents),
      note: row.note,
      approved_by: row.approved_by,
      reverses: row.reverses,
      reversed_by: row.reversed_by,
      created_by: row.created_by,
      updated_by: row.updated_by,
      updated_at: row.updated_at,
    }
    if (followups !== undefined) record.followups = followups
    return record
  }

  private requireType(value: string | undefined, context: 'create' | 'update'): EntryType {
    if (value === undefined || !(TYPE_VALUES as readonly string[]).includes(value)) {
      // 措辞与 md 工具两分支一致：create=“create 需要 type（…）”，update=“type 应为 …”
      throw new BadRequestError(
        context === 'create'
          ? `create 需要 type（${TYPE_VALUES.join('|')}），收到："${value ?? ''}"。`
          : `type 应为 ${TYPE_VALUES.join('|')}，收到："${value ?? ''}"。`,
      )
    }
    return value as EntryType
  }

  private requireStatus(value: string): EntryStatus {
    if (!(STATUS_VALUES as readonly string[]).includes(value)) {
      throw new BadRequestError(`status 应为 ${STATUS_VALUES.join('|')}，收到："${value}"。`)
    }
    return value as EntryStatus
  }

  private requireId(rawId: string): string {
    const id = (rawId ?? '').trim()
    if (!ID_PATTERN.test(id)) {
      throw new BadRequestError(`id 格式应为 FIN-YYYYMMDD-NNN，收到："${rawId ?? ''}"。`)
    }
    return id
  }

  /** 出数守门：该月已标记出数则拒绝写（冲销是唯一例外，且冲销不经过本守门）。 */
  private requireNotReported(month: string, message: string): void {
    const hit = this.db.prepare('SELECT month FROM finance_reported_months WHERE month = ?').get(month)
    if (hit !== undefined) throw new BadRequestError(message)
  }

  /** 账户校验：填了账户就必须是已建档且未停用的账户（口袋维的地基——账户名算得准余额的前提）。 */
  private requireAccount(name: string): void {
    if (name === '') return
    const row = this.db.prepare('SELECT archived_at FROM finance_accounts WHERE name = ?').get(name) as
      | { archived_at: string | null }
      | undefined
    if (row === undefined || row.archived_at !== null) {
      throw new BadRequestError(`账户"${name}"未建档或已停用。先在「账户」页添加（或 finance_account 建），不挂账户就留空。`)
    }
  }
}

interface EntryRow {
  id: string
  date: string
  type: string
  amount_cents: number
  status: string
  counterparty: string
  category: string
  account: string
  invoice_no: string
  due_date: string
  paid_amount_cents: number
  note: string
  approved_by: string
  reverses: string
  reversed_by: string
  created_by: string
  updated_by: string
  updated_at: string
}

function clean(value: string | undefined): string {
  return (value ?? '').trim()
}

function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

function r2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

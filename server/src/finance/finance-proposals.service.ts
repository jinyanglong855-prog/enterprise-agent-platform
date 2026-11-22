/** 确认卡片提案域服务（授权维"谁认的"，任务全图 §0.2/§0.5）：
 *  对话记账默认路径：agent 调 finance_propose 出提案（pending）→ 老板在对话框卡片上
 *  点确认 → 本服务调 finance.create 落库（审计 source=confirm，approved_by=确认人）。
 *  提案不落账本：确认时才过 create 的完整守门（出数窗口变了会 fail-closed 留在 pending）。
 *  kind=import（2026-10-21，§0.6 对话入口）：agent 解析完文件出的一批账，payload={rows}，
 *  确认时走导入域事务原子落库——agent 没有批量直落的入口，这张卡是唯一通道。 */
import type { DB } from '../db/database.js'
import { nowIso } from '../db/database.js'
import type { AuditService } from '../audit/audit.service.js'
import { BadRequestError, NotFoundError } from '../errors.js'
import { type Actor, type EntryInput, type EntryType } from './finance.types.js'
import type { FinanceService, EntryRecord } from './finance.service.js'
import { IMPORT_MAX_ROWS, type FinanceImportsService } from './finance-imports.service.js'
import { r2 } from './finance.util.js'

export type ProposalKind = 'single' | 'import'

export interface ImportPayload {
  rows: EntryInput[]
  note: string
}

export interface ProposalRecord {
  id: string
  kind: ProposalKind
  payload: EntryInput | ImportPayload
  summary: string
  status: 'pending' | 'confirmed' | 'rejected'
  created_at: string
  created_by: string
  resolved_at: string
  resolved_by: string
  entry_id: string
  reason: string
}

const TYPE_LABELS: Record<EntryType, string> = {
  expense: '支出',
  income: '收入',
  invoice: '发票',
  payroll: '工资',
  reimburse: '报销',
  tax: '税费',
}

export class FinanceProposalsService {
  constructor(
    private readonly db: DB,
    private readonly audit: AuditService,
    private readonly finance: FinanceService,
    private readonly imports: FinanceImportsService,
  ) {}

  /** agent 提案：只校验不落账本（create 同款要素校验，提案时就拦错）。 */
  create(actor: Actor, input: EntryInput): ProposalRecord {
    const norm = this.finance.normalizeCreateInput(input)
    const id = this.allocateId()
    const summary = buildSummary(input, norm)
    this.db
      .prepare(
        "INSERT INTO finance_proposals (id, kind, payload, summary, status, created_at, created_by) VALUES (?, 'single', ?, ?, 'pending', ?, ?)",
      )
      .run(id, JSON.stringify(input), summary, nowIso(), actor.username)
    this.audit.log({
      username: actor.username,
      source: actor.source,
      action: 'proposal.create',
      targetId: id,
      detail: { summary },
    })
    return this.getOne(id)
  }

  /** 批量导入提案：每行先过 create 守门（提案时拦错，确认时不会炸一半）；重复判定不在这拦——
   *  预览已把疑似重复标给 agent，agent 与老板商量后决定哪些行进提案。 */
  createImport(actor: Actor, rows: EntryInput[], note = ''): ProposalRecord {
    if (!Array.isArray(rows) || rows.length === 0) throw new BadRequestError('批量提案没有行。')
    if (rows.length > IMPORT_MAX_ROWS) throw new BadRequestError(`单批最多 ${IMPORT_MAX_ROWS} 行，本次 ${rows.length} 行。`)
    const norms = rows.map((row, i) => {
      if (row === null || typeof row !== 'object') throw new BadRequestError(`第 ${i + 1} 行不是对象。`)
      try {
        return this.finance.normalizeCreateInput(row)
      } catch (err) {
        throw new BadRequestError(`第 ${i + 1} 行：${err instanceof Error ? err.message : String(err)}`)
      }
    })
    const id = this.allocateId()
    let summary = buildImportSummary(norms)
    // 卡面知情（对抗审查 P2-2）：重复的账确认后会照常入成两笔，老板得在卡上看到这个数再点头。
    // norms 没有 counterparty（指纹四要素之一），合并原始行再判。
    const dupCount = this.imports.countDbDuplicates(rows.map((row, i) => ({ ...row, ...norms[i]! })))
    if (dupCount > 0) summary += `；其中 ${dupCount} 笔与账本已有账同日期同金额同对方（确认后会照常入账）`
    const payload: ImportPayload = { rows, note: (note ?? '').trim() }
    this.db
      .prepare(
        "INSERT INTO finance_proposals (id, kind, payload, summary, status, created_at, created_by) VALUES (?, 'import', ?, ?, 'pending', ?, ?)",
      )
      .run(id, JSON.stringify(payload), summary, nowIso(), actor.username)
    this.audit.log({
      username: actor.username,
      source: actor.source,
      action: 'proposal.create',
      targetId: id,
      detail: { summary, kind: 'import', count: rows.length },
    })
    return this.getOne(id)
  }

  /** 老板确认：落库（source=confirm）→ 提案绑定条目编号。重复确认/已处理被拒。
   *  import 卡：走导入域事务，entry_id 记批次号，条目清单在审计 detail 与返回值里。 */
  confirm(actor: Actor, rawId: string): { proposal: ProposalRecord; entry?: EntryRecord; entries?: EntryRecord[]; batch?: string } {
    const row = this.requireRow(rawId)
    if (row.status !== 'pending') {
      throw new BadRequestError(`${rawId} 已处理过（${statusLabel(row.status)}），不能重复确认。`)
    }
    const confirmer: Actor = { username: actor.username, source: 'confirm' }
    if (row.kind === 'import') {
      const payload = JSON.parse(row.payload) as ImportPayload
      const result = this.imports.commit(confirmer, payload.rows, { note: `提案 ${row.id}${payload.note ? `：${payload.note}` : ''}` })
      this.db
        .prepare("UPDATE finance_proposals SET status = 'confirmed', resolved_at = ?, resolved_by = ?, entry_id = ? WHERE id = ?")
        .run(nowIso(), actor.username, result.batch, row.id)
      this.audit.log({
        username: actor.username,
        source: 'confirm',
        action: 'proposal.confirm',
        targetId: row.id,
        detail: { kind: 'import', batch: result.batch, count: result.created.length, ids: result.created.map((e) => e.id) },
      })
      return { proposal: this.getOne(row.id), entries: result.created, batch: result.batch }
    }
    const payload = JSON.parse(row.payload) as EntryInput
    const entry = this.finance.create(confirmer, payload)
    this.db
      .prepare("UPDATE finance_proposals SET status = 'confirmed', resolved_at = ?, resolved_by = ?, entry_id = ? WHERE id = ?")
      .run(nowIso(), actor.username, entry.id, row.id)
    this.audit.log({
      username: actor.username,
      source: 'confirm',
      action: 'proposal.confirm',
      targetId: row.id,
      detail: { entry_id: entry.id, payload },
    })
    return { proposal: this.getOne(row.id), entry }
  }

  reject(actor: Actor, rawId: string, reason: string): ProposalRecord {
    const row = this.requireRow(rawId)
    if (row.status !== 'pending') {
      throw new BadRequestError(`${rawId} 已处理过（${statusLabel(row.status)}），不能重复拒绝。`)
    }
    this.db
      .prepare("UPDATE finance_proposals SET status = 'rejected', resolved_at = ?, resolved_by = ?, reason = ? WHERE id = ?")
      .run(nowIso(), actor.username, (reason ?? '').trim(), row.id)
    this.audit.log({
      username: actor.username,
      source: actor.source,
      action: 'proposal.reject',
      targetId: row.id,
      detail: { reason: (reason ?? '').trim() },
    })
    return this.getOne(row.id)
  }

  list(status?: string): { count: number; proposals: ProposalRecord[] } {
    const clauses: string[] = []
    const params: unknown[] = []
    if (status !== undefined && status !== '') {
      if (!(['pending', 'confirmed', 'rejected'] as readonly string[]).includes(status)) {
        throw new BadRequestError(`status 应为 pending|confirmed|rejected，收到："${status}"。`)
      }
      clauses.push('status = ?')
      params.push(status)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db
      .prepare(`SELECT * FROM finance_proposals ${where} ORDER BY id DESC LIMIT 50`)
      .all(...params) as ProposalRow[]
    return { count: rows.length, proposals: rows.map((r) => this.toRecord(r)) }
  }

  // --------------------------------------------------------------- 内部

  private allocateId(): string {
    const date = new Date()
    const ymd = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
    const prefix = `PROP-${ymd}-`
    const row = this.db
      .prepare('SELECT MAX(CAST(substr(id, -3) AS INTEGER)) AS maxn FROM finance_proposals WHERE id LIKE ?')
      .get(`${prefix}%`) as { maxn: number | null }
    return `${prefix}${String((row.maxn ?? 0) + 1).padStart(3, '0')}`
  }

  private requireRow(rawId: string): ProposalRow {
    const id = (rawId ?? '').trim()
    if (!/^PROP-\d{8}-\d{3}$/.test(id)) {
      throw new BadRequestError(`提案编号格式应为 PROP-YYYYMMDD-NNN，收到："${rawId ?? ''}"。`)
    }
    const row = this.db.prepare('SELECT * FROM finance_proposals WHERE id = ?').get(id) as ProposalRow | undefined
    if (row === undefined) throw new NotFoundError(`找不到提案 ${id}。`)
    return row
  }

  private getOne(rawId: string): ProposalRecord {
    return this.toRecord(this.requireRow(rawId))
  }

  private toRecord(row: ProposalRow): ProposalRecord {
    const kind: ProposalKind = row.kind === 'import' ? 'import' : 'single'
    return {
      id: row.id,
      kind,
      payload: JSON.parse(row.payload) as EntryInput | ImportPayload,
      summary: row.summary,
      status: row.status as ProposalRecord['status'],
      created_at: row.created_at,
      created_by: row.created_by,
      resolved_at: row.resolved_at ?? '',
      resolved_by: row.resolved_by ?? '',
      entry_id: row.entry_id ?? '',
      reason: row.reason,
    }
  }
}

/** 一句话展示（卡片标题行）：把人话提案归一成要素齐全的摘要。 */
function buildSummary(input: EntryInput, norm: { type: EntryType; amount: number; date: string; status: string }): string {
  const bits = [`${TYPE_LABELS[norm.type]} ${norm.amount} 元`]
  const counterparty = (input.counterparty ?? '').trim()
  if (counterparty !== '') bits.push(`对方 ${counterparty}`)
  bits.push(norm.date)
  const account = (input.account ?? '').trim()
  if (account !== '') bits.push(`走 ${account}`)
  const category = (input.category ?? '').trim()
  if (category !== '') bits.push(category)
  if (input.status !== undefined && input.status !== norm.status) bits.push(`状态 ${norm.status}`)
  return `记一笔：${bits.join('，')}`
}

/** 批量卡标题：按类型聚合金额，老板一眼看到"进多少出多少"（收入排前）。 */
const SUMMARY_ORDER: EntryType[] = ['income', 'expense', 'reimburse', 'invoice', 'payroll', 'tax']
function buildImportSummary(norms: { type: EntryType; amount: number; date: string }[]): string {
  const totals = new Map<EntryType, number>()
  for (const n of norms) totals.set(n.type, r2((totals.get(n.type) ?? 0) + n.amount))
  const parts = SUMMARY_ORDER.filter((t) => totals.has(t)).map((t) => `${TYPE_LABELS[t]} ${totals.get(t)} 元`)
  const dates = norms.map((n) => n.date).sort()
  const span = dates[0] === dates[dates.length - 1] ? dates[0] : `${dates[0]} ~ ${dates[dates.length - 1]}`
  return `批量导入 ${norms.length} 笔（${span}）：${parts.join('，')}`
}

function statusLabel(status: string): string {
  return status === 'confirmed' ? '已确认' : status === 'rejected' ? '已拒绝' : status
}

interface ProposalRow {
  id: string
  kind: string
  payload: string
  summary: string
  status: string
  created_at: string
  created_by: string
  resolved_at: string | null
  resolved_by: string | null
  entry_id: string | null
  reason: string
}

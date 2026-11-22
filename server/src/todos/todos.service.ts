/** 义务/待办服务（2026-10-31 待办预警方案 P0-b；二批完善按用户口述定版）：obligations 表的唯一写入口。
 *  铁律（方案 §1.4，二批修订）：
 *  - 推导型（origin=scan）的真相源在原表（账本/票夹/提案/用户表）。「已完成」不直接落 done：
 *    先由扫描服务核实源头（completeDerived）——源头消失=resolved；仍在=不关、恢复提醒；
 *    系统无法核实（申报缴费）=要备注强制确认，落 dismissed（永久，源头重现不再建）。
 *    本服务的 done() 只接人工待办，推导型调用直接拒绝（卡片等旁路进不来）。
 *  - 推导型可改到期日/严重度/责任人（标题与说明由扫描器维护）；改过后 user_edited=1，扫描刷新不覆盖。
 *  - 可见性谓词（§1.6 数据分割）：管理员(admin:manage) ∨ 创建人 ∨ (owner=user ∧ 是本人) ∨
 *    (owner=role ∧ 持有该岗)；不可见一律 404"不存在"，不泄露存在性。
 *  审计纪律：只记义务 id+动作，不记 title/detail/备注正文（义务文本是经营内容，不进审计）。 */
import { randomUUID } from 'node:crypto'
import type { DB } from '../db/database.js'
import { nowIso } from '../db/database.js'
import { BadRequestError, NotFoundError } from '../errors.js'
import type { AuditService } from '../audit/audit.service.js'
import type { RbacService } from '../rbac/rbac.service.js'
import { DATE_PATTERN } from '../finance/finance.types.js'
import { localDate } from '../finance/finance.util.js'
import {
  ACTIVE_STATUSES,
  SEVERITIES,
  type ObligationRow,
  type ObligationSeverity,
  type ObligationStatus,
} from './todos.types.js'

export { localDate }

/** 到期日加减天数（due_date 是 YYYY-MM-DD 日历口径，本地时区）。 */
export function addDaysISO(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number]
  return localDate(new Date(y, m - 1, d + days))
}

export interface TodoInput {
  title?: unknown
  detail?: unknown
  ownerType?: unknown
  ownerId?: unknown
  dueDate?: unknown
  severity?: unknown
}

export interface TodoListOpts {
  scope: 'mine' | 'pool' | 'enterprise'
  /** active（默认：open+escalated）| all | 具体状态。 */
  status?: unknown
  limit?: unknown
}

export interface TodoSummary {
  overdue: number
  today: number
  upcoming7: number
  undated: number
}

export interface RouteView {
  source_type: string
  owner_type: 'user' | 'role'
  owner_id: string
  enabled: number
}

interface RouteRow {
  source_type: string
  owner_type: 'user' | 'role'
  owner_id: string
  enabled: number
}

export class TodosService {
  constructor(
    private readonly db: DB,
    private readonly rbac: RbacService,
    private readonly audit: AuditService,
  ) {}

  // ---------- 可见性 ----------

  private viewerRoles(username: string): string[] {
    return this.rbac.rolesOf(username)
  }

  private isAdmin(username: string): boolean {
    return this.rbac.hasPermission(username, 'admin:manage')
  }

  private visibleTo(row: ObligationRow, viewer: string, roles: string[], admin: boolean): boolean {
    if (admin) return true
    if (row.created_by === viewer) return true
    if (row.owner_type === 'user' && row.owner_id === viewer) return true
    if (row.owner_type === 'role' && roles.includes(row.owner_id)) return true
    return false
  }

  /** 单条读取：不可见=不存在（不泄露存在性，与对话域同一口径）。 */
  getVisible(viewer: string, rawId: unknown): ObligationRow {
    const id = Number(rawId)
    if (!Number.isInteger(id) || id <= 0) throw new NotFoundError('待办不存在或已关闭。')
    const row = this.db.prepare('SELECT * FROM obligations WHERE id = ?').get(id) as ObligationRow | undefined
    if (row === undefined) throw new NotFoundError('待办不存在或已关闭。')
    if (!this.visibleTo(row, viewer, this.viewerRoles(viewer), this.isAdmin(viewer))) {
      throw new NotFoundError('待办不存在或已关闭。')
    }
    return row
  }

  // ---------- 人工待办 CRUD ----------

  /** 新指派即时卡钩子（扫描服务在构造时挂上）：推送失败不影响建待办。 */
  onCreated: ((row: ObligationRow, actor: string) => Promise<void>) | undefined

  async create(actor: string, input: TodoInput): Promise<ObligationRow> {
    const { title, detail, ownerType, ownerId, dueDate, severity } = this.parseInput(input, actor)
    const ts = nowIso()
    const r = this.db
      .prepare(
        `INSERT INTO obligations
           (source_type, source_ref, dedupe_key, title, detail, owner_type, owner_id, due_date,
            severity, status, origin, first_seen_at, created_by, created_at)
         VALUES ('manual', '{}', ?, ?, ?, ?, ?, ?, ?, 'open', 'manual', ?, ?, ?)`,
      )
      .run(`manual:${randomUUID()}`, title, detail, ownerType, ownerId, dueDate, severity, ts, actor, ts)
    this.audit.log({
      username: actor,
      source: 'ui',
      action: 'todo.created',
      targetId: String(r.lastInsertRowid),
      detail: { ownerType, ownerId, dueDate, severity },
    })
    const row = this.getVisible(actor, r.lastInsertRowid)
    if (this.onCreated !== undefined) {
      try {
        await this.onCreated(row, actor)
      } catch (e) {
        console.warn('[todos] 新指派推卡失败：', e instanceof Error ? e.message : e)
      }
    }
    return row
  }

  update(actor: string, rawId: unknown, input: TodoInput): ObligationRow {
    const row = this.getVisible(actor, rawId)
    this.requireActive(row)
    const derived = row.origin === 'scan'
    if (derived) {
      // 推导型：标题/说明是扫描器从源头算出来的事实，不让人改；到期/严重度/责任人可调（延期、转派、降级）
      const titleChanged = typeof input.title === 'string' && input.title.trim() !== row.title
      const detailChanged = typeof input.detail === 'string' && input.detail.trim() !== row.detail
      if (titleChanged || detailChanged) {
        throw new BadRequestError('系统推导的待办标题与说明由系统维护，只能改到期日、严重度和责任人。')
      }
    }
    const merged: TodoInput = {
      title: derived ? row.title : (input.title ?? row.title),
      detail: derived ? row.detail : (input.detail ?? row.detail),
      ownerType: input.ownerType ?? row.owner_type,
      ownerId: input.ownerId ?? row.owner_id,
      dueDate: input.dueDate ?? row.due_date,
      severity: input.severity ?? row.severity,
    }
    const { title, detail, ownerType, ownerId, dueDate, severity } = this.parseInput(merged, actor)
    this.db
      .prepare(
        `UPDATE obligations SET title = ?, detail = ?, owner_type = ?, owner_id = ?, due_date = ?, severity = ?,
           user_edited = CASE WHEN ? THEN 1 ELSE user_edited END
         WHERE id = ?`,
      )
      .run(title, detail, ownerType, ownerId, dueDate, severity, derived ? 1 : 0, row.id)
    this.audit.log({
      username: actor,
      source: 'ui',
      action: 'todo.updated',
      targetId: String(row.id),
      detail: { ownerType, ownerId, dueDate, severity, derived },
    })
    return this.getVisible(actor, row.id)
  }

  /** 完成（人工待办；可带备注）。推导型不走这里——由扫描服务 completeDerived 核实源头后处置，
   *  卡片等旁路直接调到本方法的推导型一律拒绝。 */
  done(actor: string, rawId: unknown, rawNote?: unknown): ObligationRow {
    const row = this.getVisible(actor, rawId)
    if (row.origin === 'scan') {
      throw new BadRequestError('系统推导的待办请在待办中心点「已完成」，系统会先核实源头再关闭；源头处理掉（收款核销/挂票）也会自动闭合。')
    }
    this.requireActive(row)
    const note = this.parseNote(rawNote)
    this.db
      .prepare("UPDATE obligations SET status = 'done', done_by = ?, done_at = ?, done_note = ? WHERE id = ?")
      .run(actor, nowIso(), note, row.id)
    this.audit.log({ username: actor, source: 'ui', action: 'todo.done', targetId: String(row.id), detail: { hasNote: note !== '' } })
    return this.getVisible(actor, row.id)
  }

  /** 推导型经扫描器核实"源头已消失"后的闭合（completeDerived 调）：与自动闭合同为 resolved，
   *  但记下是谁按的、备注是什么。 */
  resolveVerified(actor: string, rawId: unknown, rawNote?: unknown): ObligationRow {
    const row = this.getVisible(actor, rawId)
    this.requireActive(row)
    const note = this.parseNote(rawNote)
    this.db
      .prepare("UPDATE obligations SET status = 'resolved', resolved_at = ?, done_by = ?, done_at = ?, done_note = ? WHERE id = ?")
      .run(nowIso(), actor, nowIso(), note, row.id)
    this.audit.log({ username: actor, source: 'ui', action: 'todo.done', targetId: String(row.id), detail: { verified: true, hasNote: note !== '' } })
    return this.getVisible(actor, row.id)
  }

  /** 核实结果"源头仍在"：这条不关；若之前按过「暂不处理」（ack 静音），恢复提醒。 */
  resumeReminders(rawId: unknown): void {
    this.db
      .prepare("UPDATE obligations SET last_notified = '' WHERE id = ? AND last_notified LIKE 'ack:%'")
      .run(Number(rawId))
  }

  /** 强制确认完成 / 静默：必须留备注；落 dismissed（永久：源头重现也不再建）。两种来源都可。
   *  forced=true 表示走的是「已完成→无法核实→填备注确认」路径（审计区分，状态同为 dismissed）。 */
  dismiss(actor: string, rawId: unknown, rawReason: unknown, forced = false): ObligationRow {
    const row = this.getVisible(actor, rawId)
    this.requireActive(row)
    const reason = typeof rawReason === 'string' ? rawReason.trim() : ''
    if (reason === '') throw new BadRequestError('必须填写备注——这是审计与回看时唯一的"为什么这样处理"。')
    if (reason.length > 200) throw new BadRequestError('备注最长 200 字。')
    this.db
      .prepare("UPDATE obligations SET status = 'dismissed', dismissed_by = ?, dismissed_reason = ?, dismissed_at = ? WHERE id = ?")
      .run(actor, reason, nowIso(), row.id)
    this.audit.log({
      username: actor,
      source: 'ui',
      action: 'todo.dismissed',
      targetId: String(row.id),
      detail: { forced },
    })
    return this.getVisible(actor, row.id)
  }

  /** 暂不处理（原「知道了」）：不再推送这条（晨报里仍会出现一行），到期升级时再提醒一次；两种来源都可。 */
  ack(actor: string, rawId: unknown): ObligationRow {
    const row = this.getVisible(actor, rawId)
    this.requireActive(row)
    this.db.prepare("UPDATE obligations SET last_notified = ? WHERE id = ?").run(`ack:${localDate()}`, row.id)
    this.audit.log({ username: actor, source: 'ui', action: 'todo.acked', targetId: String(row.id) })
    return this.getVisible(actor, row.id)
  }

  /** 卡片回写端口（BridgeService 待办卡按钮走这里，方案 P2）：ack=暂不处理 / done=完成（仅人工待办）。
   *  phrase 带标题回平台（用户自己的卡，回显无泄露问题）；审计仍不含标题。 */
  todoCardAction(actor: string, rawTodoId: unknown, action: 'ack' | 'done'): { outcome: 'acked' | 'done'; phrase: string } {
    const row = this.getVisible(actor, rawTodoId)
    if (action === 'done') {
      const updated = this.done(actor, row.id)
      return { outcome: 'done', phrase: `已完成：${updated.title}` }
    }
    const updated = this.ack(actor, row.id)
    return { outcome: 'acked', phrase: `收到，这条暂不处理、不再推送（仍在待办中心，到期升级时再提醒一次）：${updated.title}` }
  }

  // ---------- 视图 ----------

  listFor(viewer: string, opts: TodoListOpts): { count: number; items: ObligationRow[] } {
    const admin = this.isAdmin(viewer)
    if (opts.scope === 'enterprise' && !admin) throw new NotFoundError('待办不存在或已关闭。')
    const where: string[] = []
    const params: unknown[] = []
    if (opts.scope === 'mine') {
      where.push("((owner_type = 'user' AND owner_id = ?) OR (origin = 'manual' AND created_by = ?))")
      params.push(viewer, viewer)
    } else if (opts.scope === 'pool') {
      const roles = this.viewerRoles(viewer)
      if (roles.length === 0) return { count: 0, items: [] }
      where.push(`(owner_type = 'role' AND owner_id IN (${roles.map(() => '?').join(', ')}))`)
      params.push(...roles)
    }
    const status = opts.status === undefined || opts.status === 'active' ? 'active' : opts.status
    if (status === 'active') {
      where.push(`status IN (${ACTIVE_STATUSES.map(() => '?').join(', ')})`)
      params.push(...ACTIVE_STATUSES)
    } else if (status !== 'all') {
      if (typeof status !== 'string' || !['open', 'resolved', 'dismissed', 'done', 'escalated'].includes(status)) {
        throw new BadRequestError("status 只认 active | all | open | resolved | dismissed | done | escalated。")
      }
      where.push('status = ?')
      params.push(status as string)
    }
    const limit = typeof opts.limit === 'number' && Number.isInteger(opts.limit) && opts.limit > 0 ? Math.min(opts.limit, 500) : 200
    const sql = `SELECT * FROM obligations ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY (due_date = '') ASC, due_date ASC,
        CASE severity WHEN 'critical' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END ASC,
        first_seen_at DESC
      LIMIT ${limit}`
    const items = this.db.prepare(sql).all(...params) as ObligationRow[]
    return { count: items.length, items }
  }

  /** 角标汇总：我的 + 岗位池的活跃待办，按到期分桶（方案 §七 badge）。 */
  summaryFor(viewer: string): TodoSummary {
    const roles = this.viewerRoles(viewer)
    const today = localDate()
    const plus7 = addDaysISO(today, 7)
    const scope = ["(owner_type = 'user' AND owner_id = ?)"]
    const params: unknown[] = [viewer]
    if (roles.length > 0) {
      scope.push(`(owner_type = 'role' AND owner_id IN (${roles.map(() => '?').join(', ')}))`)
      params.push(...roles)
    }
    const row = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN due_date != '' AND due_date < ? THEN 1 ELSE 0 END) AS overdue,
           SUM(CASE WHEN due_date = ? THEN 1 ELSE 0 END) AS today,
           SUM(CASE WHEN due_date > ? AND due_date <= ? THEN 1 ELSE 0 END) AS upcoming7,
           SUM(CASE WHEN due_date = '' THEN 1 ELSE 0 END) AS undated
         FROM obligations WHERE status IN ('open', 'escalated') AND (${scope.join(' OR ')})`,
      )
      .get(today, today, today, plus7, ...params) as { overdue: number | null; today: number | null; upcoming7: number | null; undated: number | null }
    return {
      overdue: row.overdue ?? 0,
      today: row.today ?? 0,
      upcoming7: row.upcoming7 ?? 0,
      undated: row.undated ?? 0,
    }
  }

  // ---------- 路由与运行记录 ----------

  /** 可指派对象清单（建待办时选人/选岗用）：启用的真人账号 + 非技术角色。
   *  只给 todo:write 持有者，不含权限明细——比 /api/rbac/users 轻，非管理员也能用。 */
  owners(): { users: { username: string; displayName: string }[]; roles: string[] } {
    const users = this.rbac
      .listUsersWithRoles()
      .filter((u) => !u.isService && !u.disabled)
      .map((u) => ({ username: u.username, displayName: u.displayName }))
    const roles = this.rbac
      .listRoles()
      .filter((r) => !r.technical)
      .map((r) => r.name)
    return { users, roles }
  }

  /** 扫描器注册表里声明过的 source_type（controller 注入，避免服务间互相依赖）。 */
  knownSourceTypes: string[] = []

  routes(): RouteView[] {
    const rows = this.db.prepare('SELECT * FROM obligation_routes').all() as RouteRow[]
    const byKey = new Map(rows.map((r) => [r.source_type, r]))
    const fallback = this.rbac.bossUsername() ?? 'boss'
    return this.knownSourceTypes.map(
      (k) => byKey.get(k) ?? { source_type: k, owner_type: 'user', owner_id: fallback, enabled: 1 },
    )
  }

  setRoute(actor: string, sourceType: string, input: { ownerType?: unknown; ownerId?: unknown; enabled?: unknown }): RouteView {
    if (!this.knownSourceTypes.includes(sourceType)) {
      throw new BadRequestError(`未知义务来源 "${sourceType}"，可选：${this.knownSourceTypes.join('、')}。`)
    }
    const current = this.routes().find((r) => r.source_type === sourceType)!
    const ownerType = input.ownerType === undefined ? current.owner_type : input.ownerType
    if (ownerType !== 'user' && ownerType !== 'role') throw new BadRequestError("ownerType 只认 'user' | 'role'。")
    const ownerId = (input.ownerId === undefined ? current.owner_id : input.ownerId) as unknown
    if (typeof ownerId !== 'string' || ownerId.trim() === '') throw new BadRequestError('ownerId 不能为空。')
    const owner = ownerId.trim()
    if (ownerType === 'user') {
      const u = this.rbac.findUser(owner)
      if (u === undefined || u.disabled_at !== null) throw new BadRequestError(`系统里没有启用的用户 "${owner}"。`)
    } else if (!this.rbac.listRoles().some((r) => r.name === owner)) {
      throw new BadRequestError(`系统里没有角色 "${owner}"。`)
    }
    const enabled =
      input.enabled === undefined ? current.enabled : input.enabled === true || input.enabled === 1 || input.enabled === '1' ? 1 : 0
    this.db
      .prepare(
        `INSERT INTO obligation_routes (source_type, owner_type, owner_id, enabled) VALUES (?, ?, ?, ?)
         ON CONFLICT(source_type) DO UPDATE SET owner_type = excluded.owner_type, owner_id = excluded.owner_id, enabled = excluded.enabled`,
      )
      .run(sourceType, ownerType, owner, enabled)
    // 路由=这类事归谁：改绑时把该来源仍活跃的推导项一并移交（已闭合/已静默的留在原责任人名下可追溯；
    // 被人手动改过责任人的也不动——user_edited 的承诺是"扫描不覆盖"，路由批量移交同样不能洗掉人的改派）
    const migrated = this.db
      .prepare(
        `UPDATE obligations SET owner_type = ?, owner_id = ?
         WHERE source_type = ? AND origin = 'scan' AND status IN ('open', 'escalated') AND user_edited = 0
           AND NOT (owner_type = ? AND owner_id = ?)`,
      )
      .run(ownerType, owner, sourceType, ownerType, owner).changes
    this.audit.log({
      username: actor,
      source: 'ui',
      action: 'todo.route.set',
      targetId: sourceType,
      detail: { ownerType, ownerId: owner, enabled: enabled === 1, migrated },
    })
    return this.routes().find((r) => r.source_type === sourceType)!
  }

  listScanRuns(limit: unknown): { count: number; runs: Record<string, unknown>[] } {
    const n = typeof limit === 'number' && Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50
    const runs = this.db.prepare('SELECT * FROM scan_runs ORDER BY id DESC LIMIT ?').all(n) as Record<string, unknown>[]
    return { count: runs.length, runs }
  }

  // ---------- 内部 ----------

  /** 活跃态守卫（扫描服务的核实式完成也用：推导型关闭前先过这道）。 */
  requireActive(row: ObligationRow): void {
    if (!ACTIVE_STATUSES.includes(row.status)) {
      throw new BadRequestError(`这条待办已关闭（${row.status}），不能再操作。`)
    }
  }

  /** 完成备注：可空；最长 200 字（与静默原因同上限）。 */
  private parseNote(raw: unknown): string {
    if (raw === undefined || raw === null) return ''
    if (typeof raw !== 'string') throw new BadRequestError('备注必须是文本。')
    const note = raw.trim()
    if (note.length > 200) throw new BadRequestError('备注最长 200 字。')
    return note
  }

  private parseInput(
    input: TodoInput,
    actor: string,
  ): { title: string; detail: string; ownerType: 'user' | 'role'; ownerId: string; dueDate: string; severity: ObligationSeverity } {
    const title = typeof input.title === 'string' ? input.title.trim() : ''
    if (title === '') throw new BadRequestError('标题不能为空。')
    if (title.length > 120) throw new BadRequestError('标题最长 120 字。')
    const detail = typeof input.detail === 'string' ? input.detail.trim().slice(0, 2000) : ''
    const ownerType = (input.ownerType ?? 'user') as unknown
    if (ownerType !== 'user' && ownerType !== 'role') throw new BadRequestError("ownerType 只认 'user' | 'role'。")
    const rawOwner = (input.ownerId ?? actor) as unknown
    if (typeof rawOwner !== 'string' || rawOwner.trim() === '') throw new BadRequestError('ownerId 不能为空。')
    const ownerId: string = rawOwner.trim()
    if (ownerType === 'user') {
      const u = this.rbac.findUser(ownerId)
      if (u === undefined || u.disabled_at !== null) throw new BadRequestError(`系统里没有启用的用户 "${ownerId}"。`)
    } else if (!this.rbac.listRoles().some((r) => r.name === ownerId)) {
      throw new BadRequestError(`系统里没有角色 "${ownerId}"。`)
    }
    let dueDate = ''
    if (input.dueDate !== undefined && input.dueDate !== null && input.dueDate !== '') {
      if (typeof input.dueDate !== 'string' || !DATE_PATTERN.test(input.dueDate)) {
        throw new BadRequestError('dueDate 格式应为 YYYY-MM-DD。')
      }
      dueDate = input.dueDate
    }
    const severity = (input.severity ?? 'info') as unknown
    if (typeof severity !== 'string' || !SEVERITIES.includes(severity as ObligationSeverity)) {
      throw new BadRequestError("severity 只认 'info' | 'warn' | 'critical'。")
    }
    return { title, detail, ownerType, ownerId: ownerId as string, dueDate, severity: severity as ObligationSeverity }
  }
}

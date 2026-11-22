/** 审计：所有写路径（界面/agent/确认卡片）统一落一张审计表。 */
import Database from 'better-sqlite3'
import type { DB } from '../db/database.js'
import { nowIso } from '../db/database.js'

export interface AuditEntry {
  username: string
  source: string
  action: string
  targetId?: string | null
  detail?: Record<string, unknown>
  ok?: boolean
}

export class AuditService {
  private stmt: Database.Statement

  constructor(private readonly db: DB) {
    this.stmt = db.prepare(
      `INSERT INTO audit_log (ts, username, source, action, target_id, detail, ok)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
  }

  log(entry: AuditEntry): void {
    this.stmt.run(
      nowIso(),
      entry.username,
      entry.source,
      entry.action,
      entry.targetId ?? null,
      JSON.stringify(entry.detail ?? {}),
      entry.ok === false ? 0 : 1,
    )
  }

  /** 最近审计（财务台侧用，倒序）。 */
  recent(limit = 50): unknown[] {
    const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 500)
    return this.db
      .prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?')
      .all(safeLimit)
  }

  /** 系统审计页（2026-10-27 框架定版）：可按动作/用户筛，倒序。 */
  list(opts: { limit?: number; action?: string; username?: string } = {}): unknown[] {
    const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 100)), 500)
    const where: string[] = []
    const params: (string | number)[] = []
    if (opts.action) {
      where.push('action = ?')
      params.push(opts.action)
    }
    if (opts.username) {
      where.push('username = ?')
      params.push(opts.username)
    }
    const sql = `SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`
    return this.db.prepare(sql).all(...params, limit)
  }
}

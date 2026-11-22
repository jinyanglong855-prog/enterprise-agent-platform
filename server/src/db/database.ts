/** SQLite 连接与建库：WAL、外键、schema 执行与老库迁移。测试可用临时文件路径。 */
import Database from 'better-sqlite3'
import { migrate, SCHEMA_SQL } from './schema.js'

export type DB = Database.Database

export function openDatabase(dbPath: string): DB {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA_SQL)
  migrate(db)
  return db
}

export function nowIso(): string {
  return new Date().toISOString()
}

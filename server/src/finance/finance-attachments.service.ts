/** 附件归档域（证据维，任务全图 B3 回单/单据归集，2026-10-26）：
 *  每笔账的证据文件（网银回单 PDF、发票图片、合同扫描件）挂到账目上。
 *  文件落磁盘（数据目录 attachments/YYYY/MM/，随机文件名防路径注入），DB 只存索引与 sha256。
 *  删除=软删（只摘引用不删文件）：档案维的证据一旦归集就不物理消灭；审计全程留痕。
 *  agent 不开附件工具：归集是人的活（任务全图 B3 分工），工具面保持窄门面。 */
import { randomUUID, createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DB } from '../db/database.js'
import { nowIso } from '../db/database.js'
import type { AuditService } from '../audit/audit.service.js'
import { config } from '../config.js'
import { BadRequestError, NotFoundError } from '../errors.js'
import type { Actor } from './finance.types.js'
import { localDate } from './finance.util.js'

/** 单文件上限（解码后字节数）：网银回单/发票图片的现实量级远够。 */
export const ATTACH_MAX_BYTES = 8 * 1024 * 1024

/** 允许的扩展名：回单/发票/合同类证据文件。exe 等可执行一律拒——单机也要守住"上传即运行"的口子。 */
const EXT_WHITELIST = ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'heic', 'ofd', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'txt'] as const

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  ofd: 'application/ofd',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  txt: 'text/plain',
}

export interface AttachmentRecord {
  id: number
  entry_id: string
  file_name: string
  ext: string
  mime: string
  size: number
  sha256: string
  note: string
  created_by: string
  created_at: string
}

export interface AttachmentInput {
  file_name?: unknown
  data_base64?: unknown
  note?: unknown
}

export class FinanceAttachmentsService {
  constructor(
    private readonly db: DB,
    private readonly audit: AuditService,
  ) {}

  add(actor: Actor, rawEntryId: string, input: AttachmentInput): AttachmentRecord {
    const entryId = this.requireAttachableEntry(rawEntryId)
    const fileName = this.cleanFileName(input.file_name)
    const ext = this.requireExt(fileName)
    const bytes = this.decodeBase64(input.data_base64)
    if (bytes.length === 0) throw new BadRequestError('文件内容为空（data_base64 解码后 0 字节）。')
    if (bytes.length > ATTACH_MAX_BYTES) {
      throw new BadRequestError(`文件超过 ${Math.floor(ATTACH_MAX_BYTES / 1024 / 1024)} MB 上限（收到 ${Math.ceil(bytes.length / 1024)} KB），请压缩后再传。`)
    }

    const day = localDate()
    const [y, m] = day.split('-')
    const dir = join(config.dataDir, 'attachments', y!, m!)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const storedName = `${randomUUID()}.${ext}`
    writeFileSync(join(dir, storedName), bytes)

    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const note = typeof input.note === 'string' ? input.note.trim().slice(0, 200) : ''
    const info = this.db
      .prepare(
        `INSERT INTO finance_attachments (entry_id, file_name, stored_name, ext, mime, size, sha256, note, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(entryId, fileName, `${y}/${m}/${storedName}`, ext, MIME_BY_EXT[ext] ?? 'application/octet-stream', bytes.length, sha256, note, actor.username, nowIso())
    this.audit.log({
      username: actor.username,
      source: actor.source,
      action: 'attachment.upload',
      targetId: String(info.lastInsertRowid),
      detail: { entry_id: entryId, file_name: fileName, size: bytes.length, sha256 },
    })
    return this.getOne(Number(info.lastInsertRowid))
  }

  listByEntry(rawEntryId: string): { count: number; attachments: AttachmentRecord[] } {
    const entryId = this.requireEntryId(rawEntryId)
    const rows = this.db
      .prepare('SELECT * FROM finance_attachments WHERE entry_id = ? AND deleted_at IS NULL ORDER BY id ASC')
      .all(entryId) as AttachmentRow[]
    return { count: rows.length, attachments: rows.map(toRecord) }
  }

  /** 读文件内容（下载用）：文件不在盘上要明说——备份只备 DB，附件目录要单独备份。 */
  read(id: number): { record: AttachmentRecord; bytes: Buffer } {
    const row = this.requireRow(id)
    // stored_name 存的是相对 attachments 根的 "YYYY/MM/uuid.ext"（写入时生成，非用户输入），直接拼
    const path = join(config.dataDir, 'attachments', row.stored_name)
    if (!existsSync(path)) {
      throw new NotFoundError(`附件文件在磁盘上找不到（${row.file_name}）。数据库记录还在；检查 attachments 目录是否被移动过或备份恢复是否完整。`)
    }
    return { record: toRecord(row), bytes: readFileSync(path) }
  }


  /** 软删：只摘引用。文件留在盘上（档案维：归集过的证据不物理消灭）。 */
  remove(actor: Actor, id: number, reason: string): void {
    const row = this.requireRow(id)
    this.db.prepare('UPDATE finance_attachments SET deleted_at = ? WHERE id = ?').run(nowIso(), row.id)
    this.audit.log({
      username: actor.username,
      source: actor.source,
      action: 'attachment.delete',
      targetId: String(row.id),
      detail: { entry_id: row.entry_id, file_name: row.file_name, reason },
    })
  }

  // --------------------------------------------------------------- 内部

  private getOne(id: number): AttachmentRecord {
    return toRecord(this.requireRow(id))
  }

  private requireRow(id: number): AttachmentRow {
    if (!Number.isInteger(id) || id <= 0) throw new BadRequestError(`附件 id 应为正整数，收到："${id}"。`)
    const row = this.db.prepare('SELECT * FROM finance_attachments WHERE id = ? AND deleted_at IS NULL').get(id) as AttachmentRow | undefined
    if (row === undefined) throw new NotFoundError(`找不到附件 #${id}。`)
    return row
  }

  /** 挂附件的账目必须存在且在账：作废账与冲销对不给挂证据（与票挂联同一口径）。 */
  private requireAttachableEntry(rawId: string): string {
    const id = this.requireEntryId(rawId)
    const row = this.db
      .prepare('SELECT id, status, reverses, reversed_by FROM finance_entries WHERE id = ? AND deleted_at IS NULL')
      .get(id) as { id: string; status: string; reverses: string; reversed_by: string } | undefined
    if (row === undefined) throw new NotFoundError(`找不到账目 ${id}。可先在台账核对编号。`)
    if (row.status === 'cancelled') throw new BadRequestError(`账目 ${id} 已作废（不计入统计），附件不给挂。`)
    if (row.reverses !== '' || row.reversed_by !== '') throw new BadRequestError(`账目 ${id} 属于冲销对，附件挂到原账或冲销后的新账上，不挂冲销条目。`)
    return id
  }

  private requireEntryId(rawId: string): string {
    const id = (rawId ?? '').trim()
    if (!/^FIN-\d{8}-\d{3}$/.test(id)) {
      throw new BadRequestError(`账目编号格式应为 FIN-YYYYMMDD-NNN，收到："${rawId ?? ''}"。`)
    }
    return id
  }

  /** 文件名只留名字部分（去路径分隔符），限长 120；扩展名必须在白名单。 */
  private cleanFileName(value: unknown): string {
    if (typeof value !== 'string' || value.trim() === '') throw new BadRequestError('需要 file_name（文件名，带扩展名）。')
    const name = value.replaceAll('\\', '/').split('/').pop()!.trim()
    if (name === '' || name === '.' || name === '..') throw new BadRequestError(`文件名不合法："${value}"。`)
    return name.slice(0, 120)
  }

  private requireExt(fileName: string): string {
    const dot = fileName.lastIndexOf('.')
    const ext = dot === -1 ? '' : fileName.slice(dot + 1).toLowerCase()
    if (!(EXT_WHITELIST as readonly string[]).includes(ext)) {
      throw new BadRequestError(`扩展名 .${ext || '（无）'} 不在白名单（${EXT_WHITELIST.join('/')}）。回单/发票请用 PDF 或图片格式。`)
    }
    return ext
  }

  private decodeBase64(value: unknown): Buffer {
    if (typeof value !== 'string' || value.trim() === '') throw new BadRequestError('需要 data_base64（文件内容的 Base64 编码）。')
    const compact = value.replace(/\s/g, '')
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) throw new BadRequestError('data_base64 不是合法的 Base64 内容。')
    return Buffer.from(compact, 'base64')
  }
}

interface AttachmentRow {
  id: number
  entry_id: string
  file_name: string
  stored_name: string
  ext: string
  mime: string
  size: number
  sha256: string
  note: string
  created_by: string
  created_at: string
  deleted_at: string | null
}

function toRecord(row: AttachmentRow): AttachmentRecord {
  return {
    id: row.id,
    entry_id: row.entry_id,
    file_name: row.file_name,
    ext: row.ext,
    mime: row.mime,
    size: row.size,
    sha256: row.sha256,
    note: row.note,
    created_by: row.created_by,
    created_at: row.created_at,
  }
}

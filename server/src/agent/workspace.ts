/** 文件工作区（任务全图 §0.6 对话入口）：agent 专属 inbox/outbox 目录，数据根与账本同目录。
 *  约束（后端上传与 dsh-file-tools 插件共用同一套）：文件名白名单 + 解析后路径必须落在
 *  对应子目录内、大小与行数上限——越界报错回给 agent 自然重试。账本 DB 不在这里：落库只走确认。 */
import { mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, extname } from 'node:path'
import { BadRequestError } from '../errors.js'
import { config } from '../config.js'

export const WORKSPACE_LIMITS = {
  maxBytes: 1024 * 1024,
  maxLines: 5000,
  /** 文件名：中文/字母/数字/下划线/点/连字符/常用括号，≤80 字，不以点开头（防藏文件与路径花招）。 */
  namePattern: /^[A-Za-z0-9\u4e00-\u9fa5_（）()-][A-Za-z0-9\u4e00-\u9fa5_.（）()-]{0,79}$/,
} as const

/** 工作区只收文本表/文档（xlsx 二进制的解析在前端做，进来之前先转文本）。 */
export const ALLOWED_EXT = ['.csv', '.tsv', '.txt', '.md'] as const

export function workspaceRoot(): string {
  return join(config.dataDir, 'workspace')
}

function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true })
  return path
}

export function inboxDir(): string {
  return ensureDir(join(workspaceRoot(), 'inbox'))
}

export function outboxDir(): string {
  return ensureDir(join(workspaceRoot(), 'outbox'))
}

/** 文件名校验 + 目录封口：解析后的绝对路径必须仍在 dir 内（防 .. 与绝对路径越界）。 */
export function safeResolve(dir: string, rawName: string): string {
  const name = (rawName ?? '').trim()
  if (!WORKSPACE_LIMITS.namePattern.test(name)) {
    if (name.includes('/')) {
      throw new BadRequestError(`文件名"${name}"不合法：不要带目录，只传纯文件名，目录用 dir 参数指定（inbox/outbox）。`)
    }
    throw new BadRequestError(`文件名"${name}"不合法：中文/字母/数字/下划线/点/连字符，≤80 字，不以点开头。`)
  }
  if (!(ALLOWED_EXT as readonly string[]).includes(extname(name).toLowerCase())) {
    throw new BadRequestError(`只认 ${ALLOWED_EXT.join(' ')} 文本文件，收到扩展名"${extname(name) || '(无)'}"（xlsx 请先在前端转成 CSV/TSV）。`)
  }
  const full = resolve(dir, name)
  if (full !== dir && !full.startsWith(dir + '/')) {
    throw new BadRequestError(`文件路径越出工作区：只允许 ${dir} 下。`)
  }
  return full
}

export interface SavedFile {
  name: string
  path: string
  bytes: number
  lines: number
  overwritten: boolean
}

/** 存文本文件（同名覆盖，重传即更新）。超过大小/行数上限直接拒。 */
export function saveTextFile(dir: string, rawName: string, content: string): SavedFile {
  const name = (rawName ?? '').trim()
  if (typeof content !== 'string' || content.trim() === '') throw new BadRequestError('文件内容为空。')
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > WORKSPACE_LIMITS.maxBytes) {
    throw new BadRequestError(`文件超过 ${Math.floor(WORKSPACE_LIMITS.maxBytes / 1024 / 1024)} MB 上限，请拆分。`)
  }
  const lines = content.replace(/\n$/, '').split(/\r?\n/).length
  if (lines > WORKSPACE_LIMITS.maxLines) {
    throw new BadRequestError(`文件 ${lines} 行，超过 ${WORKSPACE_LIMITS.maxLines} 行上限，请拆分。`)
  }
  const full = safeResolve(dir, name)
  const overwritten = statSync(full, { throwIfNoEntry: false }) !== undefined
  writeFileSync(full, content, 'utf8')
  return { name, path: full, bytes, lines, overwritten }
}

export function listTextFiles(dir: string): { name: string; bytes: number; updated_at: string }[] {
  ensureDir(dir)
  return readdirSync(dir)
    .filter((n) => (ALLOWED_EXT as readonly string[]).includes(extname(n).toLowerCase()))
    .map((n) => {
      const st = statSync(join(dir, n))
      return { name: n, bytes: st.size, updated_at: st.mtime.toISOString() }
    })
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
}

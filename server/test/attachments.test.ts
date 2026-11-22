/** 附件归档测试（B3，2026-10-26）：白名单/大小/路径安全/软删/作废账拒挂/文件真实落盘可读回。
 *  ADMIN_DATA_DIR 指向临时目录：绝不碰生产数据目录（attachments 写磁盘）。 */
import assert from 'node:assert/strict'
import { test, beforeEach, after } from 'node:test'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ADMIN_DATA_DIR = mkdtempSync(join(tmpdir(), 'admin-attachments-test-'))

const { openDatabase } = await import('../src/db/database.js')
const { AuditService } = await import('../src/audit/audit.service.js')
const { FinanceService } = await import('../src/finance/finance.service.js')
const { FinanceAccountsService } = await import('../src/finance/finance-accounts.service.js')
const { FinanceAttachmentsService, ATTACH_MAX_BYTES } = await import('../src/finance/finance-attachments.service.js')
const { config } = await import('../src/config.js')
type DB = import('better-sqlite3').Database
import type { Actor } from '../src/finance/finance.types.js'

let db: DB
let audit: InstanceType<typeof AuditService>
let finance: InstanceType<typeof FinanceService>
let accounts: InstanceType<typeof FinanceAccountsService>
let attachments: InstanceType<typeof FinanceAttachmentsService>
const boss: Actor = { username: 'boss', source: 'ui' }

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')

beforeEach(() => {
  db = openDatabase(':memory:')
  audit = new AuditService(db)
  finance = new FinanceService(db, audit)
  accounts = new FinanceAccountsService(db, audit)
  attachments = new FinanceAttachmentsService(db, audit)
})

after(() => {
  rmSync(process.env.ADMIN_DATA_DIR!, { recursive: true, force: true })
})

test('上传→列表→读回：内容与哈希一致，文件真实落在 attachments/YYYY/MM/ 下', () => {
  accounts.create(boss, { name: '微信', kind: 'wechat' })
  const entry = finance.create(boss, { type: 'expense', amount: 45, account: '微信', status: 'paid', date: '2026-10-20' })
  const rec = attachments.add(boss, entry.id, { file_name: '回单.pdf', data_base64: b64('PDF-CONTENT-回单'), note: '10月打印纸' })
  assert.equal(rec.entry_id, entry.id)
  assert.equal(rec.ext, 'pdf')
  assert.equal(rec.mime, 'application/pdf')
  assert.equal(rec.size, Buffer.byteLength('PDF-CONTENT-回单'))
  assert.match(rec.sha256, /^[0-9a-f]{64}$/)
  assert.equal(rec.file_name, '回单.pdf')

  const list = attachments.listByEntry(entry.id)
  assert.equal(list.count, 1)
  const { bytes } = attachments.read(rec.id)
  assert.equal(bytes.toString('utf8'), 'PDF-CONTENT-回单')

  // 磁盘上真的有文件：attachments/YYYY/MM/uuid.pdf（目录按上传时刻的年月，不跟账目日期——写死会跨月炸，2026-11-01 实证）
  const nowMonth = new Date()
  const monthDir = join(config.dataDir, 'attachments', String(nowMonth.getFullYear()), String(nowMonth.getMonth() + 1).padStart(2, '0'))
  assert.equal(existsSync(monthDir), true)
  const files = readdirSync(monthDir)
  assert.equal(files.length, 1)
  assert.match(files[0]!, /\.pdf$/)
})

test('扩展名白名单：exe/无扩展名拒绝；文件名带路径只留名字部分', () => {
  accounts.create(boss, { name: '现金', kind: 'cash' })
  const entry = finance.create(boss, { type: 'expense', amount: 10, account: '现金', date: '2026-10-20' })
  assert.throws(() => attachments.add(boss, entry.id, { file_name: '马.exe', data_base64: b64('MZ') }), /白名单/)
  assert.throws(() => attachments.add(boss, entry.id, { file_name: '无扩展名', data_base64: b64('x') }), /白名单/)
  const rec = attachments.add(boss, entry.id, { file_name: '../../etc/passwd.png', data_base64: b64('x') })
  assert.equal(rec.file_name, 'passwd.png') // 只留名字，路径剥掉
})

test('data_base64 非法内容拒绝；空文件拒绝；超大小上限拒绝', () => {
  accounts.create(boss, { name: '现金', kind: 'cash' })
  const entry = finance.create(boss, { type: 'expense', amount: 10, account: '现金', date: '2026-10-20' })
  assert.throws(() => attachments.add(boss, entry.id, { file_name: 'a.png', data_base64: '不是base64!!!' }), /Base64/)
  assert.throws(() => attachments.add(boss, entry.id, { file_name: 'a.png', data_base64: '' }), /data_base64/)
  assert.throws(() => attachments.add(boss, entry.id, { file_name: 'a.png', data_base64: '=' }), /0 字节/) // '=' 是合法 Base64、解码 0 字节
  const big = Buffer.alloc(ATTACH_MAX_BYTES + 1, 7)
  assert.throws(() => attachments.add(boss, entry.id, { file_name: 'big.pdf', data_base64: big.toString('base64') }), /上限/)
})

test('作废账与冲销对不给挂附件；不存在的账目 404 文案', () => {
  accounts.create(boss, { name: '现金', kind: 'cash' })
  const cancelled = finance.create(boss, { type: 'expense', amount: 10, account: '现金', date: '2026-10-20' })
  finance.update(boss, cancelled.id, { status: 'cancelled' })
  assert.throws(() => attachments.add(boss, cancelled.id, { file_name: 'a.png', data_base64: b64('x') }), /已作废/)

  const original = finance.create(boss, { type: 'income', amount: 100, account: '现金', status: 'paid', date: '2026-10-21' })
  const reversed = finance.reverse(boss, original.id, '记错')
  assert.throws(() => attachments.add(boss, reversed.id, { file_name: 'a.png', data_base64: b64('x') }), /冲销对/)
  assert.throws(() => attachments.add(boss, 'FIN-20260101-999', { file_name: 'a.png', data_base64: b64('x') }), /找不到账目/)
})

test('软删：列表消失、读回落 NotFound、文件留在盘上（证据不物理消灭）', () => {
  accounts.create(boss, { name: '现金', kind: 'cash' })
  const entry = finance.create(boss, { type: 'expense', amount: 10, account: '现金', date: '2026-10-20' })
  const rec = attachments.add(boss, entry.id, { file_name: 'a.png', data_base64: b64('x') })
  const nowMonth = new Date()
  const monthDir = join(config.dataDir, 'attachments', String(nowMonth.getFullYear()), String(nowMonth.getMonth() + 1).padStart(2, '0'))
  const filesBefore = readdirSync(monthDir).length // 数据目录跨用例共享，对比删除前后数量
  attachments.remove(boss, rec.id, '传错了')
  assert.equal(attachments.listByEntry(entry.id).count, 0)
  assert.throws(() => attachments.read(rec.id), /找不到附件/)
  assert.equal(readdirSync(monthDir).length, filesBefore) // 文件还在
  // 审计留痕
  const logs = db.prepare("SELECT action FROM audit_log WHERE action LIKE 'attachment.%' ORDER BY id").all() as { action: string }[]
  assert.deepEqual(logs.map((l) => l.action), ['attachment.upload', 'attachment.delete'])
})

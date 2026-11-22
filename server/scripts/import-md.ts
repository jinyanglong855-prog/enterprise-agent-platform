/** md → SQLite 导入脚本（方案 §5 切换检查单第①步）。
 *
 * 读财务 md 目录（FIN-*.md + PROFILE.md），写入管理后端数据库：
 * - 条目逐行导入并解析「## 记录」历史为 followups；
 * - 金额按元→分换算；无法解析的金额计 0 并列入警告（与工具 summary 口径一致）；
 * - PROFILE.md 键值导入 finance_profile；
 * - 结束时打印 行数/金额合计 双侧核对与警告清单。幂等：按 id 覆盖重导。
 *
 * 用法：node dist/scripts/import-md.js [--src 目录] [--db 文件] [--dry-run]
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, nowIso } from '../src/db/database.js'
import { PROFILE_TEMPLATE_KEYS } from '../src/finance/finance.types.js'
import { parseAmount, parseDate } from '../src/finance/finance.util.js'

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const srcDir = argValue('--src') ?? join(homedir(), '.dsh', 'company-data', 'finance')
const dbPath = argValue('--db')
const dryRun = process.argv.includes('--dry-run')

interface ParsedEntry {
  id: string
  date: string
  type: string
  amountCents: number
  status: string
  counterparty: string
  category: string
  account: string
  invoice_no: string
  due_date: string
  paidAmountCents: number
  note: string
  followups: { date: string; note: string }[]
}

const warnings: string[] = []

/** md 契约里账本文件的合法 frontmatter 键（核心键 + RECORD_FIELDS）；之外的键不进库但必须告警。 */
const KNOWN_FRONT_KEYS = new Set([
  'id', 'date', 'type', 'amount', 'status',
  'counterparty', 'category', 'account', 'invoice_no', 'due_date', 'paid_amount', 'note',
])

function parseFrontmatter(front: string): Map<string, string> {
  const meta = new Map<string, string>()
  for (const line of front.split('\n')) {
    const cut = line.indexOf(':')
    if (cut === -1) continue
    const key = line.slice(0, cut).trim()
    let value = line.slice(cut + 1)
    const hash = value.search(/\s+#/)
    if (hash !== -1) value = value.slice(0, hash)
    value = value.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
    if (key !== '') meta.set(key, value)
  }
  return meta
}

function splitFrontmatter(text: string): { front: string; body: string[] } {
  if (!text.startsWith('---')) return { front: '', body: text.split('\n') }
  const end = text.indexOf('\n---', 3)
  if (end === -1) return { front: '', body: text.split('\n') }
  const front = text.slice(4, end)
  const rest = text.slice(end + 4)
  return { front, body: (rest.startsWith('\n') ? rest.slice(1) : rest).split('\n') }
}

/** 解析「## 记录」小节的 - 日期：内容 行。 */
function parseFollowups(body: string[]): { date: string; note: string }[] {
  const out: { date: string; note: string }[] = []
  const start = body.findIndex((l) => l.trim() === '## 记录' || l.trimStart().startsWith('## 记录（'))
  if (start === -1) return out
  for (let i = start + 1; i < body.length; i++) {
    const line = body[i] ?? ''
    if (line.trimStart().startsWith('## ')) break
    const m = line.trim().match(/^-\s+(\d{4}-\d{2}-\d{2})\s*[：:]\s*(.+)$/)
    if (m !== null) out.push({ date: m[1]!, note: m[2]! })
  }
  return out
}

function amountToCents(raw: string | undefined, id: string): number {
  const cleaned = String(raw ?? '').replace(/[,¥\s]/g, '')
  if (cleaned === '') {
    warnings.push(`${id}: amount 缺失，按 0 导入`)
    return 0
  }
  const n = Number(cleaned)
  if (!Number.isFinite(n) || n < 0) {
    warnings.push(`${id}: amount "${raw}" 无法解析，按 0 导入（与 summary 口径一致）`)
    return 0
  }
  return Math.round(n * 100)
}

/** paid_amount 允许 0/缺省（不告警）；负数或非数字告警计 0。 */
function paidToCents(raw: string | undefined, id: string): number {
  const cleaned = String(raw ?? '').replace(/[,¥\s]/g, '')
  if (cleaned === '' || cleaned === '0') return 0
  return amountToCents(raw, id)
}

function parseEntryFile(id: string, text: string): ParsedEntry {
  const { front, body } = splitFrontmatter(text)
  const meta = parseFrontmatter(front)
  const date = parseDate(meta.get('date'), `${id} date`) ?? ''
  // 内容保留核对：md 版承诺人工编辑内容保留（行级补丁），导入丢弃的任何内容必须显式告警，
  // 否则切换①的行数/金额核对兜不住"正文/备注被静默扔掉"
  for (const [k, v] of meta) {
    if (!KNOWN_FRONT_KEYS.has(k) && v !== '') warnings.push(`${id}: frontmatter 未知键 "${k}"="${v}"，未导入`)
  }
  const recStart = body.findIndex((l) => l.trim() === '## 记录' || l.trimStart().startsWith('## 记录（'))
  const before = body.slice(0, recStart === -1 ? body.length : recStart).filter((l) => l.trim() !== '')
  if (before.length > 0) warnings.push(`${id}: 「## 记录」之前有 ${before.length} 行正文未导入`)
  if (recStart !== -1) {
    for (let i = recStart + 1; i < body.length; i++) {
      const line = (body[i] ?? '').trim()
      if (line === '' || line.startsWith('## ')) continue
      if (!/^-\s+\d{4}-\d{2}-\d{2}\s*[：:]/.test(line)) {
        warnings.push(`${id}: 记录行格式不符未导入："${line.slice(0, 40)}"`)
      }
    }
  }
  return {
    id,
    date,
    type: meta.get('type') ?? '',
    amountCents: amountToCents(meta.get('amount'), id),
    status: meta.get('status') ?? '',
    counterparty: meta.get('counterparty') ?? '',
    category: meta.get('category') ?? '',
    account: meta.get('account') ?? '',
    invoice_no: meta.get('invoice_no') ?? '',
    due_date: parseDate(meta.get('due_date'), `${id} due_date`) ?? '',
    paidAmountCents: paidToCents(meta.get('paid_amount'), id),
    note: meta.get('note') ?? '',
    followups: parseFollowups(body),
  }
}

function main(): void {
  if (!existsSync(srcDir)) {
    console.error(`目录不存在：${srcDir}`)
    process.exit(1)
  }
  const files = readdirSync(srcDir).filter((n) => /^FIN-\d{8}-\d{3}\.md$/.test(n)).sort()
  const parsed: ParsedEntry[] = []
  for (const name of files) {
    parsed.push(parseEntryFile(name.replace(/\.md$/, ''), readFileSync(join(srcDir, name), 'utf8')))
  }

  // PROFILE.md（可选）
  const profileRows: { key: string; value: string }[] = []
  const profileFile = join(srcDir, 'PROFILE.md')
  if (existsSync(profileFile)) {
    const { front } = splitFrontmatter(readFileSync(profileFile, 'utf8'))
    const meta = parseFrontmatter(front)
    for (const [key, value] of meta) {
      if (key === '更新日期' && value === '') continue
      profileRows.push({ key, value })
    }
    for (const key of PROFILE_TEMPLATE_KEYS) {
      if (!profileRows.some((r) => r.key === key)) profileRows.push({ key, value: '' })
    }
  }

  // 核对：md 侧合计
  const activeSrc = parsed.filter((p) => p.status !== 'cancelled')
  const srcTotalYuan = activeSrc.reduce((s, p) => s + p.amountCents, 0) / 100

  console.log(`源目录：${srcDir}`)
  console.log(`条目文件：${parsed.length} 个（含 cancelled ${parsed.length - activeSrc.length} 笔）`)
  console.log(`在账金额合计（源，cancelled 除外）：${srcTotalYuan} 元`)
  if (profileRows.length > 0) console.log(`建档参数：${profileRows.length} 键`)

  if (dryRun) {
    console.log('（dry-run：未写库）')
    printWarnings()
    return
  }
  if (dbPath === undefined) {
    console.error('缺 --db 参数（正式库请传管理后端数据目录下 ledger.db；测试传临时文件）')
    process.exit(1)
  }

  const db = openDatabase(dbPath)
  const ts = nowIso()
  const insertAll = db.transaction(() => {
    const upsert = db.prepare(
      `INSERT INTO finance_entries
         (id, date, type, amount_cents, status, counterparty, category, account, invoice_no,
          due_date, paid_amount_cents, note, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'md-import', ?, 'md-import')
       ON CONFLICT(id) DO UPDATE SET
         date=excluded.date, type=excluded.type, amount_cents=excluded.amount_cents,
         status=excluded.status, counterparty=excluded.counterparty, category=excluded.category,
         account=excluded.account, invoice_no=excluded.invoice_no, due_date=excluded.due_date,
         paid_amount_cents=excluded.paid_amount_cents, note=excluded.note, updated_at=excluded.updated_at`,
    )
    for (const p of parsed) {
      upsert.run(p.id, p.date, p.type, p.amountCents, p.status, p.counterparty, p.category,
        p.account, p.invoice_no, p.due_date, p.paidAmountCents, p.note, ts, ts)
      db.prepare('DELETE FROM finance_followups WHERE entry_id = ?').run(p.id)
      const insF = db.prepare(
        'INSERT INTO finance_followups (entry_id, date, note, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
      for (const f of p.followups) insF.run(p.id, f.date, f.note, 'md-import', ts)
    }
    const upsertP = db.prepare(
      `INSERT INTO finance_profile (key, value, updated_at, updated_by) VALUES (?, ?, ?, 'md-import')
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
    for (const r of profileRows) upsertP.run(r.key, r.value, ts)
  })
  insertAll()

  // 核对：库侧合计
  const dbRow = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS total
     FROM finance_entries WHERE status != 'cancelled'`) .get() as { n: number; total: number }
  console.log(`入库完成：条目 ${dbRow.n} 笔 / 在账合计 ${dbRow.total / 100} 元`)
  if (dbRow.n === activeSrc.length && Math.abs(dbRow.total / 100 - srcTotalYuan) < 0.005) {
    console.log('✅ 核对一致（行数与金额合计）')
  } else {
    console.error('❌ 核对不一致：请检查警告清单')
    process.exitCode = 1
  }
  const dropped = warnings.filter((w) => w.includes('未导入')).length
  console.log(dropped === 0 ? '内容保留核对：无丢弃' : `⚠ 内容保留核对：${dropped} 处内容未导入（见警告清单，人工确认可弃或改 md 后重导）`)
  printWarnings()
}

function printWarnings(): void {
  if (warnings.length === 0) {
    console.log('无警告')
    return
  }
  console.log(`警告 ${warnings.length} 条：`)
  for (const w of warnings) console.log(`  ⚠ ${w}`)
}

main()

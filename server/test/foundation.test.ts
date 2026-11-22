/** 数据模型地基测试（任务全图 §0.4，2026-10-20 增量）：
 *  账户实体化（余额口径）/ 出数只许冲销 / 冲销语义 / 票实体化 / 确认卡片提案 / 老库迁移。 */
import assert from 'node:assert/strict'
import { test, beforeEach } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDatabase, type DB } from '../src/db/database.js'
import { AuditService } from '../src/audit/audit.service.js'
import { RbacService } from '../src/rbac/rbac.service.js'
import { FinanceService } from '../src/finance/finance.service.js'
import { FinanceAccountsService } from '../src/finance/finance-accounts.service.js'
import { FinanceInvoicesService } from '../src/finance/finance-invoices.service.js'
import { FinanceProposalsService } from '../src/finance/finance-proposals.service.js'
import { FinanceImportsService } from '../src/finance/finance-imports.service.js'
import type { Actor } from '../src/finance/finance.types.js'
import { localDate, localMonth } from '../src/finance/finance.util.js'

let db: DB
let audit: AuditService
let finance: FinanceService
let accounts: FinanceAccountsService
let invoices: FinanceInvoicesService
let proposals: FinanceProposalsService
const boss: Actor = { username: 'boss', source: 'ui' }

beforeEach(() => {
  db = openDatabase(':memory:')
  audit = new AuditService(db)
  finance = new FinanceService(db, audit)
  accounts = new FinanceAccountsService(db, audit)
  invoices = new FinanceInvoicesService(db, audit)
  proposals = new FinanceProposalsService(db, audit, finance, new FinanceImportsService(db, audit, finance))
})

// --------------------------------------------------------------- 账户实体化

test('账户：建档/重名拒/余额=期初+已收−已付（未收付不动余额，发票登记不动钱）', () => {
  accounts.create(boss, { name: '微信', kind: 'wechat', opening_balance: 100 })
  assert.throws(() => accounts.create(boss, { name: '微信' }), /已存在/)
  finance.create(boss, { type: 'income', amount: 300, account: '微信', status: 'paid', date: '2026-10-01' })
  finance.create(boss, { type: 'income', amount: 700, account: '微信', status: 'unpaid', date: '2026-10-02' })
  finance.create(boss, { type: 'expense', amount: 150, account: '微信', status: 'paid', date: '2026-10-03' })
  finance.create(boss, { type: 'invoice', amount: 999, account: '微信', status: 'paid', date: '2026-10-04' })
  const wx = accounts.list().accounts.find((a) => a.name === '微信')!
  assert.equal(wx.balance, 250) // 100 + 300 − 150；700 未收不动；发票登记不算钱
  const wx2 = accounts.list().accounts.find((a) => a.name === '微信')!
  assert.equal(wx2.opening_balance, 100)
})

test('账户：冲销条目按负计入；改账目的账户=流量跟着搬家；停用账户不能再挂新账', () => {
  accounts.create(boss, { name: '支付宝', kind: 'alipay' })
  const inc = finance.create(boss, { type: 'income', amount: 300, account: '支付宝', status: 'paid', date: '2026-10-01' })
  assert.equal(accounts.list().accounts[0]?.balance, 300)
  finance.reverse(boss, inc.id, '记错了')
  assert.equal(accounts.list().accounts[0]?.balance, 0)
  const exp = finance.create(boss, { type: 'expense', amount: 80, account: '支付宝', status: 'paid', date: '2026-10-05' })
  assert.equal(accounts.list().accounts[0]?.balance, -80)
  accounts.create(boss, { name: '现金', kind: 'cash' })
  finance.update(boss, exp.id, { account: '现金' })
  const list = accounts.list().accounts
  assert.equal(list.find((a) => a.name === '支付宝')?.balance, 0)
  assert.equal(list.find((a) => a.name === '现金')?.balance, -80)
  accounts.update(boss, list.find((a) => a.name === '现金')!.id, { archived: true })
  assert.throws(() => finance.create(boss, { type: 'income', amount: 1, account: '现金' }), /未建档或已停用/)
})

test('账户：记账挂未建档账户被拒（create/update 两路）；留空不拦；改名被拒', () => {
  assert.throws(() => finance.create(boss, { type: 'income', amount: 1, account: '不存在的口袋' }), /未建档/)
  accounts.create(boss, { name: '微信' })
  const r = finance.create(boss, { type: 'income', amount: 1, account: '微信' })
  assert.throws(() => finance.update(boss, r.id, { account: '银行卡' }), /未建档/)
  const ok = finance.create(boss, { type: 'income', amount: 1 })
  assert.equal(ok.account, '')
  assert.throws(() => accounts.update(boss, accounts.list().accounts[0]!.id, { name: '新名字' }), /不能改名/)
})

test('账户：期初允许负数；kind 校验；期初修改立生效', () => {
  assert.throws(() => accounts.create(boss, { name: '对公', kind: ' saver ' }), /kind 应为/)
  accounts.create(boss, { name: '对公', kind: 'bank', opening_balance: -5000 })
  const bank = accounts.list().accounts[0]!
  assert.equal(bank.balance, -5000)
  accounts.update(boss, bank.id, { opening_balance: 3000 })
  assert.equal(accounts.list().accounts[0]!.balance, 3000)
})

// --------------------------------------------------------------- 出数 + 冲销

test('出数：标记后该月禁改/禁删/禁补录；冲销放行；撤销标记解锁', () => {
  const r = finance.create(boss, { type: 'income', amount: 5000, date: '2026-09-10', counterparty: 'A' })
  finance.markReported(boss, '2026-09')
  assert.throws(() => finance.update(boss, r.id, { note: '改一下' }), /只许冲销不许改/)
  assert.throws(() => finance.softDelete(boss, r.id, '删掉'), /只许冲销不许删/)
  assert.throws(() => finance.create(boss, { type: 'income', amount: 1, date: '2026-09-20' }), /不能补录该月/)
  const rev = finance.reverse(boss, r.id, '金额错了') // 唯一放行
  assert.match(rev.note ?? '', /冲销 FIN-/)
  finance.unmarkReported(boss, '2026-09')
  // 解锁后：出数守门不再拦，但冲销对自身仍冻结（修正出数前的错账从来都该走冲销）
  assert.throws(() => finance.update(boss, r.id, { note: 'x' }), /已被 .* 冲销，不可修改/)
  assert.throws(() => finance.update(boss, rev.id, { note: 'x' }), /冲销条目，不可修改/)
  assert.throws(() => finance.softDelete(boss, r.id, 'x'), /属于冲销对，不可删除/)
  finance.markReported(boss, '2026-09')
  assert.equal(finance.listReported().months[0]?.month, '2026-09')
  assert.throws(() => finance.markReported(boss, '2026-13'), /YYYY-MM/)
})

test('冲销：语义=原条目保留+反向条目（今天日期、全额、reverses 指回）；聚合相抵；防重复冲销', () => {
  const r = finance.create(boss, { type: 'income', amount: 5000, date: '2026-09-10', counterparty: 'A', status: 'paid' })
  finance.markReported(boss, '2026-09')
  const rev = finance.reverse(boss, r.id, '对方名称写错')
  assert.equal(rev.amount, 5000)
  assert.equal(rev.status, 'paid')
  assert.equal(rev.reverses, r.id)
  assert.equal(rev.type, 'income')
  assert.equal(rev.date.slice(0, 7), localMonth())
  const after = finance.getOne(r.id)
  assert.equal(after.reversed_by, rev.id)
  assert.match(after.followups?.at(-1)?.note ?? '', /被冲销/)
  // 冲销月聚合：反向条目按负计
  const sNow = finance.summary(localMonth()) as { byType: { type: string; total: number }[] }
  assert.equal(sNow.byType[0]?.total, -5000)
  // 原 9 月聚合不变（历史不被覆盖）
  const sSep = finance.summary('2026-09') as { byType: { type: string; total: number }[] }
  assert.equal(sSep.byType[0]?.total, 5000)
  assert.throws(() => finance.reverse(boss, r.id, '再冲一次'), /不能重复冲销/)
  assert.throws(() => finance.reverse(boss, rev.id, '冲销条目再冲'), /本身是冲销条目/)
  assert.throws(() => finance.reverse(boss, 'FIN-20260101-999', 'x'), /找不到记录/)
})

test('冲销：应收余额按"截至月底累计"口径相抵；已出数月份的历史报数不被追溯改动', () => {
  const r = finance.create(boss, { type: 'income', amount: 2000, date: '2026-09-01', status: 'unpaid' })
  const s1 = finance.summary('2026-09') as { receivableOutstanding: number }
  assert.equal(s1.receivableOutstanding, 2000)
  finance.reverse(boss, r.id, '这笔取消') // 冲销条目落在当月
  const sNow = finance.summary(localMonth()) as { receivableOutstanding: number; byType: { count: number }[] }
  assert.equal(sNow.receivableOutstanding, 0, '当前时点：冲销对相抵')
  assert.equal(sNow.byType[0]?.count, 1, '笔数照算（轨迹真实）')
  const sSep = finance.summary('2026-09') as { receivableOutstanding: number }
  assert.equal(sSep.receivableOutstanding, 2000, '9 月历史口径冻结（出数过的报数不追溯）')
})

test('出数：改期不许搬进已出数月份（对抗审查 P0-1）；同月内改期不误伤', () => {
  const sep = finance.create(boss, { type: 'income', amount: 100, date: '2026-09-10' })
  finance.markReported(boss, '2026-09')
  assert.throws(() => finance.update(boss, sep.id, { date: '2026-10-05' }), /只许冲销不许改/)
  const oct = finance.create(boss, { type: 'income', amount: 200, date: '2026-10-05' })
  assert.throws(() => finance.update(boss, oct.id, { date: '2026-09-15' }), /改期到 2026-09/)
  assert.equal(finance.update(boss, oct.id, { date: '2026-10-08' }).date, '2026-10-08')
  assert.throws(() => finance.update(boss, oct.id, { date: '2026-02-30' }), /不是真实存在的日期/)
})

test('出数：空串 date（=重置今天）也按生效月份守门，不留旁路（复验 P1-A）', () => {
  const sep = finance.create(boss, { type: 'income', amount: 100, date: '2026-09-10' })
  finance.markReported(boss, localMonth()) // 当月已出数
  assert.throws(() => finance.update(boss, sep.id, { date: '' }), /改期到/, '空串=改到今天，目标月已出数必须拦')
  // 当月没出数的对照组：空串正常落今天
  const other = finance.create(boss, { type: 'income', amount: 50, date: '2026-09-11' })
  finance.unmarkReported(boss, localMonth())
  const moved = finance.update(boss, other.id, { date: '' })
  assert.equal(moved.date, localDate(), '空串 date 语义=重置为今天')
})

test('催收清单（due_before）剔除冲销对：被冲销的债不再出现在"该催的账"里（复验 P1-B）', () => {
  const debt = finance.create(boss, {
    type: 'income', amount: 2000, date: '2026-08-01', status: 'unpaid', counterparty: '欠款甲', due_date: '2026-08-15',
  })
  const alive = finance.create(boss, {
    type: 'income', amount: 500, date: '2026-08-02', status: 'unpaid', counterparty: '欠款乙', due_date: '2026-08-20',
  })
  const before = finance.list({ due_before: '2026-09-01' })
  assert.equal(before.count, 2)
  finance.reverse(boss, debt.id, '这笔债取消了')
  const after = finance.list({ due_before: '2026-09-01' })
  assert.equal(after.count, 1, '冲销对退出催收清单')
  assert.equal(after.records[0]?.id, alive.id)
})

test('冲销：部分收付/未收付的账冲销后总额、已收付、未收付同归零；作废账不许冲销（对抗审查 P1-1/P1-2）', () => {
  accounts.create(boss, { name: '微信', kind: 'wechat' })
  const m = localMonth()
  const partial = finance.create(boss, {
    type: 'income', amount: 1000, date: `${m}-05`, status: 'partial', paid_amount: 400, account: '微信',
  })
  const cancelled = finance.create(boss, { type: 'expense', amount: 999, date: `${m}-01`, status: 'cancelled' })
  const unpaid = finance.create(boss, { type: 'income', amount: 700, date: `${m}-02`, status: 'unpaid', account: '微信' })
  finance.markReported(boss, m)
  const revP = finance.reverse(boss, partial.id, '整笔取消')
  assert.equal(revP.status, 'partial', '冲销条目复制原状态')
  assert.equal(revP.paid_amount, 400, '已收付同步复制才相抵')
  const sNow = finance.summary(m) as {
    byType: { type: string; total: number; paid: number; outstanding: number }[]
  }
  const inc = sNow.byType.find((b) => b.type === 'income')!
  assert.equal(inc.total, 700, '部分收付对相抵后剩未冲销的 unpaid 700（1000−1000+700）')
  assert.equal(inc.paid, 0, '已收口径：400−400=0，不留 -600')
  assert.equal(inc.outstanding, 700, '未收口径只剩 unpaid 的 700，不挂冲销对的 600')
  assert.equal(accounts.list().accounts[0]?.balance, 0, '账户余额：400−400=0')
  assert.throws(() => finance.reverse(boss, partial.id, 'x'), /不能重复冲销/)

  assert.throws(() => finance.reverse(boss, cancelled.id, 'x'), /已作废.*无需冲销/)

  const revU = finance.reverse(boss, unpaid.id, '没这回事')
  assert.equal(revU.status, 'unpaid')
  const sU = finance.summary(m) as { byType: { type: string; total: number; paid: number; outstanding: number }[] }
  const incU = sU.byType.find((b) => b.type === 'income')!
  assert.equal(incU.total, 0, '两对全部相抵')
  assert.equal(incU.paid, 0, '未收付的账冲销不从已收/账户口径凭空扣钱')
  assert.equal(incU.outstanding, 0)
  assert.equal(accounts.list().accounts[0]?.balance, 0)
})

// --------------------------------------------------------------- 票实体化

test('票：建档/编号连续/缺省今天/列表过滤；票面金额与方向不可改', () => {
  const a = invoices.create(boss, { kind: 'sales', amount: 3000, counterparty: '甲公司', number: '24320...' })
  const b = invoices.create(boss, { kind: 'purchase', amount: 500, counterparty: '供应商A' })
  assert.match(a.id, /^INV-\d{8}-001$/)
  assert.match(b.id, /^INV-\d{8}-002$/)
  assert.equal(b.date, new Date().toLocaleDateString('sv-SE'))
  assert.equal(a.status, 'held')
  assert.equal(invoices.list({ kind: 'sales' }).count, 1)
  assert.equal(invoices.list({ counterparty: '打印' }).count, 1)
  invoices.update(boss, a.id, { status: 'red', note: '开错红冲' })
  assert.equal(invoices.getOne(a.id).status, 'red')
  assert.throws(() => invoices.update(boss, a.id, { amount: 1 }), /不可改/)
  assert.throws(() => invoices.update(boss, a.id, { kind: 'purchase' }), /不可改/)
  assert.throws(() => invoices.create(boss, { amount: 1, kind: 'nope' }), /kind 应为/)
  assert.throws(() => invoices.getOne('BAD'), /INV-YYYYMMDD-NNN/)
})

test('票挂联：多对多、重复挂联幂等、解挂；挂联双方必须存在', () => {
  const inv = invoices.create(boss, { kind: 'purchase', amount: 500, counterparty: '供应商A' })
  const e1 = finance.create(boss, { type: 'expense', amount: 300, date: '2026-10-01', counterparty: '供应商A' })
  const e2 = finance.create(boss, { type: 'expense', amount: 200, date: '2026-10-02', counterparty: '供应商A' })
  invoices.link(boss, inv.id, e1.id)
  invoices.link(boss, inv.id, e1.id) // 幂等
  invoices.link(boss, inv.id, e2.id)
  assert.deepEqual(invoices.getOne(inv.id).entry_ids.sort(), [e1.id, e2.id].sort())
  assert.throws(() => invoices.link(boss, inv.id, 'FIN-20260101-999'), /找不到账目/)
  assert.throws(() => invoices.link(boss, 'INV-20260101-999', e1.id), /找不到票/)
  assert.throws(() => invoices.link(boss, inv.id, 'BAD-ID'), /FIN-YYYYMMDD-NNN/)
  invoices.unlink(boss, inv.id, e1.id)
  assert.deepEqual(invoices.getOne(inv.id).entry_ids, [e2.id])
})

test('票：改期不许落进已出数月份；不许挂已作废账目（对抗审查 P1-4/P2-4）', () => {
  const inv = invoices.create(boss, { kind: 'sales', amount: 1000, date: '2026-10-01' })
  finance.markReported(boss, '2026-09')
  assert.throws(() => invoices.update(boss, inv.id, { date: '2026-09-20' }), /改期到 2026-09/)
  assert.equal(invoices.update(boss, inv.id, { date: '2026-10-15' }).date, '2026-10-15', '同月/往后改不拦')
  const cancelled = finance.create(boss, { type: 'expense', amount: 50, date: '2026-10-02', status: 'cancelled' })
  assert.throws(() => invoices.link(boss, inv.id, cancelled.id), /已作废/)
})

// --------------------------------------------------------------- 确认卡片提案

test('提案：要素校验拦在提案（不落账本）；确认落库 approved_by + 审计双来源 + 提案绑定条目', () => {
  accounts.create(boss, { name: '微信', kind: 'wechat' })
  const p = proposals.create({ username: 'boss', source: 'agent' }, {
    type: 'income', amount: 800, counterparty: '王五', account: '微信', category: '货款', date: '2026-10-20',
  })
  assert.match(p.id, /^PROP-\d{8}-001$/)
  assert.equal(p.status, 'pending')
  assert.match(p.summary, /收入 800 元，对方 王五/)
  assert.equal(finance.list({}).count, 0, '提案不落账本')
  assert.throws(() => proposals.create(boss, { type: 'nope', amount: 1 }), /需要 type/)
  assert.throws(() => proposals.create(boss, { type: 'income', amount: -1 }), /金额/)
  assert.throws(() => proposals.create(boss, { type: 'income', amount: 1, account: '没建的账户' }), /未建档/)

  const { proposal, entry } = proposals.confirm(boss, p.id)
  assert.equal(proposal.kind, 'single')
  assert.ok(entry, '单笔卡确认返回 entry')
  assert.equal(proposal.entry_id, entry.id)
  assert.equal(entry.amount, 800)
  assert.equal(entry.approved_by, 'boss', '谁认的=确认人')
  assert.equal(finance.list({}).count, 1)
  const logs = audit.recent(10) as { source: string; action: string; target_id: string }[]
  assert.ok(logs.some((l) => l.source === 'confirm' && l.action === 'finance.create' && l.target_id === entry.id))
  assert.ok(logs.some((l) => l.action === 'proposal.confirm' && l.target_id === p.id))
  assert.throws(() => proposals.confirm(boss, p.id), /不能重复确认/)
})

test('提案：拒绝留原因；提案后出数窗口变化 → 确认时 fail-closed 留 pending；列表按状态过滤', () => {
  const p = proposals.create({ username: 'boss', source: 'agent' }, { type: 'expense', amount: 50, date: '2026-09-15' })
  const rj = proposals.reject(boss, p.id, '金额不对，重新报')
  assert.equal(rj.status, 'rejected')
  assert.equal(rj.reason, '金额不对，重新报')
  assert.throws(() => proposals.reject(boss, p.id, '再拒'), /已处理过/)
  const p2 = proposals.create(boss, { type: 'income', amount: 10, date: '2026-09-20' })
  finance.markReported(boss, '2026-09')
  assert.throws(() => proposals.confirm(boss, p2.id), /不能补录该月/)
  assert.equal(proposals.list('pending').proposals[0]?.id, p2.id, '确认失败提案留在 pending')
  finance.unmarkReported(boss, '2026-09')
  assert.equal(proposals.confirm(boss, p2.id).entry!.id.startsWith('FIN-'), true)
  assert.equal(proposals.list('confirmed').count, 1, '被拒的不算 confirmed')
  assert.equal(proposals.list('rejected').count, 1)
  assert.equal(proposals.list('pending').count, 0)
  assert.throws(() => proposals.list('nope'), /pending\|confirmed\|rejected/)
  assert.throws(() => proposals.confirm(boss, 'BAD'), /PROP-YYYYMMDD-NNN/)
})

// --------------------------------------------------------------- 老库迁移

test('迁移：旧版 finance_entries（无新列）打开后补齐三列且数据保留', () => {
  const dir = mkdtempSync(join(tmpdir(), 'admin-migrate-'))
  const path = join(dir, 'old.db')
  const raw = new Database(path)
  raw.exec(`CREATE TABLE finance_entries (
    id TEXT PRIMARY KEY, date TEXT NOT NULL, type TEXT NOT NULL, amount_cents INTEGER NOT NULL,
    status TEXT NOT NULL, counterparty TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '',
    account TEXT NOT NULL DEFAULT '', invoice_no TEXT NOT NULL DEFAULT '', due_date TEXT NOT NULL DEFAULT '',
    paid_amount_cents INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL, created_by TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL,
    deleted_at TEXT)`)
  raw.prepare(
    `INSERT INTO finance_entries (id, date, type, amount_cents, status, created_at, created_by, updated_at, updated_by)
     VALUES ('FIN-20260101-001', '2026-01-01', 'income', 10000, 'paid', '2026-01-01T00:00:00Z', 'boss', '2026-01-01T00:00:00Z', 'boss')`,
  ).run()
  raw.close()

  const upgraded = openDatabase(path)
  const cols = new Set(
    (upgraded.prepare('PRAGMA table_info(finance_entries)').all() as { name: string }[]).map((c) => c.name),
  )
  for (const name of ['approved_by', 'reverses', 'reversed_by']) assert.ok(cols.has(name), `缺列 ${name}`)
  const row = upgraded.prepare('SELECT approved_by, reverses FROM finance_entries WHERE id = ?').get('FIN-20260101-001') as {
    approved_by: string
    reverses: string
  }
  assert.equal(row.approved_by, '')
  assert.equal(row.reverses, '')
  // 迁移后的库能正常走新语义
  const audit2 = new AuditService(upgraded)
  const finance2 = new FinanceService(upgraded, audit2)
  assert.equal(finance2.getOne('FIN-20260101-001').amount, 100)
  // 幂等：再开一次不炸
  assert.doesNotThrow(() => openDatabase(path))
  rmSync(dir, { recursive: true, force: true })
})

test('RBAC：老板账号改名后重启 seed 不重种 boss（防初始密码安全洞）；bossUsername 按角色找', () => {
  const dir = mkdtempSync(join(tmpdir(), 'foundation-rbac-'))
  const db = openDatabase(join(dir, 't.db'))
  const rbac = new RbacService(db)
  rbac.seed()
  // 模拟老板改名（boss → manager01）：角色绑定按 user_id，权限不丢
  db.prepare("UPDATE users SET username = 'manager01' WHERE username = 'boss'").run()
  rbac.seed() // 重启再 seed 一遍
  assert.equal(rbac.userExists('boss'), false, '改名后不得重新种出初始密码的 boss')
  assert.ok(rbac.findUser('manager01') !== undefined, '改名后的账号还在')
  assert.ok(rbac.permissionsOf('manager01').has('finance:write'), '权限经角色仍在')
  assert.equal(rbac.bossUsername(), 'manager01', 'bossUsername 按角色返回真实用户名')
  // 全新库（无任何真人账号）仍要能种出首个老板号
  const fresh = openDatabase(join(dir, 'fresh.db'))
  const rbacFresh = new RbacService(fresh)
  rbacFresh.seed()
  assert.ok(rbacFresh.findUser('boss') !== undefined, '全新库仍种出首个老板号')
  assert.equal(rbacFresh.bossUsername(), 'boss')
  rmSync(dir, { recursive: true, force: true })
})

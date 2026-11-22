/** 银行对账 + 缺票清单测试（任务全图 §4-5，2026-10-21 增量）。
 *  对账=账户页同一流量口径（finance-flow 单源）加截止日窗口；缺票=expense/reimburse 无在手票无票号。
 *  依赖"今天"的用例一律用相对日期生成，不许硬编码未来日期（对抗审查 P1-1：硬编码会在几天后变成定时炸弹）。 */
import assert from 'node:assert/strict'
import { test, beforeEach } from 'node:test'
import { openDatabase, type DB } from '../src/db/database.js'
import { AuditService } from '../src/audit/audit.service.js'
import { FinanceService } from '../src/finance/finance.service.js'
import { FinanceAccountsService } from '../src/finance/finance-accounts.service.js'
import { FinanceInvoicesService } from '../src/finance/finance-invoices.service.js'
import { FinanceReconciliationService } from '../src/finance/finance-reconciliation.service.js'
import type { Actor } from '../src/finance/finance.types.js'

let db: DB
let audit: AuditService
let finance: FinanceService
let accounts: FinanceAccountsService
let invoices: FinanceInvoicesService
let reconciliation: FinanceReconciliationService
const boss: Actor = { username: 'boss', source: 'ui' }

/** 本地日期 ± n 天（与 service 的 localDate 同口径：本地时区，不走 UTC）。 */
function dayOffset(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

beforeEach(() => {
  db = openDatabase(':memory:')
  audit = new AuditService(db)
  finance = new FinanceService(db, audit)
  accounts = new FinanceAccountsService(db, audit)
  invoices = new FinanceInvoicesService(db, audit)
  reconciliation = new FinanceReconciliationService(db)
})

// --------------------------------------------------------------- 银行对账

test('对账：账面=期初+截止日已收付；对上差额 0；差额=账面−对账单', () => {
  accounts.create(boss, { name: '对公', kind: 'bank', opening_balance: 1000 })
  finance.create(boss, { type: 'income', amount: 300, account: '对公', status: 'paid', date: '2026-10-05' })
  finance.create(boss, { type: 'expense', amount: 150, account: '对公', status: 'paid', date: '2026-10-08' })
  finance.create(boss, { type: 'income', amount: 700, account: '对公', status: 'paid', date: '2026-10-20' })
  // 截止 10-10：1000+300−150=1150；20 号那笔不算
  const r = reconciliation.preview({ account: '对公', as_of: '2026-10-10', statement_balance: 1150 })
  assert.equal(r.book_balance, 1150)
  assert.equal(r.difference, 0)
  assert.match(r.hint, /对上了/)
  assert.equal(r.book_balance_current, 1850) // 全时段口径含 20 号
  const r2 = reconciliation.preview({ account: '对公', as_of: '2026-10-10', statement_balance: 1100 })
  assert.equal(r2.difference, 50)
  assert.match(r2.hint, /账面比银行多 50/)
  const r3 = reconciliation.preview({ account: '对公', as_of: '2026-10-10', statement_balance: 1200 })
  assert.equal(r3.difference, -50)
  assert.match(r3.hint, /账面比银行少 50/)
})

test('对账：截止日当天（含）计入；截止日前的部分收付按已付额进账面', () => {
  accounts.create(boss, { name: '现金', kind: 'cash', opening_balance: 100 })
  finance.create(boss, { type: 'income', amount: 50, account: '现金', status: 'paid', date: '2026-10-10' }) // == as_of
  finance.create(boss, { type: 'expense', amount: 80, account: '现金', status: 'partial', paid_amount: 30, date: '2026-10-09' })
  finance.create(boss, { type: 'income', amount: 70, account: '现金', status: 'paid', date: '2026-10-11' }) // as_of 之后
  const r = reconciliation.preview({ account: '现金', as_of: '2026-10-10', statement_balance: 120 })
  assert.equal(r.book_balance, 120) // 100 + 50（当天含）− 30（部分付只算已付）
  assert.equal(r.difference, 0)
  assert.equal(r.flows_after.length, 1)
  assert.equal(r.flows_after[0]?.moved, 70)
  assert.equal(r.net_after, 70)
  assert.equal(r.book_balance_current, 190)
})

test('对账：未收付不动余额；as_of 缺省今天；flows_after 只列动了钱的（未收付/发票跳过）', () => {
  accounts.create(boss, { name: '微信', kind: 'wechat' })
  finance.create(boss, { type: 'income', amount: 500, account: '微信', status: 'paid', date: dayOffset(-3) })
  finance.create(boss, { type: 'expense', amount: 200, account: '微信', status: 'unpaid', date: dayOffset(-2) })
  finance.create(boss, { type: 'income', amount: 300, account: '微信', status: 'paid', date: dayOffset(4) })
  finance.create(boss, { type: 'expense', amount: 80, account: '微信', status: 'partial', paid_amount: 30, date: dayOffset(5) })
  finance.create(boss, { type: 'invoice', amount: 999, account: '微信', status: 'paid', date: dayOffset(6) })
  const r = reconciliation.preview({ account: '微信', statement_balance: 500 })
  assert.equal(r.as_of, dayOffset(0)) // 缺省=今天（本地日期）
  assert.equal(r.book_balance, 500) // 未付那笔不动余额
  assert.equal(r.difference, 0)
  assert.equal(r.flows_after.length, 2) // 收 300 + 部分付 30；未付 expense 与发票不列
  const inc = r.flows_after.find((f) => f.type === 'income')!
  const exp = r.flows_after.find((f) => f.type === 'expense')!
  assert.equal(inc.moved, 300)
  assert.equal(inc.direction, 'in')
  assert.equal(exp.moved, 30)
  assert.equal(exp.direction, 'out')
  assert.equal(r.net_after, 270)
  assert.match(r.hint, /2 笔已记账流水/)
})

test('对账：冲销条目按反向计入——在截止日内进账面，在截止日后进 flows_after', () => {
  accounts.create(boss, { name: '备用金', kind: 'cash' })
  const inc = finance.create(boss, { type: 'income', amount: 300, account: '备用金', status: 'paid', date: dayOffset(-5) })
  finance.reverse(boss, inc.id, '记错了') // 冲销条目 date=今天
  // 截止今天：收 300 与冲回 300 都在窗口内 → 账面 0
  const today = reconciliation.preview({ account: '备用金', statement_balance: 0 })
  assert.equal(today.book_balance, 0)
  assert.equal(today.flows_after.length, 0)
  // 截止昨天：只有收 300 在窗口内；冲销在截止日后，方向取反（收入的冲销=钱出去）
  const yesterday = reconciliation.preview({ account: '备用金', as_of: dayOffset(-1), statement_balance: 300 })
  assert.equal(yesterday.book_balance, 300)
  assert.equal(yesterday.difference, 0)
  assert.equal(yesterday.flows_after.length, 1)
  assert.equal(yesterday.flows_after[0]?.direction, 'out')
  assert.notEqual(yesterday.flows_after[0]?.reverses, '')
  assert.equal(yesterday.net_after, -300)
  assert.equal(yesterday.book_balance_current, 0)
})

test('对账：停用账户可对账；缺账户/坏日期/缺余额/坏余额给 400 文案；负余额合法', () => {
  const acc = accounts.create(boss, { name: '旧卡', kind: 'bank' })
  accounts.update(boss, acc.id, { archived: true })
  const r = reconciliation.preview({ account: '旧卡', statement_balance: 0 })
  assert.equal(r.account_archived, true)
  const neg = reconciliation.preview({ account: '旧卡', statement_balance: '-1,200.50' })
  assert.equal(neg.statement_balance, -1200.5)
  assert.equal(neg.difference, 1200.5)
  assert.throws(() => reconciliation.preview({ statement_balance: 0 }), /需要 account/)
  assert.throws(() => reconciliation.preview({ account: '不存在', statement_balance: 0 }), /找不到账户/)
  assert.throws(() => reconciliation.preview({ account: '旧卡', as_of: '2026-13-40', statement_balance: 0 }), /as_of/)
  assert.throws(() => reconciliation.preview({ account: '旧卡' }), /需要 statement_balance/)
  assert.throws(() => reconciliation.preview({ account: '旧卡', statement_balance: 'abc' }), /statement_balance 应为数字/)
})

// --------------------------------------------------------------- 缺票清单

test('缺票：expense/reimburse 无票无票号进清单；挂联或填票号后消失；payroll/tax/income 不纳入', () => {
  finance.create(boss, { type: 'expense', amount: 100, counterparty: '房东', date: '2026-10-05' }) // 缺票
  finance.create(boss, { type: 'expense', amount: 200, counterparty: '文具店', invoice_no: '№123', date: '2026-10-06' }) // 有票号
  finance.create(boss, { type: 'reimburse', amount: 50, counterparty: '张三', date: '2026-10-07' }) // 缺票
  finance.create(boss, { type: 'payroll', amount: 9000, counterparty: '员工', date: '2026-10-08' }) // 工资不算缺票
  finance.create(boss, { type: 'tax', amount: 300, counterparty: '税务局', date: '2026-10-09' }) // 税不算缺票
  finance.create(boss, { type: 'income', amount: 500, counterparty: '客户', date: '2026-10-10' }) // 收入不纳入
  const exp = finance.create(boss, { type: 'expense', amount: 400, counterparty: '航司', date: '2026-10-11' }) // 建票挂联后消失
  const inv = invoices.create(boss, { kind: 'purchase', amount: 400, date: '2026-10-11', counterparty: '航司' })
  invoices.link(boss, inv.id, exp.id)

  const missing = invoices.listMissing({})
  assert.deepEqual(
    missing.entries.map((e) => [e.type, e.counterparty]),
    [
      ['expense', '房东'],
      ['reimburse', '张三'],
    ],
  )
  assert.equal(missing.count, 2)
  assert.equal(missing.total, 2)
  assert.equal(missing.entries[0]?.amount, 100)

  const month = invoices.listMissing({ month: '2026-09' })
  assert.equal(month.count, 0)
  assert.throws(() => invoices.listMissing({ month: '2026-13' }), /month 格式/)
})

test('缺票：已作废/已红冲的票不算证据——挂了废票的账照样列出；票恢复在手才消失', () => {
  const exp = finance.create(boss, { type: 'expense', amount: 500, counterparty: '废票商', date: '2026-10-12' })
  const inv = invoices.create(boss, { kind: 'purchase', amount: 500, date: '2026-10-12', counterparty: '废票商' })
  invoices.link(boss, inv.id, exp.id)
  assert.equal(invoices.listMissing({}).count, 0)
  invoices.update(boss, inv.id, { status: 'voided' })
  assert.deepEqual(invoices.listMissing({}).entries.map((e) => e.id), [exp.id])
  invoices.update(boss, inv.id, { status: 'red' })
  assert.equal(invoices.listMissing({}).count, 1)
  invoices.update(boss, inv.id, { status: 'held' })
  assert.equal(invoices.listMissing({}).count, 0)
})

test('缺票：作废账与冲销对不算欠证据；limit 截断只影响 entries，total 仍是真实条数；按日期升序', () => {
  const e1 = finance.create(boss, { type: 'expense', amount: 10, date: '2026-10-01' })
  const e2 = finance.create(boss, { type: 'expense', amount: 20, date: '2026-10-02' })
  finance.create(boss, { type: 'expense', amount: 30, date: '2026-10-03', status: 'cancelled' })
  const e4 = finance.create(boss, { type: 'expense', amount: 40, date: '2026-10-04' })
  const e5 = finance.create(boss, { type: 'expense', amount: 50, date: '2026-10-05' })
  finance.reverse(boss, e2.id, '记错了')
  const all = invoices.listMissing({})
  assert.deepEqual(
    all.entries.map((e) => e.id),
    [e1.id, e4.id, e5.id],
  ) // cancelled 与冲销对（e2 及其反向条目）都不进
  assert.equal(all.total, 3)
  const capped = invoices.listMissing({ limit: 2 })
  assert.deepEqual(
    capped.entries.map((e) => e.id),
    [e1.id, e4.id],
  )
  assert.equal(capped.count, 2)
  assert.equal(capped.total, 3)
})

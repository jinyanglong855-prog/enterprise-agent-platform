/** 票-账猜挂测试（A5/A6，2026-10-26）：金额/日期/对方三信号打分、方向过滤、已挂联排除、只建议不挂。 */
import assert from 'node:assert/strict'
import { test, beforeEach } from 'node:test'
import { openDatabase, type DB } from '../src/db/database.js'
import { AuditService } from '../src/audit/audit.service.js'
import { FinanceService } from '../src/finance/finance.service.js'
import { FinanceAccountsService } from '../src/finance/finance-accounts.service.js'
import { FinanceInvoicesService } from '../src/finance/finance-invoices.service.js'
import { FinanceMatchesService } from '../src/finance/finance-matches.service.js'
import type { Actor } from '../src/finance/finance.types.js'

let db: DB
let audit: AuditService
let finance: FinanceService
let accounts: FinanceAccountsService
let invoices: FinanceInvoicesService
let matches: FinanceMatchesService
const boss: Actor = { username: 'boss', source: 'ui' }

beforeEach(() => {
  db = openDatabase(':memory:')
  audit = new AuditService(db)
  finance = new FinanceService(db, audit)
  accounts = new FinanceAccountsService(db, audit)
  invoices = new FinanceInvoicesService(db, audit)
  matches = new FinanceMatchesService(db)
})

test('进项票→支出账：金额一致+对方相同+同天 = 满分建议；reason 说得清为什么', () => {
  accounts.create(boss, { name: '微信', kind: 'wechat' })
  const entry = finance.create(boss, { type: 'expense', amount: 368.5, account: '微信', status: 'paid', date: '2026-10-09', counterparty: '顺丰速运' })
  const inv = invoices.create(boss, { kind: 'purchase', amount: 368.5, date: '2026-10-09', counterparty: '顺丰速运' })
  const r = matches.forInvoice(inv.id)
  assert.equal(r.suggestions.length, 1)
  const s = r.suggestions[0]!
  assert.equal(s.entry_id, entry.id)
  assert.equal(s.score, 8) // 金额4+同天2+对方2
  assert.match(s.reason, /金额一致/)
  assert.match(s.reason, /同一天|日期差 0/)
  assert.match(s.reason, /对方相同/)
})

test('方向过滤：进项票不猜收入账、销项票不猜支出账；internal 票全类型都猜', () => {
  accounts.create(boss, { name: '微信', kind: 'wechat' })
  const expense = finance.create(boss, { type: 'expense', amount: 100, account: '微信', status: 'paid', date: '2026-10-09', counterparty: '甲' })
  const income = finance.create(boss, { type: 'income', amount: 100, account: '微信', status: 'paid', date: '2026-10-09', counterparty: '甲' })
  const purchase = invoices.create(boss, { kind: 'purchase', amount: 100, date: '2026-10-09', counterparty: '甲' })
  const sales = invoices.create(boss, { kind: 'sales', amount: 100, date: '2026-10-09', counterparty: '甲' })
  assert.equal(matches.forInvoice(purchase.id).suggestions.some((s) => s.entry_id === income.id), false)
  assert.equal(matches.forInvoice(sales.id).suggestions.some((s) => s.entry_id === expense.id), false)
  const internal = invoices.create(boss, { kind: 'internal', amount: 100, date: '2026-10-09', counterparty: '甲' })
  const internalHits = matches.forInvoice(internal.id).suggestions
  assert.equal(internalHits.some((s) => s.entry_id === expense.id), true)
  assert.equal(internalHits.some((s) => s.entry_id === income.id), true)
})

test('forEntry 反向：支出账猜进项票；废票（作废/红冲）不出建议', () => {
  accounts.create(boss, { name: '微信', kind: 'wechat' })
  const entry = finance.create(boss, { type: 'expense', amount: 500, account: '微信', status: 'paid', date: '2026-10-09', counterparty: '供应商A' })
  const good = invoices.create(boss, { kind: 'purchase', amount: 500, date: '2026-10-10', counterparty: '供应商A' })
  const voided = invoices.create(boss, { kind: 'purchase', amount: 500, date: '2026-10-10', counterparty: '供应商A' })
  invoices.update(boss, voided.id, { status: 'voided' })
  const red = invoices.create(boss, { kind: 'purchase', amount: 500, date: '2026-10-10', counterparty: '供应商A' })
  invoices.update(boss, red.id, { status: 'red' })
  const r = matches.forEntry(entry.id)
  assert.equal(r.suggestions.length, 1)
  assert.equal(r.suggestions[0]!.invoice_id, good.id)
  // 销项票不给支出账猜（kind 过滤）
  const sales = invoices.create(boss, { kind: 'sales', amount: 500, date: '2026-10-10', counterparty: '供应商A' })
  assert.equal(matches.forEntry(entry.id).suggestions.some((s) => s.invoice_id === sales.id), false)
})

test('已挂联的候选不再出；解挂后又回来', () => {
  accounts.create(boss, { name: '微信', kind: 'wechat' })
  const entry = finance.create(boss, { type: 'expense', amount: 88, account: '微信', status: 'paid', date: '2026-10-09', counterparty: '乙' })
  const inv = invoices.create(boss, { kind: 'purchase', amount: 88, date: '2026-10-09', counterparty: '乙' })
  invoices.link(boss, inv.id, entry.id)
  assert.equal(matches.forInvoice(inv.id).suggestions.length, 0)
  assert.equal(matches.forEntry(entry.id).suggestions.length, 0)
  invoices.unlink(boss, inv.id, entry.id)
  assert.equal(matches.forInvoice(inv.id).suggestions.length, 1)
})

test('低相关不出：金额不同+对方不同+日期差超月 = 0 条', () => {
  accounts.create(boss, { name: '微信', kind: 'wechat' })
  finance.create(boss, { type: 'expense', amount: 123.45, account: '微信', status: 'paid', date: '2026-06-01', counterparty: '丙' })
  const inv = invoices.create(boss, { kind: 'purchase', amount: 999, date: '2026-10-09', counterparty: '丁' })
  assert.equal(matches.forInvoice(inv.id).suggestions.length, 0)
})

test('作废账与冲销对不当候选；同额多笔各配一次（建议清单不去重误伤）', () => {
  accounts.create(boss, { name: '微信', kind: 'wechat' })
  const a = finance.create(boss, { type: 'expense', amount: 100, account: '微信', status: 'paid', date: '2026-10-09', counterparty: '戊' })
  finance.create(boss, { type: 'expense', amount: 100, account: '微信', status: 'paid', date: '2026-10-09', counterparty: '戊' })
  const cancelled = finance.create(boss, { type: 'expense', amount: 100, account: '微信', status: 'paid', date: '2026-10-09', counterparty: '戊' })
  finance.update(boss, cancelled.id, { status: 'cancelled' })
  const inv = invoices.create(boss, { kind: 'purchase', amount: 100, date: '2026-10-09', counterparty: '戊' })
  const ids = matches.forInvoice(inv.id).suggestions.map((s) => s.entry_id)
  assert.equal(ids.length, 2)
  assert.equal(ids.includes(a.id), true)
  assert.equal(ids.includes(cancelled.id), false)
})

test('冲销对彻底退出猜挂：不当候选，冲销行也不当"猜票"的源账', () => {
  accounts.create(boss, { name: '微信', kind: 'wechat' })
  const a = finance.create(boss, { type: 'expense', amount: 66, account: '微信', status: 'paid', date: '2026-10-09', counterparty: '己' })
  const red = finance.reverse(boss, a.id, '开票有误')
  const inv = invoices.create(boss, { kind: 'purchase', amount: 66, date: '2026-10-09', counterparty: '己' })
  // 票→账：原账被标记冲销、冲销行本身都是红字更正，都不该收票
  assert.equal(matches.forInvoice(inv.id).suggestions.length, 0)
  // 账→票：拿冲销行当源账直接 404
  assert.throws(() => matches.forEntry(red.id), /找不到在账的账目/)
})

test('坏编号 400 文案；不存在的票 404', () => {
  assert.throws(() => matches.forInvoice('INV-BAD'), /票编号格式/)
  assert.throws(() => matches.forInvoice('INV-20260101-001'), /找不到票/)
  assert.throws(() => matches.forEntry('BAD'), /账目编号格式/)
})

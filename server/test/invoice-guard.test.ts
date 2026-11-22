/** 票守门补齐测试（审查 P2-1，2026-10-26）：已出数月份的票——禁改期出去、禁作废、禁复活；红冲放行。
 *  挂到已出数账目的票同样守（挂联月份也算"已出数月份"）。未出数月份行为不变。 */
import assert from 'node:assert/strict'
import { test, beforeEach } from 'node:test'
import { openDatabase, type DB } from '../src/db/database.js'
import { AuditService } from '../src/audit/audit.service.js'
import { FinanceService } from '../src/finance/finance.service.js'
import { FinanceAccountsService } from '../src/finance/finance-accounts.service.js'
import { FinanceInvoicesService } from '../src/finance/finance-invoices.service.js'
import type { Actor } from '../src/finance/finance.types.js'

let db: DB
let audit: AuditService
let finance: FinanceService
let accounts: FinanceAccountsService
let invoices: FinanceInvoicesService
const boss: Actor = { username: 'boss', source: 'ui' }

beforeEach(() => {
  db = openDatabase(':memory:')
  audit = new AuditService(db)
  finance = new FinanceService(db, audit)
  accounts = new FinanceAccountsService(db, audit)
  invoices = new FinanceInvoicesService(db, audit)
})

test('已出数月份：改期出去拒绝（无论改去哪个月）；未出数月份改期照旧自由', () => {
  const inv = invoices.create(boss, { kind: 'sales', amount: 1000, date: '2026-09-10', counterparty: '甬城科技' })
  finance.markReported(boss, '2026-09')
  assert.throws(() => invoices.update(boss, inv.id, { date: '2026-10-10' }), /改期出去/)
  assert.throws(() => invoices.update(boss, inv.id, { date: '2026-08-10' }), /改期出去/)
  // 同月内改日期不算改期，放行（改的是"哪天开的"，不是"哪个月的"）
  const sameMonth = invoices.update(boss, inv.id, { date: '2026-09-12' })
  assert.equal(sameMonth.date, '2026-09-12')

  const free = invoices.create(boss, { kind: 'sales', amount: 500, date: '2026-10-01' })
  const moved = invoices.update(boss, free.id, { date: '2026-11-01' })
  assert.equal(moved.date, '2026-11-01')
})

test('已出数月份：在手→作废拒绝并指路红冲；在手→红冲放行；废票→复活回在手拒绝', () => {
  const inv = invoices.create(boss, { kind: 'purchase', amount: 200, date: '2026-09-05', counterparty: '供应商A' })
  finance.markReported(boss, '2026-09')
  assert.throws(() => invoices.update(boss, inv.id, { status: 'voided' }), /不能改作废.*红冲/s)
  const red = invoices.update(boss, inv.id, { status: 'red' })
  assert.equal(red.status, 'red')
  assert.throws(() => invoices.update(boss, inv.id, { status: 'held' }), /追溯造证/)
  // 2026-11-01 口径变更（义务维聚合落地+对抗审查 P1-1）：红票改作废会把已申报月的冲减一起蒸发，
  // 改为拦——旧口径"两种废态互换放行"是聚合落地前定的，当时状态位不进钱数
  assert.throws(() => invoices.update(boss, inv.id, { status: 'voided' }), /红冲记录一起蒸发/)
  // 同理（P2-2）：作废票直改红冲=无开票效力凭空冲减申报数，拦（先在未出数月作废，再出数，再试）
  const voided = invoices.create(boss, { kind: 'sales', amount: 50, date: '2026-08-20' })
  invoices.update(boss, voided.id, { status: 'voided' })
  finance.markReported(boss, '2026-08')
  assert.throws(() => invoices.update(boss, voided.id, { status: 'red' }), /凭空冲减/)
})

test('未出数月份：改期/作废/复活照旧自由（守门只加在已出数月份）', () => {
  const inv = invoices.create(boss, { kind: 'purchase', amount: 200, date: '2026-10-05' })
  const moved = invoices.update(boss, inv.id, { date: '2026-11-05' })
  assert.equal(moved.date, '2026-11-05')
  invoices.update(boss, inv.id, { status: 'voided' })
  const revived = invoices.update(boss, inv.id, { status: 'held' })
  assert.equal(revived.status, 'held')
})

test('挂联已出数账目的票：作废被拦（证据不许从已申报月份抽走）；没挂联的同票期票不受牵连', () => {
  accounts.create(boss, { name: '微信', kind: 'wechat' })
  const entry = finance.create(boss, { type: 'expense', amount: 200, account: '微信', status: 'paid', date: '2026-09-15' })
  finance.markReported(boss, '2026-09')
  const linked = invoices.create(boss, { kind: 'purchase', amount: 200, date: '2026-10-05', counterparty: '供应商A' })
  invoices.link(boss, linked.id, entry.id)
  assert.throws(() => invoices.update(boss, linked.id, { status: 'voided' }), /已出数/)
  // 但红冲放行：修正走红冲
  const red = invoices.update(boss, linked.id, { status: 'red' })
  assert.equal(red.status, 'red')

  const loose = invoices.create(boss, { kind: 'purchase', amount: 300, date: '2026-10-06' })
  const voided = invoices.update(boss, loose.id, { status: 'voided' })
  assert.equal(voided.status, 'voided')
})

test('解挂之后不再受该月守门（挂联关系是守门的依据，解挂是老板明示动作，留审计）', () => {
  accounts.create(boss, { name: '微信', kind: 'wechat' })
  const entry = finance.create(boss, { type: 'expense', amount: 200, account: '微信', status: 'paid', date: '2026-09-15' })
  finance.markReported(boss, '2026-09')
  const inv = invoices.create(boss, { kind: 'purchase', amount: 200, date: '2026-10-05' })
  invoices.link(boss, inv.id, entry.id)
  assert.throws(() => invoices.update(boss, inv.id, { status: 'voided' }), /已出数/)
  invoices.unlink(boss, inv.id, entry.id)
  const voided = invoices.update(boss, inv.id, { status: 'voided' })
  assert.equal(voided.status, 'voided')
})

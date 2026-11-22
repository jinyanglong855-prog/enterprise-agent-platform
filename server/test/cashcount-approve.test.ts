/** 现金盘点（B2）+ 报销批准（A4）测试，2026-10-26。 */
import assert from 'node:assert/strict'
import { test, beforeEach } from 'node:test'
import { openDatabase, type DB } from '../src/db/database.js'
import { AuditService } from '../src/audit/audit.service.js'
import { FinanceService } from '../src/finance/finance.service.js'
import { FinanceAccountsService } from '../src/finance/finance-accounts.service.js'
import { FinanceCashCountsService } from '../src/finance/finance-cashcounts.service.js'
import { FinanceProposalsService } from '../src/finance/finance-proposals.service.js'
import { FinanceImportsService } from '../src/finance/finance-imports.service.js'
import type { Actor } from '../src/finance/finance.types.js'

let db: DB
let audit: AuditService
let finance: FinanceService
let accounts: FinanceAccountsService
let cashCounts: FinanceCashCountsService
let proposals: FinanceProposalsService
const boss: Actor = { username: 'boss', source: 'ui' }

beforeEach(() => {
  db = openDatabase(':memory:')
  audit = new AuditService(db)
  finance = new FinanceService(db, audit)
  accounts = new FinanceAccountsService(db, audit)
  cashCounts = new FinanceCashCountsService(db, audit)
  const imports = new FinanceImportsService(db, audit, finance)
  proposals = new FinanceProposalsService(db, audit, finance, imports)
})

test('盘点：账面=期初+截止日已收付（与账户页同口径）；差额=实盘−账面，只记录不调平', () => {
  accounts.create(boss, { name: '现金', kind: 'cash', opening_balance: 500 })
  finance.create(boss, { type: 'expense', amount: 45, account: '现金', status: 'paid', date: '2026-10-20' })
  finance.create(boss, { type: 'income', amount: 100, account: '现金', status: 'unpaid', date: '2026-10-21' }) // 未收不动账面
  const r = cashCounts.create(boss, { account: '现金', counted: 452.3, as_of: '2026-10-25' })
  assert.equal(r.book, 455) // 500 − 45；未收 100 不进
  assert.equal(r.counted, 452.3)
  assert.equal(r.diff, -2.7)
  // 历史可查，余额没被盘点改掉
  const list = cashCounts.list({ account: '现金' })
  assert.equal(list.count, 1)
  const acc = accounts.list().accounts.find((a) => a.name === '现金')!
  assert.equal(acc.balance, 455)
})

test('盘点：缺账户/缺实盘数/坏日期明确报错；盘点留审计', () => {
  assert.throws(() => cashCounts.create(boss, { account: '没建过', counted: 1 }), /找不到账户/)
  accounts.create(boss, { name: '现金', kind: 'cash' })
  assert.throws(() => cashCounts.create(boss, { account: '现金' }), /counted/)
  assert.throws(() => cashCounts.create(boss, { account: '现金', counted: 1, as_of: '2026-13-99' }), /YYYY-MM-DD|真实存在/)
  cashCounts.create(boss, { account: '现金', counted: 0 })
  const logs = db.prepare("SELECT action FROM audit_log WHERE action = 'cashcount.create'").all()
  assert.equal(logs.length, 1)
})

test('报销的"谁批的"已由确认卡片覆盖：confirm 落 approved_by；界面直记=本人（A4 审批链既有语义）', () => {
  const rb = finance.create(boss, { type: 'reimburse', amount: 320, counterparty: '张三', date: '2026-10-20' })
  assert.equal(rb.approved_by, 'boss') // 直通路径=操作者本人（2026-10-20 地基语义）
  // 付款走正常改状态：pending→paid 两条留痕分开
  const paid = finance.update(boss, rb.id, { status: 'paid', paid_amount: 320 })
  assert.equal(paid.status, 'paid')
  assert.equal(paid.approved_by, 'boss')
})

test('卡片确认入账的报销自带 approved_by（确认即审批，单人不设审批状态机，无"再批准"一说）', () => {
  const p = proposals.create(boss, { type: 'reimburse', amount: 66, counterparty: '李四', date: '2026-10-22' })
  const confirmed = proposals.confirm(boss, p.id)
  const entry = confirmed.entry!
  assert.equal(entry.approved_by, 'boss')
})

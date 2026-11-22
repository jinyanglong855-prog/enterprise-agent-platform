/** 财务域语义测试：与 dsh-finance-tools.mjs 的行为逐条对齐（REST 化的等价性保证）。 */
import assert from 'node:assert/strict'
import { test, beforeEach } from 'node:test'
import { openDatabase, type DB } from '../src/db/database.js'
import { AuditService } from '../src/audit/audit.service.js'
import { FinanceService } from '../src/finance/finance.service.js'
import type { Actor } from '../src/finance/finance.types.js'

let db: DB
let audit: AuditService
let finance: FinanceService
const boss: Actor = { username: 'boss', source: 'ui' }

beforeEach(() => {
  db = openDatabase(':memory:')
  audit = new AuditService(db)
  finance = new FinanceService(db, audit)
})

test('create：默认状态按类型（income=unpaid，reimburse=pending，invoice=issued）', () => {
  const a = finance.create(boss, { type: 'income', amount: 5000, counterparty: '示例厂' })
  const b = finance.create(boss, { type: 'reimburse', amount: 88.5 })
  const c = finance.create(boss, { type: 'invoice', amount: 300 })
  assert.equal(a.status, 'unpaid')
  assert.equal(b.status, 'pending')
  assert.equal(c.status, 'issued')
  assert.match(a.id, /^FIN-\d{8}-001$/)
  assert.match(b.id, /^FIN-\d{8}-002$/)
})

test('create：日期缺省=今天，编号连续', () => {
  const a = finance.create(boss, { type: 'expense', amount: 100 })
  const b = finance.create(boss, { type: 'expense', amount: 200 })
  const today = new Date()
  const ymd = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`
  assert.equal(a.id, `FIN-${ymd}-001`)
  assert.equal(b.id, `FIN-${ymd}-002`)
  assert.equal(a.status, 'unpaid')
})

test('create：指定日期与状态，金额两位小数不丢精度', () => {
  const r = finance.create(boss, { type: 'income', amount: '1,234.56', date: '2026-10-15', status: 'paid', counterparty: ' 甲乙公司 ' })
  assert.equal(r.id, 'FIN-20261015-001')
  assert.equal(r.amount, 1234.56)
  assert.equal(r.status, 'paid')
  assert.equal(r.counterparty, '甲乙公司')
})

test('create：非法金额/类型/日期被拒；due_date 不校验（与工具 create 一致，update 才校验）', () => {
  assert.throws(() => finance.create(boss, { type: 'income', amount: 0 }), /正的金额数字/)
  assert.throws(() => finance.create(boss, { type: 'income', amount: -5 }), /正的金额数字/)
  assert.throws(() => finance.create(boss, { type: 'income', amount: 'abc' }), /金额数字/)
  assert.throws(() => finance.create(boss, { amount: 100 }), /需要 type/)
  assert.throws(() => finance.create(boss, { type: 'income', amount: 100, date: '2026-02-30' }), /不是真实存在的日期/)
  // md 工具 create 对 due_date 只 trim 不校验，这里同样原样存
  const loose = finance.create(boss, { type: 'income', amount: 100, due_date: '月底前' })
  assert.equal(loose.due_date, '月底前')
  // update 的 due_date 才校验（与工具 update 同一 parseDate：格式坏报"格式应为"，日历假报"不是真实存在"）
  assert.throws(() => finance.update(boss, loose.id, { due_date: '2026-13-01' }), /不是真实存在的日期/)
  assert.throws(() => finance.update(boss, loose.id, { due_date: '月底前' }), /格式应为 YYYY-MM-DD/)
})

test('update：改状态/金额/paid_amount（累计语义），追加记录日志', () => {
  const r = finance.create(boss, { type: 'income', amount: 7000, counterparty: '示例厂', date: '2026-10-15' })
  const u1 = finance.update(boss, r.id, { paid_amount: 2000, status: 'partial' })
  assert.equal(u1.paid_amount, 2000)
  assert.equal(u1.status, 'partial')
  const u2 = finance.update(boss, r.id, { paid_amount: 5000 }) // 累计数直接填新值（SOP：先查现值再加）
  assert.equal(u2.paid_amount, 5000)
  const u3 = finance.update(boss, r.id, { followup_note: '催收微信已发' })
  assert.equal(u3.followups?.length, 2) // 登记 + 催收
  assert.match(u3.followups?.[1]?.note ?? '', /催收微信已发/)
})

test('update：无有效字段=成功空跑返回现值（与工具一致）；非法 status/type/id 被拒', () => {
  const r = finance.create(boss, { type: 'expense', amount: 10 })
  const noop = finance.update(boss, r.id, {}) as { id: string; amount: number }
  assert.equal(noop.id, r.id)
  assert.equal(noop.amount, 10)
  assert.throws(() => finance.update(boss, r.id, { status: 'nope' }), /status 应为/)
  assert.throws(() => finance.update(boss, r.id, { type: 'nope' }), /type 应为/)
  assert.throws(() => finance.update(boss, 'BAD-ID', { note: 'x' }), /FIN-YYYYMMDD-NNN/)
  assert.throws(() => finance.update(boss, 'FIN-20260101-999', { note: 'x' }), /finance_lookup/)
})

test('list：过滤 type/status/对方模糊/月份，id 倒序，limit', () => {
  finance.create(boss, { type: 'income', amount: 100, counterparty: '示例厂', date: '2026-10-01' })
  finance.create(boss, { type: 'income', amount: 200, counterparty: '另一厂', date: '2026-10-02' })
  finance.create(boss, { type: 'expense', amount: 50, counterparty: '示例厂', date: '2026-09-30' })
  assert.equal(finance.list({}).count, 3)
  assert.equal(finance.list({ type: 'income' }).count, 2)
  assert.equal(finance.list({ counterparty: '示例' }).count, 2)
  assert.equal(finance.list({ month: '2026-10' }).count, 2)
  assert.equal(finance.list({ limit: 1 }).records[0]?.counterparty, '另一厂') // id 倒序=最新的 10-02 那笔
  assert.throws(() => finance.list({ month: '2026-13' }), /YYYY-MM/) // 月份过滤非法格式直接抛（与工具一致）
  // 非法 type/status 过滤值：不抛错，静默空结果（与工具逐条比较后 continue 的行为一致）
  assert.equal(finance.list({ type: 'nope' }).count, 0)
  assert.equal(finance.list({ status: 'nope' }).count, 0)
})

test('list：month 格式非法直接抛错', () => {
  assert.throws(() => finance.list({ month: '2026-1' }), /YYYY-MM/)
})

test('summary：已收/部分收/未收、发票不进收付、cancelled 跳过、分类只统计流出类', () => {
  finance.create(boss, { type: 'income', amount: 5000, counterparty: 'A', date: '2026-10-01', status: 'unpaid' })
  finance.create(boss, { type: 'income', amount: 2000, counterparty: 'A', date: '2026-10-02', status: 'paid' })
  finance.create(boss, { type: 'income', amount: 1000, counterparty: 'B', date: '2026-10-03', paid_amount: 400, status: 'partial' })
  finance.create(boss, { type: 'expense', amount: 800, counterparty: 'C', date: '2026-10-04', category: '办公', status: 'paid' })
  finance.create(boss, { type: 'expense', amount: 999, counterparty: 'D', date: '2026-10-05', category: '推广', status: 'cancelled' })
  finance.create(boss, { type: 'invoice', amount: 3000, counterparty: 'A', date: '2026-10-06' })

  const s = finance.summary('2026-10') as { byType: { type: string; count: number; total: number; paid: number; outstanding: number }[]; receivableOutstanding: number; payableOutstanding: number; count: number }

  // cancelled(999) 不进 count；invoice 进 count
  assert.equal(s.count, 5)
  const income = s.byType.find((t) => t.type === 'income')
  assert.equal(income?.count, 3)
  assert.equal(income?.total, 8000)
  assert.equal(income?.paid, 2400) // 2000 已收 + 400 部分收
  assert.equal(income?.outstanding, 5600) // 5000 + (1000-400)
  const invoice = s.byType.find((t) => t.type === 'invoice')
  assert.equal(invoice?.total, 3000)
  assert.equal(invoice?.paid, 0, '发票不进收付统计')
  assert.equal(s.receivableOutstanding, 5600)
  assert.equal(s.payableOutstanding, 0, '已付 800 不欠')
})

test('summary：paid_amount>0 且未标 partial 也按部分收处理（与工具一致）', () => {
  finance.create(boss, { type: 'expense', amount: 600, counterparty: 'D', date: '2026-10-10', paid_amount: 100 })
  const s = finance.summary('2026-10') as { payableOutstanding: number }
  assert.equal(s.payableOutstanding, 500)
})

test('软删除：list/summary 不再计入，留 followup 与审计', () => {
  const r = finance.create(boss, { type: 'expense', amount: 500, category: '办公', date: '2026-10-11' })
  finance.softDelete(boss, r.id, '录错了')
  assert.equal(finance.list({}).count, 0)
  assert.equal((finance.summary('2026-10') as { count: number }).count, 0)
  assert.throws(() => finance.getOne(r.id), /找不到记录/)
  const logs = audit.recent(10) as { action: string; target_id: string }[]
  assert.ok(logs.some((l) => l.action === 'finance.delete' && l.target_id === r.id))
})

test('建档：模板键齐全、set/更新、键名校验', () => {
  const { profile } = finance.profileGet()
  assert.equal(profile['主体类型'], '')
  assert.ok('社保基数上下限' in profile)
  finance.profileSet(boss, '主体类型', '个体工商户')
  finance.profileSet(boss, '员工人数', '1')
  assert.equal(finance.profileGet().profile['主体类型'], '个体工商户')
  assert.throws(() => finance.profileSet(boss, '带 空格', 'x'), /参数名/)
  assert.throws(() => finance.profileSet(boss, '主体类型', '多\n行'), /单行/)
  assert.throws(() => finance.profileSet(boss, '主体类型', ''), /单行/)
})

test('审计：每笔写操作带来源落一条', () => {
  const r = finance.create(boss, { type: 'income', amount: 1 })
  finance.update(boss, r.id, { status: 'paid' })
  const agent: Actor = { username: 'boss', source: 'agent' }
  finance.create(agent, { type: 'expense', amount: 2 })
  const logs = audit.recent(10) as { source: string; action: string }[]
  assert.ok(logs.some((l) => l.source === 'ui' && l.action === 'finance.create'))
  assert.ok(logs.some((l) => l.source === 'agent' && l.action === 'finance.create'))
  assert.ok(logs.some((l) => l.action === 'finance.update'))
})

test('金额边界：分库整数无浮点漂移（0.1+0.2 类）', () => {
  finance.create(boss, { type: 'income', amount: 0.1, date: '2026-10-01', status: 'paid' })
  finance.create(boss, { type: 'income', amount: 0.2, date: '2026-10-01', status: 'paid' })
  const s = finance.summary('2026-10') as { byType: { total: number; paid: number }[] }
  assert.equal(s.byType[0]?.total, 0.3)
  assert.equal(s.byType[0]?.paid, 0.3)
})

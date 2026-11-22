/** 征期数据包测试（任务全图 §4 缺口第 3 条，2026-10-21 增量）：
 *  期间解析与缺省（上一期）/ 小规模免征与 1% 预估 / 一般纳税人占位 / 个体户与公司分支节点 /
 *  账本口径（发票不计入、冲销相抵、作废剔除、含未收款）/ 档案回显与缺失提示。 */
import assert from 'node:assert/strict'
import { test, beforeEach } from 'node:test'
import { openDatabase, type DB } from '../src/db/database.js'
import { AuditService } from '../src/audit/audit.service.js'
import { FinanceService } from '../src/finance/finance.service.js'
import { FinanceFilingService, parsePeriod } from '../src/finance/finance-filing.service.js'
import type { Actor } from '../src/finance/finance.types.js'

let db: DB
let audit: AuditService
let finance: FinanceService
let filing: FinanceFilingService
const boss: Actor = { username: 'boss', source: 'ui' }

beforeEach(() => {
  db = openDatabase(':memory:')
  audit = new AuditService(db)
  finance = new FinanceService(db, audit)
  filing = new FinanceFilingService(db, finance)
})

const NOW = new Date('2026-10-21T10:00:00')

// --------------------------------------------------------------- 期间解析

test('期间解析：YYYY-MM 与 YYYY-Qn 都认；非法格式报错', () => {
  assert.equal(parsePeriod('2026-10', '', NOW).kind, 'month')
  const q = parsePeriod('2026-Q4', '', NOW)
  assert.deepEqual(q.months, ['2026-10', '2026-11', '2026-12'])
  assert.equal(q.from, '2026-10-01')
  assert.match(q.label, /第 4 季度/)
  assert.throws(() => parsePeriod('2026年Q4', '', NOW), /period 格式/)
  assert.throws(() => parsePeriod('2026-Q5', '', NOW), /period 格式/)
  assert.throws(() => parsePeriod('2026-13', '', NOW), /YYYY-MM/)
})

test('期间缺省=当前征期的上一期：一般纳税人报上月，其余报上季（含跨年）；先认小规模', () => {
  assert.equal(parsePeriod(undefined, '小规模纳税人', NOW).key, '2026-Q3')
  assert.equal(parsePeriod(undefined, '一般纳税人', NOW).key, '2026-09')
  assert.equal(parsePeriod(undefined, '小规模（待转一般）', NOW).key, '2026-Q3', '先认小规模：待转一般仍按季缺省')
  assert.equal(parsePeriod(undefined, '', new Date('2026-01-10T10:00:00')).key, '2025-Q4')
  assert.equal(parsePeriod(undefined, '一般纳税人', new Date('2026-01-10T10:00:00')).key, '2025-12')
})

// --------------------------------------------------------------- 免征与预估

test('小规模季度：≤30 万免征；超过则全额按 1%（不是只对超出部分）', () => {
  finance.profileSet(boss, '纳税人身份', '小规模纳税人')
  for (const [m, amt] of [['2026-10', 100000], ['2026-11', 100000], ['2026-12', 50000]] as const) {
    finance.create(boss, { type: 'income', amount: amt, date: `${m}-05`, counterparty: '客户' })
  }
  const p = filing.pack('2026-Q4', NOW)
  assert.equal(p.vat.exempt, true, '25 万 ≤ 30 万免征')
  assert.equal(p.vat.estimated, 0)
  assert.equal(p.figures.sales, 250000)

  finance.create(boss, { type: 'income', amount: 150000, date: '2026-12-20', counterparty: '客户' })
  const p2 = filing.pack('2026-Q4', NOW)
  assert.equal(p2.figures.sales, 400000)
  assert.equal(p2.vat.exempt, false)
  assert.equal(p2.vat.estimated, 4000, '40 万 × 1% = 4000，全额计')
  assert.match(p2.vat.note, /2027-12-31/)
  assert.ok(p2.notes.some((n) => n.includes('1%')), '超线时补一条预估口径提示')
})

test('小规模月度包：没填「纳税期限」不下增值税结论、指向季度包；填了按月申报才按 10 万线判断', () => {
  finance.profileSet(boss, '纳税人身份', '小规模纳税人')
  finance.create(boss, { type: 'income', amount: 120000, date: '2026-10-05', counterparty: '客户' })
  const p = filing.pack('2026-10', NOW)
  assert.equal(p.vat.exempt, null, '默认按季申报：月包不下增值税结论')
  assert.equal(p.vat.estimated, null)
  assert.match(p.vat.note, /季度/)
  assert.ok(p.nodes.some((n) => n.note.includes('按季申报')), '月包仍提示小规模按季')

  finance.profileSet(boss, '纳税期限', '按月申报')
  const pm = filing.pack('2026-10', NOW)
  assert.equal(pm.vat.exempt, false, '档案明确按月申报：按月线判断')
  assert.equal(pm.vat.estimated, 1200, '12 万 × 1% = 1200')

  finance.create(boss, { type: 'income', amount: 100000, date: '2026-11-05', counterparty: '客户' })
  const pb = filing.pack('2026-11', NOW)
  assert.equal(pb.vat.exempt, true, '月线整边界：10 万整免征')

  const pq = filing.pack('2026-Q4', NOW) // 仍是按月申报档案：Q4 = 12 万 + 10 万
  assert.equal(pq.vat.exempt, true, '按月申报的老板查季包：仍给季线结论')
  assert.match(pq.vat.note, /仅供对照/, '但注明季线结论非其申报依据')
})

test('季度整边界 30 万整免征；期末越过优惠有效期后判断带待核实提示', () => {
  finance.profileSet(boss, '纳税人身份', '小规模纳税人')
  finance.create(boss, { type: 'income', amount: 300000, date: '2026-07-15', counterparty: '客户' })
  const p = filing.pack('2026-Q3', NOW)
  assert.equal(p.vat.exempt, true, '30 万整 ≤ 30 万免征（≤ 边界）')
  finance.create(boss, { type: 'income', amount: 100000, date: '2028-04-10', counterparty: '客户' })
  const f = filing.pack('2028-Q2', NOW)
  assert.equal(f.vat.exempt, true, '2028 年仍给备料参考判断')
  assert.match(f.vat.note, /已超出/)
  assert.match(f.vat.note, /待按最新政策核实/)
})

test('period 重复参数（数组溜进来）按非法输入拒绝，不抛 500', () => {
  finance.profileSet(boss, '纳税人身份', '小规模纳税人')
  assert.throws(() => filing.pack(['2026-Q3'] as unknown as string), /重复/)
})

test('一般纳税人：不做销项进项核算，只给销售额参考与占位提示', () => {
  finance.profileSet(boss, '纳税人身份', '一般纳税人')
  finance.create(boss, { type: 'income', amount: 500000, date: '2026-10-05', counterparty: '客户' })
  const p = filing.pack('2026-10', NOW)
  assert.equal(p.vat.applicable, false)
  assert.equal(p.vat.estimated, null)
  assert.match(p.vat.note, /销项/)
  assert.ok(p.nodes.some((n) => n.name.includes('按月')))
})

// --------------------------------------------------------------- 账本口径

test('口径：发票登记不计销售额、冲销对相抵、作废剔除、未收款照算；发票额另列', () => {
  // 期间用"真实当前月"：冲销条目落库用真实时钟（跨月会掉出写死的期间，2026-11-01 实证），期间跟着时钟走才稳定
  const d = new Date()
  const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  finance.profileSet(boss, '纳税人身份', '小规模纳税人')
  finance.create(boss, { type: 'income', amount: 10000, date: `${ym}-05`, counterparty: '甲', status: 'unpaid' }) // 未收款照算
  finance.create(boss, { type: 'invoice', amount: 8000, date: `${ym}-06`, counterparty: '甲' }) // 只进 invoice_total
  const e = finance.create(boss, { type: 'income', amount: 1000, date: `${ym}-07`, counterparty: '乙' })
  finance.reverse(boss, e.id, '记错') // 冲销 → −1000（落真实当天，同月）
  const bad = finance.create(boss, { type: 'income', amount: 999, date: `${ym}-08`, counterparty: '丙' })
  finance.update(boss, bad.id, { status: 'cancelled' }) // 作废剔除
  const p = filing.pack(ym, NOW)
  assert.equal(p.figures.sales, 10000)
  assert.equal(p.figures.invoice_total, 8000)
  const cur = p.figures.sales_by_month.find((m: { month: string }) => m.month === ym)!
  assert.equal(cur.total, 10000)
  assert.match(p.notes.join(''), /与开票额对照/)
})

test('应收/应付未收付是"截至期末累计"口径（期前也计入）；利润参考=收入−流出（工资单列）', () => {
  finance.profileSet(boss, '纳税人身份', '小规模纳税人')
  finance.create(boss, { type: 'income', amount: 5000, date: '2026-11-05', counterparty: '甲' }) // 未收
  finance.create(boss, { type: 'income', amount: 3000, date: '2026-09-20', counterparty: '前期' }) // 期前未收也计入
  finance.create(boss, { type: 'expense', amount: 2000, date: '2026-12-05', counterparty: '乙' })
  finance.create(boss, { type: 'payroll', amount: 8000, date: '2026-12-10', counterparty: '员工' })
  const p = filing.pack('2026-Q4', NOW)
  assert.equal(p.figures.receivable_outstanding, 8000, '期前 3000 + 期内 5000：截至期末累计，不是只算期末月')
  assert.equal(p.figures.payable_outstanding, 10000, '未付支出 2000 + 未付工资 8000')
  assert.equal(p.figures.outflow, 10000)
  assert.equal(p.figures.payroll, 8000)
  assert.equal(p.figures.profit_ref, -5000, '5000 收入 − 10000 流出')
})

test('跨期冲销：本期含冲销条目给口径注释；净冲回为负时点明不是亏损', () => {
  finance.profileSet(boss, '纳税人身份', '小规模纳税人')
  const e = finance.create(boss, { type: 'income', amount: 200000, date: '2026-07-10', counterparty: '甲' })
  const q3 = filing.pack('2026-Q3', NOW)
  assert.equal(q3.figures.sales, 200000)
  assert.ok(!q3.notes.some((n) => n.includes('冲销条目')), '期内无冲销条目时不加注释')
  finance.reverse(boss, e.id, '记错') // 冲销条目落真实当天（finance.service 取真实时钟），期望季度按真实日期动态推，跨年不变红
  const d = new Date()
  const nowQuarter = `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`
  const qNow = filing.pack(nowQuarter, NOW)
  assert.equal(qNow.figures.sales, -200000, `冲销条目落在 ${nowQuarter}，净冲回为负`)
  assert.ok(qNow.notes.some((n) => n.includes('冲销条目')), '含冲销条目给口径注释')
  assert.ok(qNow.notes.some((n) => n.includes('净冲回')), '负数点明不是亏损')
})

// --------------------------------------------------------------- 分支节点与档案

test('分支节点：公司→企税预缴；个体户查账→经营所得；定期定额→补申报；发工资→个税', () => {
  finance.profileSet(boss, '主体类型', '有限公司')
  finance.profileSet(boss, '纳税人身份', '小规模纳税人')
  finance.create(boss, { type: 'payroll', amount: 6000, date: '2026-10-10', counterparty: '员工' })
  const company = filing.pack('2026-Q4', NOW)
  assert.ok(company.nodes.some((n) => n.name.includes('企业所得税')))
  assert.ok(company.nodes.some((n) => n.name.includes('个税代扣')))

  finance.profileSet(boss, '主体类型', '个体户')
  finance.profileSet(boss, '征收方式', '查账征收')
  const sole = filing.pack('2026-Q4', NOW)
  assert.ok(sole.nodes.some((n) => n.name.includes('经营所得')))
  assert.ok(!sole.nodes.some((n) => n.name.includes('企业所得税')))

  finance.profileSet(boss, '征收方式', '定期定额')
  const dinge = filing.pack('2026-Q4', NOW)
  const node = dinge.nodes.find((n) => n.name.includes('定期定额'))
  assert.match(node!.due_rule, /超定额/)

  finance.profileSet(boss, '员工人数', '3')
  const withStaff = filing.pack('2026-Q4', NOW)
  assert.match(withStaff.nodes.find((n) => n.name.includes('社保'))!.note, /3/)
  assert.equal(withStaff.profile_echo['员工人数'], '3')
})

test('档案缺失：missing 列表 + 提示补齐；社保参数原文回显不硬算；主体类型没识别出公司/个体时提示', () => {
  const p = filing.pack('2026-Q4', NOW)
  assert.ok(p.identity.missing.includes('主体类型'))
  assert.ok(p.identity.missing.includes('纳税人身份'))
  assert.match(p.vat.note, /未填「纳税人身份」/)
  finance.profileSet(boss, '社保基数上下限', '下限 4820/月，上限 24930/月（2026 年，以 12333 为准）')
  finance.profileSet(boss, '纳税期限', '按季申报')
  const p2 = filing.pack('2026-Q4', NOW)
  assert.equal(p2.profile_echo['社保基数上下限'], '下限 4820/月，上限 24930/月（2026 年，以 12333 为准）')
  assert.equal(p2.profile_echo['纳税期限'], '按季申报')
  finance.profileSet(boss, '主体类型', '合伙企业')
  const p3 = filing.pack('2026-Q4', NOW)
  assert.ok(!p3.identity.missing.includes('主体类型'), '填了就不算缺')
  assert.ok(p3.notes.some((n) => n.includes('没识别出公司/个体户')), '非公司非个体：所得税节点没列要明说')
  assert.ok(!p3.nodes.some((n) => n.name.includes('所得')))
})

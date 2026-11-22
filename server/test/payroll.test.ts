/** 工资个税计算器测试（任务全图 §4 缺口第 6 条）：累计预扣法公式、跨档、负差按 0、
 *  年中入职减除月数、专项附加累计、输入校验。政策口径见 finance-payroll.service.ts 头注。 */
import assert from 'node:assert/strict'
import { test, beforeEach } from 'node:test'
import { openDatabase, type DB } from '../src/db/database.js'
import { AuditService } from '../src/audit/audit.service.js'
import { FinanceService } from '../src/finance/finance.service.js'
import { FinancePayrollService, type PayrollCalcRequest } from '../src/finance/finance-payroll.service.js'

let db: DB
let payroll: FinancePayrollService

beforeEach(() => {
  db = openDatabase(':memory:')
  const audit = new AuditService(db)
  const finance = new FinanceService(db, audit)
  payroll = new FinancePayrollService(db, finance)
})

const calc = (req: PayrollCalcRequest) => payroll.calc(req)

test('首月低档：月薪 1 万无社保 → 税 150、实发 9850；3% 档', () => {
  const r = calc({ month: 1, gross: 10000 })
  assert.equal(r.taxable_cum, 5000)
  assert.equal(r.bracket.level, 1)
  assert.equal(r.bracket.rate, '3%')
  assert.equal(r.tax_this, 150)
  assert.equal(r.net_pay, 9850)
  assert.equal(r.months_count, 1)
})

test('社保个人部分参与累计扣除：税 126 而非 150', () => {
  const r = calc({ month: 1, gross: 10000, social_this: 800 })
  assert.equal(r.cum_social, 800)
  assert.equal(r.taxable_cum, 4200)
  assert.equal(r.tax_this, 126)
})

test('跨档：2 月累计 7 万进 10% 档，本月税 3430（扣已预扣 1050）', () => {
  const r = calc({ month: 2, gross: 40000, gross_prev: 40000, withheld_prev: 1050 })
  assert.equal(r.bracket.level, 2)
  assert.equal(r.bracket.rate, '10%')
  assert.equal(r.tax_cum, 4480)
  assert.equal(r.tax_this, 3430)
  assert.equal(r.negative_diff, 0)
})

test('档界：累计应纳税所得额整 36000 仍 3%；36001 跳 10% 档（速算扣除 2520）', () => {
  const edge = calc({ month: 1, gross: 41000, social_this: 0, extra_deduct_cum: 0 })
  assert.equal(edge.taxable_cum, 36000)
  assert.equal(edge.bracket.level, 1)
  assert.equal(edge.tax_this, 1080)
  const over = calc({ month: 1, gross: 41000.01 })
  assert.equal(over.taxable_cum, 36000.01)
  assert.equal(over.bracket.level, 2)
  // 申报口径：累计应纳税所得额×预扣率先四舍五入到分（3600.001→3600.00）再减速算扣除
  assert.equal(over.tax_this, 1080)
})

test('累计应纳税所得额 ≤0：本月 0 计税，有提示', () => {
  const r = calc({ month: 1, gross: 3000 })
  assert.equal(r.taxable_cum, -2000)
  assert.equal(r.tax_this, 0)
  assert.ok(r.notes.some((n) => n.includes('不计税')))
})

test('累计减免大于应预扣：本月按 0，差额记 negative_diff 留抵', () => {
  const r = calc({ month: 1, gross: 10000, relief_cum: 5000 })
  assert.equal(r.tax_cum, 0)
  assert.equal(r.tax_this, 0)
  assert.equal(r.negative_diff, 4850)
  assert.ok(r.notes.some((n) => n.includes('继续抵减')))
})

test('年中入职：7 月首薪减除费用只算 1 个月（5000）', () => {
  const r = calc({ month: 7, start_month: 7, gross: 8000 })
  assert.equal(r.months_count, 1)
  assert.equal(r.cum_standard_deduct, 5000)
  assert.equal(r.taxable_cum, 3000)
  assert.equal(r.tax_this, 90)
})

test('专项附加累计参与扣除：三个月房贷 3000，本月税 96', () => {
  const r = calc({
    month: 3,
    gross: 10000,
    gross_prev: 20000,
    social_this: 800,
    social_prev: 1600,
    extra_deduct_cum: 3000,
    withheld_prev: 192,
  })
  assert.equal(r.cum_extra_deduct, 3000)
  assert.equal(r.taxable_cum, 9600)
  assert.equal(r.tax_cum, 288)
  assert.equal(r.tax_this, 96)
})

test('社保按 0 算时给补数提示（个人社保不替老板定）', () => {
  const r = calc({ month: 1, gross: 10000 })
  assert.ok(r.notes.some((n) => n.includes('社保公积金按 0')))
})

test('模型传字符串数字照收：month/gross 等字符串形式归一后计算一致', () => {
  const r = calc({ month: '3' as unknown as number, start_month: '3' as unknown as number, gross: '10000' as unknown as number, social_this: '800' as unknown as number })
  assert.equal(r.tax_this, 126)
  assert.equal(r.net_pay, 9074)
})

test('输入校验：月份越界/负金额/首薪晚于本次/超两位小数/非数字', () => {
  assert.throws(() => calc({ month: 13, gross: 100 }), /month 应为 1-12/)
  assert.throws(() => calc({ month: 0, gross: 100 }), /month 应为 1-12/)
  assert.throws(() => calc({ month: 1, gross: -1 }), /不能为负数/)
  assert.throws(() => calc({ month: 5, start_month: 6, gross: 100 }), /不能晚于 month/)
  assert.throws(() => calc({ month: 1, gross: 100.005 }), /最多两位小数/)
  assert.throws(() => calc({ month: 1, gross: '一万' as unknown as number }), /应为数字，收到看不懂的/)
  assert.throws(() => calc({ month: 1.5 as number, gross: 100 }), /month 应为整数/)
})

test('建档社保参数回显进 profile_echo（原文不硬算）', () => {
  const r = calc({ month: 1, gross: 10000 })
  assert.equal(typeof r.profile_echo, 'object')
  assert.ok(r.policy.includes('61 号'))
})

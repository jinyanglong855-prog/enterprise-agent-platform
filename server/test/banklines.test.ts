/** 银行流水逐笔比对测试（B1，2026-10-26）：导入/指纹幂等/模板/校验/比对报告三清单/人工配对。
 *  依赖"今天"的窗口一律相对日期生成（不对抗审查 P1 的硬编码定时炸弹）。 */
import assert from 'node:assert/strict'
import { test, beforeEach } from 'node:test'
import { openDatabase, type DB } from '../src/db/database.js'
import { AuditService } from '../src/audit/audit.service.js'
import { FinanceService } from '../src/finance/finance.service.js'
import { FinanceAccountsService } from '../src/finance/finance-accounts.service.js'
import { FinanceBankLinesService, BANK_TEMPLATE_HEADER } from '../src/finance/finance-banklines.service.js'
import type { Actor } from '../src/finance/finance.types.js'

let db: DB
let audit: AuditService
let finance: FinanceService
let accounts: FinanceAccountsService
let bankLines: FinanceBankLinesService
const boss: Actor = { username: 'boss', source: 'ui' }

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
  bankLines = new FinanceBankLinesService(db, audit)
})

const csv = (rows: string[][]) => [BANK_TEMPLATE_HEADER.join(','), ...rows.map((r) => r.join(','))].join('\n')

test('模板：列头六列，照模板导入两行全进', () => {
  const t = bankLines.template()
  assert.deepEqual(t.header, ['日期', '方向', '金额', '对方', '流水号', '备注'])
  accounts.create(boss, { name: '对公', kind: 'bank' })
  const r = bankLines.importLines(boss, { account: '对公', text: t.csv })
  assert.equal(r.inserted, 2)
  assert.equal(r.skipped, 0)
})

test('重复导入同一份流水：指纹幂等，第二次全 skipped 不翻倍', () => {
  accounts.create(boss, { name: '对公', kind: 'bank' })
  const text = csv([['2026-10-08', '收入', '12000.00', '甬城科技', 'BK001', '货款']])
  const first = bankLines.importLines(boss, { account: '对公', text })
  assert.equal(first.inserted, 1)
  const second = bankLines.importLines(boss, { account: '对公', text })
  assert.equal(second.inserted, 0)
  assert.equal(second.skipped, 1)
  assert.equal(bankLines.list({ account: '对公' }).count, 1)
  // 同额同日但流水号不同 = 两笔（现实里就是两笔）
  bankLines.importLines(boss, { account: '对公', text: csv([['2026-10-08', '收入', '12000.00', '甬城科技', 'BK002', '']]) })
  assert.equal(bankLines.list({ account: '对公' }).count, 2)
})

test('列头缺失/方向不认/日期格式/账户不存在，全都明确报错', () => {
  accounts.create(boss, { name: '对公', kind: 'bank' })
  assert.throws(() => bankLines.importLines(boss, { account: '对公', text: '日期,金额\n2026-10-08,1' }), /列头缺/)
  assert.throws(() => bankLines.importLines(boss, { account: '对公', text: csv([['2026-10-08', '转账', '1', '', '', '']]) }), /方向/)
  assert.throws(() => bankLines.importLines(boss, { account: '对公', text: csv([['10月8日', '收入', '1', '', '', '']]) }), /YYYY-MM-DD/)
  assert.throws(() => bankLines.importLines(boss, { account: '对公', text: csv([['2026-10-08', '收入', '-5', '', '', '']]) }), /正/)
  assert.throws(() => bankLines.importLines(boss, { account: '没建过', text: csv([['2026-10-08', '收入', '1', '', '', '']]) }), /找不到账户/)
})

test('比对报告：同额同向 3 天内自动配上；银行多出的进 bank_only；账本多出的进 book_only', () => {
  accounts.create(boss, { name: '对公', kind: 'bank', opening_balance: 1000 })
  const e1 = finance.create(boss, { type: 'income', amount: 12000, account: '对公', status: 'paid', date: dayOffset(-2), counterparty: '甬城科技' })
  finance.create(boss, { type: 'expense', amount: 368.5, account: '对公', status: 'paid', date: dayOffset(-1), counterparty: '顺丰' })
  // 账本多出的：在途支出（记了账、银行对账单里还没出现）
  const e3 = finance.create(boss, { type: 'expense', amount: 200, account: '对公', status: 'paid', date: dayOffset(0), counterparty: '房租' })
  // 银行侧：两笔能配上 + 一笔银行多收（利息）
  const text = csv([
    [dayOffset(-2), '收入', '12000', '甬城科技', 'B1', ''],
    [dayOffset(-1), '支出', '368.5', '顺丰', 'B2', ''],
    [dayOffset(-1), '收入', '50.23', '银行', 'B3', '利息'],
  ])
  bankLines.importLines(boss, { account: '对公', text })
  const r = bankLines.report({ account: '对公' })
  assert.equal(r.matched.length, 2)
  assert.equal(r.matched.every((m) => m.how === 'auto'), true)
  assert.equal(r.bank_only.length, 1)
  assert.equal(r.bank_only[0]!.ref, 'B3')
  assert.equal(r.book_only.length, 1)
  assert.equal(r.book_only[0]!.entry_id, e3.id)
  void e1
  assert.match(r.hint, /银行有而账本没有 1 笔/)
  assert.match(r.hint, /账本动了钱而银行没有 1 笔/)
})

test('比对报告：金额相等多笔贪心不重复认领（两笔同额流水对两笔同额账目）', () => {
  accounts.create(boss, { name: '微信', kind: 'wechat' })
  finance.create(boss, { type: 'income', amount: 800, account: '微信', status: 'paid', date: dayOffset(-5), counterparty: '王五' })
  finance.create(boss, { type: 'income', amount: 800, account: '微信', status: 'paid', date: dayOffset(-4), counterparty: '王五' })
  bankLines.importLines(boss, { account: '微信', text: csv([
    [dayOffset(-5), '收入', '800', '王五', 'W1', ''],
    [dayOffset(-4), '收入', '800', '王五', 'W2', ''],
  ]) })
  const r = bankLines.report({ account: '微信' })
  assert.equal(r.matched.length, 2)
  assert.equal(new Set(r.matched.map((m) => m.entry_id)).size, 2)
  assert.equal(r.bank_only.length, 0)
  assert.equal(r.book_only.length, 0)
})

test('人工配对优先且不被自动覆盖；配到金额不同的账也允许（差额人负责，报告可见）；解除配对', () => {
  accounts.create(boss, { name: '对公', kind: 'bank' })
  const entry = finance.create(boss, { type: 'income', amount: 95.5, account: '对公', status: 'paid', date: dayOffset(-1), counterparty: '己' })
  const line = bankLines.importLines(boss, { account: '对公', text: csv([[dayOffset(-1), '收入', '100', '己', 'Z1', '含手续费']]) })
  const list = bankLines.list({ account: '对公' })
  const patched = bankLines.setMatch(boss, list.lines[0]!.id, entry.id)
  assert.equal(patched.matched_entry_id, entry.id)
  const r = bankLines.report({ account: '对公' })
  assert.equal(r.matched.length, 1)
  assert.equal(r.matched[0]!.how, 'manual')
  // 解除
  const cleared = bankLines.setMatch(boss, list.lines[0]!.id, '')
  assert.equal(cleared.matched_entry_id, '')
  void line
})

test('人工配对：作废账拒、开票登记拒、坏编号 400、空行不存在 404', () => {
  accounts.create(boss, { name: '对公', kind: 'bank' })
  bankLines.importLines(boss, { account: '对公', text: csv([[dayOffset(-1), '收入', '100', '庚', 'Z9', '']]) })
  const lineId = bankLines.list({ account: '对公' }).lines[0]!.id
  const cancelled = finance.create(boss, { type: 'income', amount: 100, account: '对公', status: 'paid', date: dayOffset(-1) })
  finance.update(boss, cancelled.id, { status: 'cancelled' })
  assert.throws(() => bankLines.setMatch(boss, lineId, cancelled.id), /已作废/)
  const invoiceEntry = finance.create(boss, { type: 'invoice', amount: 100, account: '对公', date: dayOffset(-1) })
  assert.throws(() => bankLines.setMatch(boss, lineId, invoiceEntry.id), /开票登记/)
  assert.throws(() => bankLines.setMatch(boss, lineId, 'BAD'), /账目编号格式/)
  assert.throws(() => bankLines.setMatch(boss, lineId, 'FIN-20260101-999'), /找不到账目/)
})

test('报告窗口：from/to 过滤两边；账户没流水且不给 from 报错给指引', () => {
  accounts.create(boss, { name: '对公', kind: 'bank' })
  assert.throws(() => bankLines.report({ account: '对公' }), /显式给 from/)
  finance.create(boss, { type: 'income', amount: 100, account: '对公', status: 'paid', date: '2026-09-01' })
  bankLines.importLines(boss, { account: '对公', text: csv([
    ['2026-10-01', '收入', '100', '辛', 'V1', ''],
  ]) })
  const oct = bankLines.report({ account: '对公', from: '2026-10-01', to: '2026-10-31' })
  assert.equal(oct.matched.length, 0)
  assert.equal(oct.bank_only.length, 1)
  assert.equal(oct.book_only.length, 0) // 9 月账目在窗口外
  // 坏窗口：from 晚于 to 报错（用相对日期，避免未来日期定时炸弹）
  const d1 = dayOffset(1)
  const d0 = dayOffset(0)
  assert.throws(() => bankLines.report({ account: '对公', from: d1, to: d0 }), /不能晚于|窗口不合法/)
})

test('删行：删掉重导不冲突（指纹随行删除释放）', () => {
  accounts.create(boss, { name: '对公', kind: 'bank' })
  bankLines.importLines(boss, { account: '对公', text: csv([[dayOffset(-1), '收入', '100', '壬', 'D1', '']]) })
  const line = bankLines.list({ account: '对公' }).lines[0]!
  bankLines.remove(boss, line.id)
  assert.equal(bankLines.list({ account: '对公' }).count, 0)
  const again = bankLines.importLines(boss, { account: '对公', text: csv([[dayOffset(-1), '收入', '100', '壬', 'D1', '']]) })
  assert.equal(again.inserted, 1)
})

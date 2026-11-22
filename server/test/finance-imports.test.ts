/** 批量导入域测试（任务全图 §0.6 输入通道，2026-10-21 增量）：
 *  解析器（CSV/TSV/引号转义）/ 日期与金额归一 / 映射规则 / 逐行守门预览 /
 *  防重指纹 / 事务原子提交 / 批量提案（kind=import）确认落库。 */
import assert from 'node:assert/strict'
import { test, beforeEach } from 'node:test'
import { openDatabase, type DB } from '../src/db/database.js'
import { AuditService } from '../src/audit/audit.service.js'
import { FinanceService } from '../src/finance/finance.service.js'
import { FinanceAccountsService } from '../src/finance/finance-accounts.service.js'
import { FinanceImportsService, parseDelimited, normalizeDateCell, normalizeAmountCell, resolveDelimiter, TEMPLATE_MAPPING, IMPORT_MAX_ROWS } from '../src/finance/finance-imports.service.js'
import { FinanceProposalsService } from '../src/finance/finance-proposals.service.js'
import type { Actor } from '../src/finance/finance.types.js'
import { localDate } from '../src/finance/finance.util.js'

let db: DB
let audit: AuditService
let finance: FinanceService
let accounts: FinanceAccountsService
let imports: FinanceImportsService
let proposals: FinanceProposalsService
const boss: Actor = { username: 'boss', source: 'ui' }

beforeEach(() => {
  db = openDatabase(':memory:')
  audit = new AuditService(db)
  finance = new FinanceService(db, audit)
  accounts = new FinanceAccountsService(db, audit)
  imports = new FinanceImportsService(db, audit, finance)
  proposals = new FinanceProposalsService(db, audit, finance, imports)
})

const header = '日期,类型,金额,对方,分类,账户,状态,已收付,到期日,发票号,备注'

function csvOf(...rows: string[]): string {
  return [header, ...rows].join('\n')
}

// --------------------------------------------------------------- 解析器与归一

test('解析：RFC 4180 引号转义（引号内含逗号/换行/双引号）；空行保留原样（preview 层才剔除）', () => {
  const rows = parseDelimited('a,"b,c","d""e"\r\n\r\n"多\r\n行",x\n', ',')
  assert.deepEqual(rows, [['a', 'b,c', 'd"e'], [''], ['多\n行', 'x']])
})

test('分隔符 auto：tab 多认 tab，逗号多认逗号；显式非法值报错', () => {
  assert.equal(resolveDelimiter('a\tb\tc', 'auto'), '\t')
  assert.equal(resolveDelimiter('a,b,c', 'auto'), ',')
  assert.equal(resolveDelimiter('a|b;c', 'auto'), ';')
  assert.equal(resolveDelimiter('a,b', ';'), ';')
  assert.throws(() => resolveDelimiter('a', ':'), /delimiter/)
})

test('日期归一：斜杠/点/年月日/紧凑/带时间都归一成 YYYY-MM-DD；乱格式原样交 parseDate 报错', () => {
  assert.equal(normalizeDateCell('2026/10/1'), '2026-10-01')
  assert.equal(normalizeDateCell('2026.10.01'), '2026-10-01')
  assert.equal(normalizeDateCell('2026年10月1日'), '2026-10-01')
  assert.equal(normalizeDateCell('20261001'), '2026-10-01')
  assert.equal(normalizeDateCell('2026-10-01 12:30:00'), '2026-10-01')
  assert.equal(normalizeDateCell('2026/10/01 08:00'), '2026-10-01')
  assert.equal(normalizeDateCell(' 2026-02-29 '), '2026-02-29')
})

test('金额清洗：千分位/货币符/元/各种负号/括号负数', () => {
  assert.deepEqual(normalizeAmountCell('1,234.50'), { value: '1234.50', negative: false })
  assert.deepEqual(normalizeAmountCell('¥3,680.00元'), { value: '3680.00', negative: false })
  assert.deepEqual(normalizeAmountCell('-123.4'), { value: '123.4', negative: true })
  assert.deepEqual(normalizeAmountCell('−99'), { value: '99', negative: true }) // Unicode minus
  assert.deepEqual(normalizeAmountCell('(56.7)'), { value: '56.7', negative: true })
  assert.deepEqual(normalizeAmountCell('（88）'), { value: '88', negative: true })
  assert.deepEqual(normalizeAmountCell('+20'), { value: '20', negative: false })
})

// --------------------------------------------------------------- 预览

test('预览（固定模板）：中文类型/状态映射、空账户回落、已收付自动补全额、金额缺行报错', () => {
  accounts.create(boss, { name: '微信' })
  const p = imports.preview(
    csvOf(
      '2026/10/8,收入,12000,甬城科技,货款,,未收付,,2026/11/8,,尾款',
      '2026-10-09,expense,368.5,顺丰,快递,微信,已收付,,,,',
      '20261010,收入,800,,,,,,,',
      '2026-10-11,收入,,张三,,,,,,,',
    ),
  )
  assert.equal(p.total, 4)
  assert.equal(p.valid, 3)
  assert.equal(p.invalid, 1)
  const r0 = p.rows[0]!.input!
  assert.equal(r0.date, '2026-10-08')
  assert.equal(r0.type, 'income')
  assert.equal(r0.status, 'unpaid')
  assert.equal(r0.due_date, '2026-11-08')
  assert.equal(r0.account, undefined)
  assert.equal(r0.paid_amount, undefined)
  const r1 = p.rows[1]!.input!
  assert.equal(r1.status, 'paid')
  assert.equal(r1.paid_amount, 368.5, '状态已收付且未给已收付列 → 自动补全额')
  assert.equal(r1.type, 'expense')
  const r2 = p.rows[2]!.input
  assert.equal(r2?.date, '2026-10-10')
  assert.equal(p.rows[3]!.error, '金额为空。')
})

test('预览：过 create 完整守门——出数月拒绝、未建档账户拒绝、坏日期拒绝', () => {
  finance.markReported(boss, '2026-09')
  accounts.create(boss, { name: '微信' })
  const p = imports.preview(
    csvOf(
      '2026-09-01,收入,100,甲,,,,,,,', // 出数月
      '2026-10-02,支出,50,乙,办公,没建的账户,,,,,', // 未建档账户
      '2026-13-40,收入,1,丙,,,,,,,', // 坏日期
      '2026-10-05,收入,1,丁,,,,,,,', // 正常
    ),
  )
  assert.match(p.rows[0]!.error!, /已出数.*不能补录/)
  assert.match(p.rows[1]!.error!, /未建档或已停用/)
  assert.match(p.rows[2]!.error!, /不是真实存在的日期/)
  assert.equal(p.rows[3]!.error, undefined)
})

test('预览：库里已有同指纹 → duplicate_of；批内同指纹 → duplicate_in_batch；互不混淆', () => {
  accounts.create(boss, { name: '微信' })
  finance.create(boss, { type: 'expense', amount: 25, date: '2026-10-01', counterparty: '早点摊' })
  const p = imports.preview(
    csvOf(
      '2026-10-01,支出,25,早点摊,,,,,,,', // 与库重复
      '2026-10-02,支出,25,早点摊,,,,,,,', // 日期不同不重复
      '2026-10-03,收入,9,张三,,,,,,,',
      '2026-10-03,收入,9,张三,,,,,,,', // 批内重复
    ),
  )
  assert.match(p.rows[0]!.duplicate_of!, /^FIN-20261001-\d{3}$/)
  assert.equal(p.rows[1]!.duplicate_of, undefined)
  assert.equal(p.rows[2]!.duplicate_in_batch, undefined)
  assert.equal(p.rows[3]!.duplicate_in_batch, true)
  assert.equal(p.duplicates, 2)
})

test('预览：sign_decides_type（银行流水正负收支）+ type_map 自定义叫法 + default_status', () => {
  accounts.create(boss, { name: '对公', kind: 'bank' })
  const text = '交易日期,摘要,收支金额\n2026/10/01,客户A货款,"12,000.00"\n2026/10/02,房租,−4500\n'
  const p = imports.preview(text, {
    has_header: true,
    columns: { date: '交易日期', counterparty: '摘要', amount: '收支金额' },
    sign_decides_type: true,
    default_status: 'paid',
    default_account: '对公',
  })
  assert.equal(p.valid, 2)
  assert.equal(p.rows[0]!.input!.type, 'income')
  assert.equal(p.rows[0]!.input!.amount, 12000)
  assert.equal(p.rows[0]!.input!.status, 'paid')
  assert.equal(p.rows[1]!.input!.type, 'expense')
  assert.equal(p.rows[1]!.input!.amount, 4500)

  const p2 = imports.preview(
    csvOf('2026-10-01,转入,500,老王,,,,,,,'),
    { columns: { ...TEMPLATE_MAPPING.columns }, type_map: { 转入: 'income' } },
  )
  assert.equal(p2.rows[0]!.input!.type, 'income')
})

test('预览：mapping 必须映射 date/amount；列头名找不到/列索引越界/行数超限报错', () => {
  assert.throws(() => imports.preview('a,b\n1,2\n', { columns: { amount: 0 } }), /必须映射 date/)
  assert.throws(() => imports.preview('a,b\n1,2\n', { columns: { date: 0 } }), /必须映射 amount/)
  assert.throws(() => imports.preview(csvOf('2026-10-01,收入,1'), { columns: { date: '哪天', amount: '金额' } }), /找不到/)
  assert.throws(
    () => imports.preview('2026-10-01,1\n', { has_header: false, columns: { date: '日期', amount: '金额' } }),
    /没有列头时/,
  )
  assert.throws(
    () => imports.preview('日期,金额\n2026-10-01,1\n', { columns: { date: 5, amount: 1 } }),
    /超出列数/,
  )
  const big = Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, i) => `2026-10-01,收入,1,行${i},,,,,,,`).join('\n')
  assert.throws(() => imports.preview(csvOf(big)), /单批最多/)
  assert.throws(() => imports.preview(''), /导入内容为空/)
})

// --------------------------------------------------------------- 提交

test('提交：事务原子——一行过不了守门整批回滚，库里一条不多；通过的批次逐条留 followup 与审计', () => {
  accounts.create(boss, { name: '微信' })
  assert.throws(
    () =>
      imports.commit(boss, [
        { type: 'income', amount: 10, date: '2026-10-01', counterparty: '甲' },
        { type: 'expense', amount: 20, date: '2026-10-02', counterparty: '乙', account: '没建的账户' },
      ]),
    /第 2 行：.*未建档/,
  )
  assert.equal(finance.list({}).count, 0, '回滚后一条不多')

  const r = imports.commit(boss, [
    { type: 'income', amount: 10, date: '2026-10-01', counterparty: '甲' },
    { type: 'income', amount: 20, date: '2026-10-02', counterparty: '丙', status: 'paid' },
  ], { note: '10 月上半月' })
  assert.match(r.batch, /^IMP-\d{8}-\d{6}-[a-z0-9]{4}$/, '批次号秒级时间戳 + 随机后缀防同秒撞号')
  assert.equal(r.created.length, 2)
  assert.equal(r.created[0]!.id, 'FIN-20261001-001')
  const one = finance.getOne(r.created[0]!.id)
  assert.match(one.followups?.map((f) => f.note).join('') ?? '', /导入登记（批次 IMP-/)
  assert.equal(finance.list({}).count, 2)
  const logs = audit.recent(10) as { action: string; target_id: string }[]
  const imp = logs.find((l) => l.action === 'finance.import')
  assert.ok(imp, '有批次审计')
  assert.equal(imp.target_id, r.batch)
})

test('提交：skip_duplicates 跳过库里已有的行；全重时报错不落一条；行数超限报错', () => {
  finance.create(boss, { type: 'income', amount: 10, date: '2026-10-01', counterparty: '甲' })
  const r = imports.commit(boss, [
    { type: 'income', amount: 10, date: '2026-10-01', counterparty: '甲' },
    { type: 'income', amount: 99, date: '2026-10-09', counterparty: '新客户' },
  ], { skip_duplicates: true })
  assert.equal(r.created.length, 1)
  assert.equal(r.skipped, 1)
  assert.throws(
    () => imports.commit(boss, [{ type: 'income', amount: 10, date: '2026-10-01', counterparty: '甲' }], { skip_duplicates: true }),
    /没有新账可入/,
  )
  assert.equal(finance.list({}).count, 2, '跳过后入库的还是 1 笔新账 + 原有 1 笔')
  assert.throws(() => imports.commit(boss, Array.from({ length: IMPORT_MAX_ROWS + 1 }, () => ({ type: 'income', amount: 1 }))), /单批最多/)
})

test('提交：冲销对不参与查重（被冲销的原账不会再挡同名新账）', () => {
  accounts.create(boss, { name: '微信' })
  const e = finance.create(boss, { type: 'expense', amount: 30, date: '2026-10-01', counterparty: 'A' })
  finance.reverse(boss, e.id, '记错')
  const r = imports.commit(boss, [{ type: 'expense', amount: 30, date: '2026-10-01', counterparty: 'A' }], { skip_duplicates: true })
  assert.equal(r.created.length, 1)
  assert.equal(r.skipped, 0)
})

test('提交：批内重复 + skip_duplicates=true 仍是两笔（对抗审查 P1-1：跳重只跳库里已有的）', () => {
  const r = imports.commit(boss, [
    { type: 'expense', amount: 25, date: '2026-10-01', counterparty: '早点摊' },
    { type: 'expense', amount: 25, date: '2026-10-01', counterparty: '早点摊' },
  ], { skip_duplicates: true })
  assert.equal(r.created.length, 2)
  assert.equal(r.skipped, 0)
  assert.equal(finance.list({}).count, 2)
  // 对照：库里已有同指纹 → 全重报错不落（既有行为）
  assert.throws(
    () => imports.commit(boss, [{ type: 'expense', amount: 25, date: '2026-10-01', counterparty: '早点摊' }], { skip_duplicates: true }),
    /没有新账可入/,
  )
  assert.equal(finance.list({}).count, 2)
})

test('提交/预览：作废账不参与查重（对抗审查 P2-1：作废幽灵不挡重导）', () => {
  const e = finance.create(boss, { type: 'expense', amount: 80, date: '2026-10-02', counterparty: '供应商A' })
  finance.update(boss, e.id, { status: 'cancelled' })
  const p = imports.preview(csvOf('2026-10-02,支出,80,供应商A,,,,,,,'))
  assert.equal(p.rows[0]!.duplicate_of, undefined, '预览不再把作废账标成重复')
  const r = imports.commit(boss, [{ type: 'expense', amount: 80, date: '2026-10-02', counterparty: '供应商A' }], { skip_duplicates: true })
  assert.equal(r.created.length, 1)
  assert.equal(r.skipped, 0)
})

// --------------------------------------------------------------- 模板

test('模板：列头/示例行/映射三者自洽——模板映射解析示例行应全通过', () => {
  accounts.create(boss, { name: '微信' })
  const t = imports.template()
  assert.deepEqual(t.header, Object.values(TEMPLATE_MAPPING.columns))
  const p = imports.preview([t.header.join(','), ...t.example.map((r) => r.join(','))].join('\n'))
  assert.equal(p.invalid, 0)
  assert.equal(p.valid, 2)
  assert.equal(p.rows[0]!.input!.type, 'income')
})

// --------------------------------------------------------------- 批量提案（kind=import）

test('批量提案：提案时逐行拦错；summary 按类型聚合；确认走事务导入且审计双来源', () => {
  accounts.create(boss, { name: '微信' })
  const rows = [
    { type: 'income', amount: 3000, date: '2026-10-05', counterparty: '客户A' },
    { type: 'expense', amount: 4500, date: '2026-10-06', counterparty: '房东', account: '微信' },
  ]
  assert.throws(() => proposals.createImport(boss, [...rows, { type: 'income', amount: -1 }]), /第 3 行：.*金额/)
  assert.throws(() => proposals.createImport(boss, []), /没有行/)
  assert.throws(() => proposals.createImport(boss, [{ type: 'income', amount: 1, date: '2026-10-01', account: '没建的账户' }]), /未建档/)

  const p = proposals.createImport({ username: 'boss', source: 'agent' }, rows, '10 月上半月流水')
  assert.equal(p.kind, 'import')
  assert.match(p.summary, /批量导入 2 笔.*收入 3000 元.*支出 4500 元/)
  assert.equal(finance.list({}).count, 0, '提案不落账本')

  // 卡面知情（对抗审查 P2-2）：与库重复的行数要写进 summary，老板不盲批
  finance.create(boss, { type: 'income', amount: 3000, date: '2026-10-05', counterparty: '客户A' })
  const p2 = proposals.createImport({ username: 'boss', source: 'agent' }, rows)
  assert.match(p2.summary, /其中 1 笔与账本已有账同日期同金额同对方/)

  const { proposal, entries, batch } = proposals.confirm(boss, p.id)
  assert.equal(proposal.status, 'confirmed')
  assert.equal(proposal.entry_id, batch)
  assert.match(batch!, /^IMP-/)
  assert.equal(entries!.length, 2)
  assert.equal(entries![0]!.approved_by, 'boss', '谁认的=确认人')
  assert.equal(finance.list({}).count, 3, '确认照常入账：与库重复的 3000 也入成两笔（卡面已告知）')
  const logs = audit.recent(10) as { source: string; action: string }[]
  assert.ok(logs.some((l) => l.source === 'confirm' && l.action === 'finance.import'))
  assert.ok(logs.some((l) => l.action === 'proposal.confirm'))
  assert.throws(() => proposals.confirm(boss, p.id), /不能重复确认/)
})

test('批量提案：确认时出数窗口变化 → fail-closed 留 pending，整批不落', () => {
  const p = proposals.createImport(boss, [
    { type: 'income', amount: 100, date: '2026-09-01', counterparty: '甲' },
    { type: 'income', amount: 200, date: '2026-09-02', counterparty: '乙' },
  ])
  finance.markReported(boss, '2026-09')
  assert.throws(() => proposals.confirm(boss, p.id), /不能补录该月/)
  assert.equal(proposals.list('pending').count, 1)
  assert.equal(finance.list({}).count, 0)
  finance.unmarkReported(boss, '2026-09')
  const { entries } = proposals.confirm(boss, p.id)
  assert.equal(entries!.length, 2)
})

test('批量提案：单笔提案 kind 仍是 single；列表带 kind 字段', () => {
  const s = proposals.create(boss, { type: 'income', amount: 5, date: localDate() })
  assert.equal(s.kind, 'single')
  const b = proposals.createImport(boss, [{ type: 'income', amount: 6, date: localDate() }])
  const all = proposals.list()
  assert.deepEqual(all.proposals.map((x) => x.kind).sort(), ['import', 'single'])
})

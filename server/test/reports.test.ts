/** 报表与打包测试（C4 凭证对照/A8 对账单/F5 应答包/E5 年度归档），2026-10-26。 */
import assert from 'node:assert/strict'
import { test, beforeEach } from 'node:test'
import { openDatabase, type DB } from '../src/db/database.js'
import { AuditService } from '../src/audit/audit.service.js'
import { FinanceService } from '../src/finance/finance.service.js'
import { FinanceAccountsService } from '../src/finance/finance-accounts.service.js'
import { FinanceInvoicesService } from '../src/finance/finance-invoices.service.js'
import { FinanceReportsService } from '../src/finance/finance-reports.service.js'
import { FinanceAttachmentsService } from '../src/finance/finance-attachments.service.js'
import { FinanceBankLinesService } from '../src/finance/finance-banklines.service.js'
import type { Actor } from '../src/finance/finance.types.js'

let db: DB
let audit: AuditService
let finance: FinanceService
let accounts: FinanceAccountsService
let invoices: FinanceInvoicesService
let reports: FinanceReportsService
let attachments: FinanceAttachmentsService
let bankLines: FinanceBankLinesService
const boss: Actor = { username: 'boss', source: 'ui' }

beforeEach(() => {
  db = openDatabase(':memory:')
  audit = new AuditService(db)
  finance = new FinanceService(db, audit)
  accounts = new FinanceAccountsService(db, audit)
  invoices = new FinanceInvoicesService(db, audit)
  reports = new FinanceReportsService(db, finance)
  attachments = new FinanceAttachmentsService(db, audit)
  bankLines = new FinanceBankLinesService(db, audit)
})

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')

test('凭证对照清单：票号/挂票/附件/银行配对四路证据计数，缺的列 missing，hint 报总数', () => {
  accounts.create(boss, { name: '微信', kind: 'wechat' })
  const noEvidence = finance.create(boss, { type: 'expense', amount: 50, account: '微信', status: 'paid', date: '2026-10-05', counterparty: '供应商A' })
  const withInvoiceNo = finance.create(boss, { type: 'expense', amount: 80, account: '微信', status: 'paid', date: '2026-10-06', invoice_no: 'INV123' })
  const withLink = finance.create(boss, { type: 'expense', amount: 90, account: '微信', status: 'paid', date: '2026-10-07' })
  const inv = invoices.create(boss, { kind: 'purchase', amount: 90, date: '2026-10-07' })
  invoices.link(boss, inv.id, withLink.id)
  const withAttachment = finance.create(boss, { type: 'expense', amount: 70, account: '微信', status: 'paid', date: '2026-10-08' })
  attachments.add(boss, withAttachment.id, { file_name: '回单.png', data_base64: b64('x') })
  const withBank = finance.create(boss, { type: 'expense', amount: 60, account: '微信', status: 'paid', date: '2026-10-09' })
  bankLines.importLines(boss, { account: '微信', text: '日期,方向,金额,对方,流水号,备注\n2026-10-09,支出,60,某,RL1,' })
  const lineId = bankLines.list({ account: '微信' }).lines[0]!.id
  bankLines.setMatch(boss, lineId, withBank.id)
  // 作废账与冲销对不进清单；开票登记（type=invoice）不进清单
  const cancelled = finance.create(boss, { type: 'expense', amount: 1, account: '微信', date: '2026-10-10' })
  finance.update(boss, cancelled.id, { status: 'cancelled' })
  finance.create(boss, { type: 'invoice', amount: 999, date: '2026-10-10' })

  const r = reports.evidenceChecklist('2026-10')
  assert.equal(r.count, 5)
  const byId = new Map(r.entries.map((e) => [e.id, e]))
  assert.deepEqual(byId.get(noEvidence.id)!.missing, ['票', '附件'])
  assert.deepEqual(byId.get(withInvoiceNo.id)!.missing, ['附件'])
  assert.deepEqual(byId.get(withLink.id)!.missing, ['附件'])
  assert.equal(byId.get(withLink.id)!.evidence.linked_held_invoices, 1)
  assert.deepEqual(byId.get(withAttachment.id)!.missing, ['票']) // 有附件没票：缺什么照实列
  assert.equal(byId.get(withAttachment.id)!.voucher_ok, true) // 但凭证齐（有附件即算）
  assert.equal(byId.get(withAttachment.id)!.evidence.attachments, 1)
  assert.equal(byId.get(withBank.id)!.voucher_ok, false) // 银行配对是核对信号不是单据
  assert.equal(byId.get(withBank.id)!.evidence.bank_matches, 1)
  assert.equal(r.with_voucher, 3) // 票号/挂票/附件三笔齐
  assert.equal(r.missing_voucher, 2)
  assert.equal(r.bank_matched, 1)
  assert.match(r.hint, /共 5 笔/)
})

test('凭证对照清单：缺省当月；坏月份 400', () => {
  reports.evidenceChecklist(undefined) // 不抛
  assert.throws(() => reports.evidenceChecklist('2026-13'), /YYYY-MM/)
})

test('往来对账单：期初未结（严格早于 from）→期间明细→期末未结；冲销对与作废账不进', () => {
  accounts.create(boss, { name: '对公', kind: 'bank' })
  finance.create(boss, { type: 'income', amount: 1000, account: '对公', status: 'unpaid', date: '2026-08-15', counterparty: '甬城科技' })
  finance.create(boss, { type: 'income', amount: 2000, account: '对公', status: 'partial', paid_amount: 500, date: '2026-10-05', counterparty: '甬城科技' })
  finance.create(boss, { type: 'expense', amount: 300, account: '对公', status: 'unpaid', date: '2026-10-06', counterparty: '甬城科技' }) // 同名账也进（LIKE 匹配）
  const cancelled = finance.create(boss, { type: 'income', amount: 777, account: '对公', status: 'unpaid', date: '2026-10-07', counterparty: '甬城科技' })
  finance.update(boss, cancelled.id, { status: 'cancelled' })

  const r = reports.counterpartyStatement({ counterparty: '甬城科技', from: '2026-09-01', to: '2026-10-31' })
  assert.equal(r.opening.receivable, 1000) // 8 月那笔未收
  assert.equal(r.closing.receivable, 2500) // 1000 + (2000−500)
  assert.equal(r.closing.payable, 300)
  assert.equal(r.lines.length, 2)
  assert.equal(r.totals.income, 2000)
  assert.match(r.hint, /截至该日累计未收付/)
})

test('往来对账单：对方必填；from>to 400', () => {
  assert.throws(() => reports.counterpartyStatement({}), /counterparty/)
  assert.throws(() => reports.counterpartyStatement({ counterparty: '甲', from: '2026-10-02', to: '2026-10-01' }), /不能晚于/)
})

test('检查应答包：md 有期间合计/档案/明细/票据对照四节+口径声明；冲销条目负计入', () => {
  const day = (n: number) => {
    const d = new Date()
    d.setDate(d.getDate() + n)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  const from = day(-5)
  const to = day(0)
  accounts.create(boss, { name: '对公', kind: 'bank' })
  finance.profileSet(boss, '主体类型', '个体工商户')
  finance.create(boss, { type: 'income', amount: 5000, account: '对公', status: 'paid', date: day(-4) })
  finance.create(boss, { type: 'expense', amount: 400, account: '对公', status: 'paid', date: day(-3) })
  const bad = finance.create(boss, { type: 'income', amount: 100, account: '对公', status: 'paid', date: day(-2) })
  finance.reverse(boss, bad.id, '重复') // 冲销条目 date=今天，落在窗口内
  invoices.create(boss, { kind: 'sales', amount: 5000, date: day(-4), number: 'SP123' })

  const pack = reports.inspectionPack({ from, to })
  assert.match(pack.markdown, new RegExp(`# 财务检查应答包（${from} 至 ${to}）`))
  assert.match(pack.markdown, /## 一、期间合计/)
  assert.match(pack.markdown, /## 二、建档参数（档案概要）/)
  assert.match(pack.markdown, /主体类型：个体工商户/)
  assert.match(pack.markdown, /## 三、逐笔明细（共 4 笔）/)
  assert.match(pack.markdown, /## 四、票据对照（期间内票期）/)
  assert.match(pack.markdown, /SP123/)
  assert.match(pack.markdown, /不是会计核算结果/)
  assert.match(pack.markdown, /被冲销/) // 冲销轨迹在明细里可见
  assert.equal(pack.entry_count, 4)
  assert.equal(pack.truncated, false)
})

test('年度归档导出：逐节 sha256 清单+重导同数据哈希稳定；金额全部转元；坏年份 400', () => {
  accounts.create(boss, { name: '对公', kind: 'bank', opening_balance: 100 })
  finance.create(boss, { type: 'income', amount: 1200, account: '对公', status: 'paid', date: '2026-03-01' })
  invoices.create(boss, { kind: 'sales', amount: 1200, date: '2026-03-01' })
  const a = reports.annualArchive('2026') as { manifest: { sections: Record<string, { count: number; sha256: string }>; bundle_sha256: string }; data: { entries: { amount: number }[] } }
  assert.equal(a.manifest.sections['entries']!.count, 1)
  assert.equal(a.data.entries[0]!.amount, 1200)
  assert.match(a.manifest.bundle_sha256, /^[0-9a-f]{64}$/)
  const b = reports.annualArchive('2026') as { manifest: { bundle_sha256: string } }
  assert.equal(a.manifest.bundle_sha256, b.manifest.bundle_sha256) // 同数据哈希稳定（可复核）
  assert.throws(() => reports.annualArchive('26'), /4 位年份/)
  assert.throws(() => reports.annualArchive(undefined), /4 位年份/)
})

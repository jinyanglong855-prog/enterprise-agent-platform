/** 新域 HTTP 全链路冒烟（2026-10-26）：附件（上传/下载二进制/摘除）、猜挂、银行流水、盘点、
 *  凭证对照/对账单/应答包/年度归档、报销批准、票守门。重点验证：控制器装配 + 权限点 + 路由顺序。 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { json } from 'express'

process.env.ADMIN_DATA_DIR = mkdtempSync(join(tmpdir(), 'admin-evidence-api-test-'))
delete process.env.ADMIN_JWT_SECRET

const { createRuntimeModule, registerAuthMiddleware, BODY_LIMIT } = await import('../src/app.module.js')
const { config } = await import('../src/config.js')

describe('证据与核对域 HTTP 全链路', () => {
  let app: import('@nestjs/common').INestApplication
  let base: string
  let token: string

  const get = (path: string) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } })
  const send = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

  before(async () => {
    const { dynamicModule, services } = createRuntimeModule()
    app = await (await import('@nestjs/core')).NestFactory.create(dynamicModule, { logger: false })
    app.use(json({ limit: BODY_LIMIT }))
    registerAuthMiddleware(app, services.auth)
    await app.listen(0, '127.0.0.1')
    const address = app.getHttpServer().address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    base = `http://127.0.0.1:${port}`
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'boss', password: config.bossInitialPassword }),
    })
    token = ((await res.json()) as { token: string }).token
  })

  after(async () => {
    await app.close()
    rmSync(process.env.ADMIN_DATA_DIR!, { recursive: true, force: true })
  })

  test('附件：上传→列表→二进制下载（中文文件名头）→摘除', async () => {
    assert.equal((await fetch(`${base}/api/finance/bank-lines`)).status, 401) // 未登录先挡
    await send('POST', '/api/finance/accounts', { name: '微信', kind: 'wechat' })
    const entry = (await (await send('POST', '/api/finance/entries', { type: 'expense', amount: 45, account: '微信', status: 'paid' })).json()) as { id: string }
    const b64 = Buffer.from('PDF内容', 'utf8').toString('base64')
    const up = await send('POST', `/api/finance/entries/${entry.id}/attachments`, { file_name: '回单.pdf', data_base64: b64 })
    assert.equal(up.status, 201)
    const rec = (await up.json()) as { id: number; size: number }
    assert.equal(rec.size, Buffer.byteLength('PDF内容'))
    const list = (await (await get(`/api/finance/entries/${entry.id}/attachments`)).json()) as { count: number }
    assert.equal(list.count, 1)
    const dl = await get(`/api/finance/attachments/${rec.id}/download`)
    assert.equal(dl.status, 200)
    assert.match(dl.headers.get('content-type') ?? '', /application\/pdf/)
    assert.match(dl.headers.get('content-disposition') ?? '', /attachment/)
    assert.match(dl.headers.get('content-disposition') ?? '', /filename\*=UTF-8''/)
    assert.equal(Buffer.from(await dl.arrayBuffer()).toString('utf8'), 'PDF内容')
    // 坏扩展名 400
    assert.equal((await send('POST', `/api/finance/entries/${entry.id}/attachments`, { file_name: 'a.exe', data_base64: b64 })).status, 400)
    const del = await send('DELETE', `/api/finance/attachments/${rec.id}`, { reason: '传错' })
    assert.equal(del.status, 200)
  })

  test('大请求走 HTTP 不被 body 上限挡（对抗审查 P1）：200KB 附件 201、9MB 附件到服务层 400、1MB 级 CSV 导入 201', async () => {
    const entry = (await (await send('POST', '/api/finance/entries', { type: 'expense', amount: 3, date: '2020-01-01', account: '微信', status: 'paid' })).json()) as { id: string }
    // 200KB 二进制 → base64 ~267KB，远超 express 默认 100kb；能拿到 201 说明上限已放开到 BODY_LIMIT
    const big = Buffer.alloc(200 * 1024, 7).toString('base64')
    const up = await send('POST', `/api/finance/entries/${entry.id}/attachments`, { file_name: '大合同扫描.pdf', data_base64: big })
    assert.equal(up.status, 201)
    assert.equal(((await up.json()) as { size: number }).size, 200 * 1024)
    // 超附件上限（8MB）但低于 body 上限（16MB）：请求能到服务层，拿到的是 400 业务拒绝而非 413
    const tooBig = Buffer.alloc(9 * 1024 * 1024, 7).toString('base64')
    const rejected = await send('POST', `/api/finance/entries/${entry.id}/attachments`, { file_name: '超限.pdf', data_base64: tooBig })
    assert.equal(rejected.status, 400)
    // 批量导入同理：500 行 × 300+ 字节备注 ≈ 160KB 文本，超 express 默认上限
    await send('POST', '/api/finance/accounts', { name: '导入压测', kind: 'bank' })
    const rows: string[] = []
    for (let i = 0; i < 500; i++) rows.push(`2026-01-${String((i % 28) + 1).padStart(2, '0')},收入,10,客户${i},REF${i},${'x'.repeat(300)}`)
    const csv = `日期,方向,金额,对方,流水号,备注\n${rows.join('\n')}`
    assert.ok(Buffer.byteLength(csv, 'utf8') > 100 * 1024)
    const imp = await send('POST', '/api/finance/bank-lines/import', { account: '导入压测', text: csv })
    assert.equal(imp.status, 201)
    assert.equal(((await imp.json()) as { inserted: number }).inserted, 500)
  })

  test('猜挂：票→账与账→票两个方向出建议', async () => {
    const inv = (await (await send('POST', '/api/finance/invoices', { kind: 'purchase', amount: 45, counterparty: '供应商A' })).json()) as { id: string }
    const byInvoice = (await (await get(`/api/finance/invoices/${inv.id}/matches`)).json()) as { suggestions: unknown[] }
    assert.equal(byInvoice.suggestions.length, 1)
    // 定位用金额而不是排序第一（id DESC 会指向最新建的账，前面用例谁后跑谁占位，靠排序会碎）
    const records = ((await (await get('/api/finance/entries?limit=50')).json()) as { records: { id: string; amount: number }[] }).records
    const entryId = records.find((r) => r.amount === 45)!.id
    const byEntry = (await (await get(`/api/finance/entries/${entryId}/matches`)).json()) as { suggestions: { invoice_id: string }[] }
    assert.equal(byEntry.suggestions.some((s) => s.invoice_id === inv.id), true)
  })

  test('银行流水：模板→导入→报告→人工配对（PATCH）', async () => {
    await send('POST', '/api/finance/accounts', { name: '对公', kind: 'bank' })
    const tpl = (await (await get('/api/finance/bank-lines/template')).json()) as { csv: string }
    const imp = await send('POST', '/api/finance/bank-lines/import', { account: '对公', text: tpl.csv })
    assert.equal(imp.status, 201)
    const impBody = (await imp.json()) as { inserted: number }
    assert.equal(impBody.inserted, 2)
    const report = (await (await get('/api/finance/bank-lines/report?account=对公')).json()) as { bank_only: unknown[] }
    assert.equal(report.bank_only.length, 2)
    const line = (await (await get('/api/finance/bank-lines?account=对公')).json()) as { lines: { id: number }[] }
    const entry = (await (await send('POST', '/api/finance/entries', { type: 'income', amount: 12000, account: '对公', status: 'paid' })).json()) as { id: string }
    const patched = await send('PATCH', `/api/finance/bank-lines/${line.lines[0]!.id}`, { matched_entry_id: entry.id })
    assert.equal(patched.status, 200)
    assert.equal((await send('PATCH', `/api/finance/bank-lines/${line.lines[0]!.id}`, {})).status, 400)
  })

  test('盘点：POST 落记录，账面与账户页同口径', async () => {
    const count = await send('POST', '/api/finance/cash-counts', { account: '微信', counted: 100 })
    assert.equal(count.status, 201)
    const list = (await (await get('/api/finance/cash-counts?account=微信')).json()) as { count: number }
    assert.equal(list.count, 1)
  })

  test('报表四件：凭证对照/对账单/应答包/年度归档全通；坏参数 400', async () => {
    const ev = await get('/api/finance/reports/evidence-checklist')
    assert.equal(ev.status, 200)
    assert.equal((await get('/api/finance/reports/evidence-checklist?month=2026-13')).status, 400)
    const st = await get('/api/finance/reports/counterparty-statement?counterparty=供应商A')
    assert.equal(st.status, 200)
    assert.equal((await get('/api/finance/reports/counterparty-statement')).status, 400)
    const pack = (await (await get('/api/finance/reports/inspection-pack')).json()) as { markdown: string }
    assert.match(pack.markdown, /财务检查应答包/)
    const archive = (await (await get('/api/finance/reports/archive/2026')).json()) as { manifest: { bundle_sha256: string } }
    assert.match(archive.manifest.bundle_sha256, /^[0-9a-f]{64}$/)
    assert.equal((await get('/api/finance/reports/archive/bad')).status, 400)
  })

  test('票守门走 HTTP 也生效：已出数月的票作废 400', async () => {
    const inv = (await (await send('POST', '/api/finance/invoices', { kind: 'sales', amount: 1, counterparty: '守门' })).json()) as { id: string }
    const month = new Date()
    const m = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}`
    await send('PUT', `/api/finance/periods/${m}/reported`, {})
    const res = await send('PATCH', `/api/finance/invoices/${inv.id}`, { status: 'voided' })
    assert.equal(res.status, 400)
    const body = (await res.json()) as { message: string }
    assert.match(body.message, /作废/)
    // 红冲放行
    assert.equal((await send('PATCH', `/api/finance/invoices/${inv.id}`, { status: 'red' })).status, 200)
  })
})

/** 导入域 HTTP 全链路：模板/预览/提交 + agent 来源禁直接落库 + 批量提案确认。 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ADMIN_DATA_DIR = mkdtempSync(join(tmpdir(), 'admin-imports-api-test-'))
delete process.env.ADMIN_JWT_SECRET

const { createRuntimeModule, registerAuthMiddleware } = await import('../src/app.module.js')
const { config } = await import('../src/config.js')

describe('导入域 HTTP 全链路', () => {
  let app: import('@nestjs/common').INestApplication
  let base: string
  let token: string

  const send = (method: string, path: string, body?: unknown, source?: string) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        ...(source ? { 'x-actor-source': source } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

  before(async () => {
    const { dynamicModule, services } = createRuntimeModule()
    app = await (await import('@nestjs/core')).NestFactory.create(dynamicModule, { logger: false })
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

  const header = '日期,类型,金额,对方,分类,账户,状态,已收付,到期日,发票号,备注'

  test('模板端点：未登录 401；登录后 header/example/mapping 自洽', async () => {
    assert.equal((await fetch(`${base}/api/finance/imports/template`)).status, 401)
    const res = await send('GET', '/api/finance/imports/template')
    assert.equal(res.status, 200)
    const t = (await res.json()) as { header: string[]; example: string[][]; csv: string }
    assert.equal(t.header.length, 11)
    assert.match(t.csv, /^日期,类型,金额/)
    assert.equal(t.example.length, 2)
  })

  test('预览：不传 mapping 走固定模板；错误行带行号与原因；未登录 401', async () => {
    assert.equal((await fetch(`${base}/api/finance/imports/preview`, { method: 'POST', body: '{}' })).status, 401)
    const res = await send('POST', '/api/finance/imports/preview', {
      text: [header, '2026-10-01,收入,100,甲,,,,,,,', '2026-10-02,收入,,乙,,,,,,,'].join('\n'),
    })
    assert.equal(res.status, 201)
    const p = (await res.json()) as { total: number; valid: number; invalid: number; rows: { line: number; error?: string }[] }
    assert.equal(p.total, 2)
    assert.equal(p.valid, 1)
    assert.equal(p.invalid, 1)
    assert.equal(p.rows[1]!.line, 3, '行号含列头行')
    assert.match(p.rows[1]!.error!, /金额为空/)
    assert.equal((await send('POST', '/api/finance/imports/preview', { mapping: {} })).status, 400)
  })

  test('提交：UI 来源落库；事务原子失败 400；agent 来源 403 且一条不落', async () => {
    const ok = await send('POST', '/api/finance/entries', { type: 'expense', amount: 1, date: '2026-10-01', counterparty: '铺垫' })
    assert.equal(ok.status, 201)
    const res = await send('POST', '/api/finance/imports/commit', {
      rows: [
        { type: 'income', amount: 100, date: '2026-10-01', counterparty: '甲' },
        { type: 'income', amount: 200, date: '2026-10-02', counterparty: '乙' },
      ],
      note: '10 月初流水',
    })
    assert.equal(res.status, 201)
    const r = (await res.json()) as { batch: string; created: { id: string }[]; skipped: number }
    assert.match(r.batch, /^IMP-\d{8}-\d{6}-[a-z0-9]{4}$/)
    assert.equal(r.created.length, 2)

    const bad = await send('POST', '/api/finance/imports/commit', {
      rows: [
        { type: 'income', amount: 1, date: '2026-10-03', counterparty: '丙' },
        { type: 'income', amount: -5, date: '2026-10-04', counterparty: '丁' },
      ],
    })
    assert.equal(bad.status, 400)
    assert.match(((await bad.json()) as { message: string }).message, /第 2 行/)

    const agent = await send(
      'POST',
      '/api/finance/imports/commit',
      { rows: [{ type: 'income', amount: 999, date: '2026-10-05', counterparty: '戊' }] },
      'agent',
    )
    assert.equal(agent.status, 403)
    assert.match(((await agent.json()) as { message: string }).message, /批量提案/)
  })

  test('批量提案：agent 提交 import 提案 → 卡片确认落库（kind/entries/batch）', async () => {
    const proposed = await send(
      'POST',
      '/api/finance/proposals/import',
      {
        rows: [
          { type: 'income', amount: 300, date: '2026-10-06', counterparty: '客户A' },
          { type: 'expense', amount: 50, date: '2026-10-07', counterparty: '供应商A' },
        ],
        note: '上午丢进来的表',
      },
      'agent',
    )
    assert.equal(proposed.status, 201)
    const proposal = (await proposed.json()) as { id: string; kind: string; summary: string; payload: { rows: unknown[]; note: string } }
    assert.equal(proposal.kind, 'import')
    assert.match(proposal.summary, /批量导入 2 笔/)
    assert.equal(proposal.payload.rows.length, 2)
    assert.equal(proposal.payload.note, '上午丢进来的表')

    const confirmed = await send('POST', `/api/finance/proposals/${proposal.id}/confirm`, {})
    assert.equal(confirmed.status, 201)
    const done = (await confirmed.json()) as { batch: string; entries: { id: string; approved_by: string }[]; proposal: { entry_id: string } }
    assert.match(done.batch, /^IMP-/)
    assert.equal(done.entries.length, 2)
    assert.equal(done.entries[0]!.approved_by, 'boss')
    assert.equal(done.proposal.entry_id, done.batch)

    const dup = await send('POST', `/api/finance/proposals/${proposal.id}/confirm`, {})
    assert.equal(dup.status, 400)
    assert.equal((await send('POST', '/api/finance/proposals/import', { note: '没有行' }, 'agent')).status, 400)
  })
})

/** 地基增量 HTTP 全链路：账户/票/提案/出数四组新端点（权限 + 来源标记 + 落库链路）。 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ADMIN_DATA_DIR = mkdtempSync(join(tmpdir(), 'admin-foundation-api-test-'))
delete process.env.ADMIN_JWT_SECRET

const { createRuntimeModule, registerAuthMiddleware } = await import('../src/app.module.js')
const { config } = await import('../src/config.js')

describe('地基增量 HTTP 全链路', () => {
  let app: import('@nestjs/common').INestApplication
  let base: string
  let token: string
  let db: import('better-sqlite3').Database

  const get = (path: string) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } })
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
    db = services.db
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

  test('账户：未登录 401 → 建/查/改全链路（余额随记账变化）', async () => {
    assert.equal((await fetch(`${base}/api/finance/accounts`)).status, 401)
    const bad = await send('POST', '/api/finance/accounts', { name: '' })
    assert.equal(bad.status, 400)
    const created = await send('POST', '/api/finance/accounts', { name: '微信', kind: 'wechat', opening_balance: 100 })
    assert.equal(created.status, 201)
    await send('POST', '/api/finance/entries', { type: 'income', amount: 300, account: '微信', status: 'paid', date: '2026-10-01' })
    const list = (await (await get('/api/finance/accounts')).json()) as { accounts: { name: string; balance: number }[] }
    assert.equal(list.accounts.find((a) => a.name === '微信')?.balance, 400)
    const dup = await send('POST', '/api/finance/accounts', { name: '微信' })
    assert.equal(dup.status, 400)
    const id = (await (await get('/api/finance/accounts')).json() as { accounts: { id: number; name: string }[] }).accounts[0]!.id
    const patched = await send('PATCH', `/api/finance/accounts/${id}`, { note: '主力口袋' })
    assert.equal(patched.status, 200)
    assert.equal((await send('PATCH', '/api/finance/accounts/999', { note: 'x' })).status, 404)
  })

  test('记账挂未建档账户 → 400 带指引文案', async () => {
    const res = await send('POST', '/api/finance/entries', { type: 'income', amount: 1, account: '没建过的' })
    assert.equal(res.status, 400)
    const body = (await res.json()) as { message: string }
    assert.match(body.message, /未建档/)
  })

  test('票：建→挂联→查→解挂；坏 kind 400', async () => {
    const created = await send('POST', '/api/finance/invoices', { kind: 'purchase', amount: 500, counterparty: '供应商A' })
    assert.equal(created.status, 201)
    const inv = (await created.json()) as { id: string }
    const entry = (await (await send('POST', '/api/finance/entries', { type: 'expense', amount: 500, date: '2026-10-02', counterparty: '供应商A' })).json()) as { id: string }
    const linked = await send('POST', `/api/finance/invoices/${inv.id}/links`, { entry_id: entry.id })
    assert.equal(linked.status, 201)
    const one = (await (await get(`/api/finance/invoices/${inv.id}`)).json()) as { entry_ids: string[] }
    assert.deepEqual(one.entry_ids, [entry.id])
    const unlinked = await send('DELETE', `/api/finance/invoices/${inv.id}/links/${entry.id}`)
    assert.equal(unlinked.status, 200)
    assert.equal((await send('POST', '/api/finance/invoices', { kind: 'nope', amount: 1 })).status, 400)
  })

  test('确认卡片：agent 提案 → confirm 落库审计 source=confirm → 重复确认 400 → reject', async () => {
    const proposed = await send('POST', '/api/finance/proposals', { type: 'income', amount: 800, counterparty: '王五' }, 'agent')
    assert.equal(proposed.status, 201)
    const proposal = (await proposed.json()) as { id: string; status: string }
    assert.equal(proposal.status, 'pending')

    const confirmed = await send('POST', `/api/finance/proposals/${proposal.id}/confirm`, {})
    assert.equal(confirmed.status, 201)
    const { entry } = (await confirmed.json()) as { entry: { id: string; approved_by: string } }
    assert.equal(entry.approved_by, 'boss')
    const log = db.prepare("SELECT source FROM audit_log WHERE action = 'finance.create' AND target_id = ?").get(entry.id) as { source: string }
    assert.equal(log.source, 'confirm')
    assert.equal((await send('POST', `/api/finance/proposals/${proposal.id}/confirm`, {})).status, 400)

    const proposed2 = await send('POST', '/api/finance/proposals', { type: 'expense', amount: 20 }, 'agent')
    const p2 = (await proposed2.json()) as { id: string }
    const rejected = await send('POST', `/api/finance/proposals/${p2.id}/reject`, { reason: '金额不对' })
    assert.equal(rejected.status, 201)
    const pending = (await (await get('/api/finance/proposals?status=pending')).json()) as { count: number }
    assert.equal(pending.count, 0)
  })

  test('出数：标记后改账 400 → 撤销（admin:manage）→ 可改', async () => {
    const entry = (await (await send('POST', '/api/finance/entries', { type: 'income', amount: 5000, date: '2026-09-10' })).json()) as { id: string }
    const marked = await send('PUT', '/api/finance/periods/2026-09/reported', {})
    assert.equal(marked.status, 200)
    const periods = (await (await get('/api/finance/periods')).json()) as { months: { month: string }[] }
    assert.ok(periods.months.some((m) => m.month === '2026-09'))
    const edit = await send('PATCH', `/api/finance/entries/${entry.id}`, { note: '改' })
    assert.equal(edit.status, 400)
    const unmarked = await send('DELETE', '/api/finance/periods/2026-09/reported')
    assert.equal(unmarked.status, 200)
    assert.equal((await send('PATCH', `/api/finance/entries/${entry.id}`, { note: '解锁' })).status, 200)
    assert.equal((await send('PUT', '/api/finance/periods/2026-13/reported', {})).status, 400)
  })

  test('冲销：HTTP 全链路（出数月里唯一放行的修正）', async () => {
    const entry = (await (await send('POST', '/api/finance/entries', { type: 'income', amount: 2000, date: '2026-08-01' })).json()) as { id: string }
    await send('PUT', '/api/finance/periods/2026-08/reported', {})
    assert.equal((await send('PATCH', `/api/finance/entries/${entry.id}`, { note: 'x' })).status, 400)
    const reversed = await send('POST', `/api/finance/entries/${entry.id}/reverse`, { reason: '记错对方' })
    assert.equal(reversed.status, 201)
    const rev = (await reversed.json()) as { reverses: string; amount: number }
    assert.equal(rev.reverses, entry.id)
    assert.equal(rev.amount, 2000)
    assert.equal((await send('POST', `/api/finance/entries/${entry.id}/reverse`, { reason: 'x' })).status, 400)
  })
})

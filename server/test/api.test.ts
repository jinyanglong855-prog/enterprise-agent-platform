/** HTTP 全链路测试：登录 → 权限拦截 → 记账 → 汇总 → 审计（真实 Nest 路由 + 中间件 + 临时库）。 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NestFactory } from '@nestjs/core'
import type { INestApplication } from '@nestjs/common'

process.env.ADMIN_DATA_DIR = mkdtempSync(join(tmpdir(), 'admin-server-test-'))
delete process.env.ADMIN_JWT_SECRET

const { createRuntimeModule, registerAuthMiddleware } = await import('../src/app.module.js')
const { config } = await import('../src/config.js')

describe('HTTP API 全链路', () => {
  let app: INestApplication
  let base: string
  let token: string
  let db: ReturnType<typeof import('../src/db/database.js')['openDatabase']>

  before(async () => {
    const { dynamicModule, services } = createRuntimeModule()
    db = services.db
    app = await NestFactory.create(dynamicModule, { logger: false })
    registerAuthMiddleware(app, services.auth)
    await app.listen(0, '127.0.0.1')
    const address = app.getHttpServer().address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    base = `http://127.0.0.1:${port}`
  })

  after(async () => {
    await app.close()
    rmSync(process.env.ADMIN_DATA_DIR!, { recursive: true, force: true })
  })

  test('未登录读账本 → 401', async () => {
    const res = await fetch(`${base}/api/finance/entries`)
    assert.equal(res.status, 401)
  })

  test('错误密码 → 401，且审计留失败记录', async () => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'boss', password: 'wrong' }),
    })
    assert.equal(res.status, 401)
    const row = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'auth.login' AND ok = 0").get() as { n: number }
    assert.ok(row.n >= 1, '审计表应有登录失败记录')
  })

  test('boss 登录 → token + 全部权限', async () => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'boss', password: config.bossInitialPassword }),
    })
    assert.equal(res.status, 201)
    const body = (await res.json()) as { token: string; user: { permissions: string[] } }
    token = body.token
    assert.ok(token.length > 20)
    assert.ok(body.user.permissions.includes('finance:write'))
  })

  test('登录后记账 → 汇总能看到；来源默认 ui', async () => {
    const createRes = await fetch(`${base}/api/finance/entries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ type: 'income', amount: 7001, counterparty: '示例厂', date: '2026-10-15' }),
    })
    assert.equal(createRes.status, 201)
    const created = (await createRes.json()) as { id: string; amount: number }
    assert.equal(created.id, 'FIN-20261015-001')
    assert.equal(created.amount, 7001)

    const summaryRes = await fetch(`${base}/api/finance/summary?month=2026-10`, {
      headers: { authorization: `Bearer ${token}` },
    })
    const summary = (await summaryRes.json()) as { count: number; byType: { type: string; total: number }[] }
    assert.equal(summary.count, 1)
    assert.equal(summary.byType[0]?.total, 7001)

    const listRes = await fetch(`${base}/api/finance/entries?id=${created.id}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    const one = (await listRes.json()) as { records: { followups: { note: string }[] }[] }
    assert.match(one.records[0]?.followups?.[0]?.note ?? '', /登记/)
  })

  test('X-Actor-Source: agent 记账 → 审计来源=agent；审计页可见', async () => {
    const res = await fetch(`${base}/api/finance/entries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-actor-source': 'agent' },
      body: JSON.stringify({ type: 'expense', amount: 250, counterparty: '供应商A', date: '2026-10-16' }),
    })
    assert.equal(res.status, 201)
    const auditRes = await fetch(`${base}/api/finance/audit?limit=5`, {
      headers: { authorization: `Bearer ${token}` },
    })
    const logs = (await auditRes.json()) as { source: string; action: string }[]
    assert.ok(logs.some((l) => l.source === 'agent' && l.action === 'finance.create'))
  })

  test('建档读写走 API', async () => {
    const setRes = await fetch(`${base}/api/finance/profile`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ key: '纳税人身份', value: '小规模纳税人' }),
    })
    assert.equal(setRes.status, 200)
    const getRes = await fetch(`${base}/api/finance/profile`, { headers: { authorization: `Bearer ${token}` } })
    const body = (await getRes.json()) as { profile: Record<string, string> }
    assert.equal(body.profile['纳税人身份'], '小规模纳税人')
  })

  test('改密：旧密码错→401；新密码太短→400；成功后新密登录、旧密失效（放最后：会改掉 boss 密码）', async () => {
    const wrongOld = await fetch(`${base}/api/auth/password`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ oldPassword: 'not-the-old', newPassword: 'new-pass-2026' }),
    })
    assert.equal(wrongOld.status, 401)

    const tooShort = await fetch(`${base}/api/auth/password`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ oldPassword: config.bossInitialPassword, newPassword: 'short' }),
    })
    assert.equal(tooShort.status, 400)

    const okRes = await fetch(`${base}/api/auth/password`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ oldPassword: config.bossInitialPassword, newPassword: 'new-pass-2026' }),
    })
    assert.equal(okRes.status, 200)

    const oldLogin = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'boss', password: config.bossInitialPassword }),
    })
    assert.equal(oldLogin.status, 401)

    const newLogin = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'boss', password: 'new-pass-2026' }),
    })
    assert.equal(newLogin.status, 201)

    // 审计：旧密错 1 条失败 + 成功 1 条（新密码太短在写审计前就被参数校验拦下，不产生记录）
    const pwOk = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'auth.password' AND ok = 1").get() as { n: number }
    const pwFail = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'auth.password' AND ok = 0").get() as { n: number }
    assert.ok(pwOk.n >= 1 && pwFail.n >= 1, '改密成败都应留审计')
  })
})

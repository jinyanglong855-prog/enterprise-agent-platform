/** 票夹义务维 HTTP 全链路（2026-11-01 财务残余 A7/A1/A2）：
 *  A7 票夹列表 total/截断；A2 销项计税聚合（红冲按执行日冲减执行当月，老红票按票期归月并披露）；
 *  A1 数电票额度手工抄入（校验/剩余/低额警示/票夹当月销项对照/审计）。 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import bcrypt from 'bcryptjs'

process.env.ADMIN_DATA_DIR = mkdtempSync(join(tmpdir(), 'admin-invoice-duty-test-'))
delete process.env.ADMIN_JWT_SECRET

const { createRuntimeModule, registerAuthMiddleware } = await import('../src/app.module.js')
const { config } = await import('../src/config.js')

function localDate(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

describe('票夹义务维（A7 截断/A2 销项汇总/A1 额度）', () => {
  let app: import('@nestjs/common').INestApplication
  let base: string
  let token: string
  let clerkToken = ''
  let db: import('better-sqlite3').Database

  const get = (path: string, withToken = token) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${withToken}` } })
  const send = (method: string, path: string, body?: unknown, withToken = token) =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${withToken}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

  before(async () => {
    const { dynamicModule, services } = createRuntimeModule()
    db = services.db
    // 只读对话岗观察员：验证新读端点挂 finance:read 层（无该权限 403）
    db.prepare(
      'INSERT INTO users (username, password_hash, display_name, is_service, created_at) VALUES (?, ?, ?, 0, ?)',
    ).run('clerk-inv', bcrypt.hashSync('Clerk-Inv-Pass-1', 10), '票仓观察员', new Date().toISOString())
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
    await send('POST', '/api/rbac/roles', { name: 'inv-readonly', permissions: ['agent:read'] })
    await send('POST', '/api/rbac/users/clerk-inv/roles', { role: 'inv-readonly' })
    const clerkLogin = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'clerk-inv', password: 'Clerk-Inv-Pass-1' }),
    })
    clerkToken = ((await clerkLogin.json()) as { token: string }).token
  })

  after(async () => {
    await app.close()
    rmSync(process.env.ADMIN_DATA_DIR!, { recursive: true, force: true })
  })

  test('A7 票夹列表带 total：limit 截断时 count<total，筛选项同时作用于两者；无权限 403', async () => {
    assert.equal((await fetch(`${base}/api/finance/invoices`)).status, 401)
    assert.equal((await get('/api/finance/invoices', clerkToken)).status, 403, '只读对话岗无 finance:read')
    for (const [i, amount] of [100, 200, 300].entries()) {
      const res = await send('POST', '/api/finance/invoices', {
        kind: 'sales',
        amount,
        date: `2026-01-1${i + 1}`,
        counterparty: `客户${i}`,
      })
      assert.equal(res.status, 201)
    }
    await send('POST', '/api/finance/invoices', { kind: 'purchase', amount: 50, date: '2026-01-15' })
    const paged = (await (await get('/api/finance/invoices?limit=2')).json()) as { count: number; total: number; invoices: unknown[] }
    assert.equal(paged.count, 2, 'limit 截断本页条数')
    assert.equal(paged.total, 4, 'total 是不截断的真实总数')
    assert.equal(paged.invoices.length, 2)
    const filtered = (await (await get('/api/finance/invoices?kind=sales&limit=2')).json()) as { count: number; total: number }
    assert.equal(filtered.total, 3, '筛选条件同时作用于 total')
    const full = (await (await get('/api/finance/invoices?limit=100')).json()) as { count: number; total: number }
    assert.equal(full.count, full.total, '无截断时 count=total')
  })

  test('A2 销项汇总：在手按票期、跨月红冲按执行日冲减执行当月、老红票按票期归月并标估算；权限 403/200', async () => {
    // 布景：1 月开 1000（在手）；2 月开 500 后红冲、执行日改 3 月（跨月红冲的真实形态）；
    // 3 月开 800（在手）；进项与作废销项不得出现；老红票=红冲后清掉 red_date（迁移前存量形态）
    await send('POST', '/api/finance/invoices', { kind: 'sales', amount: 1000, date: '2027-01-10' })
    const crossRed = (await (await send('POST', '/api/finance/invoices', { kind: 'sales', amount: 500, date: '2027-02-10' })).json()) as { id: string }
    assert.equal((await send('PATCH', `/api/finance/invoices/${crossRed.id}`, { status: 'red' })).status, 200)
    db.prepare('UPDATE finance_invoices SET red_date = ? WHERE id = ?').run('2027-03-05', crossRed.id)
    await send('POST', '/api/finance/invoices', { kind: 'sales', amount: 800, date: '2027-03-20' })
    await send('POST', '/api/finance/invoices', { kind: 'purchase', amount: 50, date: '2027-01-11' })
    const voided = (await (await send('POST', '/api/finance/invoices', { kind: 'sales', amount: 666, date: '2027-01-12' })).json()) as { id: string }
    await send('PATCH', `/api/finance/invoices/${voided.id}`, { status: 'voided' })
    const legacy = (await (await send('POST', '/api/finance/invoices', { kind: 'sales', amount: 300, date: '2027-02-20' })).json()) as { id: string }
    await send('PATCH', `/api/finance/invoices/${legacy.id}`, { status: 'red' })
    db.prepare('UPDATE finance_invoices SET red_date = ? WHERE id = ?').run('', legacy.id)

    assert.equal((await get('/api/finance/invoices/output-summary?year=2027', clerkToken)).status, 403)
    const sum = (await (await get('/api/finance/invoices/output-summary?year=2027')).json()) as {
      year: string
      rows: { month: string; issued: number; red: number; net: number; legacy_red: boolean }[]
      total: { issued: number; red: number; net: number }
      note: string
    }
    assert.equal(sum.year, '2027')
    const byMonth = new Map(sum.rows.map((r) => [r.month, r]))
    assert.deepEqual(byMonth.get('2027-01'), { month: '2027-01', issued: 1000, red: 0, net: 1000, legacy_red: false })
    assert.deepEqual(byMonth.get('2027-02'), { month: '2027-02', issued: 0, red: 300, net: -300, legacy_red: true }, '老红票按票期归月并标估算')
    assert.deepEqual(byMonth.get('2027-03'), { month: '2027-03', issued: 800, red: 500, net: 300, legacy_red: false }, '跨月红冲冲减执行当月')
    assert.equal(sum.rows.length, 3, '没动的月份不凑零行')
    assert.deepEqual(sum.total, { issued: 1800, red: 800, net: 1000 })
    assert.match(sum.note, /电子税务局/)
    const detail = (await (await get(`/api/finance/invoices/${crossRed.id}`)).json()) as { status: string; red_date: string }
    assert.equal(detail.status, 'red')
    assert.equal(detail.red_date, '2027-03-05', '红冲执行日落在票上')
    const empty = (await (await get('/api/finance/invoices/output-summary?year=2025')).json()) as { rows: unknown[]; total: { net: number } }
    assert.equal(empty.rows.length, 0)
    assert.equal(empty.total.net, 0)
    assert.equal((await get('/api/finance/invoices/output-summary?year=26x')).status, 400, '坏年份 400')
  })

  test('A2 红冲执行日语义：红冲落当日、同状态重复提交不刷日（P0-1）、复活清空', async () => {
    const t = (await (await send('POST', '/api/finance/invoices', { kind: 'sales', amount: 88, date: '2026-04-01' })).json()) as { id: string }
    const red = (await (await send('PATCH', `/api/finance/invoices/${t.id}`, { status: 'red' })).json()) as { status: string; red_date: string }
    assert.equal(red.status, 'red')
    assert.equal(red.red_date, localDate(), '红冲执行日=操作当天')
    // 对抗审查 P0-1 钉子：编辑弹窗总带 status 字段——同状态 PATCH 若重写执行日，红冲冲减月就被搬走。
    // 把执行日人为拨回 4 月中，再以同状态+带 status 提交，执行日必须原地不动
    db.prepare('UPDATE finance_invoices SET red_date = ? WHERE id = ?').run('2026-04-15', t.id)
    const resubmit = await send('PATCH', `/api/finance/invoices/${t.id}`, { status: 'red', note: '只补个备注' })
    assert.equal(resubmit.status, 200)
    const after = (await (await get(`/api/finance/invoices/${t.id}`)).json()) as { red_date: string }
    assert.equal(after.red_date, '2026-04-15', '同状态重复提交不得刷执行日')
    const noteOnly = await send('PATCH', `/api/finance/invoices/${t.id}`, { note: '再改备注' })
    assert.equal(noteOnly.status, 200)
    const after2 = (await (await get(`/api/finance/invoices/${t.id}`)).json()) as { red_date: string }
    assert.equal(after2.red_date, '2026-04-15', '不带 status 的编辑同样不动执行日')
    const revived = (await (await send('PATCH', `/api/finance/invoices/${t.id}`, { status: 'held' })).json()) as { status: string; red_date: string }
    assert.equal(revived.status, 'held')
    assert.equal(revived.red_date, '', '退回在手清掉执行日（不再是红冲）')
    // 审查 P3：year 重复传参不��默回落当年
    assert.equal((await get('/api/finance/invoices/output-summary?year=2027&year=2028')).status, 400, 'year 重复传参 400')
  })

  test('A1 额度：未配置形状 → 抄入校验（已用 0 合法/已用>总额拒/坏日期拒）→ 剩余与警示 → 票夹当月销项对照 → 审计', async () => {
    await send('POST', '/api/finance/invoices', { kind: 'sales', amount: 123, date: localDate() })
    assert.equal((await get('/api/finance/invoices/quota', clerkToken)).status, 403)
    const before = (await (await get('/api/finance/invoices/quota')).json()) as { configured: boolean; month_sales: number }
    assert.equal(before.configured, false)
    assert.equal(before.month_sales, 123, '票夹当月销项对照自动算（按票期=今天，本文件夹具确定性）')
    assert.equal((await send('PUT', '/api/finance/invoices/quota', { quota_total: 0, quota_used: 0 })).status, 400, '总额度 0 拒')
    assert.equal((await send('PUT', '/api/finance/invoices/quota', { quota_total: 100, quota_used: 200 })).status, 400, '已用>总额拒')
    assert.equal((await send('PUT', '/api/finance/invoices/quota', { quota_total: 100, quota_used: 0, as_of: '2027-13-40' })).status, 400, '坏日期拒')
    assert.equal((await send('PUT', '/api/finance/invoices/quota', { quota_total: 'abc', quota_used: 0 })).status, 400)
    assert.equal(
      await fetch(`${base}/api/finance/invoices/quota`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.status),
      401,
      '未登录 401',
    )
    const fresh = (await (await send('PUT', '/api/finance/invoices/quota', { quota_total: 100000, quota_used: 0, as_of: '2026-11-01' })).json()) as {
      configured: boolean
      remaining: number
      warn: boolean
      as_of: string
      quota_used: number
    }
    assert.equal(fresh.configured, true)
    assert.equal(fresh.quota_used, 0, '新批额度已用 0 合法')
    assert.equal(fresh.remaining, 100000)
    assert.equal(fresh.warn, false)
    assert.equal(fresh.as_of, '2026-11-01')
    const low = (await (await send('PUT', '/api/finance/invoices/quota', { quota_total: 10000, quota_used: 9000, as_of: '2026-11-01' })).json()) as {
      remaining: number
      warn: boolean
    }
    assert.equal(low.remaining, 1000)
    assert.equal(low.warn, true, '剩余 <20% 亮警示')
    const auditRows = (await (await get('/api/audit?limit=500')).json()) as { items: { action: string; username: string }[] }
    const quotaAudit = auditRows.items.find((e) => e.action === 'invoice.quota.set')
    assert.ok(quotaAudit, '额度抄入进审计')
    assert.equal(quotaAudit!.username, 'boss')
    // 审查 P3 钉子：抄入数据损坏时如实说损坏，不按 0/0 出数冒充正常
    db.prepare("UPDATE app_meta SET value = '{broken' WHERE key = 'finance.invoice_quota'").run()
    const corrupted = (await (await get('/api/finance/invoices/quota')).json()) as { configured: boolean; note: string }
    assert.equal(corrupted.configured, false, '坏数据不冒充已配置')
    assert.match(corrupted.note, /损坏/)
  })
})

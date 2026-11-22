/** 飞书 OAuth 登录全链路：POST /api/auth/feishu（假飞书接口注入）→ 绑定表映射 → 系统会话。 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NestFactory } from '@nestjs/core'
import type { INestApplication } from '@nestjs/common'

process.env.ADMIN_DATA_DIR = mkdtempSync(join(tmpdir(), 'admin-feishu-sso-test-'))
delete process.env.ADMIN_JWT_SECRET

const { createRuntimeModule, registerAuthMiddleware } = await import('../src/app.module.js')

/** 假飞书开放平台：按 URL 分流。授权码 good-code → user_access_token ut-1 → open_id ou_test_boss。 */
function makeFakeFeishu() {
  const calls: Array<{ url: string; code?: string; redirect_uri?: string }> = []
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input)
    const body = JSON.parse(String(init?.body ?? '{}')) as { code?: string; redirect_uri?: string }
    if (url.includes('/authen/v2/oauth/token')) {
      calls.push({ url: 'token', code: body.code, redirect_uri: body.redirect_uri })
      if (body.code === 'good-code') {
        return new Response(JSON.stringify({ code: 0, access_token: 'ut-1', token_type: 'Bearer', expires_in: 6900 }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: 20003, error: 'invalid_grant', error_description: '授权码无效' }), { status: 400 })
    }
    if (url.includes('/authen/v1/user_info')) {
      calls.push({ url: 'user_info' })
      return new Response(JSON.stringify({ code: 0, data: { open_id: 'ou_test_boss', name: '老板' } }), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  }
  return { calls, fetchFn }
}

const REDIRECT = 'http://192.168.43.13:5666/feishu-callback'

describe('飞书 OAuth 登录（绑定表映射）', () => {
  let app: INestApplication
  let base: string
  let db: ReturnType<typeof import('../src/db/database.js')['openDatabase']>
  let fake: ReturnType<typeof makeFakeFeishu>

  before(async () => {
    const { dynamicModule, services } = createRuntimeModule()
    db = services.db
    fake = makeFakeFeishu()
    services.auth.fetchFn = fake.fetchFn
    app = await NestFactory.create(dynamicModule, { logger: false })
    registerAuthMiddleware(app, services.auth)
    await app.listen(0, '127.0.0.1')
    const address = app.getHttpServer().address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    base = `http://127.0.0.1:${port}`
    // 绑定表（bridge_identities，融合层白名单）里给 boss 绑一个飞书身份；另一条 allowed=0 用来测停用
    db.prepare(
      "INSERT INTO bridge_identities (platform, platform_userid, username, display_name, allowed, created_at, updated_at) VALUES ('feishu','ou_test_boss','boss','老板',1,'2026-10-29T00:00:00.000Z','2026-10-29T00:00:00.000Z')",
    ).run()
    db.prepare(
      "INSERT INTO bridge_identities (platform, platform_userid, username, display_name, allowed, created_at, updated_at) VALUES ('feishu','ou_disabled','boss','老板',0,'2026-10-29T00:00:00.000Z','2026-10-29T00:00:00.000Z')",
    ).run()
  })

  after(async () => {
    await app.close()
    rmSync(process.env.ADMIN_DATA_DIR!, { recursive: true, force: true })
  })

  test('已绑定的飞书身份 → 系统会话，token 可用；换 token 带原样 redirect_uri', async () => {
    const res = await fetch(`${base}/api/auth/feishu`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'good-code', redirectUri: REDIRECT }),
    })
    assert.equal(res.status, 201)
    const body = (await res.json()) as { token: string; user: { username: string; permissions: string[] } }
    assert.equal(body.user.username, 'boss')
    assert.ok(body.user.permissions.length > 0)
    assert.deepEqual(fake.calls[0], { url: 'token', code: 'good-code', redirect_uri: REDIRECT })
    assert.deepEqual(fake.calls[1], { url: 'user_info' })
    const me = await fetch(`${base}/api/auth/me`, { headers: { authorization: `Bearer ${body.token}` } })
    assert.equal(me.status, 200)
  })

  test('未绑定的飞书身份 → 401 + 审计留痕', async () => {
    // 假飞书只会发 ou_test_boss：未绑定场景用「绑定表删掉再登录」构造
    db.prepare("DELETE FROM bridge_identities WHERE platform_userid = 'ou_test_boss'").run()
    const res = await fetch(`${base}/api/auth/feishu`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'good-code', redirectUri: REDIRECT }),
    })
    assert.equal(res.status, 401)
    const msg = (await res.json()) as { message: string }
    assert.ok(msg.message.includes('绑定'), '错误信息应提示绑定')
    const audit = db
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'auth.login' AND ok = 0 AND source = 'feishu-sso'")
      .get() as { n: number }
    assert.ok(audit.n >= 1, '审计表应有 feishu-sso 失败记录')
    // 恢复绑定供后续用例
    db.prepare(
      "INSERT INTO bridge_identities (platform, platform_userid, username, display_name, allowed, created_at, updated_at) VALUES ('feishu','ou_test_boss','boss','老板',1,'2026-10-29T00:00:00.000Z','2026-10-29T00:00:00.000Z')",
    ).run()
  })

  test('绑定条目停用（allowed=0）→ 401，默认拒绝语义', async () => {
    // 假飞书按授权码切 open_id：这里直接改 user_info 需要新假实现——改为删 boss 绑定、插停用绑定，open_id 相同即可
    db.prepare("DELETE FROM bridge_identities WHERE platform_userid = 'ou_test_boss'").run()
    db.prepare(
      "INSERT INTO bridge_identities (platform, platform_userid, username, display_name, allowed, created_at, updated_at) VALUES ('feishu','ou_test_boss','boss','老板',0,'2026-10-29T00:00:00.000Z','2026-10-29T00:00:00.000Z')",
    ).run()
    const res = await fetch(`${base}/api/auth/feishu`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'good-code', redirectUri: REDIRECT }),
    })
    assert.equal(res.status, 401)
    db.prepare("DELETE FROM bridge_identities WHERE platform_userid = 'ou_test_boss'").run()
    db.prepare(
      "INSERT INTO bridge_identities (platform, platform_userid, username, display_name, allowed, created_at, updated_at) VALUES ('feishu','ou_test_boss','boss','老板',1,'2026-10-29T00:00:00.000Z','2026-10-29T00:00:00.000Z')",
    ).run()
  })

  test('授权码无效（飞书侧拒绝）→ 401', async () => {
    const res = await fetch(`${base}/api/auth/feishu`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'bad-code', redirectUri: REDIRECT }),
    })
    assert.equal(res.status, 401)
  })

  test('缺授权码或回调地址 → 400', async () => {
    const res1 = await fetch(`${base}/api/auth/feishu`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '', redirectUri: REDIRECT }),
    })
    assert.equal(res1.status, 400)
    const res2 = await fetch(`${base}/api/auth/feishu`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'good-code', redirectUri: '' }),
    })
    assert.equal(res2.status, 400)
  })

  test('密码登录回归：同一账号密码登录不受影响（issueSession 重构回归）', async () => {
    const { config } = await import('../src/config.js')
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'boss', password: config.bossInitialPassword }),
    })
    assert.equal(res.status, 201)
    const body = (await res.json()) as { token: string }
    assert.ok(body.token.length > 20)
  })
})

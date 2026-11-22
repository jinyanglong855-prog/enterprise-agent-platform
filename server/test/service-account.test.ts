/** 最小权限服务账号（2026-10-28 融合方案 §6 风险1）：
 *  seed 幂等创建 is_service=1 的 "agent" 服务号 + agent-runtime 角色（权限=工具门面最小集，
 *  无 admin:manage）；audit:read 新权限点让服务号能读系统审计（audit_query 唯一非管理消费方）；
 *  /api/audit 接受 admin:manage 或 audit:read，零权限用户仍 403，未登录 401。 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ADMIN_DATA_DIR = mkdtempSync(join(tmpdir(), 'admin-svc-account-test-'))
delete process.env.ADMIN_JWT_SECRET

const { buildServices, createRuntimeModule, registerAuthMiddleware } = await import('../src/app.module.js')
const { config } = await import('../src/config.js')
const { AGENT_SERVICE_USERNAME, AGENT_RUNTIME_PERMISSIONS, PERMISSIONS } = await import('../src/rbac/rbac.service.js')
const jwt = (await import('jsonwebtoken')).default
import type { Services } from '../src/app.module.js'

describe('最小权限服务账号', () => {
  let app: import('@nestjs/common').INestApplication
  let base: string
  let services: Services
  let bossToken: string
  let svcToken: string
  let limitedToken: string

  const get = (path: string, token: string) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } })

  before(async () => {
    services = buildServices()
    const { dynamicModule } = createRuntimeModule(services)
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
    bossToken = ((await res.json()) as { token: string }).token
    // 服务号密码是随机哈希（不可登录）：按网关同款方式直签
    svcToken = jwt.sign({ sub: services.rbac.agentServiceUsername()! }, config.jwtSecret, { expiresIn: '1h' })
    // 造一个零权限真人对出 403
    const bcrypt = (await import('bcryptjs')).default
    services.db.prepare(
      "INSERT INTO users (username, password_hash, display_name, is_service, created_at) VALUES ('nobody', ?, '无权限', 0, ?)",
    ).run(bcrypt.hashSync('nobody-2026-xx', 10), new Date().toISOString())
    const res2 = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'nobody', password: 'nobody-2026-xx' }),
    })
    limitedToken = ((await res2.json()) as { token: string }).token
  })

  after(async () => {
    await app.close()
    rmSync(process.env.ADMIN_DATA_DIR!, { recursive: true, force: true })
  })

  test('seed：agent 服务号存在、is_service=1、未停用，agentServiceUsername 返回它', () => {
    assert.equal(services.rbac.agentServiceUsername(), AGENT_SERVICE_USERNAME)
    const user = services.rbac.findUser(AGENT_SERVICE_USERNAME)!
    assert.equal(user.is_service, 1)
    assert.equal(user.disabled_at, null)
    // 密码哈希是随机量：任何文档/常量里都不存在它的明文
    assert.ok(user.password_hash.startsWith('$2'))
  })

  test('权限：服务号=工具门面最小集（含 audit:read，无 admin:manage）；boss 全量含新权限点', () => {
    const svcPerms = services.rbac.permissionsOf(AGENT_SERVICE_USERNAME)
    assert.deepEqual([...svcPerms].sort(), [...AGENT_RUNTIME_PERMISSIONS].sort())
    assert.equal(svcPerms.has('admin:manage'), false)
    for (const p of AGENT_RUNTIME_PERMISSIONS) {
      assert.ok(PERMISSIONS.includes(p), `角色权限点 ${p} 必须在权限字典里`)
    }
    const bossPerms = services.rbac.permissionsOf('boss')
    assert.equal(bossPerms.has('audit:read'), true)
    assert.equal(bossPerms.has('admin:manage'), true)
  })

  test('/api/audit：未登录 401 → 零权限 403 → 服务号 200（audit:read）→ boss 200（admin:manage）', async () => {
    assert.equal((await fetch(`${base}/api/audit`)).status, 401)
    assert.equal((await get('/api/audit', limitedToken)).status, 403)
    const svcRes = await get('/api/audit', svcToken)
    assert.equal(svcRes.status, 200)
    const svcBody = (await svcRes.json()) as { items: unknown[] }
    assert.ok(Array.isArray(svcBody.items))
    assert.equal((await get('/api/audit', bossToken)).status, 200)
  })
})

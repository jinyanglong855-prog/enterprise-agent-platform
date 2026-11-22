/** 拼装台面 P1 全链路（2026-10-30 执行计划）：角色 CRUD + 用户绑定 REST + 四条护栏
 *  （技术角色保护/同名 400/最后管理员守卫/自己改自己拒绝）+ 权限实时生效 + 审计留痕。
 *  走真 REST（Nest 动态模块），护栏场景里直接动 DB 造"存量库"前提（守卫本身才是被测对象）。 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import bcrypt from 'bcryptjs'

process.env.ADMIN_DATA_DIR = mkdtempSync(join(tmpdir(), 'admin-rbac-test-'))
delete process.env.ADMIN_JWT_SECRET
delete process.env.ADMIN_BRIDGE_ENABLED

const appModule = await import('../src/app.module.js')
const { buildServices, createRuntimeModule, registerAuthMiddleware } = appModule
const { config } = await import('../src/config.js')
import type { Services } from '../src/app.module.js'

describe('拼装台面 P1（角色拼装 + 用户绑定）', () => {
  let app: import('@nestjs/common').INestApplication
  let base: string
  let token: string
  let db: import('better-sqlite3').Database
  let services: Services

  const get = (path: string, withToken = token) =>
    fetch(`${base}${path}`, { headers: { authorization: `Bearer ${withToken}` } })
  const send = (method: string, path: string, body?: unknown, withToken = token) =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${withToken}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const login = async (username: string, password: string): Promise<string> => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    assert.ok(res.status === 200 || res.status === 201, `登录 ${username} 应成功`)
    return ((await res.json()) as { token: string }).token
  }
  const auditCount = (action: string): number =>
    (db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?').get(action) as { n: number }).n

  before(async () => {
    services = buildServices()
    db = services.db
    const { dynamicModule } = createRuntimeModule(services)
    app = await (await import('@nestjs/core')).NestFactory.create(dynamicModule, { logger: false })
    registerAuthMiddleware(app, services.auth)
    await app.listen(0, '127.0.0.1')
    const address = app.getHttpServer().address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    base = `http://127.0.0.1:${port}`
    token = await login('boss', config.bossInitialPassword)
    // 测试用户直接入库（系统没有"建用户"REST——账号只走审批进场）
    db.prepare(
      'INSERT INTO users (username, password_hash, display_name, is_service, created_at) VALUES (?, ?, ?, 0, ?)',
    ).run('ops1', bcrypt.hashSync('Ops-Pass-1', 10), '运营一号', new Date().toISOString())
    db.prepare(
      'INSERT INTO users (username, password_hash, display_name, is_service, created_at) VALUES (?, ?, ?, 0, ?)',
    ).run('ops2', bcrypt.hashSync('Ops-Pass-2', 10), '运营二号', new Date().toISOString())
  })

  after(async () => {
    await app.close()
    rmSync(process.env.ADMIN_DATA_DIR!, { recursive: true, force: true })
  })

  test('清单只读：权限目录=常量 PERMISSIONS（2026-11-01 生产域 supply:read/write 与工资域 payroll:read/write 同日加入；2026-11-02 知识库 knowledge:read 加入，14 项）；技术角色带 technical 标记', async () => {
    assert.equal((await fetch(`${base}/api/rbac/roles`)).status, 401, '未登录拒绝')
    const perms = (await (await get('/api/rbac/permissions')).json()) as { permissions: string[] }
    // 与常量全等对比而非手抄清单：两线并行各自加权限点时不再互相踩这行钉子（常量本身过 review）
    const { PERMISSIONS } = await import('../src/rbac/rbac.service.js')
    assert.deepEqual(perms.permissions.sort(), [...PERMISSIONS].sort())
    assert.equal(PERMISSIONS.length, 14, '两线各加两点 + 知识库 knowledge:read 后为 14 项——再加权限点请同步改这里与 README')
    assert.ok(perms.permissions.includes('supply:read') && perms.permissions.includes('supply:write'), '生产供应链域独立权限点在场')
    assert.ok(perms.permissions.includes('payroll:read') && perms.permissions.includes('payroll:write'), '工资域独立权限点在场')
    assert.ok(perms.permissions.includes('knowledge:read'), '知识库权限点在场')
    const { roles } = (await (await get('/api/rbac/roles')).json()) as {
      roles: { name: string; permissions: string[]; technical: boolean; users: number }[]
    }
    const byName = new Map(roles.map((r) => [r.name, r]))
    assert.equal(byName.get('boss')!.technical, true)
    assert.equal(byName.get('agent-runtime')!.technical, true)
    assert.equal(byName.get('employee'), undefined, 'P2 迁出：全新库 seed 只建技术角色，employee 由样例脚本补')
    assert.ok(byName.get('boss')!.permissions.includes('admin:manage'))
  })

  test('建角色 happy path：勾权限点 → 列表可见 → 审计留痕', async () => {
    const created = await send('POST', '/api/rbac/roles', { name: '会计', permissions: ['finance:read', 'finance:write'] })
    assert.equal(created.status, 201)
    const { roles } = (await (await get('/api/rbac/roles')).json()) as {
      roles: { name: string; permissions: string[]; users: number }[]
    }
    const role = roles.find((r) => r.name === '会计')!
    assert.deepEqual(role.permissions.sort(), ['finance:read', 'finance:write'])
    assert.equal(role.users, 0)
    assert.ok(auditCount('rbac.role.created') >= 1)
  })

  test('建角色护栏：同名 400 / 撞技术角色名 400 / 未知权限点 400 / 空名 400', async () => {
    assert.equal((await send('POST', '/api/rbac/roles', { name: '会计', permissions: [] })).status, 400, '重名')
    assert.equal((await send('POST', '/api/rbac/roles', { name: 'boss', permissions: [] })).status, 400, '撞技术角色')
    assert.equal((await send('POST', '/api/rbac/roles', { name: 'agent-runtime', permissions: [] })).status, 400, '撞技术角色')
    assert.equal((await send('POST', '/api/rbac/roles', { name: '坏权限', permissions: ['nope:all'] })).status, 400)
    assert.equal((await send('POST', '/api/rbac/roles', { name: '   ', permissions: [] })).status, 400)
    assert.equal((await send('POST', '/api/rbac/roles', { name: 123, permissions: [] })).status, 400)
  })

  test('技术角色保护：改权限/删除都 403；不存在的角色 404', async () => {
    assert.equal((await send('PUT', '/api/rbac/roles/boss/permissions', { permissions: ['finance:read'] })).status, 403)
    assert.equal((await send('PUT', '/api/rbac/roles/agent-runtime/permissions', { permissions: [] })).status, 403)
    assert.equal((await send('DELETE', '/api/rbac/roles/boss')).status, 403)
    assert.equal((await send('DELETE', '/api/rbac/roles/agent-runtime')).status, 403)
    assert.equal((await send('PUT', '/api/rbac/roles/不存在/permissions', { permissions: [] })).status, 404)
    assert.equal((await send('DELETE', '/api/rbac/roles/不存在')).status, 404)
  })

  test('自己改自己的权限：绑定/解绑/改自己持有的角色全 403', async () => {
    assert.equal((await send('POST', '/api/rbac/users/boss/roles', { role: '会计' })).status, 403, '自己给自己绑角色')
    assert.equal((await send('DELETE', '/api/rbac/users/boss/roles/boss')).status, 403, '自己摘自己的角色')
    // "改自己持有的角色"：直接入库让 boss 持有一个拼装角色，再试改它
    db.prepare('INSERT INTO roles (name) VALUES (?)').run('自持角色')
    db.prepare(
      'INSERT INTO user_roles (user_id, role_id) VALUES ((SELECT id FROM users WHERE username=?), (SELECT id FROM roles WHERE name=?))',
    ).run('boss', '自持角色')
    db.prepare("INSERT INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE name='自持角色'), (SELECT id FROM permissions WHERE code='finance:read'))").run()
    assert.equal(
      (await send('PUT', '/api/rbac/roles/自持角色/permissions', { permissions: ['admin:manage'] })).status,
      403,
      '改自己持有的角色=给自己提权，拒绝',
    )
    assert.equal((await send('DELETE', '/api/rbac/roles/自持角色')).status, 403, '删自己持有的角色同理')
    // 清理：还原 DB（该测试的安排不该影响后面的最后管理员场景）
    db.prepare("DELETE FROM user_roles WHERE user_id=(SELECT id FROM users WHERE username='boss') AND role_id=(SELECT id FROM roles WHERE name='自持角色')").run()
  })

  test('绑定/解绑 + 权限实时生效：绑上即通、摘掉即断、改角色权限同样即时', async () => {
    await send('POST', '/api/rbac/roles', { name: '审计员', permissions: ['audit:read'] })
    const ops1Token = await login('ops1', 'Ops-Pass-1')
    assert.equal((await get('/api/audit', ops1Token)).status, 403, '绑前无权限')

    const assigned = await send('POST', '/api/rbac/users/ops1/roles', { role: '审计员' })
    assert.equal(assigned.status, 201)
    assert.ok((await get('/api/audit', ops1Token)).status === 200, '绑上即生效')
    assert.ok(auditCount('rbac.user.role.assigned') >= 1)

    // 重复绑定幂等：alreadyBound 标记，不重复审计
    const before = auditCount('rbac.user.role.assigned')
    const again = (await (await send('POST', '/api/rbac/users/ops1/roles', { role: '审计员' })).json()) as { alreadyBound: boolean }
    assert.equal(again.alreadyBound, true)
    assert.equal(auditCount('rbac.user.role.assigned'), before)

    // 改角色权限即时生效：摘掉 audit:read 后同一令牌立即 403
    const updated = await send('PUT', '/api/rbac/roles/审计员/permissions', { permissions: [] })
    assert.equal(updated.status, 200)
    assert.equal((await get('/api/audit', ops1Token)).status, 403, '改角色权限即时生效')
    assert.ok(auditCount('rbac.role.permissions.updated') >= 1)
    // 恢复权限再验证解绑路径
    await send('PUT', '/api/rbac/roles/审计员/permissions', { permissions: ['audit:read'] })
    assert.ok((await get('/api/audit', ops1Token)).status === 200)
    const removed = await send('DELETE', '/api/rbac/users/ops1/roles/审计员')
    assert.equal(removed.status, 200)
    assert.equal((await get('/api/audit', ops1Token)).status, 403, '摘掉即断')
    assert.ok(auditCount('rbac.user.role.removed') >= 1)
  })

  test('绑定护栏：404（用户/角色不存在）、400（未绑定就摘）、删除角色连带解绑', async () => {
    assert.equal((await send('POST', '/api/rbac/users/没有人/roles', { role: '会计' })).status, 404)
    assert.equal((await send('POST', '/api/rbac/users/ops1/roles', { role: '没有这角色' })).status, 404)
    assert.equal((await send('DELETE', '/api/rbac/users/ops1/roles/会计')).status, 400, '未绑定就摘')
    assert.equal((await send('POST', '/api/rbac/users/ops1/roles', {})).status, 400, '缺 role 字段')
    // 删除角色 → 用户的绑定一并消失
    await send('POST', '/api/rbac/users/ops1/roles', { role: '会计' })
    const users1 = (await (await get('/api/rbac/users')).json()) as { users: { username: string; roles: string[] }[] }
    assert.ok(users1.users.find((u) => u.username === 'ops1')!.roles.includes('会计'))
    await send('DELETE', '/api/rbac/roles/会计')
    const users2 = (await (await get('/api/rbac/users')).json()) as { users: { username: string; roles: string[] }[] }
    assert.equal(users2.users.find((u) => u.username === 'ops1')!.roles.includes('会计'), false, '删角色连带解绑')
  })

  test('最后管理员守卫：REST 几何+服务层直调钉守卫（403 含"锁在门外"）+守卫拒绝落审计+多持有人不误伤', async () => {
    await send('POST', '/api/rbac/roles', { name: '管理', permissions: ['admin:manage'] })
    await send('POST', '/api/rbac/users/ops2/roles', { role: '管理' })
    // 安排"存量库"：boss 丢掉唯一 admin:manage 绑定，ops2 成为唯一持有人（经拼装角色「管理」）
    db.prepare("DELETE FROM user_roles WHERE user_id=(SELECT id FROM users WHERE username='boss') AND role_id=(SELECT id FROM roles WHERE name='boss')").run()
    // REST 几何（P1 审查 P1-1 的彻底版）：调用者必须持 admin:manage 才能过权限门——
    // 若经「管理」本身则自持拒绝先拦；若经别的角色则那条角色改权后仍持有、守卫正确放行。
    // 所以角色级守卫在 REST 不可达，本体在服务层直调钉住（调用方无权限门，如后台任务）。
    const ops2Token = await login('ops2', 'Ops-Pass-2')
    const strip = await send('PUT', '/api/rbac/roles/管理/permissions', { permissions: [] }, ops2Token)
    assert.equal(strip.status, 403)
    assert.match(await strip.text(), /自己持有的角色/, 'REST 持有者改权被自持守卫拦')
    await assert.rejects(
      async () => services.rbac.updateRolePermissions({ username: 'system-task', source: 'test' }, '管理', []),
      /锁在门外/,
      '改权守卫：摘掉唯一来源的 admin:manage',
    )
    await assert.rejects(
      async () => services.rbac.deleteRole({ username: 'system-task', source: 'test' }, '管理'),
      /锁在门外/,
      '删角色守卫',
    )
    await assert.rejects(
      async () => services.rbac.removeUserRole({ username: 'system-task', source: 'test' }, 'ops2', '管理'),
      /锁在门外/,
      '解绑守卫：摘唯一持有人',
    )
    assert.ok(auditCount('rbac.guard.rejected') >= 3, '守卫拒绝统一落审计')

    // 多持有人不误伤（绑定级判据）：同角色两个持有人解绑其中一名必须放行
    db.prepare("INSERT INTO user_roles (user_id, role_id) VALUES ((SELECT id FROM users WHERE username='boss'), (SELECT id FROM roles WHERE name='boss'))").run()
    await send('POST', '/api/rbac/users/ops1/roles', { role: '管理' })
    assert.equal((await send('DELETE', '/api/rbac/users/ops2/roles/管理')).status, 200, '同角色多持有人解绑放行（只排除那一条绑定）')
    assert.equal((await send('DELETE', '/api/rbac/users/ops1/roles/管理')).status, 200)
    assert.equal((await send('DELETE', '/api/rbac/roles/管理')).status, 200)
  })

  test('护栏补充（P1 审查采纳）：被映射引用的角色不可删；技术角色不可经界面绑定/解绑', async () => {
    // 删除被部门映射引用的角色 → 400（否则悬挂映射让后续开通静默少配权限）
    await send('POST', '/api/rbac/roles', { name: '被引用角色', permissions: ['finance:read'] })
    db.prepare(
      "INSERT INTO feishu_org_rules (department_id, department_name, role, scope, created_at) VALUES ('od-ref', '引用部', '被引用角色', '*', '2026-10-30T00:00:00.000Z')",
    ).run()
    assert.equal((await send('DELETE', '/api/rbac/roles/被引用角色')).status, 400)
    db.prepare("DELETE FROM feishu_org_rules WHERE role = '被引用角色'").run()
    assert.equal((await send('DELETE', '/api/rbac/roles/被引用角色')).status, 200, '解除引用后可删')
    // 技术角色不可经界面绑定/解绑（与改权/删除同一口径；防 bossUsername/网关直签候选扩散、防服务号失能）
    assert.equal((await send('POST', '/api/rbac/users/ops1/roles', { role: 'boss' })).status, 403)
    assert.equal((await send('DELETE', '/api/rbac/users/agent/roles/agent-runtime')).status, 403)
  })

  test('删角色 happy path：删后角色消失、审计留痕', async () => {
    await send('POST', '/api/rbac/roles', { name: '临时角色', permissions: ['finance:read'] })
    const before = auditCount('rbac.role.deleted')
    assert.equal((await send('DELETE', '/api/rbac/roles/临时角色')).status, 200)
    const { roles } = (await (await get('/api/rbac/roles')).json()) as { roles: { name: string }[] }
    assert.equal(roles.find((r) => r.name === '临时角色'), undefined)
    assert.ok(auditCount('rbac.role.deleted') >= before + 1)
  })
})

/** 融合层 P1 数据通道（2026-11-01）：只读平台数据 REST 面全链路。
 *  假 fetch 按真机探针（2026-11-01）核订的契约形状写——不按实现抄（契约坑 15 教训：
 *  data.user 包装/od- ID 形状/99991663、1390002、99992357 语义都是真机实证，假件与实现
 *  同错相抵时测试恒绿是假阳性）。覆盖：RBAC（401/403/服务号恰有 platform:read）、
 *  部门树分页、成员接口 od- 形状与错误翻译、定义列表缺 scope 如实降级登记册、
 *  实例列表 10h 红线分段+分页+截断上限、实例详情表单拍平、登记册 CRUD、全 GET 只读。 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ADMIN_DATA_DIR = mkdtempSync(join(tmpdir(), 'admin-platform-test-'))
delete process.env.ADMIN_JWT_SECRET

const appModule = await import('../src/app.module.js')
const { buildServices, createRuntimeModule, registerAuthMiddleware } = appModule
const { config } = await import('../src/config.js')
const JWT = (await import('jsonwebtoken')).default
import type { Services } from '../src/app.module.js'

/** 假飞书：记录全部请求；按路径+行为开关应答（行为开关驱动各用例）。 */
const calls: Array<{ method: string; url: string }> = []
const fake = {
  /** definitions 接口行为：'noscope'（默认，真机现状 99991663）| 'ok' | 'trunc'（翻页上限耗尽仍 has_more）。 */
  definitionsMode: 'noscope' as 'noscope' | 'ok' | 'trunc',
}
let pagesServed = 0

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const fakeFetch: typeof fetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
  const url = String(input)
  const method = init?.method ?? 'GET'
  calls.push({ method, url })
  const rawPath = url.includes('/open-apis') ? url.slice(url.indexOf('/open-apis') + '/open-apis'.length) : url
  const qAt = rawPath.indexOf('?')
  const path = qAt === -1 ? rawPath : rawPath.slice(0, qAt)
  const u = new URL(url)
  if (path === '/auth/v3/tenant_access_token/internal') {
    return jsonRes({ code: 0, msg: 'ok', tenant_access_token: 't-1', expire: 7200 })
  }
  if (path === '/contact/v3/departments/0/children') {
    if (u.searchParams.get('page_token') === 'p2') {
      return jsonRes({ code: 0, data: { items: [{ department_id: 'd2', open_department_id: 'od-d2', name: '财务部', member_count: 0, parent_department_id: '0' }], has_more: false } })
    }
    return jsonRes({
      code: 0,
      data: {
        items: [
          { department_id: 'd1', open_department_id: 'od-d1', name: '技术部', member_count: 1, parent_department_id: '0' },
          { department_id: 'd3', open_department_id: 'od-d3', name: '市场部', member_count: 2, parent_department_id: '0' },
        ],
        has_more: true,
        page_token: 'p2',
      },
    })
  }
  if (path === '/contact/v3/users/find_by_department') {
    if (u.searchParams.get('department_id') === 'od-err') {
      return jsonRes({ code: 99992357, msg: 'not a valid {open_department_id}' })
    }
    return jsonRes({
      code: 0,
      data: {
        items: [{ name: '王小明', open_id: 'ou-1', department_ids: ['0', 'od-d1'], employee_no: null }],
        has_more: false,
      },
    })
  }
  if (path === '/approval/v4/approvals') {
    if (fake.definitionsMode === 'trunc') {
      // 两页（上限）都还有下一页：服务必须亮 truncated 而不是静默当全量
      return jsonRes({ code: 0, data: { approval_list: [{ approval_code: 'C-t', approval_name: '截断样例' }], has_more: true } })
    }
    if (fake.definitionsMode === 'ok') {
      return jsonRes({
        code: 0,
        data: {
          approval_list: [
            { approval_code: 'C-live-1', approval_name: '报销审批' },
            { approval_code: 'C-live-2', approval_name: '请假' },
          ],
          has_more: false,
        },
      })
    }
    return jsonRes({ code: 99991663, msg: 'Invalid access token for authorization.' })
  }
  if (path === '/approval/v4/instances' && u.searchParams.get('approval_code') !== null) {
    const code = u.searchParams.get('approval_code') ?? ''
    if (code === 'C-unknown') return jsonRes({ code: 1390002, msg: 'approval code not found' })
    if (code === 'C-pages') {
      if (u.searchParams.get('page_token') === 'pt2') {
        return jsonRes({ code: 0, data: { instance_code_list: ['INST-p3'], has_more: false } })
      }
      // 数据只在第一个时间分段喂（24h 默认窗=3 段，段与段是不同窗口不是重复页）
      pagesServed += 1
      if (pagesServed === 1) {
        return jsonRes({ code: 0, data: { instance_code_list: ['INST-p1', 'INST-p2'], has_more: true, page_token: 'pt2' } })
      }
      return jsonRes({ code: 0, data: { instance_code_list: [], has_more: false } })
    }
    if (code === 'C-cap') {
      return jsonRes({ code: 0, data: { instance_code_list: Array.from({ length: 60 }, (_, i) => `INST-${i}`), has_more: false } })
    }
    if (code === 'C-dup') {
      return jsonRes({ code: 0, data: { instance_code_list: ['INST-same'], has_more: false } })
    }
    if (code === 'C-seg') {
      // 分段：每段回 1 个带段序号的码，数调用次数用
      const start = Number(u.searchParams.get('start_time'))
      return jsonRes({ code: 0, data: { instance_code_list: [`SEG-${start}`], has_more: false } })
    }
    return jsonRes({ code: 0, data: { instance_code_list: ['INST-x'], has_more: false } })
  }
  if (path.startsWith('/approval/v4/instances/')) {
    const instCode = path.slice('/approval/v4/instances/'.length)
    if (instCode === 'INST-null') return jsonRes({ code: 0, data: null })
    if (instCode === 'INST-badtime') {
      return jsonRes({ code: 0, data: { status: 'APPROVED', start_time: 'not-a-number', form: '[]' } })
    }
    return jsonRes({
      code: 0,
      data: {
        status: 'APPROVED',
        approval_code: 'C-live-1',
        open_id: 'ou-boss',
        start_time: '1730000000',
        form: JSON.stringify([
          { id: 'widget1', custom_id: 'amount', value: 150 },
          { id: 'widget2', value: { text: '打印纸' } },
          { id: 'widget3', custom_id: 'empty', value: null },
        ]),
      },
    })
  }
  throw new Error(`假飞书没实现该路径：${method} ${path}`)
}

describe('融合层 P1 数据通道（只读平台数据面）', () => {
  let app: import('@nestjs/common').INestApplication
  let base: string
  let bossToken: string
  let limitedToken: string
  let agentToken: string
  let db: import('better-sqlite3').Database
  let services: Services

  const get = (path: string, token: string, source?: string) =>
    fetch(`${base}${path}`, {
      headers: { authorization: `Bearer ${token}`, ...(source !== undefined ? { 'x-actor-source': source } : {}) },
    })
  const send = (method: string, path: string, body?: unknown, token = bossToken) =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

  before(async () => {
    const real = buildServices()
    db = real.db
    services = real
    real.platformData.setFetchFn(fakeFetch)
    // 无 platform:read 的普通用户：agent:read 岗位角色（403 反例）
    real.rbac.createRole({ username: 'boss', source: 'ui' }, '只读对话岗', ['agent:read'])
    db.prepare(
      'INSERT INTO users (username, password_hash, display_name, is_service, created_at) VALUES (?, ?, ?, 0, ?)',
    ).run('clerk', 'x', '职员', new Date().toISOString())
    real.rbac.assignRole('clerk', '只读对话岗')
    agentToken = JWT.sign({ sub: 'agent' }, config.jwtSecret)
    const { dynamicModule } = createRuntimeModule(real)
    app = await (await import('@nestjs/core')).NestFactory.create(dynamicModule, { logger: false })
    registerAuthMiddleware(app, real.auth)
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
    const res2 = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'clerk', password: 'x' }),
    })
    assert.equal(res2.status, 401, '假哈希用户登录必须失败——limited 令牌直接用服务层签（走 verifyBearer 同一条路）')
    limitedToken = JWT.sign({ sub: 'clerk' }, config.jwtSecret)
  })

  after(async () => {
    await app.close()
    rmSync(process.env.ADMIN_DATA_DIR!, { recursive: true, force: true })
  })

  test('RBAC：未登录 401 → 无 platform:read 的用户 403 → boss 与 agent 服务号 200', async () => {
    assert.equal((await fetch(`${base}/api/platform/contacts/departments`)).status, 401)
    const forbid = await get('/api/platform/contacts/departments', limitedToken)
    assert.equal(forbid.status, 403)
    const boss = await get('/api/platform/contacts/departments', bossToken)
    assert.equal(boss.status, 200)
    const agent = await get('/api/platform/contacts/departments', agentToken)
    assert.equal(agent.status, 200)
  })

  test('部门树：分页取尽合并（od- 形状对外），审计 source 跟 x-actor-source', async () => {
    const r = (await (await get('/api/platform/contacts/departments', agentToken, 'agent')).json()) as {
      departments: Array<{ open_department_id: string; name: string }>
    }
    assert.deepEqual(r.departments.map((d) => d.open_department_id), ['od-d1', 'od-d3', 'od-d2'])
    assert.equal(r.departments[0]!.name, '技术部')
    const row = db
      .prepare("SELECT source FROM audit_log WHERE action = 'platform.read.departments' ORDER BY id DESC LIMIT 1")
      .get() as { source: string }
    assert.equal(row.source, 'agent')
  })

  test('部门成员：od- 形状可查（真机探针形状）；坏 ID 错误翻译带 od- 提示', async () => {
    const r = (await (await get('/api/platform/contacts/members?department_id=od-d1', agentToken)).json()) as {
      members: Array<{ name: string; open_id: string; department_ids: string[] }>
    }
    assert.equal(r.members[0]!.name, '王小明')
    assert.deepEqual(r.members[0]!.department_ids, ['0', 'od-d1'])
    const bad = await get('/api/platform/contacts/members?department_id=od-err', agentToken)
    assert.equal(bad.status, 400)
    const body = (await bad.json()) as { message: string }
    assert.ok(body.message.includes('99992357'), '保留飞书原码')
    assert.ok(body.message.includes('od-'), '带 od- 形状提示')
  })

  test('审批定义：缺 scope（99991663 真机现状）→ live:false 如实降级；登记册兜底；scope 通了 live 优先', async () => {
    const reg = await send('PUT', '/api/platform/approvals/registry', {
      definitions: [
        { code: 'C-baoxiao', name: '报销审批', note: '老板在审批页复制的 code' },
        { code: 'C-dup', name: '重复条目' },
        { code: 'C-dup', name: '重复条目2' },
      ],
    })
    assert.equal(reg.status, 200)
    const fallback = (await (await get('/api/platform/approvals/definitions', agentToken)).json()) as {
      live: boolean
      reason?: string
      definitions: Array<{ approval_code: string; approval_name: string }>
    }
    assert.equal(fallback.live, false)
    assert.ok((fallback.reason ?? '').includes('99991663'), '原因保留飞书码')
    assert.ok((fallback.reason ?? '').includes('scope'), '原因带权限提示')
    assert.ok(fallback.definitions.some((d) => d.approval_code === 'C-baoxiao'), '登记册兜底可见')
    assert.equal(fallback.definitions.filter((d) => d.approval_code === 'C-dup').length, 1, '登记册按 code 去重')
    fake.definitionsMode = 'ok'
    const live = (await (await get('/api/platform/approvals/definitions', agentToken)).json()) as {
      live: boolean
      definitions: Array<{ approval_code: string }>
    }
    assert.equal(live.live, true)
    assert.ok(live.definitions.some((d) => d.approval_code === 'C-live-1'))
    fake.definitionsMode = 'noscope'
  })

  test('审查修复钉子：列表带 truncated 标志、跨段去重、data:null 转人话 400、失败读取留审计', async () => {
    const d = (await (await get('/api/platform/contacts/departments', agentToken)).json()) as { truncated: boolean }
    assert.equal(d.truncated, false, '正常分页取尽=truncated false')
    const dup = (await (await get('/api/platform/approvals/instances?code=C-dup&hours=24', agentToken)).json()) as {
      instances: string[]
    }
    assert.deepEqual(dup.instances, ['INST-same'], '边界毫秒跨段重复实例按 code 去重')
    const nullResp = await get('/api/platform/approvals/instances/INST-null', agentToken)
    assert.equal(nullResp.status, 400, 'data:null 转 400 人话，不 500')
    assert.ok(((await nullResp.json()) as { message: string }).message.includes('实例详情为空'))
    const badTime = (await (await get('/api/platform/approvals/instances/INST-badtime', agentToken)).json()) as { start_time?: string }
    assert.equal(badTime.start_time, undefined, 'start_time 非数字不炸 RangeError，落 undefined')
    await get('/api/platform/contacts/members?department_id=od-err', agentToken)
    const failRow = db
      .prepare("SELECT ok FROM audit_log WHERE action = 'platform.read.members' ORDER BY id DESC LIMIT 1")
      .get() as { ok: number }
    assert.equal(failRow.ok, 0, '失败读取也进审计（方案 §6 留痕）')
  })

  test('审查 P1-1：定义列表翻页上限耗尽仍 has_more → 亮 truncated 不谎报全量', async () => {
    fake.definitionsMode = 'trunc'
    const r = (await (await get('/api/platform/approvals/definitions', agentToken)).json()) as {
      live: boolean
      truncated?: boolean
      definitions: unknown[]
    }
    assert.equal(r.live, true)
    assert.equal(r.truncated, true)
    fake.definitionsMode = 'noscope'
  })

  test('实例列表：48h 自动按 10h 红线分段（5 段）、分页取尽、50 条截断如实标注、1390002 翻译', async () => {
    const before = calls.filter((c) => c.url.includes('/approval/v4/instances?')).length
    const r = (await (await get('/api/platform/approvals/instances?code=C-seg&hours=48', agentToken)).json()) as {
      instances: string[]
      truncated: boolean
    }
    const after = calls.filter((c) => c.url.includes('/approval/v4/instances?')).length
    assert.equal(after - before, 5, '48h/10h 红线=5 段')
    assert.equal(r.instances.length, 5)
    assert.equal(r.truncated, false)
    const paged = (await (await get('/api/platform/approvals/instances?code=C-pages', agentToken)).json()) as {
      instances: string[]
    }
    assert.deepEqual(paged.instances, ['INST-p1', 'INST-p2', 'INST-p3'])
    const capped = (await (await get('/api/platform/approvals/instances?code=C-cap', agentToken)).json()) as {
      instances: string[]
      truncated: boolean
    }
    assert.equal(capped.instances.length, 50)
    assert.equal(capped.truncated, true)
    const unknown = await get('/api/platform/approvals/instances?code=C-unknown', agentToken)
    assert.equal(unknown.status, 400)
    assert.ok(((await unknown.json()) as { message: string }).message.includes('1390002'))
    const badHours = await get('/api/platform/approvals/instances?code=C-seg&hours=999', agentToken)
    assert.equal(badHours.status, 400)
  })

  test('实例详情：表单拍平（custom_id 优先、对象取 text、空值保留字段）、状态/时间口径', async () => {
    const r = (await (await get('/api/platform/approvals/instances/INST-1', agentToken)).json()) as {
      status: string
      approval_code?: string
      start_time?: string
      form: Array<{ field: string; value: string }>
    }
    assert.equal(r.status, 'APPROVED')
    assert.equal(r.approval_code, 'C-live-1')
    assert.equal(r.start_time, new Date(1730000000 * 1000).toISOString())
    assert.deepEqual(r.form, [
      { field: 'amount', value: '150' },
      { field: 'widget2', value: '打印纸' },
      { field: 'empty', value: '' },
    ])
  })

  test('登记册：无权限 403、坏条目 400、GET 返回、管理动作进审计', async () => {
    const forbid = await send('PUT', '/api/platform/approvals/registry', { definitions: [] }, limitedToken)
    assert.equal(forbid.status, 403)
    const bad = await send('PUT', '/api/platform/approvals/registry', { definitions: [{ code: '', name: 'x' }] })
    assert.equal(bad.status, 400)
    const bad2 = await send('PUT', '/api/platform/approvals/registry', { definitions: 'nope' })
    assert.equal(bad2.status, 400)
    const got = (await (await send('GET', '/api/platform/approvals/registry')).json()) as {
      definitions: Array<{ code: string }>
    }
    assert.ok(got.definitions.some((d) => d.code === 'C-baoxiao'))
    const logs = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'platform.registry.set'").get() as { n: number }
    assert.ok(logs.n >= 1)
  })

  test('只读铁律：除取 token 外对平台零 POST（全 GET）', async () => {
    const posts = calls.filter((c) => c.method === 'POST' && !c.url.includes('tenant_access_token'))
    assert.deepEqual(posts, [])
  })
})

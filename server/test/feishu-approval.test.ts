/** 飞书 OA 审批进场全链路（2026-10-29 用户拍板第一期；2026-10-31 方案 B 调整）：审批事件 →
 *  查实例 → 建新账号+绑飞书+私聊初始密码（**开通一律零权限**，角色由管理员在「系统权限」页
 *  手动配置）；权限变更通道已关闭（批了的单礼貌拒绝，applyPermChange 机制测试钉住可恢复）；
 *  幂等/拒绝/重名各分支；org-rules 映射与调岗重算（休眠但机制保留）；断线补抓各分支；
 *  审批事件双层订阅（契约坑 20）。飞书 HTTP 全部走假 fetch（token/定义/订阅/实例/通讯录），
 *  事件直调 handleEvent（长连接之外的环节不模拟）。 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ADMIN_DATA_DIR = mkdtempSync(join(tmpdir(), 'admin-feishu-approval-test-'))
delete process.env.ADMIN_JWT_SECRET
process.env.ADMIN_BRIDGE_ENABLED = '1'
process.env.ADMIN_BRIDGE_ADAPTER = 'mock'

const appModule = await import('../src/app.module.js')
const { buildServices, createRuntimeModule, registerAuthMiddleware } = appModule
const { config } = await import('../src/config.js')
const { BridgeService } = await import('../src/bridge/bridge.service.js')
const { FeishuApprovalService } = await import('../src/bridge/feishu-approval.service.js')
const { MockAdapter } = await import('../src/bridge/mock.adapter.js')
// P2 迁出（2026-10-30）：底层 seed 不再建 employee——样例库行为由样例初始化脚本补齐（本测试=样例库）
const { seedSampleRoles } = await import('../scripts/sample/seed-sample.js')
import type { BridgeTurnRunner } from '../src/bridge/bridge.types.js'
import type { Services } from '../src/app.module.js'
import type { MockAdapter as MockAdapterType } from '../src/bridge/mock.adapter.js'

const BOSS_OPEN_ID = 'ou_boss'
const APPROVAL_CODE = 'APPROVAL-TEST-1'
/** 权限变更定义（P3）的假 approval_code。 */
const PERM_APPROVAL_CODE = 'PERM-TEST-1'

describe('飞书 OA 审批进场（mock 适配器 + 假飞书 HTTP）', () => {
  let app: import('@nestjs/common').INestApplication
  let base: string
  let db: import('better-sqlite3').Database
  let services: Services
  let mock: InstanceType<typeof MockAdapterType>
  let approval: InstanceType<typeof FeishuApprovalService>
  /** 假飞书收到的调用（路径剥去域名前缀），断言"确实建过定义/查过实例"与幂等 */
  let calls: { body?: string; method: string; path: string }[]
  /** /approval/v4/instances/:code 的假详情（各用例改） */
  let instanceDetail: Record<string, unknown>
  /** 部门树假分页（各用例改；sync 逐页 shift，取尽后按空页兜底） */
  let childrenPages: Array<{ items: unknown[]; has_more: boolean; page_token?: string }>
  /** 置 true 时部门树接口返回权限错误（同步失败路径用） */
  let childrenFail: boolean
  /** 实例列表假返回（补抓用例改；对任何窗口请求原样返回这批 code） */
  let instanceLists: string[]
  /** P4 重算用例：ou_recalc/ou_guard 两个账号的当前部门（改它=模拟调岗） */
  let recalcDepts: string[]
  let guardDepts: string[]
  /** 置 true 时实例列表接口返回服务错误（补抓 checkpoint 不推进路径用） */
  let listFail: boolean
    /** 置 true 时订阅审批事件接口返回服务错误（契约坑 20 失败自愈路径用） */
    let subscribeFail: boolean
    /** 假飞书侧"已在订阅"的定义 code：第二次起订阅返回 1390007（真机契约） */
    const subscribedCodes = new Set<string>()
  /** before() 里建好的假 fetch（补抓用例自建带选项的服务实例时复用） */
  let fakeFetch: typeof fetch
  // 按真机契约（2026-10-30 实证）：query 声明 open_department_id 时返回字段名是 open_department_id
  const dept = (id: string, name: string, parent = '0', memberCount = 1) => ({
    open_department_id: id,
    name,
    parent_department_id: parent,
    member_count: memberCount,
  })
  // 旧字段名（department_id）也兼容：一条钉住
  const deptLegacy = (id: string, name: string) => ({ department_id: id, name })

  const userCount = (username: string) =>
    (db.prepare('SELECT COUNT(*) AS n FROM users WHERE username = ?').get(username) as { n: number }).n
  const auditRows = (action: string) =>
    db.prepare('SELECT ok, detail FROM audit_log WHERE action = ? ORDER BY id').all(action) as { ok: number; detail: string }[]
  /** 某用户某角色绑定的来源标记（P4：mapping=随映射重算 / manual=界面与审批落）。 */
  const sourceOf = (username: string, role: string): string | undefined =>
    (
      db
        .prepare(
          'SELECT ur.source AS s FROM user_roles ur JOIN users u ON u.id = ur.user_id JOIN roles r ON r.id = ur.role_id WHERE u.username = ? AND r.name = ?',
        )
        .get(username, role) as { s: string } | undefined
    )?.s

  before(async () => {
    const real = buildServices()
    db = real.db
    // P2 迁出后样例角色不再进底层 seed：本测试按样例库对待，跑样例初始化补 employee
    seedSampleRoles(db)
    // 审批人/通知对象：boss 在 mock 平台的绑定
    db.prepare(
      "INSERT INTO bridge_identities (platform, platform_userid, username, display_name, allowed, created_at, updated_at) VALUES ('mock', ?, 'boss', '老板', 1, '2026-10-29T00:00:00.000Z', '2026-10-29T00:00:00.000Z')",
    ).run(BOSS_OPEN_ID)
    // 职能型映射：财务部 → employee
    db.prepare(
      "INSERT INTO feishu_org_rules (department_id, department_name, role, scope, created_at) VALUES ('od-finance', '财务部', 'employee', '*', '2026-10-29T00:00:00.000Z')",
    ).run()

    calls = []
    instanceDetail = {}
    childrenFail = false
    instanceLists = []
    listFail = false
    subscribeFail = false
    recalcDepts = []
    guardDepts = []
    childrenPages = [
      {
        items: [dept('od-finance', '财务部', '0', 3), deptLegacy('od-hr', '人事部'), dept('od-hr-x', '坏条目')],
        has_more: true,
        page_token: 'p2',
      },
      { items: [dept('od-tech', '技术部', '0', 5), { name: '缺 ID' }], has_more: false },
    ]
    const fetchFn = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      const path = url.replace('https://open.feishu.cn/open-apis', '')
      calls.push({ body: typeof init?.body === 'string' ? init.body : undefined, method: init?.method ?? 'GET', path })
      const json = (extra: Record<string, unknown>) =>
        new Response(JSON.stringify({ code: 0, msg: 'success', ...extra }), { headers: { 'content-type': 'application/json' } })
      if (path === '/auth/v3/tenant_access_token/internal') return json({ tenant_access_token: 't-test', expire: 7200 })
      // 订阅审批事件（契约坑 20 双层订阅的第二层）：真机契约=重复订阅返回 1390007 "subscription
      // existed"（不是幂等 0），假 fetch 照抄；subscribeFail 置真时返回普通服务错误
      const subscribeMatch = path.match(/^\/approval\/v4\/approvals\/([^/]+)\/subscribe$/)
      if (subscribeMatch !== null) {
        const code = decodeURIComponent(subscribeMatch[1] ?? '')
        if (subscribeFail) return json({ code: 99991672, msg: 'subscribe fail' })
        if (subscribedCodes.has(code)) return json({ code: 1390007, msg: 'subscription existed' })
        subscribedCodes.add(code)
        return json({})
      }
      // 换审批人 user_id：path 放 open_id、声明 user_id_type=open_id（与 path 一致），短 ID 在响应里（对抗审查 P1-1）
      if (path.startsWith('/contact/v3/users/ou_new?')) return json({ data: { user: { user_id: 'u_new', department_ids: ['od-finance'] } } })
      if (path.startsWith('/contact/v3/users/ou_new2?')) return json({ data: { user: { user_id: 'u_new2', department_ids: ['od-unknown'] } } })
      if (path.startsWith('/contact/v3/users/ou_child?')) return json({ data: { user: { user_id: 'u_child', department_ids: ['od-child'] } } })
      if (path.startsWith('/contact/v3/users/ou_backfill?')) return json({ data: { user: { user_id: 'u_bf', department_ids: ['od-finance'] } } })
      if (path.startsWith('/contact/v3/users/ou_status?')) return json({ data: { user: { user_id: 'u_st', department_ids: ['od-finance'] } } })
      if (path.startsWith('/contact/v3/users/ou_watch?')) return json({ data: { user: { user_id: 'u_w', department_ids: ['od-finance'] } } })
      if (path.startsWith('/contact/v3/users/ou_form?')) return json({ data: { user: { user_id: 'u_f', department_ids: ['od-finance'] } } })
      // P4 重算用例：部门可变（改数组=调岗）
      if (path.startsWith('/contact/v3/users/ou_recalc?')) return json({ data: { user: { user_id: 'u_rc', department_ids: recalcDepts } } })
      if (path.startsWith('/contact/v3/users/ou_guard?')) return json({ data: { user: { user_id: 'u_gd', department_ids: guardDepts } } })
      if (path === '/approval/v4/approvals') {
        // 双定义（P3）：表单含 target_role 的是权限变更定义，返回独立的 approval_code
        const body = JSON.parse((init?.body as string | undefined) ?? '{}') as { form?: { form_content?: string } }
        const isPerm = (body.form?.form_content ?? '').includes('target_role')
        return json({ data: { approval_code: isPerm ? PERM_APPROVAL_CODE : APPROVAL_CODE, approval_id: isPerm ? '2' : '1' } })
      }
      // 实例列表（补抓）：带 query 的列表请求与带实例码的详情请求按前缀区分
      if (path.startsWith('/approval/v4/instances?')) {
        if (listFail) return json({ code: 1395001, msg: 'There have been some errors. Please try again later' })
        return json({ data: { instance_code_list: instanceLists, has_more: false } })
      }
      if (path.startsWith('/approval/v4/instances/')) return json({ data: instanceDetail })
      if (path.startsWith('/contact/v3/departments/0/children')) {
        if (childrenFail) return json({ code: 40004, msg: 'no dept authority error' })
        const page = childrenPages.shift() ?? { items: [], has_more: false }
        return json({ data: page })
      }
      return new Response(JSON.stringify({ code: 999, msg: `假飞书未实现的路径：${path}` }), { headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    const runner: BridgeTurnRunner = {
      createSession: (username) => real.agent.createSession(username),
      chat: async (sessionId, message, _context, username, onEvent) => {
        onEvent({ event: 'assistant', data: { text: 'stub' } })
        return { finalText: `stub 回答：${message}` }
      },
    }
    fakeFetch = fetchFn
    const bridge = new BridgeService(real.db, real.audit, real.proposals, runner, real.rbac)
    mock = new MockAdapter()
    bridge.registerAdapter(mock)
    // 通知走 bridge → mock.userTexts 可断言；platform='mock' 让 bossOpenId 查 mock 平台绑定
    approval = new FeishuApprovalService(real.db, real.audit, real.rbac, bridge, { fetchFn, platform: 'mock' })
    services = { ...real, bridge, feishuApproval: approval }
    const { dynamicModule } = createRuntimeModule(services)
    app = await (await import('@nestjs/core')).NestFactory.create(dynamicModule, { logger: false })
    registerAuthMiddleware(app, services.auth)
    await app.listen(0, '127.0.0.1')
    const address = app.getHttpServer().address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    base = `http://127.0.0.1:${port}`
    await services.bridge.start()
  })

  after(async () => {
    await services.bridge.shutdown()
    await app.close()
    rmSync(process.env.ADMIN_DATA_DIR!, { recursive: true, force: true })
  })

  const form = (userName: string, displayName: string) =>
    JSON.stringify([
      { id: 'user_name', type: 'input', value: userName },
      { id: 'display_name', type: 'input', value: displayName },
    ])

  test('ensureDefinition：建定义存 approval_code+订阅事件；再跑一次不重建只补订阅（幂等）', async () => {
    assert.equal(approval.approvalCode(), undefined)
    await approval.ensureDefinition()
    assert.equal(approval.approvalCode(), APPROVAL_CODE)
    assert.ok(calls.some((c) => c.method === 'POST' && c.path === '/approval/v4/approvals'), '应调过创建定义')
    // 审批人契约（2026-10-30 真机实证）：user_id 字段直接填 open_id（ou_ 开头），不换短 ID
    const created = JSON.parse(calls.find((c) => c.path === '/approval/v4/approvals')!.body!) as {
      node_list: Array<{ approver?: Array<{ user_id: string }> }>
    }
    assert.equal(created.node_list[1]!.approver![0]!.user_id, 'ou_boss', '审批人要直接填 open_id')
    // 双层订阅（契约坑 20）：定义建成立刻按 code 调 subscribe，否则审批事件永不推送
    assert.ok(
      calls.some((c) => c.method === 'POST' && c.path === `/approval/v4/approvals/${APPROVAL_CODE}/subscribe`),
      '建完定义要订阅该定义的审批事件',
    )
    assert.ok(auditRows('approval.subscribed').some((r) => r.ok === 1 && r.detail.includes('账号开通')))
    const postCount = calls.filter((c) => c.path === '/approval/v4/approvals').length
    calls.length = 0
    await approval.ensureDefinition()
    assert.equal(calls.length, 1, '已有 code 时不重建，但补订阅一次（订阅状态可丢，每次 ensure 自愈）')
    assert.match(calls[0]!.path!, /\/subscribe$/)
    assert.equal(postCount, 1)
  })

  test('审批通过 → 建新账号+绑飞书+零权限+私聊初始密码；老板收配权提醒；重复事件只开通一次', async () => {
    instanceDetail = {
      status: 'APPROVED',
      approval_code: APPROVAL_CODE,
      open_id: 'ou_new',
      form: form('zhangsan', '张三'),
    }
    await approval.handleEvent({ instanceCode: 'INS-1' })
    assert.equal(userCount('zhangsan'), 1, '新账号已建')
    const binding = db
      .prepare("SELECT username, allowed FROM bridge_identities WHERE platform = 'mock' AND platform_userid = 'ou_new'")
      .get() as { username: string; allowed: number }
    assert.equal(binding.username, 'zhangsan')
    assert.equal(binding.allowed, 1)
    const roles = db
      .prepare(
        "SELECT r.name AS name FROM user_roles ur JOIN users u ON u.id = ur.user_id JOIN roles r ON r.id = ur.role_id WHERE u.username = 'zhangsan'",
      )
      .all() as { name: string }[]
    assert.deepEqual(roles.map((r) => r.name), [], '方案B：开通一律零权限（角色等管理员在「系统权限」页配）')
    const notice = mock.userTexts.find((t) => t.openId === 'ou_new')
    assert.ok(notice !== undefined && notice.text.includes('初始密码'), '员工应收到初始密码私聊')
    assert.ok(notice!.text.includes('zhangsan'))
    assert.ok(notice!.text.includes('默认配置'), '开通私聊要说明当前是零权限默认配置')
    assert.ok(
      mock.userTexts.some((t) => t.openId === BOSS_OPEN_ID && t.text.includes('请到管理后台「系统权限」页')),
      '老板每单都收配权提醒（方案B：配角色是管理员必做动作）',
    )
    assert.ok(auditRows('approval.provision').some((r) => r.ok === 1 && r.detail.includes('zhangsan')))
    // 初始密码不落审计
    const provisionDetail = auditRows('approval.provision').at(-1)!.detail
    const pwd = mock.userTexts.find((t) => t.openId === 'ou_new')!.text.match(/初始密码：(\S+)/)![1]!
    assert.ok(!provisionDetail.includes(pwd), '明文密码不得进审计')
    // 幂等：同一实例再来一次事件，不重复建号不重复通知
    mock.userTexts.length = 0
    await approval.handleEvent({ instanceCode: 'INS-1' })
    assert.equal(userCount('zhangsan'), 1)
    assert.equal(mock.userTexts.filter((t) => t.openId === 'ou_new').length, 0)
    // 撞坑要留痕（对抗审查 P2-2）：坑值是完成时间不是 processing，崩溃遗留才卡 processing
    const dup = auditRows('approval.event.duplicate').at(-1)
    assert.ok(dup !== undefined && dup.ok === 1 && !dup.detail.includes('processing'), '撞坑审计要能看出已成功')
  })

  test('拒绝的审批单不动库，审计记 closed', async () => {
    instanceDetail = { status: 'REJECTED', approval_code: APPROVAL_CODE, open_id: 'ou_new', form: form('wangwu', '王五') }
    await approval.handleEvent({ instanceCode: 'INS-2' })
    assert.equal(userCount('wangwu'), 0)
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM bridge_identities WHERE platform_userid = 'ou_new' AND username = 'wangwu'").get() as { n: number }).n,
      0,
    )
    assert.ok(auditRows('approval.instance.closed').some((r) => r.detail.includes('REJECTED')))
  })

  test('用户名重名 → 开通失败：审计 ok=0 + 老板收失败通知 + 不半途落库 + 不落处理标记', async () => {
    instanceDetail = { status: 'APPROVED', approval_code: APPROVAL_CODE, open_id: 'ou_new', form: form('boss', '重名测试') }
    await approval.handleEvent({ instanceCode: 'INS-3' })
    const failed = auditRows('approval.provision.failed')
    assert.ok(failed.some((r) => r.ok === 0 && r.detail.includes('已被占用')))
    assert.ok(mock.userTexts.some((t) => t.openId === BOSS_OPEN_ID && t.text.includes('开通失败')), '老板应收失败通知')
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM bridge_identities WHERE platform = 'mock' AND platform_userid = 'ou_new'").get() as { n: number }).n,
      1,
      '此前 zhangsan 的绑定不受影响',
    )
    assert.equal(
      db.prepare("SELECT value FROM app_meta WHERE key = 'feishu.approval.instance.INS-3'").get(),
      undefined,
      '失败不得落永久处理标记（对抗审查 P2-1：留重试机会）',
    )
  })

  test('同一飞书账号重复开通 → 拒绝（一人一号一飞书），不产出孤儿账号', async () => {
    instanceDetail = { status: 'APPROVED', approval_code: APPROVAL_CODE, open_id: 'ou_new', form: form('zhangsan2', '重复开通') }
    await approval.handleEvent({ instanceCode: 'INS-6' })
    assert.ok(auditRows('approval.provision.failed').some((r) => r.ok === 0 && r.detail.includes('一人一号')))
    assert.equal(userCount('zhangsan2'), 0, '不得建出无绑定的孤儿账号（对抗审查 P1-2）')
  })

  test('表单缺用户名 → 开通失败审计，老板收通知', async () => {
    instanceDetail = {
      status: 'APPROVED',
      approval_code: APPROVAL_CODE,
      open_id: 'ou_new',
      form: JSON.stringify([{ id: 'display_name', type: 'input', value: '没填用户名' }]),
    }
    await approval.handleEvent({ instanceCode: 'INS-4' })
    assert.ok(auditRows('approval.provision.failed').some((r) => r.ok === 0 && r.detail.includes('形状不对')))
  })

  test('方案B：不管部门有没有映射，开通一律零权限账号，老板收配权提醒', async () => {
    instanceDetail = { status: 'APPROVED', approval_code: APPROVAL_CODE, open_id: 'ou_new2', form: form('lisi', '李四') }
    await approval.handleEvent({ instanceCode: 'INS-5' })
    assert.equal(userCount('lisi'), 1)
    const roles = db
      .prepare('SELECT COUNT(*) AS n FROM user_roles ur JOIN users u ON u.id = ur.user_id WHERE u.username = ?')
      .get('lisi') as { n: number }
    assert.equal(roles.n, 0, '开通即零权限（不再看部门映射）')
    assert.ok(
      mock.userTexts.some((t) => t.openId === BOSS_OPEN_ID && t.text.includes('「系统权限」')),
      '老板应收配权提醒',
    )
  })

  test('approval_code 不匹配的事件不处理', async () => {
    instanceDetail = { status: 'APPROVED', approval_code: 'OTHER-DEF', open_id: 'ou_new', form: form('hacker', '伪造') }
    await approval.handleEvent({ instanceCode: 'INS-X' })
    assert.equal(userCount('hacker'), 0)
    assert.ok(auditRows('approval.event.ignored').length >= 1)
  })

  // ---------- P3：权限变更审批（2026-10-31 方案 B 起通道关闭；机制测试钉住可恢复） ----------

  /** 权限变更实例表单：真机自定义字段 id 在 custom_id（FormWidget 契约），顺带钉住 custom_id 优先解析。 */
  const permForm = (userName: string, targetRole: string) =>
    JSON.stringify([
      { id: 'widget-a', custom_id: 'user_name', type: 'input', value: userName },
      { id: 'widget-b', custom_id: 'target_role', type: 'input', value: targetRole },
    ])

  /** applyPermChange 直调用的实例形状（机制测试绕过 handleEvent 的通道关闭分流）。 */
  const asInst = () => instanceDetail as Parameters<typeof approval.applyPermChange>[1]

  /** 造一个已绑定的申请人：系统账号 + mock 平台绑定（一人一号校验的前提）。 */
  function seedBoundUser(username: string, openId: string): void {
    db.prepare('INSERT INTO users (username, password_hash, display_name, is_service, created_at) VALUES (?, ?, ?, 0, ?)').run(
      username,
      'not-a-real-hash',
      username,
      '2026-10-30T00:00:00.000Z',
    )
    db.prepare(
      "INSERT INTO bridge_identities (platform, platform_userid, username, display_name, allowed, created_at, updated_at) VALUES ('mock', ?, ?, ?, 1, '2026-10-30T00:00:00.000Z', '2026-10-30T00:00:00.000Z')",
    ).run(openId, username, username)
  }

  test('ensurePermDefinition：权限变更定义独立建、独立 approval_code；幂等不重建只补订阅', async () => {
    assert.equal(approval.approvalPermCode(), undefined)
    await approval.ensurePermDefinition()
    assert.equal(approval.approvalPermCode(), PERM_APPROVAL_CODE, '权限变更定义要有自己的 code，与开通定义分流')
    const permPost = calls.filter((c) => c.method === 'POST' && c.path === '/approval/v4/approvals').at(-1)
    assert.ok(permPost !== undefined && permPost.body!.includes('target_role'), '创建体要带 target_role 字段（假飞书靠它分流）')
    const before = calls.length
    await approval.ensurePermDefinition()
    assert.equal(calls.length, before + 1, '已有 code 时不重建，但补订阅一次（契约坑 20 自愈）')
    assert.match(calls.at(-1)!.path!, /\/subscribe$/)
  })

  test('subscribeApproval（契约坑 20）：订阅成功落审计；重复订阅 1390007 按"已在订阅"成功；真失败翻健康标记不抛', async () => {
    assert.ok(auditRows('approval.subscribed').length >= 1, '前面建定义时已订阅（双层订阅第二层）')
    assert.equal(approval.subscriptionHealthy(), true)
    // 重复订阅（重启场景）：真机返回 1390007 而非幂等 0——按"已在订阅"成功处理，
    // 不误报失败、不翻健康标记（否则每次重启都喊"推送不可达"+定时器空转）
    await approval.ensurePermSubscription()
    assert.equal(approval.subscriptionHealthy(), true)
    assert.ok(auditRows('approval.subscribed').at(-1)!.detail.includes('1390007'), '重复订阅落审计并注明已在订阅')
    // 真失败：不抛、ok=0 审计、健康标记翻 false（main.ts 定时器见 false 留 10 分钟一轮重订，P2-1）
    subscribeFail = true
    try {
      await assert.doesNotReject(() => approval.ensurePermSubscription())
      const failed = auditRows('approval.subscribe.failed')
      assert.ok(failed.at(-1) !== undefined && failed.at(-1)!.ok === 0, '订阅失败要留 ok=0 审计（补抓兜底）')
      assert.equal(approval.subscriptionHealthy(), false, '失败翻健康标记=false（定时器据此低频重订）')
    } finally {
      subscribeFail = false
    }
    await approval.ensurePermSubscription()
    assert.equal(approval.subscriptionHealthy(), true, '恢复后重订成功（0 或 1390007 都算好），定时器可以停')
  })

  test('P3 主链路（机制）：审批通过 → 给绑定账号加角色+私聊+审计', async () => {
    seedBoundUser('permuser', 'ou_perm')
    db.prepare("INSERT INTO roles (name) VALUES ('会计')").run()
    instanceDetail = { status: 'APPROVED', approval_code: PERM_APPROVAL_CODE, open_id: 'ou_perm', form: permForm('permuser', '会计') }
    assert.equal(await approval.applyPermChange('INS-PERM-1', asInst()), true)
    assert.deepEqual(services.rbac.rolesOf('permuser'), ['会计'], '角色已加到申请人自己绑定的账号')
    const applied = auditRows('approval.permchange.applied')
    assert.equal(applied.length, 1)
    assert.ok(applied[0]!.ok === 1 && applied[0]!.detail.includes('permuser') && applied[0]!.detail.includes('会计'))
    assert.match(mock.userTexts.at(-1)!.text, /已加上角色「会计」/, '申请人应收结果私聊')
    assert.ok(mock.userTexts.some((t) => t.openId === 'ou_perm'))
  })

  test('P3 护栏（机制）：替别人申请/技术角色/角色不存在/未绑定/停用账号/撤销绑定 → 永久拒绝+申请人与老板都收通知', async () => {
    seedBoundUser('permuser2', 'ou_perm2')
    db.prepare("INSERT INTO roles (name) VALUES ('库管')").run()
    // 停用账号（P3 审查 D1）与撤销绑定（D2）的边角：护栏要与 applyOrgRules 同一口径
    seedBoundUser('disabledguy', 'ou_disabled')
    db.prepare("UPDATE users SET disabled_at = '2026-10-30T00:00:00.000Z' WHERE username = 'disabledguy'").run()
    seedBoundUser('revokedguy', 'ou_revoked')
    db.prepare("UPDATE bridge_identities SET allowed = 0 WHERE platform_userid = 'ou_revoked'").run()
    const expectReject = async (instanceCode: string, openId: string, userName: string, role: string, pattern: RegExp) => {
      instanceDetail = { status: 'APPROVED', approval_code: PERM_APPROVAL_CODE, open_id: openId, form: permForm(userName, role) }
      const ok = await approval.applyPermChange(instanceCode, asInst())
      assert.equal(ok, true, '永久拒绝=处理完成（占坑落地），不进重试队列')
      assert.match(auditRows('approval.permchange.rejected').at(-1)!.detail, pattern)
    }
    await expectReject('INS-PERM-2', 'ou_perm2', '别人家账号', '库管', /只能给自己的账号（permuser2）申请/)
    await expectReject('INS-PERM-3', 'ou_perm2', 'permuser2', 'boss', /技术角色，不能通过审批申请/)
    await expectReject('INS-PERM-4', 'ou_perm2', 'permuser2', '没有这角色', /还不存在/)
    await expectReject('INS-PERM-5', 'ou_stranger', '随便填', '库管', /还没绑定系统账号/)
    await expectReject('INS-PERM-7', 'ou_disabled', 'disabledguy', '库管', /已停用/)
    // 撤销的绑定（allowed=0）不算身份证明，落"还没绑定"同一分支
    await expectReject('INS-PERM-8', 'ou_revoked', 'revokedguy', '库管', /还没绑定系统账号/)
    // 六条拒绝：申请人各一条 ❌ 私聊 + 老板各一条知情
    assert.ok(mock.userTexts.filter((t) => t.text.includes('权限变更申请没有生效')).length >= 6)
    assert.ok(mock.userTexts.filter((t) => t.openId === BOSS_OPEN_ID && t.text.includes('无法执行')).length >= 6)
  })

  test('P3 已有角色（机制）：幂等 no-op（alreadyHad）+ 申请人收到"本来就有"', async () => {
    seedBoundUser('permuser3', 'ou_perm3')
    db.prepare("INSERT INTO roles (name) VALUES ('采购')").run()
    services.rbac.assignRole('permuser3', '采购')
    instanceDetail = { status: 'APPROVED', approval_code: PERM_APPROVAL_CODE, open_id: 'ou_perm3', form: permForm('permuser3', '采购') }
    assert.equal(await approval.applyPermChange('INS-PERM-6', asInst()), true)
    assert.match(auditRows('approval.permchange.applied').at(-1)!.detail, /"alreadyHad":true/)
    assert.match(mock.userTexts.at(-1)!.text, /本来就有/)
  })

  test('方案B：权限变更通道已关闭——handleEvent 派发礼貌拒绝，批了也不加角色，占坑不重试', async () => {
    seedBoundUser('permuser5', 'ou_perm5')
    db.prepare("INSERT INTO roles (name) VALUES ('运营')").run()
    mock.userTexts.length = 0
    instanceDetail = { status: 'APPROVED', approval_code: PERM_APPROVAL_CODE, open_id: 'ou_perm5', form: permForm('permuser5', '运营') }
    assert.equal(await approval.handleEvent({ instanceCode: 'INS-PERM-CLOSED' }), 'rejected', '礼貌拒绝=处理完成（占坑落地，不进重试；统计与"新开通"分开计数）')
    assert.deepEqual(services.rbac.rolesOf('permuser5'), [], '通道已关闭：boss 批了也不加角色（权限归管理员统一配置）')
    const rejected = auditRows('approval.permchange.rejected').at(-1)!
    assert.ok(rejected.ok === 0 && rejected.detail.includes('权限变更申请通道已关闭'))
    assert.ok(
      mock.userTexts.some((t) => t.openId === 'ou_perm5' && t.text.includes('权限变更申请没有生效') && t.text.includes('管理员统一配置')),
      '申请人收礼貌告知（指路管理员配置，不是冷冰冰的拒绝）',
    )
    assert.ok(
      mock.userTexts.some((t) => t.openId === BOSS_OPEN_ID && t.text.includes('无法执行')),
      '老板要知道自己批的单不会生效',
    )
    // 占坑：同单事件重推只算 duplicate，不再重复通知/审计
    mock.userTexts.length = 0
    assert.equal(await approval.handleEvent({ instanceCode: 'INS-PERM-CLOSED' }), 'duplicate')
    assert.equal(mock.userTexts.filter((t) => t.openId === 'ou_perm5').length, 0)
  })

  test('方案B 补抓：双定义同一时间窗各扫一遍，权限变更单补回也只落通道关闭拒绝', async () => {
    instanceLists = ['INS-PERM-BF']
    seedBoundUser('permuser4', 'ou_perm4')
    db.prepare("INSERT INTO roles (name) VALUES ('客服')").run()
    instanceDetail = { status: 'APPROVED', approval_code: PERM_APPROVAL_CODE, open_id: 'ou_perm4', form: permForm('permuser4', '客服') }
    await approval.backfillMissed('reconnect')
    assert.deepEqual(services.rbac.rolesOf('permuser4'), [], '通道已关闭：补抓追回也不加角色，落礼貌拒绝')
    assert.ok(
      auditRows('approval.permchange.rejected').some((r) => r.ok === 0 && r.detail.includes('通道已关闭')),
      '补抓路径同样走 closePermChannel',
    )
    const bf = JSON.parse(auditRows('approval.backfill').at(-1)!.detail) as { permRejected: number; provisioned: number }
    assert.equal(bf.permRejected, 1, '通道关闭拒绝单独计数（方案B 审查 P3-1）')
    assert.equal(bf.provisioned, 0, '不混进"新开通"')
    const listPaths = calls.filter((c) => c.path.startsWith('/approval/v4/instances?')).map((c) => c.path)
    assert.ok(listPaths.some((p) => p.includes(encodeURIComponent(APPROVAL_CODE))), '开通定义也在扫描窗口里')
    assert.ok(listPaths.some((p) => p.includes(encodeURIComponent(PERM_APPROVAL_CODE))), '权限变更定义也要扫（双定义同窗）')
  })

  test('org-rules：service 建查删 + 角色不存在/重复部门/ID 形状拒绝', async () => {
    const created = approval.createOrgRule('boss', { departmentId: 'od-hr', departmentName: '人事部', role: 'employee' })
    assert.equal(created.role, 'employee')
    assert.equal(created.scope, '*', '一期 scope 恒 *（小组地盘占位）')
    assert.throws(() => approval.createOrgRule('boss', { departmentId: 'od-x', role: 'nope' }), /不存在/)
    assert.throws(() => approval.createOrgRule('boss', { departmentId: 'od-hr', role: 'employee' }), /已有映射/)
    assert.throws(() => approval.createOrgRule('boss', { departmentId: 'finance-dept', role: 'employee' }), /od-/, '贴错 ID 形状的规则永不匹配，源头拒（P3-4）')
    assert.ok(approval.listOrgRules().some((r) => r.department_id === 'od-hr'))
    approval.deleteOrgRule('boss', created.id)
    assert.equal(approval.listOrgRules().some((r) => r.department_id === 'od-hr'), false)
  })

  test('applyOrgRules：映射补配后给存量零权限账号补角色（P2-2 死路的解法）', async () => {
    // lisi 是「部门无映射」用例建出的零权限账号
    const before = db
      .prepare('SELECT COUNT(*) AS n FROM user_roles ur JOIN users u ON u.id = ur.user_id WHERE u.username = ?')
      .get('lisi') as { n: number }
    assert.equal(before.n, 0)
    db.prepare(
      "INSERT INTO feishu_org_rules (department_id, department_name, role, scope, created_at) VALUES ('od-unknown', '后配的部', 'employee', '*', '2026-10-29T02:00:00.000Z')",
    ).run()
    const r = await approval.applyOrgRules('boss', 'lisi')
    assert.deepEqual(r, { count: 1, roles: ['employee'] }, '补配契约：count+roles（对抗审查 P2-3）')
    const after = db
      .prepare("SELECT r.name AS name FROM user_roles ur JOIN users u ON u.id = ur.user_id JOIN roles r ON r.id = ur.role_id WHERE u.username = 'lisi'")
      .all() as { name: string }[]
    assert.deepEqual(after.map((x) => x.name), ['employee'])
    // 幂等：重复 apply 不翻车不重复落
    const again = await approval.applyOrgRules('boss', 'lisi')
    assert.deepEqual(again.roles, ['employee'])
    assert.equal(after.length, 1)
    await assert.rejects(() => approval.applyOrgRules('boss', 'no-such-user'), /不存在/)
  })

  // ---------- P4：调岗自动同步（组织同步后的映射角色重算） ----------

  test('P4 来源约定：映射落的=mapping（含存量重刷）、审批与界面落的=manual；方案B 开通=零角色', async () => {
    assert.deepEqual(services.rbac.rolesOf('zhangsan'), [], '方案B：审批开通不再按部门落角色（默认零权限待管理员配）')
    assert.equal(sourceOf('permuser', '会计'), 'manual', 'P3 审批落的角色=manual（针对个体的单独决定）')
    db.prepare("INSERT INTO roles (name) VALUES ('界面岗')").run()
    services.rbac.assignRole('permuser', '界面岗')
    assert.equal(sourceOf('permuser', '界面岗'), 'manual', '界面绑定默认 manual')
    // 存量重刷（执行计划拍板的迁移路径）：加列前的旧行默认 manual → applyOrgRules 重刷成 mapping
    db.prepare(
      "UPDATE user_roles SET source = 'manual' WHERE user_id = (SELECT id FROM users WHERE username = 'lisi') AND role_id = (SELECT id FROM roles WHERE name = 'employee')",
    ).run()
    const r = await approval.applyOrgRules('boss', 'lisi')
    assert.deepEqual(r.roles, ['employee'])
    assert.equal(sourceOf('lisi', 'employee'), 'mapping', 'applyOrgRules 把存量 manual 刷成 mapping，纳入调岗重算')
  })

  test('P4 调岗重算：mapping 多退少补、manual 不动', async () => {
    seedBoundUser('recalcuser', 'ou_recalc')
    db.prepare("INSERT INTO roles (name) VALUES ('技师')").run()
    db.prepare("INSERT INTO roles (name) VALUES ('顾问')").run()
    db.prepare(
      "INSERT INTO feishu_org_rules (department_id, department_name, role, scope, created_at) VALUES ('od-tech', '技术部', '技师', '*', '2026-10-30T00:00:00.000Z')",
    ).run()
    services.rbac.assignRole('recalcuser', '顾问') // manual：调岗也不许被冲掉
    recalcDepts = ['od-tech']
    let st = await approval.recalcOrgRoles('ui')
    assert.ok(st.added >= 1 && st.users >= 1)
    assert.equal(sourceOf('recalcuser', '技师'), 'mapping')
    // 调岗：换到财务部 → 技师（mapping）退掉，employee 进来；顾问（manual）不动
    recalcDepts = ['od-finance']
    st = await approval.recalcOrgRoles('schedule')
    assert.ok(st.removed >= 1)
    assert.equal(sourceOf('recalcuser', '技师'), undefined, '调岗走的 mapping 角色被退掉')
    assert.equal(sourceOf('recalcuser', 'employee'), 'mapping', '新部门的映射角色补上')
    assert.equal(sourceOf('recalcuser', '顾问'), 'manual', 'manual 角色调岗不丢')
    assert.ok(auditRows('bridge.org.recalc').at(-1)!.detail.includes('"trigger":"schedule"'))
  })

  test('P4 最后管理员守卫：重算要摘掉全场最后一个 admin:manage 时拦下（宁可少退不锁门）', async () => {
    seedBoundUser('soleadmin', 'ou_guard')
    db.prepare("INSERT INTO roles (name) VALUES ('管理岗')").run()
    const permId = (db.prepare("SELECT id FROM permissions WHERE code = 'admin:manage'").get() as { id: number }).id
    const roleId = (db.prepare("SELECT id FROM roles WHERE name = '管理岗'").get() as { id: number }).id
    db.prepare('INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)').run(roleId, permId)
    db.prepare(
      "INSERT INTO feishu_org_rules (department_id, department_name, role, scope, created_at) VALUES ('od-guard', '管理部', '管理岗', '*', '2026-10-30T00:00:00.000Z')",
    ).run()
    // 守卫要"全场最后一个"才触发：临时摘掉 boss 角色的 admin:manage（finally 恢复，后续 REST 用例靠它）
    const restoreBoss = () =>
      db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES ((SELECT id FROM roles WHERE name = ?), ?)').run(
        'boss',
        permId,
      )
    db.prepare('DELETE FROM role_permissions WHERE permission_id = ? AND role_id = (SELECT id FROM roles WHERE name = ?)').run(permId, 'boss')
    try {
      guardDepts = ['od-guard']
      await approval.recalcOrgRoles('ui')
      assert.equal(sourceOf('soleadmin', '管理岗'), 'mapping', '前置：映射把管理岗落上')
      guardDepts = ['od-elsewhere'] // 调岗到无映射规则的部门 → 重算想摘（空部门=D1 跳过路径，走不到守卫）
      const st = await approval.recalcOrgRoles('schedule')
      assert.equal(st.guardSkipped, 1, '守卫拦下')
      assert.equal(sourceOf('soleadmin', '管理岗'), 'mapping', '最后一个管理员不被摘')
      // 第二个持有人（manual）出现 → 摘除放行；manual 持有者不受影响
      services.rbac.assignRole('recalcuser', '管理岗')
      const st2 = await approval.recalcOrgRoles('schedule')
      assert.equal(st2.guardSkipped, 0)
      assert.equal(sourceOf('soleadmin', '管理岗'), undefined, '有别人持有后正常退掉')
      assert.equal(sourceOf('recalcuser', '管理岗'), 'manual')
    } finally {
      restoreBoss()
    }
  })

  test('P4 存量兜底：绕过 assignRole 直插的绑定（无来源）默认 manual——加列默认值钉住', async () => {
    db.prepare("INSERT INTO roles (name) VALUES ('默认岗')").run()
    db.prepare(
      "INSERT INTO user_roles (user_id, role_id) VALUES ((SELECT id FROM users WHERE username = 'recalcuser'), (SELECT id FROM roles WHERE name = '默认岗'))",
    ).run()
    assert.equal(sourceOf('recalcuser', '默认岗'), 'manual', 'ALTER/建表两种路径的默认值都是 manual')
  })

  test('P4 审查修复：部门接口返回空数组=跳过不摘（D1 空与字段权限故障不可区分）；一人多绑定按 username 去重（D2）', async () => {
    // 前置：给 recalcuser 落一个 mapping 角色（技师在调岗用例里已被退掉）
    recalcDepts = ['od-tech']
    await approval.recalcOrgRoles('ui')
    assert.equal(sourceOf('recalcuser', '技师'), 'mapping', '前置：技师落上')
    // D1：模拟字段权限故障——department_ids 成功返回空数组。按"调岗到无部门"摘光会把
    // 权限故障放大成失权（契约坑 19 实证过的故障形态），必须保守跳过
    recalcDepts = []
    const st = await approval.recalcOrgRoles('schedule')
    assert.ok(st.noDept >= 1, '空部门要单独计数进审计/日志')
    assert.equal(sourceOf('recalcuser', '技师'), 'mapping', '空部门不摘——故障不许放大成失权')
    // D2：同一账号绑第二个飞书号（换号重绑忘撤旧绑的已知状态）→ 按 username 去重不双计
    db.prepare(
      "INSERT INTO bridge_identities (platform, platform_userid, username, display_name, allowed, created_at, updated_at) VALUES ('mock', 'ou_recalc-new', 'recalcuser', 'recalcuser', 1, '2026-10-31T00:00:00.000Z', '2026-10-31T00:00:00.000Z')",
    ).run()
    const distinctUsers = (
      db
        .prepare(
          "SELECT COUNT(DISTINCT bi.username) AS n FROM bridge_identities bi JOIN users u ON u.username = bi.username WHERE bi.platform = 'mock' AND bi.allowed = 1 AND u.is_service = 0",
        )
        .get() as { n: number }
    ).n
    const st2 = await approval.recalcOrgRoles('schedule')
    assert.equal(st2.users, distinctUsers, '重算名单按 username 去重，一人多绑定不双计')
    // 去重取最早绑定（与 applyOrgRules 同口径）：recalcuser 仍按 ou_recalc 的部门（空）跳过
    assert.equal(sourceOf('recalcuser', '技师'), 'mapping')
  })

  test('护栏穿透封堵（拼装台面 P1 审查 P1-2）：技术角色不能配映射；不能给自己按映射补配', async () => {
    // 部门映射到技术角色 = 把全权发给整个部门每个新开通账号——源头拒
    assert.throws(
      () => approval.createOrgRule('boss', { departmentId: 'od-tech', departmentName: '技术部', role: 'boss' }),
      /技术角色，不能配部门映射/,
    )
    // 给自己补配 = 改自己的权限，与拼装台面"自改拒绝"同一套利口——自检在最前（用户不存在也先拒）
    await assert.rejects(() => approval.applyOrgRules('ghost', 'ghost'), /不能给自己/)
    assert.ok(
      (auditRows('rbac.guard.rejected').length >= 2),
      '护栏拒绝统一落审计',
    )
  })

  test('org-rules REST：admin 可建删，未带 token 401', async () => {
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'boss', password: config.bossInitialPassword }),
    })
    const { token } = (await login.json()) as { token: string }
    const denied = await fetch(`${base}/api/bridge/org-rules`)
    assert.equal(denied.status, 401)
    const created = (await (
      await fetch(`${base}/api/bridge/org-rules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ departmentId: 'od-rest', departmentName: 'REST 部', role: 'employee' }),
      })
    ).json()) as { rule: { id: number } }
    assert.ok(created.rule.id > 0)
    const list = (await (
      await fetch(`${base}/api/bridge/org-rules`, { headers: { authorization: `Bearer ${token}` } })
    ).json()) as { rules: unknown[]; approvalConfigured: boolean }
    assert.ok(list.rules.some((r) => (r as { department_id: string }).department_id === 'od-rest'))
    assert.equal(list.approvalConfigured, true)
    const del = await fetch(`${base}/api/bridge/org-rules/${created.rule.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(del.status, 200)
  })

  test('组织同步：分页拉全部门树落库（坏条目跳过），翻页参数正确，审计记触发方式', async () => {
    const { count } = await approval.syncFromFeishu('ui', 'boss')
    assert.equal(count, 4, '两页 5 条：legacy 字段名兼容、无名用 ID 占位，只跳缺 ID 的')
    const rows = db.prepare('SELECT * FROM feishu_departments ORDER BY department_id').all() as Array<{
      department_id: string
      name: string
      parent_id: string
      member_count: number
      synced_at: string
    }>
    assert.deepEqual(
      rows.map((r) => `${r.department_id}:${r.name}:${r.parent_id}:${r.member_count}`),
      ['od-finance:财务部:0:3', 'od-hr:人事部::0', 'od-hr-x:坏条目:0:1', 'od-tech:技术部:0:5'],
    )
    assert.ok(rows.every((r) => r.synced_at === rows[0]!.synced_at), '同一轮同步 synced_at 一致')
    const syncCalls = calls.filter((c) => c.path.startsWith('/contact/v3/departments/0/children'))
    assert.equal(syncCalls.length, 2)
    assert.ok(syncCalls[1]!.path.includes('page_token=p2'), '第二页带 page_token 续翻')
    const log = auditRows('bridge.org.sync').at(-1)!
    assert.equal(log.ok, 1)
    assert.ok(log.detail.includes('"count":4'))
    assert.ok(log.detail.includes('"trigger":"ui"'))
    const source = db
      .prepare("SELECT source FROM audit_log WHERE action = 'bridge.org.sync' ORDER BY id DESC LIMIT 1")
      .get() as { source: string }
    assert.equal(source.source, 'ui')
  })

  test('组织同步幂等：再同步不重复落行；映射规则 join 镜像拿到部门显示名；空响应不清镜像', async () => {
    const fullTree = () => {
      childrenPages = [
        {
          items: [dept('od-finance', '财务部', '0', 3), dept('od-hr', '人事部', '0', 2)],
          has_more: true,
          page_token: 'p2',
        },
        { items: [dept('od-tech', '技术部', '0', 5)], has_more: false },
      ]
    }
    fullTree()
    await approval.syncFromFeishu('schedule')
    fullTree()
    await approval.syncFromFeishu('schedule')
    const n = (db.prepare('SELECT COUNT(*) AS n FROM feishu_departments').get() as { n: number }).n
    assert.equal(n, 3, '快照全量替换，重复同步不堆积')
    const rules = approval.listOrgRulesWithNames()
    const finance = rules.find((r) => r.department_id === 'od-finance')!
    assert.equal(finance.displayName, '财务部')
    assert.equal(finance.departmentExists, true)
    // 空响应护栏：接口异常拉到空树时不动镜像（正常企业不会零部门）
    childrenPages = []
    await approval.syncFromFeishu('schedule')
    const after = (db.prepare('SELECT COUNT(*) AS n FROM feishu_departments').get() as { n: number }).n
    assert.equal(after, 3, '空响应不清空镜像')
    assert.ok(
      auditRows('bridge.org.sync').at(-1)!.detail.includes('"applied":false'),
      '空响应审计要能看出来没落库',
    )
  })

  test('组织同步清理：飞书侧消失的部门从镜像移除，映射规则保留', async () => {
    childrenPages = [{ items: [dept('od-finance', '财务部', '0', 3)], has_more: false }]
    await approval.syncFromFeishu('schedule')
    const ids = (db.prepare('SELECT department_id FROM feishu_departments').all() as Array<{ department_id: string }>).map(
      (r) => r.department_id,
    )
    assert.deepEqual(ids, ['od-finance'], '消失的部门清掉')
    assert.ok(
      approval.listOrgRules().some((r) => r.department_id === 'od-finance'),
      '映射是配置不是镜像，不级联删',
    )
    const gone = approval.listOrgRulesWithNames().find((r) => r.department_id === 'od-rest')
    if (gone !== undefined) assert.equal(gone.departmentExists, false)
  })

  test('组织同步 REST：GET departments 带角色清单，POST org-sync 手动刷新，未带 token 401', async () => {
    childrenPages = [
      {
        items: [dept('od-finance', '财务部', '0', 3), dept('od-hr', '人事部', '0', 2)],
        has_more: true,
        page_token: 'p2',
      },
      { items: [dept('od-tech', '技术部', '0', 5)], has_more: false },
    ]
    const denied = await fetch(`${base}/api/bridge/departments`)
    assert.equal(denied.status, 401)
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'boss', password: config.bossInitialPassword }),
    })
    const { token } = (await login.json()) as { token: string }
    const sync = (await (
      await fetch(`${base}/api/bridge/org-sync`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()) as { count: number }
    assert.equal(sync.count, 3)
    const list = (await (
      await fetch(`${base}/api/bridge/departments`, { headers: { authorization: `Bearer ${token}` } })
    ).json()) as { departments: Array<{ department_id: string; name: string }>; syncedAt: string | null; roles: string[] }
    assert.equal(list.departments.length, 3)
    assert.ok(list.departments.some((d) => d.department_id === 'od-finance' && d.name === '财务部'))
    assert.ok(list.syncedAt !== null)
    assert.ok(list.roles.includes('employee'), '建映射下拉要有角色清单')
  })

  test('白名单外来访 → 指路 OA 审批（不再发对话卡）；文案与审批单名同源钉住', async () => {
    await mock.emitMessage({ platform: 'mock', platformUserid: 'ou_stranger', conversationId: 'c-s', text: '我想用', msgId: 's-1' })
    // 同源钉住（对抗审查 P3-2）：bridge 指路文案必须含审批服务的单名常量，改一处不改另一处时这里红
    const { FEISHU_APPROVAL_NAME } = await import('../src/bridge/feishu-approval.service.js')
    assert.ok(mock.texts.at(-1)!.text.includes(`《${FEISHU_APPROVAL_NAME}》`), '指路文案要带审批单名，员工才能搜到单')
    assert.match(mock.texts.at(-1)!.text, /审批/)
  })

  test('/api/auth/me 暴露飞书绑定信息（个人中心展示用）', async () => {
    db.prepare(
      "INSERT INTO bridge_identities (platform, platform_userid, username, display_name, allowed, created_at, updated_at) VALUES ('feishu','ou_feishu_boss','boss','老板（飞书）',1,'2026-10-29T01:00:00.000Z','2026-10-29T01:00:00.000Z')",
    ).run()
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'boss', password: config.bossInitialPassword }),
    })
    const { token } = (await res.json()) as { token: string }
    const me = (await (await fetch(`${base}/api/auth/me`, { headers: { authorization: `Bearer ${token}` } })).json()) as {
      username: string
      feishuBinding: { openId: string; name: string; boundAt: string } | null
    }
    assert.equal(me.username, 'boss')
    assert.ok(me.feishuBinding !== null)
    assert.equal(me.feishuBinding!.openId, 'ou_feishu_boss')
    assert.equal(me.feishuBinding!.name, '老板（飞书）')
    assert.ok(me.feishuBinding!.boundAt !== '')
  })

  test('映射继承：规则配在上级部门也覆盖子部门员工（沿镜像 parent 链展开，P1-1）', async () => {
    // 镜像树：中心(od-parent) ← 组(od-child)；员工直接挂在组里
    db.prepare(
      "INSERT INTO feishu_departments (department_id, name, parent_id, member_count, synced_at) VALUES ('od-parent', '技术中心', '0', 9, '2026-10-29T03:00:00.000Z'), ('od-child', '一组', 'od-parent', 3, '2026-10-29T03:00:00.000Z')",
    ).run()
    db.prepare(
      "INSERT INTO feishu_org_rules (department_id, department_name, role, scope, created_at) VALUES ('od-parent', '技术中心', 'employee', '*', '2026-10-29T03:00:00.000Z')",
    ).run()
    // 方案B 下开通不再落角色，祖先展开机制走映射补配面验证（同一 rolesForDepartments 管线）
    seedBoundUser('wangwu', 'ou_child')
    const granted = await approval.applyOrgRules('boss', 'wangwu')
    assert.deepEqual(
      granted,
      { count: 1, roles: ['employee'] },
      '用户直接部门是子部门，规则配在上级——要落角色（飞书 department_ids 不含祖先，必须自己展开）',
    )
    // 镜像缺父行不炸：od-child 的 parent 指针名义还在，上级 ID 仍参与匹配；
    // "截断"= 父行缺失时不再往上层找（不会无限循环、不会抛错）
    db.prepare("DELETE FROM feishu_departments WHERE department_id = 'od-parent'").run()
    const patched = await approval.applyOrgRules('boss', 'wangwu')
    assert.deepEqual(patched, { count: 1, roles: ['employee'] }, '缺父行截断不炸，名义父 ID 仍参与匹配')
  })

  test('组织同步失败 → REST 400 带真实原因（权限没配是常态，不能笼统 500，P2-1）', async () => {
    childrenFail = true
    try {
      const login = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'boss', password: config.bossInitialPassword }),
      })
      const { token } = (await login.json()) as { token: string }
      const res = await fetch(`${base}/api/bridge/org-sync`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      })
      assert.equal(res.status, 400)
      const body = (await res.json()) as { message: string }
      assert.ok(body.message.includes('40004'), '失败原因要带飞书错误码')
      assert.ok(body.message.includes('组织同步失败'))
    } finally {
      childrenFail = false
    }
  })

  // ---------- 断线补抓（2026-10-30 第2层）：事件驱动+对账，不做定时轮询 ----------

  /** 播种补抓 checkpoint（回看窗口从它起算；播种在近处保证测试只扫一个 10h 段）。 */
  const seedCheckpoint = (ms: number) =>
    db
      .prepare("INSERT OR REPLACE INTO app_meta (key, value, updated_at) VALUES ('feishu.approval.backfill_until', ?, '2026-10-30T00:00:00.000Z')")
      .run(String(ms))
  const readCheckpoint = (): number | undefined => {
    const row = db.prepare("SELECT value FROM app_meta WHERE key = 'feishu.approval.backfill_until'").get() as { value: string } | undefined
    return row === undefined ? undefined : Number(row.value)
  }

  test('补抓主流程：未处理实例补开通、已处理实例跳过（不查详情）、checkpoint 推进、审计留触发方式', async () => {
    const checkpoint = Date.now() - 3600_000
    seedCheckpoint(checkpoint)
    instanceDetail = { status: 'APPROVED', approval_code: APPROVAL_CODE, open_id: 'ou_backfill', form: form('sunqi', '孙七') }
    instanceLists = ['INS-1', 'INS-B1'] // INS-1 是此前事件用例开通过的（占坑在），必须跳过
    calls.length = 0
    await approval.backfillMissed('startup')
    assert.equal(userCount('sunqi'), 1, '断线期间错过的实例应补开通')
    assert.equal(
      calls.filter((c) => c.path.startsWith('/approval/v4/instances/INS-1')).length,
      0,
      '已占坑实例在查详情前就被跳过',
    )
    const listCalls = calls.filter((c) => c.path.startsWith('/approval/v4/instances?'))
    assert.equal(listCalls.length, 2, '近处 checkpoint → 只扫一个 10h 段（P3 双定义：开通+权限变更各拉一遍）')
    assert.ok(listCalls.some((c) => c.path.includes('approval_code=APPROVAL-TEST-1')))
    assert.ok(listCalls.some((c) => c.path.includes('approval_code=PERM-TEST-1')), '权限变更定义也要进同一时间窗')
    assert.ok(readCheckpoint()! > checkpoint, 'checkpoint 推进到本轮 now')
    const log = auditRows('approval.backfill').at(-1)!
    assert.ok(log.detail.includes('"provisioned":1'))
    assert.ok(log.detail.includes('"skipped":3'), '已处理实例在双定义窗口里重复出现：INS-1×2 + INS-B1 的第二份，各跳过一次')
    assert.ok(log.detail.includes('"trigger":"startup"'))
    assert.ok(log.detail.includes('"checkpointAdvanced":true'))
  })

  test('补抓：列表 API 失败 → checkpoint 不推进，下轮触发重扫（占坑跳过，成本≈0）', async () => {
    const checkpoint = Date.now() - 600_000
    seedCheckpoint(checkpoint)
    listFail = true
    try {
      await approval.backfillMissed('reconnect')
    } finally {
      listFail = false
    }
    assert.equal(readCheckpoint(), checkpoint, '窗口边界不可信时 checkpoint 原地不动')
    assert.ok(auditRows('approval.backfill').at(-1)!.detail.includes('"checkpointAdvanced":false'))
  })

  test('补抓：单实例失败进重试队列逐轮+1，3 次不中弃追清出（防毒实例反复吵老板）', async () => {
    seedCheckpoint(Date.now() - 600_000)
    db
      .prepare("INSERT OR REPLACE INTO app_meta (key, value, updated_at) VALUES ('feishu.approval.backfill_retry', ?, '2026-10-30T00:00:00.000Z')")
      .run(JSON.stringify([{ code: 'INS-BAD', attempts: 2 }]))
    instanceLists = [] // 窗口里没有新实例：只走重试段
    instanceDetail = { status: 'APPROVED', approval_code: APPROVAL_CODE, open_id: 'ou_new', form: form('boss', '重名必败') }
    mock.userTexts.length = 0
    await approval.backfillMissed('reconnect')
    const queueRow = () => db.prepare("SELECT value FROM app_meta WHERE key = 'feishu.approval.backfill_retry'").get() as { value: string } | undefined
    assert.deepEqual(JSON.parse(queueRow()!.value), [{ code: 'INS-BAD', attempts: 3 }], '失败一次 attempt+1 留队')
    const first = JSON.parse(auditRows('approval.backfill').at(-1)!.detail) as { retried: number }
    assert.equal(first.retried, 1, '本轮重试了遗留的一条')
    await approval.backfillMissed('reconnect')
    assert.equal(queueRow(), undefined, '第 3 次失败弃追，队列清空')
    const second = JSON.parse(auditRows('approval.backfill').at(-1)!.detail) as { deadLettered: number; retried: number }
    assert.equal(second.deadLettered, 1)
    assert.equal(second.retried, 0, '已达上限的不再重试')
  })

  test('handleEvent 返回处理状态（补抓据此判定跳过/重试；长连接路径不受影响）', async () => {    instanceDetail = { status: 'APPROVED', approval_code: APPROVAL_CODE, open_id: 'ou_status', form: form('zhouba', '周八') }
    assert.equal(await approval.handleEvent({ instanceCode: 'INS-ST1' }), 'ok')
    assert.equal(await approval.handleEvent({ instanceCode: 'INS-ST1' }), 'duplicate')
    instanceDetail = { status: 'APPROVED', approval_code: 'OTHER-DEF', open_id: 'ou_new', form: form('hacker2', '伪造') }
    assert.equal(await approval.handleEvent({ instanceCode: 'INS-ST2' }), 'ignored')
    instanceDetail = { status: 'REJECTED', approval_code: APPROVAL_CODE, open_id: 'ou_new', form: form('x', '被拒') }
    assert.equal(await approval.handleEvent({ instanceCode: 'INS-ST3' }), 'closed')
    instanceDetail = { status: 'PENDING', approval_code: APPROVAL_CODE, open_id: 'ou_new', form: form('x', '在途') }
    assert.equal(await approval.handleEvent({ instanceCode: 'INS-ST4' }), 'pending')
  })

  test('补抓：窗口按 10h 红线分段、段间无缝推进到 now（官方文档红线）', async () => {
    const checkpoint = Date.now() - 25 * 3600_000
    seedCheckpoint(checkpoint)
    instanceLists = []
    calls.length = 0
    await approval.backfillMissed('reconnect')
    const allListCalls = calls.filter((c) => c.path.startsWith('/approval/v4/instances?'))
    assert.equal(allListCalls.length, 6, '25h+10min 重叠 → 3 段 × P3 双定义各一遍')
    const listCalls = allListCalls.filter((c) => c.path.includes('approval_code=APPROVAL-TEST-1'))
    assert.equal(listCalls.length, 3, '单看开通定义：3 段')
    const windows = listCalls.map((c) => {
      const p = new URLSearchParams(c.path.split('?')[1] ?? '')
      return { start: Number(p.get('start_time')), end: Number(p.get('end_time')) }
    })
    assert.equal(windows[0]!.start, checkpoint - 10 * 60_000, '窗口起点=checkpoint-10min 重叠')
    assert.equal(windows[0]!.end - windows[0]!.start, 10 * 3600_000, '段长=10h 红线')
    assert.equal(windows[1]!.start, windows[0]!.end, '段间无缝衔接')
    assert.equal(windows[2]!.start, windows[1]!.end)
    assert.ok(windows[2]!.end > checkpoint + 24 * 3600_000, '最后一段推进到本轮 now')
    assert.ok(auditRows('approval.backfill').at(-1)!.detail.includes('"checkpointAdvanced":true'))
  })

  test('补抓：单轮处理上限截断后 checkpoint 不推进，下轮跳过已处理续扫不活锁（对抗审查 P1-3；终态实例也要落标记防饿死）', async () => {
    const checkpoint = Date.now() - 3600_000
    seedCheckpoint(checkpoint)
    instanceLists = ['INS-T1', 'INS-T2', 'INS-T3', 'INS-T4']
    instanceDetail = { status: 'REJECTED', approval_code: APPROVAL_CODE, open_id: 'ou_backfill', form: form('x', '拒') }
    const capped = new FeishuApprovalService(db, services.audit, services.rbac, services.bridge, {
      fetchFn: fakeFetch,
      platform: 'mock',
      backfillMaxInstances: 2,
    })
    calls.length = 0
    await capped.backfillMissed('reconnect')
    assert.equal(readCheckpoint(), checkpoint, '没扫完不推进')
    assert.equal(
      calls.filter((c) => c.path.startsWith('/approval/v4/instances/INS-T3')).length,
      0,
      '截断时第 3 个起本轮不处理',
    )
    calls.length = 0
    await capped.backfillMissed('reconnect')
    assert.ok(readCheckpoint()! > checkpoint, '第二轮续扫完推进')
    assert.ok(
      calls.some((c) => c.path.startsWith('/approval/v4/instances/INS-T3')) && calls.some((c) => c.path.startsWith('/approval/v4/instances/INS-T4')),
      '排后面的实例被续扫追上（终态实例已落标记，不吃第二轮额度）',
    )
  })

  test('补抓：PENDING 实例进观察队列逐轮复查，断线期间通过的审批最终被追回（对抗审查 P0-2）', async () => {
    const checkpoint = Date.now() - 3600_000
    seedCheckpoint(checkpoint)
    instanceLists = ['INS-P'] // 创建时间在本窗口：本轮还是 PENDING，checkpoint 会越过它的创建时间
    instanceDetail = { status: 'PENDING', approval_code: APPROVAL_CODE, open_id: 'ou_watch', form: form('tianjiu', '田九') }
    await approval.backfillMissed('startup')
    assert.equal(userCount('tianjiu'), 0)
    const queueRow = () => db.prepare("SELECT value FROM app_meta WHERE key = 'feishu.approval.backfill_retry'").get() as { value: string } | undefined
    assert.deepEqual(JSON.parse(queueRow()!.value), [{ code: 'INS-P', attempts: 0 }], 'PENDING 留队观察、不计失败次数')
    assert.ok(readCheckpoint()! > checkpoint, 'PENDING 不阻塞 checkpoint 推进')
    // 老板在断线期间通过了审批：下一轮触发时队列复查（窗口列表已不含它的创建时间）追回
    instanceLists = []
    instanceDetail = { status: 'APPROVED', approval_code: APPROVAL_CODE, open_id: 'ou_watch', form: form('tianjiu', '田九') }
    await approval.backfillMissed('reconnect')
    assert.equal(userCount('tianjiu'), 1, '复查发现 APPROVED → 补开通')
    assert.equal(queueRow(), undefined, '终态后出队')
  })

  test('补抓：崩溃遗留的 processing 占坑（>30 分钟）被释放重处理；新鲜的在途坑不动（对抗审查 P1-4）', async () => {
    seedCheckpoint(Date.now() - 3600_000)
    db
      .prepare("INSERT OR REPLACE INTO app_meta (key, value, updated_at) VALUES ('feishu.approval.instance.INS-STALE', 'processing', ?)")
      .run(new Date(Date.now() - 3600_000).toISOString())
    db
      .prepare("INSERT OR REPLACE INTO app_meta (key, value, updated_at) VALUES ('feishu.approval.instance.INS-FRESH', 'processing', ?)")
      .run(new Date().toISOString())
    instanceLists = []
    await approval.backfillMissed('reconnect')
    assert.equal(
      db.prepare("SELECT value FROM app_meta WHERE key = 'feishu.approval.instance.INS-STALE'").get(),
      undefined,
      '陈坑放掉，实例可被重处理',
    )
    assert.ok(
      db.prepare("SELECT value FROM app_meta WHERE key = 'feishu.approval.instance.INS-FRESH'").get() !== undefined,
      '真正在途的坑不能动',
    )
  })

  test('表单字段名真机契约：API 建定义写的 id 在实例表单里挪进 custom_id（2026-10-30 真机实证，custom_id 优先 id 兜底）', async () => {
    // 真机形状：id=widget平台号、custom_id=建定义时的 user_name/display_name（此前按 id 匹配落空 → 空用户名开通失败）
    instanceDetail = {
      status: 'APPROVED',
      approval_code: APPROVAL_CODE,
      open_id: 'ou_form',
      form: JSON.stringify([
        { id: 'widget17933404480', custom_id: 'user_name', name: '登录用户名', type: 'input', value: 'leiba' },
        { id: 'widget17933404481', custom_id: 'display_name', name: '姓名', type: 'input', value: '雷霸' },
      ]),
    }
    await approval.handleEvent({ instanceCode: 'INS-CUSTOM-ID' })
    assert.equal(userCount('leiba'), 1, 'custom_id 契约下用户名正确解析并开通')
    // 兜底：value 直接挂在 id 上的旧形状/假数据仍可用
    instanceDetail = {
      status: 'APPROVED',
      approval_code: APPROVAL_CODE,
      open_id: 'ou_status',
      form: JSON.stringify([{ id: 'user_name', type: 'input', value: 'leiba2' }]),
    }
    await approval.handleEvent({ instanceCode: 'INS-LEGACY-ID' })
    assert.equal(userCount('leiba2'), 0, '缺 display_name 仍按校验拒绝（表单完整性闸不受解析兼容影响）')
  })
})

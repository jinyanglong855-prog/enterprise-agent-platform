/** 审批落账插槽（2026-11-01 融合方案 §5 P2，样板=报销）：飞书审批 APPROVED → 按规则建提案
 *  → 提案卡直发老板单聊 → 老板点确认 → 账本落账（source=confirm）。覆盖：规则校验与 REST
 *  权限面、启发式/字段映射两种金额解析、申请人三级解析、全链路确认落账、幂等双保险（占坑键
 *  + origin 查重）、拒绝终态、金额解析不出不假成功、提案被账本校验挡下如实报老板、补抓扫到
 *  规则里的定义、规则保存即订阅、预览解析。飞书 HTTP 全部走假 fetch，事件直调 handleEvent。 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import bcrypt from 'bcryptjs'

process.env.ADMIN_DATA_DIR = mkdtempSync(join(tmpdir(), 'admin-approval-posting-test-'))
delete process.env.ADMIN_JWT_SECRET
process.env.ADMIN_BRIDGE_ENABLED = '1'
process.env.ADMIN_BRIDGE_ADAPTER = 'mock'

const appModule = await import('../src/app.module.js')
const { buildServices, createRuntimeModule, registerAuthMiddleware } = appModule
const { config } = await import('../src/config.js')
const { BridgeService } = await import('../src/bridge/bridge.service.js')
const { FeishuApprovalService } = await import('../src/bridge/feishu-approval.service.js')
const { FinancePostingService } = await import('../src/finance/finance-posting.service.js')
const { MockAdapter } = await import('../src/bridge/mock.adapter.js')
import type { BridgeTurnRunner } from '../src/bridge/bridge.types.js'
import type { Services } from '../src/app.module.js'
import type { MockAdapter as MockAdapterType } from '../src/bridge/mock.adapter.js'

const BOSS_OPEN_ID = 'ou_boss'
/** 企业在飞书后台自建的《费用报销》定义（本服务不创建，只登记规则+订阅）。 */
const REIMBURSE_CODE = 'REIMBURSE-DEF-1'
/** 第二条规则：付款申请，用字段映射解析。 */
const PAYMENT_CODE = 'PAYMENT-DEF-2'
/** 本服务自建的账号开通定义（证明分流不串线）。 */
const PROVISION_CODE = 'APPROVAL-TEST-1'

describe('审批落账插槽（mock 适配器 + 假飞书 HTTP）', () => {
  let app: import('@nestjs/common').INestApplication
  let base: string
  let db: import('better-sqlite3').Database
  let services: Services
  let mock: InstanceType<typeof MockAdapterType>
  let approval: InstanceType<typeof FeishuApprovalService>
  let posting: InstanceType<typeof FinancePostingService>
  let token: string
  let calls: { body?: string; method: string; path: string }[]
  /** 实例码 → 假详情（多张实例并存，补抓用例一次扫多张） */
  let details: Record<string, Record<string, unknown>>
  let instanceLists: string[]
  const subscribedCodes = new Set<string>()

  const auditRows = (action: string) =>
    db.prepare('SELECT ok, detail FROM audit_log WHERE action = ? ORDER BY id').all(action) as { ok: number; detail: string }[]
  const proposalsByOrigin = (instanceCode: string) =>
    db
      .prepare('SELECT id, status, payload, summary, created_by FROM finance_proposals WHERE origin = ? ORDER BY id')
      .all(`feishu-approval:${instanceCode}`) as { id: string; status: string; payload: string; summary: string; created_by: string }[]
  const claimOf = (instanceCode: string) =>
    (db.prepare('SELECT value FROM app_meta WHERE key = ?').get(`feishu.approval.instance.${instanceCode}`) as { value: string } | undefined)?.value
  const get = async (path: string, t = token) => {
    const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${t}` } })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }
  const send = async (method: string, path: string, body?: unknown, t = token) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

  before(async () => {
    const real = buildServices()
    db = real.db
    db.prepare(
      "INSERT INTO bridge_identities (platform, platform_userid, username, display_name, allowed, created_at, updated_at) VALUES ('mock', ?, 'boss', '老板', 1, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')",
    ).run(BOSS_OPEN_ID)
    // 申请人三级解析的素材：名册里的张三（open_id）、只有平台绑定的 lisi、谁都不认识的 ou_stranger
    db.prepare(
      "INSERT INTO finance_employees (name, open_id, department, created_at, created_by, updated_at, updated_by) VALUES ('张三', 'ou_zhangsan', '销售部', '2026-11-01T00:00:00.000Z', 'boss', '2026-11-01T00:00:00.000Z', 'boss')",
    ).run()
    db.prepare(
      "INSERT INTO bridge_identities (platform, platform_userid, username, display_name, allowed, created_at, updated_at) VALUES ('mock', 'ou_lisi', 'lisi', '李四', 1, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')",
    ).run()
    // 本服务自建定义的 code 先放进 app_meta：证明分流时自建定义优先、落账规则不抢
    db.prepare("INSERT INTO app_meta (key, value, updated_at) VALUES ('feishu.approval_code', ?, '2026-11-01T00:00:00.000Z')").run(PROVISION_CODE)

    calls = []
    details = {}
    instanceLists = []
    const fetchFn = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      const path = url.replace('https://open.feishu.cn/open-apis', '')
      calls.push({ body: typeof init?.body === 'string' ? init.body : undefined, method: init?.method ?? 'GET', path })
      const json = (extra: Record<string, unknown>) =>
        new Response(JSON.stringify({ code: 0, msg: 'success', ...extra }), { headers: { 'content-type': 'application/json' } })
      if (path === '/auth/v3/tenant_access_token/internal') return json({ tenant_access_token: 't-test', expire: 7200 })
      const subscribeMatch = path.match(/^\/approval\/v4\/approvals\/([^/]+)\/subscribe$/)
      if (subscribeMatch !== null) {
        const code = decodeURIComponent(subscribeMatch[1] ?? '')
        if (subscribedCodes.has(code)) return json({ code: 1390007, msg: 'subscription existed' })
        subscribedCodes.add(code)
        return json({})
      }
      if (path.startsWith('/approval/v4/instances?')) return json({ data: { instance_code_list: instanceLists, has_more: false } })
      const detailMatch = path.match(/^\/approval\/v4\/instances\/([^?]+)/)
      if (detailMatch !== null) {
        const code = decodeURIComponent(detailMatch[1] ?? '')
        const d = details[code]
        if (d === undefined) return json({ code: 1390005, msg: 'instance not found' })
        return json({ data: d })
      }
      return new Response(JSON.stringify({ code: 999, msg: `假飞书未实现的路径：${path}` }), { headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    const runner: BridgeTurnRunner = {
      createSession: (username) => real.agent.createSession(username),
      chat: async (_sessionId, message, _context, _username, onEvent) => {
        onEvent({ event: 'assistant', data: { text: 'stub' } })
        return { finalText: `stub 回答：${message}` }
      },
    }
    const bridge = new BridgeService(real.db, real.audit, real.proposals, runner, real.rbac)
    mock = new MockAdapter()
    bridge.registerAdapter(mock)
    posting = new FinancePostingService(real.db, real.audit, real.proposals, real.rbac, bridge, { platform: 'mock' })
    approval = new FeishuApprovalService(real.db, real.audit, real.rbac, bridge, { fetchFn, platform: 'mock', posting: posting.hook() })
    services = { ...real, bridge, feishuApproval: approval, posting }
    const { dynamicModule } = createRuntimeModule(services)
    app = await (await import('@nestjs/core')).NestFactory.create(dynamicModule, { logger: false })
    registerAuthMiddleware(app, services.auth)
    await app.listen(0, '127.0.0.1')
    const address = app.getHttpServer().address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    base = `http://127.0.0.1:${port}`
    await services.bridge.start()
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'boss', password: config.bossInitialPassword }),
    })
    token = ((await login.json()) as { token: string }).token
    await send('POST', '/api/finance/accounts', { name: '招行对公', kind: 'bank' })
  })

  after(async () => {
    await services.bridge.shutdown()
    await app.close()
    rmSync(process.env.ADMIN_DATA_DIR!, { recursive: true, force: true })
  })

  /** 飞书实例表单：真机契约里自定义标识在 custom_id、id 是平台生成的 widget…（2026-10-30 实证） */
  const reimburseForm = (amount: string | number | undefined, reason = '客户拜访礼品') =>
    JSON.stringify([
      { id: 'widget16001', custom_id: 'reason', name: '报销事由', type: 'input', value: reason },
      ...(amount === undefined ? [] : [{ id: 'widget16002', custom_id: 'amount', name: '报销金额', type: 'amount', value: amount }]),
      { id: 'widget16003', custom_id: 'invoice', name: '发票', type: 'attachment', value: [] },
    ])

  test('规则校验：code 必填/不重复、type 须是账本类型、账户须建档、field_map 形状；保存即订阅；非 admin 拒', async () => {
    const bad = async (rules: unknown, needle: string) => {
      const r = await send('PUT', '/api/finance/posting-rules', { rules })
      assert.equal(r.status, 400, `应拒：${needle}`)
      assert.ok(String(r.body.message).includes(needle), `错误信息应含「${needle}」，实际：${String(r.body.message)}`)
    }
    await bad([{ name: '没 code' }], 'code')
    await bad([{ code: 'X' }, { code: 'X' }], '重复')
    await bad([{ code: 'X', type: 'gift' }], '不是账本类型')
    await bad([{ code: 'X', account: '不存在的账户' }], '未建档')
    await bad([{ code: 'X', field_map: { amount: 42 } }], 'field_map.amount')
    const r = await send('PUT', '/api/finance/posting-rules', {
      rules: [
        { code: REIMBURSE_CODE, name: '费用报销', account: '招行对公' },
        { code: PAYMENT_CODE, name: '付款申请', type: 'expense', category: '采购付款', field_map: { amount: 'pay_total', reason: 'pay_memo' } },
      ],
    })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const rules = r.body.rules as Array<Record<string, unknown>>
    assert.equal(rules.length, 2)
    assert.deepEqual(rules[0], { code: REIMBURSE_CODE, name: '费用报销', type: 'reimburse', category: '报销', account: '招行对公', enabled: true, field_map: {} })
    assert.equal(rules[1]!.type, 'expense')
    assert.equal(r.body.subscribed, 2, '保存即按规则逐个订阅')
    assert.equal(r.body.subscription_healthy, true)
    assert.ok(calls.some((c) => c.path === `/approval/v4/approvals/${REIMBURSE_CODE}/subscribe`), '报销定义应已订阅')
    assert.ok(calls.some((c) => c.path === `/approval/v4/approvals/${PAYMENT_CODE}/subscribe`), '付款定义应已订阅')
    assert.ok(auditRows('approval.posting.rules').some((x) => x.detail.includes(REIMBURSE_CODE)))
    const list = await get('/api/finance/posting-rules')
    assert.equal((list.body.rules as unknown[]).length, 2)
    // 权限面：admin:manage——只有 finance 权限的账号读写都拒
    await send('POST', '/api/rbac/roles', { name: 'ledger-only', permissions: ['finance:read', 'finance:write'] })
    db.prepare('INSERT INTO users (username, password_hash, display_name, created_at) VALUES (?, ?, ?, ?)').run(
      'clerk-post',
      bcrypt.hashSync('Clerk-Post-Pass-1', 10),
      '记账员',
      new Date().toISOString(),
    )
    await send('POST', '/api/rbac/users/clerk-post/roles', { role: 'ledger-only' })
    const clerkLogin = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'clerk-post', password: 'Clerk-Post-Pass-1' }),
    })
    const clerkToken = ((await clerkLogin.json()) as { token: string }).token
    assert.equal((await get('/api/finance/posting-rules', clerkToken)).status, 403)
    assert.equal((await send('PUT', '/api/finance/posting-rules', { rules: [] }, clerkToken)).status, 403)
  })

  test('报销审批通过 → 启发式解析金额/事由 → 提案（申请人取名册）+ 老板单聊提案卡 + 审计；占坑值=完成时间', async () => {
    details['INS-R1'] = {
      status: 'APPROVED',
      approval_code: REIMBURSE_CODE,
      open_id: 'ou_zhangsan',
      serial_number: '202611010042',
      end_time: String(Date.UTC(2026, 10, 1, 2, 0, 0)),
      form: reimburseForm('320.50'),
    }
    const st = await approval.handleEvent({ instanceCode: 'INS-R1' })
    assert.equal(st, 'posted')
    const rows = proposalsByOrigin('INS-R1')
    assert.equal(rows.length, 1, '一张实例一笔提案')
    const payload = JSON.parse(rows[0]!.payload) as Record<string, unknown>
    assert.equal(payload.type, 'reimburse')
    assert.equal(payload.amount, 320.5)
    assert.equal(payload.counterparty, '张三', '申请人先查名册 open_id')
    assert.equal(payload.category, '报销')
    assert.equal(payload.account, '招行对公')
    assert.ok(String(payload.note).includes('费用报销') && String(payload.note).includes('#202611010042') && String(payload.note).includes('客户拜访礼品') && String(payload.note).includes('INS-R1'))
    assert.equal(rows[0]!.status, 'pending')
    assert.equal(rows[0]!.created_by, 'system:feishu-approval', '提案创建人如实=审批插槽，不冒充 agent 服务号')
    // 老板单聊收到提案卡（不是群卡、不是文本）
    const card = mock.proposalCardsTo.find((c) => c.card.id === rows[0]!.id)
    assert.ok(card !== undefined, '老板应收到提案卡')
    assert.equal(card.openId, BOSS_OPEN_ID)
    assert.ok(card.card.createdBy.includes('费用报销'))
    assert.ok(card.card.summary.includes('320.5'))
    const created = auditRows('approval.posting.created').at(-1)
    assert.ok(created !== undefined && created.ok === 1 && created.detail.includes(rows[0]!.id) && created.detail.includes('启发式'))
    const claim = claimOf('INS-R1')
    assert.ok(claim !== undefined && claim !== 'processing', '占坑值应是完成时间')
  })

  test('全链路：老板在飞书卡片点「确认入账」→ 账本落账 type=reimburse、approved_by=boss、source=confirm', async () => {
    const proposalId = proposalsByOrigin('INS-R1')[0]!.id
    const result = await mock.emitCardAction({ platform: 'mock', platformUserid: BOSS_OPEN_ID, conversationId: 'p2p-boss', proposalId, action: 'confirm' })
    assert.equal(result, 'confirmed')
    const p = db.prepare('SELECT status, entry_id FROM finance_proposals WHERE id = ?').get(proposalId) as { status: string; entry_id: string }
    assert.equal(p.status, 'confirmed')
    const entry = db.prepare('SELECT type, amount_cents, counterparty, account, approved_by, date, status FROM finance_entries WHERE id = ?').get(p.entry_id) as Record<string, unknown>
    assert.equal(entry.type, 'reimburse')
    assert.equal(entry.amount_cents, 32050)
    assert.equal(entry.counterparty, '张三')
    assert.equal(entry.account, '招行对公')
    assert.equal(entry.approved_by, 'boss')
    assert.equal(entry.date, '2026-11-01', '记账日期取审批通过时刻（end_time）')
    assert.ok(auditRows('proposal.confirm').some((x) => x.detail.includes(p.entry_id)))
  })

  test('幂等双保险：同实例重推事件撞占坑不建第二笔；占坑被清后重跑由 origin 查重挡下', async () => {
    mock.proposalCardsTo.length = 0
    assert.equal(await approval.handleEvent({ instanceCode: 'INS-R1' }), 'duplicate')
    assert.equal(proposalsByOrigin('INS-R1').length, 1)
    // 模拟崩溃遗留被 30 分钟清理：坑没了，事件再来——建提案前先按 origin 查重
    db.prepare('DELETE FROM app_meta WHERE key = ?').run('feishu.approval.instance.INS-R1')
    assert.equal(await approval.handleEvent({ instanceCode: 'INS-R1' }), 'posted')
    assert.equal(proposalsByOrigin('INS-R1').length, 1, '不建第二笔')
    assert.equal(mock.proposalCardsTo.length, 0, '不重发卡')
    assert.ok(auditRows('approval.posting.duplicate').some((x) => x.detail.includes('INS-R1') || x.detail.includes('PROP-')))
    assert.notEqual(claimOf('INS-R1'), undefined, '重跑后重新落坑')
  })

  test('被拒/撤销的审批单：不建提案，审计 closed，落坑避免补抓反复吃', async () => {
    details['INS-R2'] = { status: 'REJECTED', approval_code: REIMBURSE_CODE, open_id: 'ou_zhangsan', form: reimburseForm('99') }
    assert.equal(await approval.handleEvent({ instanceCode: 'INS-R2' }), 'closed')
    assert.equal(proposalsByOrigin('INS-R2').length, 0)
    assert.notEqual(claimOf('INS-R2'), undefined)
    assert.ok(auditRows('approval.instance.closed').some((x) => x.detail.includes('REJECTED')))
  })

  test('金额解析不出 → 不建提案不假成功：老板收文本通知手工登记 + 审计 unresolved；申请人退到平台绑定名', async () => {
    details['INS-R3'] = { status: 'APPROVED', approval_code: REIMBURSE_CODE, open_id: 'ou_lisi', serial_number: '7', form: reimburseForm(undefined, '打车') }
    mock.userTexts.length = 0
    assert.equal(await approval.handleEvent({ instanceCode: 'INS-R3' }), 'posted')
    assert.equal(proposalsByOrigin('INS-R3').length, 0)
    const text = mock.userTexts.find((t) => t.openId === BOSS_OPEN_ID)
    assert.ok(text !== undefined && text.text.includes('读不到金额') && text.text.includes('lisi') && text.text.includes('打车') && text.text.includes('单号 7'))
    const un = auditRows('approval.posting.unresolved').at(-1)
    assert.ok(un !== undefined && un.detail.includes('amount/number'))
    assert.notEqual(claimOf('INS-R3'), undefined, '已如实处置，落坑不重试')
  })

  test('飞书自带报销模板形状（顶层 formula 总额 + 明细表子行 amount）：启发式只看顶层——命中「费用汇总」404.5 而不是首条明细 356.5', async () => {
    const form = JSON.stringify([
      { id: 'w1', name: '报销事由', type: 'textarea', value: '客户拜访' },
      { id: 'w2', name: '费用汇总', type: 'formula', value: '404.5' },
      {
        id: 'w3',
        name: '费用明细',
        type: 'fieldList',
        value: [
          [{ id: 'c1', name: '内容', type: 'input', value: '高铁' }, { id: 'c3', name: '金额', type: 'amount', value: '356.5' }],
          [{ id: 'c1', name: '内容', type: 'input', value: '打车' }, { id: 'c3', name: '金额', type: 'amount', value: '48' }],
        ],
      },
    ])
    details['INS-F1'] = { status: 'APPROVED', approval_code: REIMBURSE_CODE, open_id: 'ou_lisi', serial_number: '9', form }
    assert.equal(await approval.handleEvent({ instanceCode: 'INS-F1' }), 'posted')
    const rows = proposalsByOrigin('INS-F1')
    assert.equal(rows.length, 1)
    assert.equal((JSON.parse(rows[0]!.payload) as Record<string, unknown>).amount, 404.5, '顶层公式总额，不是明细首行')
    const created = auditRows('approval.posting.created').at(-1)
    assert.ok(created !== undefined && created.detail.includes('费用汇总'))
    // 只有明细表、顶层没有任何金额型控件：不假成功走金额缺失分支（子行不算候选）
    details['INS-F2'] = {
      status: 'APPROVED',
      approval_code: REIMBURSE_CODE,
      open_id: 'ou_lisi',
      serial_number: '10',
      form: JSON.stringify([{ id: 'w3', name: '明细', type: 'fieldList', value: [[{ id: 'c3', name: '金额', type: 'amount', value: '99' }]] }]),
    }
    assert.equal(await approval.handleEvent({ instanceCode: 'INS-F2' }), 'posted')
    assert.equal(proposalsByOrigin('INS-F2').length, 0)
    assert.ok(auditRows('approval.posting.unresolved').at(-1)?.detail.includes('明细表子行不算'))
  })

  test('提案被账本校验挡下（该月已出数）→ 审计 failed ok=0 + 老板收失败通知 + 不建提案', async () => {
    db.prepare("INSERT INTO finance_reported_months (month, reported_at, reported_by) VALUES ('2026-09', '2026-10-01T00:00:00.000Z', 'boss')").run()
    details['INS-R4'] = {
      status: 'APPROVED',
      approval_code: REIMBURSE_CODE,
      open_id: 'ou_stranger',
      end_time: String(Date.UTC(2026, 8, 15, 8, 0, 0)),
      form: reimburseForm(50),
    }
    mock.userTexts.length = 0
    assert.equal(await approval.handleEvent({ instanceCode: 'INS-R4' }), 'posted')
    assert.equal(proposalsByOrigin('INS-R4').length, 0)
    const failed = auditRows('approval.posting.failed').at(-1)
    assert.ok(failed !== undefined && failed.ok === 0 && failed.detail.includes('已出数'))
    const text = mock.userTexts.find((t) => t.openId === BOSS_OPEN_ID)
    assert.ok(text !== undefined && text.text.includes('生成记账提案失败') && text.text.includes('已出数'))
  })

  test('字段映射规则（付款申请，type=expense）：按 custom_id 取金额/事由；申请人谁都不认识时亮 open_id', async () => {
    details['INS-P1'] = {
      status: 'APPROVED',
      approval_code: PAYMENT_CODE,
      open_id: 'ou_stranger',
      form: JSON.stringify([
        { id: 'w1', custom_id: 'pay_memo', name: '付款说明', type: 'textarea', value: '10 月物料款' },
        { id: 'w2', custom_id: 'pay_deposit', name: '定金', type: 'amount', value: '1' },
        { id: 'w3', custom_id: 'pay_total', name: '付款总额', type: 'amount', value: 12800 },
      ]),
    }
    assert.equal(await approval.handleEvent({ instanceCode: 'INS-P1' }), 'posted')
    const rows = proposalsByOrigin('INS-P1')
    assert.equal(rows.length, 1)
    const payload = JSON.parse(rows[0]!.payload) as Record<string, unknown>
    assert.equal(payload.type, 'expense')
    assert.equal(payload.amount, 12800, '映射优先于启发式（启发式会错拿到定金 1）')
    assert.equal(payload.category, '采购付款')
    assert.equal(payload.account, '')
    assert.equal(payload.counterparty, 'ou_stranger')
    assert.ok(String(payload.note).includes('10 月物料款'))
    assert.ok(auditRows('approval.posting.created').at(-1)!.detail.includes('field_map.amount'))
  })

  test('field_map.amount 指名的字段不在表单里=规则失效：fail-loud 不建提案（审查 P2-2），不静默退回启发式；reason 映射落空退启发式', async () => {
    await send('PUT', '/api/finance/posting-rules', {
      rules: [
        { code: REIMBURSE_CODE, name: '费用报销', account: '招行对公' },
        { code: PAYMENT_CODE, name: '付款申请', type: 'expense', category: '采购付款', field_map: { amount: 'gone_total', reason: 'gone_memo' } },
      ],
    })
    // 金额映射落空 → unresolved 分支：不建提案、老板收通知、审计说清是映射失效
    details['INS-P3'] = {
      status: 'APPROVED',
      approval_code: PAYMENT_CODE,
      open_id: 'ou_zhangsan',
      form: JSON.stringify([{ id: 'w2', custom_id: 'pay_deposit', name: '定金', type: 'amount', value: '1' }]),
    }
    mock.userTexts.length = 0
    assert.equal(await approval.handleEvent({ instanceCode: 'INS-P3' }), 'posted')
    assert.equal(proposalsByOrigin('INS-P3').length, 0, '不建金额来历不明的提案')
    assert.ok(auditRows('approval.posting.unresolved').at(-1)!.detail.includes('gone_total'))
    const text = mock.userTexts.find((t) => t.openId === BOSS_OPEN_ID)
    assert.ok(text !== undefined && text.text.includes('读不到金额') && text.text.includes('不在表单里'))
    // 事由映射落空只是备注退化：金额映射有效时照常建提案，note 用启发式事由
    await send('PUT', '/api/finance/posting-rules', {
      rules: [
        { code: REIMBURSE_CODE, name: '费用报销', account: '招行对公' },
        { code: PAYMENT_CODE, name: '付款申请', type: 'expense', category: '采购付款', field_map: { amount: 'pay_total', reason: 'gone_memo' } },
      ],
    })
    details['INS-P4'] = {
      status: 'APPROVED',
      approval_code: PAYMENT_CODE,
      open_id: 'ou_zhangsan',
      form: JSON.stringify([
        { id: 'w1', custom_id: 'pay_memo', name: '付款说明', type: 'textarea', value: '运费尾款' },
        { id: 'w3', custom_id: 'pay_total', name: '付款总额', type: 'amount', value: 88 },
      ]),
    }
    assert.equal(await approval.handleEvent({ instanceCode: 'INS-P4' }), 'posted')
    const rows = proposalsByOrigin('INS-P4')
    assert.equal(rows.length, 1)
    assert.ok(String(JSON.parse(rows[0]!.payload).note).includes('运费尾款'), 'reason 落空退启发式（名字含"说明"的文本值）')
  })

  test('分流不串线：本服务自建定义的 code 不进落账插槽；不在规则里的 code 审计 ignored', async () => {
    details['INS-X1'] = { status: 'APPROVED', approval_code: 'UNKNOWN-DEF', open_id: 'ou_zhangsan', form: reimburseForm(1) }
    assert.equal(await approval.handleEvent({ instanceCode: 'INS-X1' }), 'ignored')
    assert.ok(auditRows('approval.event.ignored').at(-1)!.detail.includes('落账规则'))
    assert.equal(proposalsByOrigin('INS-X1').length, 0)
    // 停用的规则等同不存在
    await send('PUT', '/api/finance/posting-rules', {
      rules: [
        { code: REIMBURSE_CODE, name: '费用报销', account: '招行对公' },
        { code: PAYMENT_CODE, name: '付款申请', type: 'expense', enabled: false },
      ],
    })
    details['INS-P2'] = { status: 'APPROVED', approval_code: PAYMENT_CODE, open_id: 'ou_zhangsan', form: reimburseForm(5) }
    assert.equal(await approval.handleEvent({ instanceCode: 'INS-P2' }), 'ignored')
    assert.notEqual(claimOf('INS-P2'), undefined, '停用规则的实例也落坑（审查 P2-1：补抓不反复重吃）')
    assert.ok(auditRows('approval.event.ignored').at(-1)!.detail.includes('停用'))
  })

  test('补抓扫到规则里的定义：停机期间批掉的报销单补建提案；统计分计 posted', async () => {
    details['INS-R5'] = { status: 'APPROVED', approval_code: REIMBURSE_CODE, open_id: 'ou_zhangsan', form: reimburseForm(66) }
    instanceLists = ['INS-R5']
    calls.length = 0
    await approval.backfillMissed('startup')
    const listCalls = calls.filter((c) => c.path.startsWith('/approval/v4/instances?'))
    assert.ok(listCalls.some((c) => c.path.includes(`approval_code=${REIMBURSE_CODE}`)), '实例列表应按报销定义 code 拉')
    assert.ok(listCalls.some((c) => c.path.includes(`approval_code=${PROVISION_CODE}`)), '自建定义照扫')
    assert.ok(listCalls.some((c) => c.path.includes(`approval_code=${PAYMENT_CODE}`)), 'codes() 不过滤 enabled（事件侧按 enabled 分流，停用规则的实例进来=ignored+落坑）')
    assert.equal(proposalsByOrigin('INS-R5').length, 1, '补抓建出提案')
    const done = auditRows('approval.backfill').at(-1)
    assert.ok(done !== undefined && done.detail.includes('"posted":1'), `补抓统计应分计 posted：${done?.detail}`)
  })

  test('预览解析：按当前规则看一张实例会解析成什么（不建提案）；不在规则里的实例 400；缺 instance_code 400', async () => {
    details['INS-R6'] = {
      status: 'PENDING',
      approval_code: REIMBURSE_CODE,
      open_id: 'ou_zhangsan',
      serial_number: 9,
      form: reimburseForm('77.7', '团建餐费'),
    }
    const before = (db.prepare('SELECT COUNT(*) AS n FROM finance_proposals').get() as { n: number }).n
    const r = await get('/api/finance/posting-rules/preview?instance_code=INS-R6')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.amount, 77.7)
    assert.equal(r.body.reason, '团建餐费')
    assert.equal(r.body.counterparty, '张三')
    assert.equal(r.body.serial_number, '9')
    assert.ok(String(r.body.amount_source).includes('启发式'))
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM finance_proposals').get() as { n: number }).n, before, '预览不建提案')
    details['INS-X2'] = { status: 'PENDING', approval_code: 'UNKNOWN-DEF', form: '[]' }
    assert.equal((await get('/api/finance/posting-rules/preview?instance_code=INS-X2')).status, 400)
    assert.equal((await get('/api/finance/posting-rules/preview')).status, 400)
  })
})

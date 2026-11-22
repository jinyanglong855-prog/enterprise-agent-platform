/** 工资单接落账（2026-11-02 财务线残余）：某月工资单全部确认 → 自动一笔 type=payroll 提案（实发合计）
 *  → 老板单聊卡 → 卡片确认落账；一致性守卫（pending 提案随撤回确认/新生成作废；已落账月锁死）；
 *  工资条推送（按名册 open_id 私聊、无 open_id 点名跳过）；CSV 导出（BOM+合计行）；权限面独立 payroll。 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import bcrypt from 'bcryptjs'

process.env.ADMIN_DATA_DIR = mkdtempSync(join(tmpdir(), 'admin-payroll-posting-test-'))
delete process.env.ADMIN_JWT_SECRET
process.env.ADMIN_BRIDGE_ENABLED = '1'
process.env.ADMIN_BRIDGE_ADAPTER = 'mock'

const appModule = await import('../src/app.module.js')
const { buildServices, createRuntimeModule, registerAuthMiddleware } = appModule
const { config } = await import('../src/config.js')
const { BridgeService } = await import('../src/bridge/bridge.service.js')
const { FinancePostingService } = await import('../src/finance/finance-posting.service.js')
const { FinancePayrollPostingService } = await import('../src/finance/finance-payroll-posting.service.js')
const { MockAdapter } = await import('../src/bridge/mock.adapter.js')
import type { BridgeTurnRunner } from '../src/bridge/bridge.types.js'
import type { Services } from '../src/app.module.js'
import type { MockAdapter as MockAdapterType } from '../src/bridge/mock.adapter.js'

const BOSS_OPEN_ID = 'ou_boss'
const MONTH = '2026-11'

describe('工资单接落账（mock 适配器）', () => {
  let app: import('@nestjs/common').INestApplication
  let base: string
  let db: import('better-sqlite3').Database
  let services: Services
  let mock: InstanceType<typeof MockAdapterType>
  let token: string
  let slipIds: number[] = []

  const auditRows = (action: string) =>
    db.prepare('SELECT ok, detail FROM audit_log WHERE action = ? ORDER BY id').all(action) as { ok: number; detail: string }[]
  const proposals = () =>
    db
      .prepare('SELECT id, status, payload, entry_id FROM finance_proposals WHERE origin = ? ORDER BY created_at')
      .all(`payroll:${MONTH}`) as { id: string; status: string; payload: string; entry_id: string | null }[]
  const get = async (path: string, t = token) => {
    const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${t}` } })
    const ct = res.headers.get('content-type') ?? ''
    return { status: res.status, body: ct.includes('json') ? ((await res.json()) as Record<string, unknown>) : {}, text: ct.includes('json') ? '' : await res.text(), headers: res.headers }
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
    const posting = new FinancePostingService(real.db, real.audit, real.proposals, real.rbac, bridge, { platform: 'mock' })
    const payrollPosting = new FinancePayrollPostingService(real.db, real.audit, posting, real.proposals, bridge, { platform: 'mock' })
    real.payslips.setPostingGuard(payrollPosting.guard())
    services = { ...real, bridge, posting, payrollPosting }
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
    // 名册：张三有 open_id（能收工资条）、李四手工登记无 open_id
    assert.equal((await send('POST', '/api/finance/employees', { name: '张三', open_id: 'ou_zhangsan', department: '销售部', hire_date: '2026-01-01', base_salary: 8000, social: 800, extra_deduct: 1000 })).status, 201)
    assert.equal((await send('POST', '/api/finance/employees', { name: '李四', department: '行政', hire_date: '2026-03-01', base_salary: 6000, social: 600 })).status, 201)
  })

  after(async () => {
    await services.bridge.shutdown()
    await app.close()
    rmSync(process.env.ADMIN_DATA_DIR!, { recursive: true, force: true })
  })

  test('状态与门槛：没单/有草稿都不能落账（手动 400 说人话）；确认到最后一张草稿才自动生成', async () => {
    let st = await get(`/api/finance/payroll-posting?month=${MONTH}`)
    assert.equal(st.status, 200)
    assert.equal(st.body.postable, false)
    assert.ok(String(st.body.reason).includes('没有工资单'))
    const gen = await send('POST', '/api/finance/payslips/generate', { month: MONTH })
    assert.equal(gen.status, 201)
    assert.equal(gen.body.created, 2)
    slipIds = (gen.body.rows as Array<{ id: number }>).map((r) => r.id)
    st = await get(`/api/finance/payroll-posting?month=${MONTH}`)
    assert.equal(st.body.postable, false)
    assert.ok(String(st.body.reason).includes('2 张草稿') && String(st.body.reason).includes('张三'))
    const manual = await send('POST', '/api/finance/payroll-posting', { month: MONTH })
    assert.equal(manual.status, 400)
    assert.ok(String(manual.body.message).includes('草稿'))
    // 确认第一张：还有草稿 → skipped，不建提案不发卡
    const c1 = await send('POST', `/api/finance/payslips/${slipIds[0]}/confirm`)
    assert.equal(c1.status, 201)
    assert.equal((c1.body.posting as { status: string }).status, 'skipped')
    assert.equal(proposals().length, 0)
    assert.equal(mock.proposalCardsTo.length, 0)
  })

  test('最后一张确认 → 自动一笔 type=payroll 提案（金额=实发合计，备注带四项合计）+ 老板单聊卡 + 审计', async () => {
    const c2 = await send('POST', `/api/finance/payslips/${slipIds[1]}/confirm`)
    assert.equal(c2.status, 201)
    const posting = c2.body.posting as { status: string; proposal: string; card: string }
    assert.equal(posting.status, 'created')
    assert.equal(posting.card, 'sent')
    const reg = await get(`/api/finance/payslips?month=${MONTH}`)
    const totals = reg.body.totals as { gross: number; net: number; tax: number }
    const rows = proposals()
    assert.equal(rows.length, 1)
    const payload = JSON.parse(rows[0]!.payload) as Record<string, unknown>
    assert.equal(payload.type, 'payroll')
    assert.equal(payload.amount, totals.net, '实发合计口径')
    assert.equal(payload.category, '工资')
    assert.equal(payload.counterparty, '张三、李四')
    assert.ok(String(payload.note).includes(`应发 ${totals.gross.toFixed(2)}`) && String(payload.note).includes('实发口径'))
    assert.equal(mock.proposalCardsTo.length, 1)
    assert.equal(mock.proposalCardsTo[0]!.openId, BOSS_OPEN_ID)
    assert.ok(mock.proposalCardsTo[0]!.card.createdBy.includes('工资单') && mock.proposalCardsTo[0]!.card.createdBy.includes('自动'))
    const created = auditRows('payroll.posting.created').at(-1)
    assert.ok(created !== undefined && created.detail.includes('"people":2') && created.detail.includes('"auto":true'))
    const st = await get(`/api/finance/payroll-posting?month=${MONTH}`)
    assert.equal(st.body.postable, false)
    assert.equal((st.body.proposal as { status: string }).status, 'pending')
    // 再手动触发=重复：提示已生成
    const dup = await send('POST', '/api/finance/payroll-posting', { month: MONTH })
    assert.equal(dup.status, 400)
    assert.ok(String(dup.body.message).includes('已生成'))
  })

  test('一致性：撤回一张确认 → pending 提案作废（rejected+审计）；重新确认 → 新提案；旧卡不重发给已作废的那张', async () => {
    const un = await send('POST', `/api/finance/payslips/${slipIds[0]}/unconfirm`)
    assert.equal(un.status, 201)
    const after1 = proposals()
    assert.equal(after1.length, 1)
    assert.equal(after1[0]!.status, 'rejected')
    assert.ok(auditRows('payroll.posting.invalidated').at(-1)?.detail.includes('撤回了确认'))
    const st = await get(`/api/finance/payroll-posting?month=${MONTH}`)
    assert.equal(st.body.proposal, null, 'rejected 的提案不算在场')
    // 改金额后重新确认：新提案按新数
    assert.equal((await send('PATCH', `/api/finance/payslips/${slipIds[0]}`, { gross: 9000 })).status, 200)
    const c = await send('POST', `/api/finance/payslips/${slipIds[0]}/confirm`)
    assert.equal((c.body.posting as { status: string }).status, 'created')
    const after2 = proposals()
    assert.equal(after2.length, 2)
    assert.equal(after2[1]!.status, 'pending')
    const reg = await get(`/api/finance/payslips?month=${MONTH}`)
    assert.equal((JSON.parse(after2[1]!.payload) as { amount: number }).amount, (reg.body.totals as { net: number }).net)
    assert.equal(mock.proposalCardsTo.length, 2)
  })

  test('老板卡片确认 → 账本落账 type=payroll；之后该月锁死：撤回确认 400、再生成 400；status 显示已落账', async () => {
    const pending = proposals().find((p) => p.status === 'pending')!
    const result = await mock.emitCardAction({ platform: 'mock', platformUserid: BOSS_OPEN_ID, conversationId: 'p2p-boss', proposalId: pending.id, action: 'confirm' })
    assert.equal(result, 'confirmed')
    const p = db.prepare('SELECT status, entry_id FROM finance_proposals WHERE id = ?').get(pending.id) as { status: string; entry_id: string }
    assert.equal(p.status, 'confirmed')
    const entry = db.prepare('SELECT type, category, approved_by FROM finance_entries WHERE id = ?').get(p.entry_id) as Record<string, unknown>
    assert.equal(entry.type, 'payroll')
    assert.equal(entry.category, '工资')
    assert.equal(entry.approved_by, 'boss')
    const un = await send('POST', `/api/finance/payslips/${slipIds[1]}/unconfirm`)
    assert.equal(un.status, 400)
    assert.ok(String(un.body.message).includes('已确认落账') && String(un.body.message).includes(p.entry_id))
    const gen = await send('POST', '/api/finance/payslips/generate', { month: MONTH })
    assert.equal(gen.status, 400)
    assert.ok(String(gen.body.message).includes('生成新的工资单'))
    const st = await get(`/api/finance/payroll-posting?month=${MONTH}`)
    assert.equal((st.body.proposal as { status: string; entry_id: string }).entry_id, p.entry_id)
    assert.ok(String(st.body.reason).includes('已落账'))
  })

  test('工资条推送：有 open_id 的私聊本人（含实发/个税）、无 open_id 的点名跳过；逐人审计不记金额', async () => {
    mock.userTexts.length = 0
    const r = await send('POST', '/api/finance/payroll-posting/push', { month: MONTH })
    assert.equal(r.status, 201)
    assert.deepEqual(r.body.sent, ['张三'])
    assert.deepEqual(r.body.skipped, [{ name: '李四', reason: '名册没有飞书 open_id' }])
    const t = mock.userTexts.find((x) => x.openId === 'ou_zhangsan')
    assert.ok(t !== undefined && t.text.includes(`【工资条】${MONTH}`) && t.text.includes('实发') && t.text.includes('个税'))
    const a = auditRows('payroll.payslip.push').at(-1)
    assert.ok(a !== undefined && a.detail.includes('张三') && !a.detail.includes('net'))
  })

  test('CSV 导出：BOM + 表头 + 两人 + 合计行；文件名带月份', async () => {
    const r = await get(`/api/finance/payroll-posting/export?month=${MONTH}`)
    assert.equal(r.status, 200)
    assert.ok((r.headers.get('content-type') ?? '').includes('text/csv'))
    assert.ok((r.headers.get('content-disposition') ?? '').includes(`payroll-${MONTH}.csv`))
    // fetch 的 text() 按规范会吞掉开头的 BOM：用原始字节核 EF BB BF
    const raw = new Uint8Array(await (await fetch(`${base}/api/finance/payroll-posting/export?month=${MONTH}`, { headers: { authorization: `Bearer ${token}` } })).arrayBuffer())
    assert.deepEqual([...raw.slice(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM 让 Excel 直接识别中文')
    assert.ok(r.text.startsWith('姓名,部门,月份'))
    const lines = r.text.trim().split('\r\n')
    assert.equal(lines.length, 4, '表头+2 人+合计')
    assert.ok(lines[1]!.startsWith('李四,行政,') || lines[1]!.startsWith('张三,销售部,'))
    assert.ok(lines[3]!.startsWith('合计,,') && lines[3]!.includes('2 人'))
  })

  test('冲销账本那笔 → 本月解锁（审查 P1-1）：提案不再算在场、撤回确认放行、重新确认建新提案不是 duplicate；新员工 generate 新草稿 → pending 提案作废', async () => {
    const confirmed = proposals().find((p) => p.status === 'confirmed')!
    const rev = await send('POST', `/api/finance/entries/${confirmed.entry_id}/reverse`, { reason: '工资算错，重出' })
    assert.equal(rev.status, 201, JSON.stringify(rev.body))
    const st = await get(`/api/finance/payroll-posting?month=${MONTH}`)
    assert.equal(st.body.proposal, null, '账本冲销后，已确认的提案不再算在场')
    assert.equal(st.body.postable, true)
    const un = await send('POST', `/api/finance/payslips/${slipIds[1]}/unconfirm`)
    assert.equal(un.status, 201, '冲销后撤回确认放行')
    assert.equal((await send('PATCH', `/api/finance/payslips/${slipIds[1]}`, { gross: 6500 })).status, 200)
    const c = await send('POST', `/api/finance/payslips/${slipIds[1]}/confirm`)
    assert.equal(c.status, 201)
    assert.equal((c.body.posting as { status: string }).status, 'created', '同一 origin 重新生成，不被已冲销那笔挡成 duplicate')
    assert.equal(proposals().filter((p) => p.status === 'pending').length, 1)
    assert.equal(proposals().filter((p) => p.status === 'confirmed').length, 1, '被冲销那笔提案仍是 confirmed（历史不改），只是不再算在场')
    // 新员工入职 → generate 出他的草稿 → 旧 pending 提案的数不作数：作废 + 审计
    assert.equal(
      (await send('POST', '/api/finance/employees', { name: '王五', open_id: 'ou_wangwu', department: '销售部', hire_date: `${MONTH}-05`, base_salary: 5000, social: 500 })).status,
      201,
    )
    const gen = await send('POST', '/api/finance/payslips/generate', { month: MONTH })
    assert.equal(gen.status, 201)
    assert.equal(gen.body.created, 1)
    assert.equal(proposals().filter((p) => p.status === 'pending').length, 0, 'generate 新草稿即作废 pending 提案')
    assert.ok(auditRows('payroll.posting.invalidated').at(-1)?.detail.includes('新生成了 1 张'))
    const st2 = await get(`/api/finance/payroll-posting?month=${MONTH}`)
    assert.equal(st2.body.postable, false)
    assert.ok(String(st2.body.reason).includes('1 张草稿') && String(st2.body.reason).includes('王五'))
    const wangwu = (gen.body.rows as Array<{ id: number; employee_name: string }>).find((r) => r.employee_name === '王五')!
    const c3 = await send('POST', `/api/finance/payslips/${wangwu.id}/confirm`)
    assert.equal((c3.body.posting as { status: string }).status, 'created')
    const reg = await get(`/api/finance/payslips?month=${MONTH}`)
    const latest = proposals().filter((p) => p.status === 'pending').at(-1)!
    assert.equal((JSON.parse(latest.payload) as { amount: number }).amount, (reg.body.totals as { net: number }).net, '新提案按三人实发合计')
    // CSV 文本列防公式注入：备注以 = 开头的前置制表符（审查 P3-1）；合计行六个金额列齐全（审查 P3-2）
    assert.equal((await send('POST', `/api/finance/payslips/${wangwu.id}/unconfirm`)).status, 201)
    assert.equal((await send('PATCH', `/api/finance/payslips/${wangwu.id}`, { note: '=HYPERLINK("x")' })).status, 200)
    const csv = await get(`/api/finance/payroll-posting/export?month=${MONTH}`)
    const lines = csv.text.trim().split('\r\n')
    assert.ok(lines.some((l) => l.includes('\t=HYPERLINK')), '以 = 开头的文本前置制表符')
    const total = lines.at(-1)!.split(',')
    assert.equal(total[0], '合计')
    assert.ok(total.slice(3, 9).every((c) => /^\d+\.\d{2}$/.test(c)), `合计行六个金额列都要有数：${lines.at(-1)}`)
  })

  test('权限面：只有财务权限的账号读不了落账状态/导出（payroll:read 独立）', async () => {
    await send('POST', '/api/rbac/roles', { name: 'ledger-only', permissions: ['finance:read', 'finance:write'] })
    db.prepare('INSERT INTO users (username, password_hash, display_name, created_at) VALUES (?, ?, ?, ?)').run('clerk-pp', bcrypt.hashSync('Clerk-PP-Pass-1', 10), '记账员', new Date().toISOString())
    await send('POST', '/api/rbac/users/clerk-pp/roles', { role: 'ledger-only' })
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'clerk-pp', password: 'Clerk-PP-Pass-1' }) })
    const clerkToken = ((await login.json()) as { token: string }).token
    assert.equal((await get(`/api/finance/payroll-posting?month=${MONTH}`, clerkToken)).status, 403)
    assert.equal((await get(`/api/finance/payroll-posting/export?month=${MONTH}`, clerkToken)).status, 403)
    assert.equal((await send('POST', '/api/finance/payroll-posting/push', { month: MONTH }, clerkToken)).status, 403)
  })
})

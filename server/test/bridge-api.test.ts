/** 融合层 P0 基座全链路（mock 适配器，2026-10-28 融合架构方案）：
 *  白名单默认拒绝 → 消息桥入（会话映射/审计 source=bridge）→ 轮次内提案自动补卡 →
 *  卡片确认/拒绝落库（账本审计 source=confirm）→ 重推去重/长消息/批量卡边界。
 *  agent 轮次用桩替换（不 spawn DSH 子进程）；会话创建/提案域/审计用真实现。 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ADMIN_DATA_DIR = mkdtempSync(join(tmpdir(), 'admin-bridge-test-'))
delete process.env.ADMIN_JWT_SECRET
process.env.ADMIN_BRIDGE_ENABLED = '1'
process.env.ADMIN_BRIDGE_ADAPTER = 'mock'

const appModule = await import('../src/app.module.js')
const { buildServices, createRuntimeModule, registerAuthMiddleware } = appModule
const { config } = await import('../src/config.js')
const { BridgeService } = await import('../src/bridge/bridge.service.js')
const { MockAdapter } = await import('../src/bridge/mock.adapter.js')
import type { BridgeAdapter, BridgeTurnRunner } from '../src/bridge/bridge.types.js'
import type { Services } from '../src/app.module.js'
import type { MockAdapter as MockAdapterType } from '../src/bridge/mock.adapter.js'

/** 真实平台桩（isReal=true）：钉拒连闸用，不连任何东西。 */
class RealAdapterStub implements BridgeAdapter {
  readonly platform = 'feishu-stub'
  readonly isReal = true
  connected = false
  startCalls = 0
  async start(): Promise<void> {
    this.startCalls += 1
    this.connected = true
  }
  async stop(): Promise<void> {
    this.connected = false
  }
  async sendText(): Promise<void> {}
  async sendProposalCard(): Promise<void> {}
  async sendUserText(): Promise<void> {}
  async sendUserCard(): Promise<void> {}
  async sendBindRequestCard(): Promise<void> {}
  async markProposalCardProcessed(): Promise<void> {}
  onMessage(): void {}
  onCardAction(): void {}
}

describe('融合层 P0 基座（mock 适配器全链路）', () => {
  let app: import('@nestjs/common').INestApplication
  let base: string
  let token: string
  let db: import('better-sqlite3').Database
  let services: Services
  let mock: InstanceType<typeof MockAdapterType>
  let chatCalls = 0
  let lastChatSource: string | undefined

  const get = (path: string) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } })
  const send = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const emit = (platformUserid: string, conversationId: string, text: string, msgId: string) =>
    mock.emitMessage({ platform: 'mock', platformUserid, conversationId, text, msgId })
  const tapCard = (proposalId: string, action: 'confirm' | 'reject', reason?: string, messageId?: string) =>
    mock.emitCardAction({ platform: 'mock', platformUserid: 'u-boss', conversationId: 'c-1', proposalId, action, reason, messageId })

  before(async () => {
    const real = buildServices()
    db = real.db
    const svcUser = real.rbac.agentServiceUsername()!
    const runner: BridgeTurnRunner = {
      createSession: (username) => real.agent.createSession(username),
      chat: async (sessionId, message, _context, username, onEvent, source) => {
        chatCalls += 1
        lastChatSource = source
        onEvent({ event: 'assistant', data: { text: 'stub' } })
        if (message.includes('记一笔')) {
          // 真实 runtime 里提案由最小权限服务号创建（2026-10-28 起 agent 令牌不再是 boss）
          real.proposals.create(
            { username: svcUser, source: 'agent' },
            { type: 'expense', amount: 45, counterparty: '打印纸', date: '2026-10-28' },
          )
        }
        if (message.includes('导入一批')) {
          real.proposals.createImport(
            { username: svcUser, source: 'agent' },
            [
              { type: 'income', amount: 100, date: '2026-10-28', counterparty: '甲' },
              { type: 'income', amount: 200, date: '2026-10-28', counterparty: '乙' },
            ],
            '测试批',
          )
        }
        return { finalText: `stub 回答：${message}` }
      },
    }
    const bridge = new BridgeService(real.db, real.audit, real.proposals, runner, real.rbac)
    mock = new MockAdapter()
    bridge.registerAdapter(mock)
    services = { ...real, bridge }
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
    token = ((await res.json()) as { token: string }).token
    await services.bridge.start()
  })

  after(async () => {
    await services.bridge.shutdown()
    await app.close()
    rmSync(process.env.ADMIN_DATA_DIR!, { recursive: true, force: true })
  })

  test('状态与白名单 REST：未登录 401 → status 反映桥接已连 → 建映射（默认拒绝）→ 开关放行', async () => {
    assert.equal((await fetch(`${base}/api/bridge/status`)).status, 401)
    const bad = await send('POST', '/api/bridge/identities', { platform: 'mock', platformUserid: 'u-boss', username: '不存在的人' })
    assert.equal(bad.status, 400)
    const created = await send('POST', '/api/bridge/identities', { platform: 'mock', platformUserid: 'u-boss', username: 'boss' })
    assert.equal(created.status, 201)
    const list1 = (await (await get('/api/bridge/identities')).json()) as { identities: { allowed: number }[] }
    assert.equal(list1.identities[0]!.allowed, 0)
    const patched = await send('PATCH', '/api/bridge/identities/mock/u-boss', { allowed: true, displayName: '老板的平台号' })
    assert.equal(patched.status, 200)
    const status = (await (await get('/api/bridge/status')).json()) as { enabled: boolean; configuredAdapter: string; connected: boolean; registeredAdapters: string[] }
    assert.equal(status.enabled, true)
    assert.equal(status.configuredAdapter, 'mock')
    assert.equal(status.connected, true)
    assert.ok(status.registeredAdapters.includes('mock'))
  })

  test('白名单外用户：消息被拒、不建会话、审计留痕、指路 OA 审批（2026-10-29 起不走对话卡）', async () => {
    const sessionsBefore = (db.prepare('SELECT COUNT(*) AS n FROM agent_sessions').get() as { n: number }).n
    await emit('stranger', 'c-stranger', '你好', 'm-stranger-1')
    assert.match(mock.texts.at(-1)!.text, /智能体系统账号开通/)
    assert.match(mock.texts.at(-1)!.text, /审批/)
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM agent_sessions').get() as { n: number }).n, sessionsBefore)
    const log = db.prepare("SELECT ok FROM audit_log WHERE action = 'bridge.message.reject'").get() as { ok: number }
    assert.equal(log.ok, 0)
  })

  test('白名单用户闲聊：轮次走通、终文回平台、审计 source=bridge、会话映射建立', async () => {
    await emit('u-boss', 'c-1', '在吗', 'm-1')
    assert.equal(chatCalls, 1)
    assert.equal(lastChatSource, 'bridge')
    assert.equal(mock.texts.at(-1)!.text, 'stub 回答：在吗')
    // 轮次内的 agent.chat 审计由真 chat() 写（本测试用桩不产生）；桥入留痕断 bridge.message 行
    const log = db
      .prepare("SELECT username, source FROM audit_log WHERE action = 'bridge.message' ORDER BY id DESC LIMIT 1")
      .get() as { username: string; source: string }
    assert.equal(log.username, 'boss')
    assert.equal(log.source, 'bridge')
    const mapping = db
      .prepare('SELECT session_id FROM bridge_sessions WHERE platform = ? AND conversation_id = ?')
      .get('mock', 'c-1') as { session_id: string }
    const session = db.prepare('SELECT created_by FROM agent_sessions WHERE id = ?').get(mapping.session_id) as { created_by: string }
    assert.equal(session.created_by, 'boss')
  })

  test('记账消息 → 提案自动补卡 → 平台点确认 → 落库审计 source=confirm，重复确认被拒', async () => {
    await emit('u-boss', 'c-1', '记一笔 45 元打印纸', 'm-2')
    assert.equal(mock.cards.length, 1)
    const card = mock.cards[0]!.card
    assert.match(card.summary, /支出 45 元/)
    await tapCard(card.id, 'confirm')
    const reply = mock.texts.at(-1)!.text
    assert.match(reply, /已入账/)
    const prop = db.prepare('SELECT entry_id FROM finance_proposals WHERE id = ?').get(card.id) as { entry_id: string }
    const entry = db.prepare('SELECT approved_by FROM finance_entries WHERE id = ?').get(prop.entry_id) as { approved_by: string }
    assert.equal(entry.approved_by, 'boss')
    const confirmLog = db
      .prepare("SELECT source FROM audit_log WHERE action = 'proposal.confirm' ORDER BY id DESC LIMIT 1")
      .get() as { source: string }
    assert.equal(confirmLog.source, 'confirm')
    const bridgeLog = db
      .prepare("SELECT source FROM audit_log WHERE action = 'bridge.card.action' ORDER BY id DESC LIMIT 1")
      .get() as { source: string }
    assert.equal(bridgeLog.source, 'bridge')
    await tapCard(card.id, 'confirm')
    assert.match(mock.texts.at(-1)!.text, /已处理过/)
  })

  test('卡片拒绝：提案转 rejected 并回文本', async () => {
    await emit('u-boss', 'c-1', '记一笔 45 元打印纸', 'm-3')
    const card = mock.cards.at(-1)!.card
    await tapCard(card.id, 'reject', '金额不对')
    assert.match(mock.texts.at(-1)!.text, /已拒绝.*金额不对/)
    const row = db.prepare('SELECT status FROM finance_proposals WHERE id = ?').get(card.id) as { status: string }
    assert.equal(row.status, 'rejected')
  })

  test('卡片动作返回处理结果：确认→confirmed、重复点击（已终态）照样返回、拒绝→rejected（改脸依据）', async () => {
    await emit('u-boss', 'c-1', '记一笔 45 元打印纸', 'm-face1')
    const card = mock.cards.at(-1)!.card
    const outcome = await tapCard(card.id, 'confirm', undefined, 'om_face1')
    assert.equal(outcome, 'confirmed')
    // 第二遍点同一张卡：业务层报"已处理过"，返回值照样给终态——平台好把卡面改脸，
    // 不然用户以为没生效再点第三遍（2026-10-29 真机冒烟实证）
    const again = await tapCard(card.id, 'confirm', undefined, 'om_face1')
    assert.equal(again, 'confirmed')
    assert.match(mock.texts.at(-1)!.text, /已处理过/)
    await emit('u-boss', 'c-1', '记一笔 45 元打印纸', 'm-face2')
    const card2 = mock.cards.at(-1)!.card
    assert.equal(await tapCard(card2.id, 'reject', undefined, 'om_face2'), 'rejected')
  })

  test('白名单外的卡片点击：无处理结果返回（平台只收纯应答，卡面不动）', async () => {
    const outcome = await mock.emitCardAction({
      platform: 'mock',
      platformUserid: 'u-stranger',
      conversationId: 'c-1',
      proposalId: 'PROP-不动',
      action: 'confirm',
    })
    assert.equal(outcome, undefined)
  })

  test('批量导入卡不桥接：只回指路文本，不出平台卡片', async () => {
    const cardsBefore = mock.cards.length
    await emit('u-boss', 'c-1', '帮我导入一批流水', 'm-4')
    assert.equal(mock.cards.length, cardsBefore)
    assert.match(mock.texts.at(-2)!.text, /stub 回答/)
    assert.match(mock.texts.at(-1)!.text, /管理后台/)
  })

  test('平台重推去重：同 msgId 只跑一轮', async () => {
    const before = chatCalls
    await emit('u-boss', 'c-1', '第二条消息', 'm-dup')
    await emit('u-boss', 'c-1', '第二条消息', 'm-dup')
    assert.equal(chatCalls, before + 1)
  })

  test('超长消息拒收并回指引，不进轮次', async () => {
    const before = chatCalls
    await emit('u-boss', 'c-1', '长'.repeat(4001), 'm-long')
    assert.match(mock.texts.at(-1)!.text, /上限/)
    assert.equal(chatCalls, before)
  })

  test('映射的会话被删后：自动重建新会话续聊不中断', async () => {
    const mapping = db
      .prepare('SELECT session_id FROM bridge_sessions WHERE platform = ? AND conversation_id = ?')
      .get('mock', 'c-1') as { session_id: string }
    db.prepare('DELETE FROM agent_messages WHERE session_id = ?').run(mapping.session_id)
    db.prepare('DELETE FROM agent_sessions WHERE id = ?').run(mapping.session_id)
    await emit('u-boss', 'c-1', '换个会话继续', 'm-5')
    assert.equal(mock.texts.at(-1)!.text, 'stub 回答：换个会话继续')
    const newMapping = db
      .prepare('SELECT session_id FROM bridge_sessions WHERE platform = ? AND conversation_id = ?')
      .get('mock', 'c-1') as { session_id: string }
    assert.notEqual(newMapping.session_id, mapping.session_id)
  })

  test('补卡只认本轮：轮次前已积压的旧提案不往平台倾倒', async () => {
    // 旧提案按"老板在网页 REST 建的"造（created_by=boss，非服务号）——服务号在轮次里出的才补卡；
    // 再把 created_at 改到过去做双保险
    const old = services.proposals.create(
      { username: 'boss', source: 'ui' },
      { type: 'expense', amount: 1, counterparty: '积压旧账', date: '2026-10-01' },
    )
    db.prepare('UPDATE finance_proposals SET created_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', old.id)
    const cardsBefore = mock.cards.length
    await emit('u-boss', 'c-1', '记一笔 45 元打印纸', 'm-new-card')
    assert.equal(mock.cards.length, cardsBefore + 1)
    const newIds = mock.cards.slice(cardsBefore).map((c) => c.card.id)
    assert.ok(!newIds.includes(old.id), '积压旧提案不该出卡')
  })

  test('服务号提案才补卡：老板自己经 REST 建的提案不出平台卡', async () => {
    const cardsBefore = mock.cards.length
    // 本轮不产生提案的闲聊，但轮次开始前一刻有老板自建的新提案（服务号之外）
    services.proposals.create(
      { username: 'boss', source: 'ui' },
      { type: 'expense', amount: 2, counterparty: '老板手建', date: '2026-10-28' },
    )
    await emit('u-boss', 'c-1', '在吗在吗', 'm-no-card')
    assert.equal(mock.cards.length, cardsBefore)
  })

  test('RBAC 闸：映射到零权限用户的平台号，消息与卡片动作都被拒（与 REST 同权）', async () => {
    const bcrypt = (await import('bcryptjs')).default
    db.prepare(
      "INSERT INTO users (username, password_hash, display_name, is_service, created_at) VALUES ('limited', ?, '受限号', 0, ?)",
    ).run(bcrypt.hashSync('limited-2026', 10), new Date().toISOString())
    const created = await send('POST', '/api/bridge/identities', { platform: 'mock', platformUserid: 'u-limited', username: 'limited', allowed: true })
    assert.equal(created.status, 201)
    await emit('u-limited', 'c-limited', '在吗', 'm-limited-1')
    assert.match(mock.texts.at(-1)!.text, /没有对话权限/)
    const rejectLog = db
      .prepare("SELECT detail FROM audit_log WHERE action = 'bridge.message.reject' ORDER BY id DESC LIMIT 1")
      .get() as { detail: string }
    assert.match(rejectLog.detail, /agent:write/)
    await mock.emitCardAction({ platform: 'mock', platformUserid: 'u-limited', conversationId: 'c-limited', proposalId: 'PROP-20260101-001', action: 'confirm' })
    assert.match(mock.texts.at(-1)!.text, /没有记账权限/)
  })

  test('服务账号不能被映射成平台身份', async () => {
    const bcrypt = (await import('bcryptjs')).default
    db.prepare(
      "INSERT INTO users (username, password_hash, display_name, is_service, created_at) VALUES ('svc-bot', ?, '服务号', 1, ?)",
    ).run(bcrypt.hashSync('svc-2026-xx', 10), new Date().toISOString())
    const res = await send('POST', '/api/bridge/identities', { platform: 'mock', platformUserid: 'u-svc', username: 'svc-bot' })
    assert.equal(res.status, 400)
  })

  test('非文本消息：白名单内过闸后回指引；白名单外与文本消息同一套指路语（探测面收口）', async () => {
    await mock.emitMessage({ platform: 'mock', platformUserid: 'u-boss', conversationId: 'c-1', text: '', msgId: 'm-img-1', unsupported: true })
    assert.match(mock.texts.at(-1)!.text, /承接不了/)
    await mock.emitMessage({ platform: 'mock', platformUserid: 'stranger', conversationId: 'c-stranger', text: '', msgId: 'm-img-2', unsupported: true })
    assert.match(mock.texts.at(-1)!.text, /审批/)
  })

  test('真实平台拒连闸：服务号在位放行、停用即拒（二轮对抗审查 P2-1：闸必须有测试钉住）', async () => {
    const runner: BridgeTurnRunner = {
      createSession: (username) => services.agent.createSession(username),
      chat: async () => ({ finalText: '' }),
    }
    const makeBridge = () => {
      const b = new BridgeService(db, services.audit, services.proposals, runner, services.rbac)
      const adapter = new RealAdapterStub()
      b.registerAdapter(adapter)
      return { b, adapter }
    }
    // 服务号在位：真实适配器放行连接
    const up = makeBridge()
    config.bridgeAdapter = 'feishu-stub'
    try {
      await up.b.start()
      assert.equal(up.adapter.startCalls, 1)
      await up.b.shutdown()
      // 服务号停用：闸拒绝连接（agentServiceUsername → undefined），适配器 start 一次都没被调
      db.prepare("UPDATE users SET disabled_at = ? WHERE username = 'agent'").run(new Date().toISOString())
      const down = makeBridge()
      await down.b.start()
      assert.equal(down.adapter.startCalls, 0)
      assert.equal(down.adapter.connected, false)
      await down.b.shutdown()
    } finally {
      db.prepare("UPDATE users SET disabled_at = NULL WHERE username = 'agent'").run()
      config.bridgeAdapter = 'mock'
    }
  })

  test('关停后 connected 翻 false，重启恢复', async () => {
    await services.bridge.shutdown()
    assert.equal(((await (await get('/api/bridge/status')).json()) as { connected: boolean }).connected, false)
    await services.bridge.start()
    assert.equal(((await (await get('/api/bridge/status')).json()) as { connected: boolean }).connected, true)
  })
})

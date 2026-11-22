/** 飞书 adapter 单测：假客户端钉归一化行为（消息/卡片回调形状按 SDK 实测扁平化结构）；不真连。 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { FeishuAdapter, type FeishuClientLike, type FeishuWsLike } from '../src/bridge/feishu.adapter.js'
import type { CardAction, InboundMessage } from '../src/bridge/bridge.types.js'
import { config } from '../src/config.js'

function makeFakeClient(opts: { failCode?: number } = {}): {
  client: FeishuClientLike
  sends: Array<{ receiveId: string; msgType: string; content: string }>
} {
  const sends: Array<{ receiveId: string; msgType: string; content: string }> = []
  const client: FeishuClientLike = {
    im: {
      v1: {
        message: {
          create: async (payload) => {
            sends.push({ receiveId: payload.data.receive_id, msgType: payload.data.msg_type, content: payload.data.content })
            if (opts.failCode !== undefined) return { code: opts.failCode, msg: '假失败' }
            return { code: 0, data: { message_id: `om_fake_${sends.length}` } }
          },
        },
      },
    },
  }
  return { client, sends }
}

function makeFakeWs(): { ws: FeishuWsLike; state: { started: number; closed: number; status: string } } {
  const state = { started: 0, closed: 0, status: 'idle' }
  const ws: FeishuWsLike = {
    start: async () => {
      state.started += 1
      state.status = 'connected'
    },
    close: () => {
      state.closed += 1
      state.status = 'idle'
    },
    getConnectionStatus: () => ({ state: state.status }),
  }
  return { ws, state }
}

describe('feishu adapter', () => {
  const savedAppId = config.feishuAppId
  const savedAppSecret = config.feishuAppSecret

  test.afterEach(() => {
    config.feishuAppId = savedAppId
    config.feishuAppSecret = savedAppSecret
  })

  test('缺凭据时 start 拒绝（bridge start 闸会接住并保持未连接）', async () => {
    config.feishuAppId = ''
    config.feishuAppSecret = ''
    const adapter = new FeishuAdapter()
    await assert.rejects(adapter.start(), /缺少飞书凭据/)
    assert.equal(adapter.connected, false)
  })

  test('App ID 形状不对大声拒绝（SDK 对非法 appId 静默放弃不重连，这里预检；顺带钉住 trim）', async () => {
    config.feishuAppId = ' cli_bad '
    config.feishuAppSecret = ' secret '
    const adapter = new FeishuAdapter()
    await assert.rejects(adapter.start(), /形状不对/)
    assert.equal(adapter.connected, false)
  })

  test('注入的假客户端不成对（只给 client）直接拒绝', async () => {
    const { client } = makeFakeClient()
    const adapter = new FeishuAdapter({ client })
    await assert.rejects(adapter.start(), /必须成对/)
  })

  test('注入假客户端后 start/stop 幂等且状态如实', async () => {
    const { client } = makeFakeClient()
    const { ws, state } = makeFakeWs()
    const adapter = new FeishuAdapter({ client, wsClient: ws })
    assert.equal(adapter.connected, false)
    await adapter.start()
    await adapter.start() // 幂等
    assert.equal(state.started, 1)
    assert.equal(adapter.connected, true)
    await adapter.stop()
    await adapter.stop() // 幂等
    assert.equal(state.closed, 1)
    assert.equal(adapter.connected, false)
  })

  test('文本消息归一为 InboundMessage；@机器人占位符剥掉；sendText 走 chat_id', async () => {
    const { client, sends } = makeFakeClient()
    const { ws } = makeFakeWs()
    const adapter = new FeishuAdapter({ client, wsClient: ws })
    await adapter.start()
    const got: InboundMessage[] = []
    adapter.onMessage(async (m) => {
      got.push(m)
    })
    await adapter.sendText('oc_chat1', '你好')
    assert.deepEqual(sends[0], {
      receiveId: 'oc_chat1',
      msgType: 'text',
      content: JSON.stringify({ text: '你好' }),
    })

    await adapter.handleMessageEvent({
      sender: { sender_id: { open_id: 'ou_boss' }, sender_type: 'user' },
      message: {
        message_id: 'om_1',
        chat_id: 'oc_chat1',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 帮我记一笔打车 32 元' }),
      },
    })
    assert.equal(got.length, 1)
    assert.deepEqual(got[0], {
      platform: 'feishu',
      platformUserid: 'ou_boss',
      conversationId: 'oc_chat1',
      text: '帮我记一笔打车 32 元',
      msgId: 'om_1',
    })
  })

  test('纯 @机器人（剥完为空）/缺发件人/缺会话 id/坏 content 的消息不进 handler', async () => {
    const { client } = makeFakeClient()
    const { ws } = makeFakeWs()
    const adapter = new FeishuAdapter({ client, wsClient: ws })
    await adapter.start()
    let calls = 0
    adapter.onMessage(async () => {
      calls += 1
    })
    await adapter.handleMessageEvent({
      sender: { sender_id: { open_id: 'ou_boss' } },
      message: { message_id: 'om_2', chat_id: 'oc_chat1', message_type: 'text', content: JSON.stringify({ text: '@_user_1 ' }) },
    })
    await adapter.handleMessageEvent({
      sender: {},
      message: { message_id: 'om_3', chat_id: 'oc_chat1', message_type: 'text', content: JSON.stringify({ text: 'hi' }) },
    })
    await adapter.handleMessageEvent({
      sender: { sender_id: { open_id: 'ou_boss' } },
      message: { message_id: 'om_4', chat_id: 'oc_chat1', message_type: 'text', content: '不是 JSON' },
    })
    await adapter.handleMessageEvent({ sender: {}, message: {} })
    assert.equal(calls, 0)
  })

  test('非文本消息：按 unsupported 标记交 handler，adapter 不直接回信（指引由 BridgeService 过闸后回）', async () => {
    const { client, sends } = makeFakeClient()
    const { ws } = makeFakeWs()
    const adapter = new FeishuAdapter({ client, wsClient: ws })
    await adapter.start()
    const got: InboundMessage[] = []
    adapter.onMessage(async (m) => {
      got.push(m)
    })
    await adapter.handleMessageEvent({
      sender: { sender_id: { open_id: 'ou_boss' } },
      message: {
        message_id: 'om_5',
        chat_id: 'oc_chat1',
        message_type: 'image',
        content: JSON.stringify({ image_key: 'img_v2_x' }),
      },
    })
    assert.equal(got.length, 1)
    assert.deepEqual(got[0], {
      platform: 'feishu',
      platformUserid: 'ou_boss',
      conversationId: 'oc_chat1',
      text: '',
      msgId: 'om_5',
      unsupported: true,
    })
    assert.equal(sends.length, 0)
  })

  test('提案卡渲染 v1 互动卡片：两个按钮 value 携带 proposalId 与动作', async () => {
    const { client, sends } = makeFakeClient()
    const { ws } = makeFakeWs()
    const adapter = new FeishuAdapter({ client, wsClient: ws })
    await adapter.start()
    await adapter.sendProposalCard('oc_chat1', {
      id: 'FIN-20261028-0001',
      summary: '打车 32 元',
      createdBy: 'agent',
      createdAt: '2026-10-28T10:00:00.000+08:00',
    })
    assert.equal(sends.length, 1)
    assert.equal(sends[0]?.msgType, 'interactive')
    const card = JSON.parse(sends[0]?.content ?? '{}') as {
      header: { title: { content: string } }
      elements: Array<{
        tag: string
        text?: { content?: string }
        actions?: Array<{ value: { proposalId: string; action: string }; type: string }>
      }>
    }
    assert.ok(card.header.title.content.includes('FIN-20261028-0001'))
    const actionEl = card.elements.find((e) => e.tag === 'action')
    const buttons = actionEl?.actions ?? []
    assert.equal(buttons.length, 2)
    assert.deepEqual(buttons[0]?.value, { proposalId: 'FIN-20261028-0001', action: 'confirm' })
    assert.deepEqual(buttons[1]?.value, { proposalId: 'FIN-20261028-0001', action: 'reject' })
  })

  test('卡片回调归一：v2 扁平形状（context/operator/action）→ CardAction', async () => {
    const { client } = makeFakeClient()
    const { ws } = makeFakeWs()
    const adapter = new FeishuAdapter({ client, wsClient: ws })
    await adapter.start()
    const got: CardAction[] = []
    adapter.onCardAction(async (a) => {
      got.push(a)
    })
    await adapter.handleCardEvent({
      operator: { open_id: 'ou_boss' },
      action: { value: { proposalId: 'FIN-20261028-0001', action: 'confirm' }, tag: 'button' },
      context: { open_message_id: 'om_card1', open_chat_id: 'oc_chat1' },
    })
    assert.deepEqual(got, [
      {
        platform: 'feishu',
        platformUserid: 'ou_boss',
        conversationId: 'oc_chat1',
        kind: 'proposal',
        proposalId: 'FIN-20261028-0001',
        action: 'confirm',
        messageId: 'om_card1',
      },
    ])
  })

  test('卡片回调归一：context.open_message_id 一并带出（改脸用），顶层兜底；都没有则缺省 undefined', async () => {
    const { client } = makeFakeClient()
    const { ws } = makeFakeWs()
    const adapter = new FeishuAdapter({ client, wsClient: ws })
    await adapter.start()
    const got: CardAction[] = []
    adapter.onCardAction(async (a) => {
      got.push(a)
    })
    await adapter.handleCardEvent({
      operator: { open_id: 'ou_boss' },
      action: { value: { proposalId: 'FIN-1', action: 'confirm' } },
      context: { open_chat_id: 'oc_chat1' },
    })
    await adapter.handleCardEvent({
      operator: { open_id: 'ou_boss' },
      action: { value: { proposalId: 'FIN-1', action: 'reject' } },
      open_chat_id: 'oc_top',
      open_message_id: 'om_top',
    })
    assert.equal(got.length, 2)
    assert.equal(got[0]?.messageId, undefined)
    assert.equal(got[1]?.messageId, 'om_top')
  })

  test('卡片回调归一：value 为字符串化 JSON、会话 id 在顶层（变体）也能接住', async () => {
    const { client } = makeFakeClient()
    const { ws } = makeFakeWs()
    const adapter = new FeishuAdapter({ client, wsClient: ws })
    await adapter.start()
    const got: CardAction[] = []
    adapter.onCardAction(async (a) => {
      got.push(a)
    })
    await adapter.handleCardEvent({
      operator: { user_id: 'boss_uid' },
      action: { value: JSON.stringify({ proposalId: 'FIN-1', action: 'reject' }) },
      open_chat_id: 'oc_top',
    })
    assert.deepEqual(got, [
      {
        platform: 'feishu',
        platformUserid: 'boss_uid',
        conversationId: 'oc_top',
        kind: 'proposal',
        proposalId: 'FIN-1',
        action: 'reject',
        messageId: undefined,
      },
    ])
  })

  test('卡片回调应答改脸：handler 返回 confirmed → 应答体为官方信封 {card:{type:raw,data:绿色终态卡}}（真机 10-29：裸卡平台静默不更新）', async () => {
    const { client } = makeFakeClient()
    const { ws } = makeFakeWs()
    const adapter = new FeishuAdapter({ client, wsClient: ws })
    await adapter.start()
    adapter.onCardAction(async () => 'confirmed')
    const face = await adapter.handleCardEvent({
      operator: { open_id: 'ou_boss' },
      action: { value: { proposalId: 'FIN-20261029-001', action: 'confirm' } },
      context: { open_message_id: 'om_card1', open_chat_id: 'oc_chat1' },
    })
    assert.ok(face !== undefined)
    const envelope = face as { card?: { type?: string; data?: { header: { template: string; title: { content: string } }; elements: Array<{ tag: string }> } } }
    assert.equal(envelope.card?.type, 'raw', '应答体必须是 {card:{type:"raw"}} 信封')
    const card = envelope.card?.data as { header: { template: string; title: { content: string } }; elements: Array<{ tag: string }> }
    assert.ok(card !== undefined, '信封 data 必须是完整卡片')
    assert.equal(card.header.template, 'green')
    assert.ok(card.header.title.content.includes('已确认入账'))
    assert.ok(card.elements.every((e) => e.tag !== 'action'), '终态卡不应再有按钮区')
  })

  test('卡片回调应答改脸：rejected → 灰色终态卡；handler 无结果（未处理）→ 返回 undefined 只纯应答', async () => {
    const { client } = makeFakeClient()
    const { ws } = makeFakeWs()
    const adapter = new FeishuAdapter({ client, wsClient: ws })
    await adapter.start()
    adapter.onCardAction(async () => 'rejected')
    const face = await adapter.handleCardEvent({
      operator: { open_id: 'ou_boss' },
      action: { value: { proposalId: 'FIN-1', action: 'reject' } },
      context: { open_chat_id: 'oc_chat1' },
    })
    const envelope = (face ?? {}) as { card?: { type?: string; data?: { header?: { template: string; title: { content: string } }; elements?: Array<{ tag: string }> } } }
    assert.equal(envelope.card?.type, 'raw')
    const card = envelope.card?.data ?? {}
    assert.equal(card.header?.template, 'default')
    assert.ok(card.header?.title.content.includes('已拒绝'))
    assert.ok((card.elements ?? []).every((e) => e.tag !== 'action'))
    adapter.onCardAction(async () => undefined)
    const none = await adapter.handleCardEvent({
      operator: { open_id: 'ou_boss' },
      action: { value: { proposalId: 'FIN-1', action: 'confirm' } },
      context: { open_chat_id: 'oc_chat1' },
    })
    assert.equal(none, undefined)
  })

  test('卡片回调：未知动作/缺会话/缺操作人/坏 value 一律不进 handler', async () => {
    const { client } = makeFakeClient()
    const { ws } = makeFakeWs()
    const adapter = new FeishuAdapter({ client, wsClient: ws })
    await adapter.start()
    let calls = 0
    adapter.onCardAction(async () => {
      calls += 1
    })
    await adapter.handleCardEvent({
      operator: { open_id: 'ou_boss' },
      action: { value: { proposalId: 'FIN-1', action: 'maybe' } },
      context: { open_chat_id: 'oc_chat1' },
    })
    await adapter.handleCardEvent({
      operator: { open_id: 'ou_boss' },
      action: { value: { proposalId: 'FIN-1', action: 'confirm' } },
    })
    await adapter.handleCardEvent({
      action: { value: { proposalId: 'FIN-1', action: 'confirm' } },
      context: { open_chat_id: 'oc_chat1' },
    })
    await adapter.handleCardEvent({
      operator: { open_id: 'ou_boss' },
      action: { value: '不是 JSON' },
      context: { open_chat_id: 'oc_chat1' },
    })
    await adapter.handleCardEvent({})
    assert.equal(calls, 0)
  })

  test('approval 审批事件归一：event 嵌套/顶层扁平两种形状都出 ApprovalNotice；形状不符/无订阅者 warn 不炸（对抗审查 P3-1）', async () => {
    const { client } = makeFakeClient()
    const { ws } = makeFakeWs()
    const adapter = new FeishuAdapter({ client, wsClient: ws })
    await adapter.start()
    const notices: string[] = []
    adapter.onApprovalEvent(async (n) => {
      notices.push(n.instanceCode)
    })
    // SDK v2 嵌套形状
    await adapter.handleApprovalEvent({ header: { event_type: 'approval' }, event: { instance_code: 'INS-A' } })
    // 扁平形状（v2 实测扁平化）
    await adapter.handleApprovalEvent({ event_type: 'approval', instance_code: 'INS-B' })
    assert.deepEqual(notices, ['INS-A', 'INS-B'])
    // 形状不符：不应调用 handler 也不应抛
    await adapter.handleApprovalEvent({ event: {} })
    await adapter.handleApprovalEvent({})
    assert.equal(notices.length, 2)
  })

  test('平台返回非 0 code 时 sendText 抛错（BridgeService 的回信 catch 接住，不炸回调链）', async () => {
    const { client } = makeFakeClient({ failCode: 99991668 })
    const { ws } = makeFakeWs()
    const adapter = new FeishuAdapter({ client, wsClient: ws })
    await adapter.start()
    await assert.rejects(adapter.sendText('oc_chat1', 'hi'), /飞书消息发送失败 code=99991668/)
  })

  // ---------- 连接监督器（2026-10-30 第0层；巡检用 superviseTick() 直驱，不真等定时器） ----------

  test('监督器：SDK 终态死亡（failed）后接管重建，重启次数与退避进状态；恢复后清零', async () => {
    const { client } = makeFakeClient()
    const { ws, state } = makeFakeWs()
    const adapter = new FeishuAdapter({ client, wsClient: ws, restartBackoffMs: [1, 1] })
    await adapter.start()
    adapter.superviseTick() // 先巡检一轮：connected → 记 everConnected
    assert.equal(state.started, 1)
    state.status = 'failed' // 2026-10-30 事故形态：SDK 重连配额用尽 terminalError
    adapter.superviseTick()
    adapter.superviseTick() // 退避睡眠中的又一次巡检：in-flight 守卫，不得叠加第二个重启任务
    await new Promise((r) => setTimeout(r, 20)) // 等退避 1ms + 异步重启落地
    assert.equal(state.started, 2, '监督器应重建连接（且只重建一次）')
    assert.equal(adapter.connectionState().restartCount, 1)
    state.status = 'connected'
    adapter.superviseTick()
    assert.equal(adapter.connectionState().restartBackoffMs, 0, '恢复后退避清零')
    assert.equal(adapter.connectionState().lastConnectedAt !== undefined, true)
  })

  test('监督器：连而复断再恢复，onConnectionChange 断/恢各一次、onReconnect 每次恢复都触发；首次连上也触发补抓（兜启动期缺口）', async () => {
    const { client } = makeFakeClient()
    const { ws, state } = makeFakeWs()
    const adapter = new FeishuAdapter({ client, wsClient: ws, restartBackoffMs: [1, 1] })
    const changes: boolean[] = []
    let reconnects = 0
    adapter.onConnectionChange((c) => {
      changes.push(c.connected)
    })
    adapter.onReconnect(() => {
      reconnects += 1
    })
    await adapter.start()
    adapter.superviseTick() // 首次连上：不算"恢复"（无断开转移），但补抓回调要触发——启动补抓（main.ts）可能扫在连接建立前
    assert.equal(reconnects, 1)
    assert.equal(changes.length, 0)
    state.status = 'failed'
    adapter.superviseTick()
    await new Promise((r) => setTimeout(r, 20))
    state.status = 'connected'
    adapter.superviseTick()
    assert.deepEqual(changes, [false, true], '断开/恢复各一次转移事件')
    assert.equal(reconnects, 2, '断而复连触发补抓回调')
    // 再断再连：回调再来一轮
    state.status = 'failed'
    adapter.superviseTick()
    await new Promise((r) => setTimeout(r, 20))
    state.status = 'connected'
    adapter.superviseTick()
    assert.equal(reconnects, 3)
    assert.deepEqual(changes, [false, true, false, true])
  })

  test('监督器：SDK 自愈（reconnecting→connected）也记断开转移并触发补抓——这是最常见的恢复路径（对抗审查 P0-1）', async () => {
    const { client } = makeFakeClient()
    const { ws, state } = makeFakeWs()
    const adapter = new FeishuAdapter({ client, wsClient: ws, restartBackoffMs: [1, 1] })
    const changes: boolean[] = []
    let reconnects = 0
    adapter.onConnectionChange((c) => {
      changes.push(c.connected)
    })
    adapter.onReconnect(() => {
      reconnects += 1
    })
    await adapter.start()
    adapter.superviseTick() // 首连
    state.status = 'reconnecting' // 网络抖动：SDK 用自己的重连配额自愈，全程不经监督器
    adapter.superviseTick()
    await new Promise((r) => setTimeout(r, 10))
    assert.equal(state.started, 1, 'SDK 自己在连，监督器不动手重启')
    assert.deepEqual(changes, [false], '但断开转移要记（审计用）')
    state.status = 'connected' // SDK 自愈成功
    adapter.superviseTick()
    assert.deepEqual(changes, [false, true])
    assert.equal(reconnects, 2, '自愈恢复必须触发补抓，否则抖动窗口内的审批单漏扫')
  })

  test('监督器：ws.start 首次就失败不再向上抛（网络级启动失败由监督器无限接手）；永久失败也不放弃', async () => {
    const { client } = makeFakeClient()
    const state = { started: 0, closed: 0, status: 'idle' }
    let fails = 2 // 前两次 start 抛错（模拟启动期 DNS 抖动），第三次起成功
    const ws: FeishuWsLike = {
      start: async () => {
        state.started += 1
        if (state.started <= fails) {
          state.status = 'failed'
          throw new Error('getaddrinfo ENOTFOUND open.feishu.cn')
        }
        state.status = 'connected'
      },
      close: () => {
        state.closed += 1
        state.status = 'idle'
      },
      getConnectionStatus: () => ({ state: state.status }),
    }
    const adapter = new FeishuAdapter({ client, wsClient: ws, restartBackoffMs: [1, 1] })
    await adapter.start() // 若向上抛这里就炸了——启动失败要被监督器吞下并接管
    adapter.superviseTick()
    await new Promise((r) => setTimeout(r, 20))
    adapter.superviseTick()
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(state.started, 3, '两次失败后第三次成功')
    assert.equal(adapter.connected, true)
    adapter.superviseTick() // 恢复后的巡检才清 lastError（markConnected）
    assert.equal(adapter.connectionState().lastError, undefined, '恢复后错误清空')
    // 之后彻底死掉也不放弃：一直 tick 一直重建
    fails = Number.MAX_SAFE_INTEGER
    state.status = 'failed'
    for (let i = 0; i < 3; i++) {
      adapter.superviseTick()
      await new Promise((r) => setTimeout(r, 5))
    }
    assert.ok(adapter.connectionState().restartCount >= 4, '反复失败仍持续重建，永不停止')
  })

  test('监督器：连接中/重连中让路不抢跑；stop 后巡检停摆；无状态机的假 ws 不作为', async () => {
    const { client } = makeFakeClient()
    const { ws, state } = makeFakeWs()
    const adapter = new FeishuAdapter({ client, wsClient: ws, restartBackoffMs: [1, 1] })
    await adapter.start()
    for (const s of ['connecting', 'reconnecting']) {
      state.status = s
      adapter.superviseTick()
      await new Promise((r) => setTimeout(r, 10))
      assert.equal(state.started, 1, `${s} 时 SDK 自己在连，监督器不动手`)
    }
    await adapter.stop()
    state.status = 'failed'
    adapter.superviseTick()
    await new Promise((r) => setTimeout(r, 10))
    assert.equal(state.started, 1, 'stop 后巡检不再重启')
    // 无 getConnectionStatus 的假 ws：监督器整体不作为，也不炸
    const bare: FeishuWsLike = { start: async () => {}, close: () => {} }
    const bareAdapter = new FeishuAdapter({ client, wsClient: bare })
    await bareAdapter.start()
    bareAdapter.superviseTick()
    assert.equal(bareAdapter.connectionState().state, undefined)
  })
})

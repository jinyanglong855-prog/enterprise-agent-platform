/**
 * 飞书 adapter（2026-10-28 融合方案 P1，第一个真实平台）：
 * - 长连接：官方 SDK WSClient 出站 WebSocket 免公网回调（钉钉 Stream 同构，见 bridge.types 纪律）；
 *   凭据只从环境变量来（ADMIN_FEISHU_APP_ID / ADMIN_FEISHU_APP_SECRET），不进任何文档与代码仓。
 * - 平台协议翻译（adapter 只翻译不碰业务）：
 *   · im.message.receive_v1 → InboundMessage：text 消息抽文本、剥 @机器人 占位符；
 *     非文本消息直接回一句指引（协议层应答，不走 handler）；
 *   · card.action.trigger → CardAction：确认/拒绝按钮 value 携带 {proposalId, action}，
 *     回调形状按 SDK 实测做防御性归一（v2 扁平化 + 顶层兜底 + value 字符串化兼容）。
 * - 出站：sendText / 提案卡都走 im.v1.message.create（receive_id_type=chat_id）；
 *   提案卡渲染 v1 互动卡片（schema 老而稳、文档全，P0 不追 cardkit 新版）。
 * - 连接监督器（2026-10-30 第0层。事故形态：一次 DNS 抖动 → SDK 只重连 1 次就 terminalError
 *   静默躺平——服务端 pong 会把 ReconnectCount=1 无条件覆盖本地配置，用户侧配不出无限重连）：
 *   每 10s 查一次连接状态，failed/idle=彻底死亡 → 指数退避（10s→5min 封顶）无限重建 WSClient，
 *   永不放弃；connecting/reconnecting=SDK 自己还在连，让路；connected=清退避。另配
 *   pingTimeout 僵死看门狗：TCP 半开时 readyState 仍显示 OPEN、监督器看不见，只有 SDK 的
 *   pong 超时能杀僵尸 socket 触发重连。断开/恢复转移走 onConnectionChange（审计在装配处接线，
 *   adapter 不碰库），恢复走 onReconnect（补抓挂点，FeishuApprovalService.backfillMissed）。
 * - 测试纪律：client / ws 全部构造器注入，单测用假客户端钉归一化行为，不真连；
 *   真机冒烟要等用户提供企业自建应用凭据（当前状态=代码就绪，未真机验证）。
 */
import { config } from '../config.js'
import type { ApprovalNotice, BridgeAdapter, CardAction, CardActionResult, InboundMessage, ProposalCardView, TodoCardView } from './bridge.types.js'

/** SDK Client 只用到发消息这一条（结构最小化，测试用假对象满足）。 */
export interface FeishuClientLike {
  im: {
    v1: {
      message: {
        create(payload: {
          data: { receive_id: string; msg_type: string; content: string }
          params: { receive_id_type: string }
        }): Promise<{ code?: number; msg?: string; data?: { message_id?: string } }>
      }
    }
  }
}

/** SDK WSClient 只用到启停与连接状态。 */
export interface FeishuWsLike {
  start(params: { eventDispatcher: unknown }): Promise<void>
  close(params?: { force?: boolean }): void
  getConnectionStatus?(): { state?: string }
}

/** dispatcher.register 的类型收口：im 事件 SDK 有类型，卡片回调/审批事件没有（走泛型 T）；
 *  卡片回调的返回值（终态卡）会被 SDK 作为应答数据发回平台，类型放宽到 unknown。 */
interface FeishuHandles {
  'im.message.receive_v1': (data: FeishuMessageEventData) => Promise<void>
  'card.action.trigger': (data: unknown) => Promise<unknown>
  'approval': (data: unknown) => Promise<void>
}

/** im.message.receive_v1 回调形状（SDK v2 事件被扁平化：header 与 event 字段都在顶层）。 */
interface FeishuMessageEventData {
  sender?: {
    sender_id?: { open_id?: string; user_id?: string; union_id?: string }
    sender_type?: string
  }
  message?: {
    message_id?: string
    chat_id?: string
    chat_type?: string
    message_type?: string
    content?: string
    mentions?: Array<{ key?: string; name?: string }>
  }
}

export interface FeishuAdapterOptions {
  appId?: string
  appSecret?: string
  /** 注入则完全不碰 SDK（单测用假客户端；两者必须成对给）。 */
  client?: FeishuClientLike
  wsClient?: FeishuWsLike
  /** 监督器重启退避序列（毫秒，用尽后停在最后一个；默认 10s/30s/1min/2min/5min）。
   *  测试注入短序列让断连重启不用真等。 */
  restartBackoffMs?: number[]
}

/** 连接转移（onConnectionChange 回调体）：断开带最近一次错误，恢复不带。 */
export interface ConnectionChange {
  connected: boolean
  error?: string
}

/** 连接状态明细（connectionState()，管理端点可观测用）。 */
export interface FeishuConnectionState {
  /** SDK 状态机原值：connected/connecting/reconnecting/failed/idle。 */
  state: string | undefined
  lastConnectedAt: string | undefined
  lastDisconnectedAt: string | undefined
  lastError: string | undefined
  /** 监督器接管后的重建次数（进程生命周期内累计）。 */
  restartCount: number
  /** 下一次监督器重启要等的退避毫秒数（0=没有在退避）。 */
  restartBackoffMs: number
}

/** 监督器巡检节奏：比最短退避细，比事件洪泛慢。 */
const SUPERVISE_TICK_MS = 10_000
/** 默认重启退避（毫秒）：快速恢复常见抖动，封顶 5 分钟防打爆对端。 */
const DEFAULT_RESTART_BACKOFF_MS = [10_000, 30_000, 60_000, 120_000, 300_000]
/** SDK 僵死看门狗（秒）：服务端 ping 约 5s 一发，60s 无 pong=连接必死。0=SDK 默认不启用。 */
const PING_TIMEOUT_SECONDS = 60

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export class FeishuAdapter implements BridgeAdapter {
  readonly platform = 'feishu'
  readonly isReal = true
  private readonly opts: FeishuAdapterOptions
  private client: FeishuClientLike | undefined
  private ws: FeishuWsLike | undefined
  /** 真连路径建好的 EventDispatcher，start 时递给 WSClient（假客户端路径为 undefined）。 */
  private pendingDispatcher: unknown = undefined
  /** 真连路径缓存的 SDK 模块与 WSClient 工厂：监督器重建连接时造新客户端（假路径无工厂=复用实例）。 */
  private wsFactory: (() => FeishuWsLike) | undefined
  private started = false
  private messageHandler: ((msg: InboundMessage) => Promise<void>) | undefined
  private cardHandler: ((action: CardAction) => Promise<CardActionResult | void>) | undefined
  private approvalHandler: ((notice: ApprovalNotice) => void | Promise<unknown>) | undefined
  // ---------- 连接监督器（第0层）与可观测（第3层）状态 ----------
  private supervisorTimer: NodeJS.Timeout | undefined
  private restartTask: Promise<void> | undefined
  /** 监督器代际：stop 时 +1，作废睡眠中的旧重启任务（防 stop→start 循环时旧任务顶掉新连接） */
  private supervisorGeneration = 0
  private backoffMs = 0
  private restartCount = 0
  private everConnected = false
  private disconnected = false
  private lastConnectedAt: string | undefined
  private lastDisconnectedAt: string | undefined
  private lastError: string | undefined
  private reconnectHandler: (() => Promise<void> | void) | undefined
  private connectionChangeHandler: ((change: ConnectionChange) => Promise<void> | void) | undefined

  constructor(opts: FeishuAdapterOptions = {}) {
    this.opts = opts
  }

  /** 长连接是否建立（SDK 状态机：connecting/reconnecting 都不算，如实）。 */
  get connected(): boolean {
    if (!this.started) return false
    const state = this.ws?.getConnectionStatus?.().state
    return state === undefined ? true : state === 'connected' // 假客户端可不实现状态机：起了就算连着
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.messageHandler = handler
  }

  onCardAction(handler: (action: CardAction) => Promise<CardActionResult | void>): void {
    this.cardHandler = handler
  }

  onApprovalEvent(handler: (notice: ApprovalNotice) => void | Promise<unknown>): void {
    this.approvalHandler = handler
  }

  /** 断线后重新连上的回调（补抓挂点）：装配处接 FeishuApprovalService.backfillMissed('reconnect')。
   *  进程冷启动的补抓在 main.ts（trigger='startup'），这里只管中途断而复连。 */
  onReconnect(handler: () => Promise<void> | void): void {
    this.reconnectHandler = handler
  }

  /** 连接断开/恢复转移回调（第3层审计挂点）：adapter 不碰库，落审计由装配处接线。 */
  onConnectionChange(handler: (change: ConnectionChange) => Promise<void> | void): void {
    this.connectionChangeHandler = handler
  }

  /** 连接状态明细（管理端点可观测，第3层）。 */
  connectionState(): FeishuConnectionState {
    return {
      state: this.ws?.getConnectionStatus?.().state,
      lastConnectedAt: this.lastConnectedAt,
      lastDisconnectedAt: this.lastDisconnectedAt,
      lastError: this.lastError,
      restartCount: this.restartCount,
      restartBackoffMs: this.backoffMs,
    }
  }

  async start(): Promise<void> {
    if (this.started) return
    // 注入假客户端必须成对（对抗审查 P3-9）：只给一个说明测试写错了，直接拒绝
    if ((this.opts.client === undefined) !== (this.opts.wsClient === undefined)) {
      throw new Error('FeishuAdapter 注入的 client / wsClient 必须成对给')
    }
    if (this.opts.client !== undefined && this.opts.wsClient !== undefined) {
      this.client = this.opts.client
      this.ws = this.opts.wsClient
    } else {
      // trim：env 里带尾随空白是常发事故；SDK 对非法 appId 静默放弃（不进重连循环），
      // 这里预检并大声抛错（对抗审查 P3-1）。形状=cli_ 开头 16 位小写字母数字（官方 App ID
      // 含 g-z 等非十六进制字符，比 SDK 内部的 hex 校验放宽；SDK 仍是严格闸——2026-10-29 官方文档核订）
      const appId = (this.opts.appId ?? config.feishuAppId).trim()
      const appSecret = (this.opts.appSecret ?? config.feishuAppSecret).trim()
      if (appId === '' || appSecret === '') {
        throw new Error('缺少飞书凭据（ADMIN_FEISHU_APP_ID / ADMIN_FEISHU_APP_SECRET），适配器不启动')
      }
      if (!/^cli_[a-z0-9]{16}$/.test(appId)) {
        throw new Error(`飞书 App ID 形状不对（应为 cli_ 开头的 16 位小写字母数字，实际 "${appId}"），请检查 ADMIN_FEISHU_APP_ID`)
      }
      // 动态 import：没配飞书时不为此加载整个 SDK
      const sdk = await import('@larksuiteoapi/node-sdk')
      this.client = new sdk.Client({ appId, appSecret, domain: sdk.Domain.Feishu }) as unknown as FeishuClientLike
      const dispatcher = new sdk.EventDispatcher({})
      dispatcher.register<FeishuHandles>({
        'im.message.receive_v1': (data) => this.handleMessageEvent(data),
        // 卡片回调键 SDK 类型未收口（IHandles 只有事件），运行时按 event_type 分发到这
        'card.action.trigger': (data) => this.handleCardEvent(data),
        // OA 审批事件（approval v4）：账号开通审批通过/拒绝后平台推送；只抽 instance_code
        'approval': (data) => this.handleApprovalEvent(data),
      })
      // 连接状态转移接 SDK 回调（即时、精确），tick 巡检只兜底（回调漏发/假客户端路径）：
      // markConnected/markDisconnected 自带转移守卫，回调与巡检重复触发不会重复发事件
      const onReady = () => {
        console.log('[bridge:feishu] 长连接已建立')
        this.markConnected()
      }
      const onReconnecting = () => this.markDisconnected()
      const onError = (err: Error) => {
        this.lastError = err.message
        console.warn('[bridge:feishu] 长连接错误：', err.message)
        // 终态死亡不必等下一轮巡检：立刻查一次状态（in-flight 守卫防与退避中的重启撞车）
        this.markDisconnected()
        this.superviseTick()
      }
      // 监督器重建时一律新造 WSClient（旧实例终态死亡后状态机有内部残留）：工厂闭包住凭据。
      // pingTimeout / handshakeTimeoutMs 运行时支持（lib/index.js: userWsConfig?.pingTimeout ?? 0、
      // handshakeTimeoutMs 默认 0 不启用），官方 TS 类型未暴露 → 断言传入
      this.wsFactory = () =>
        new sdk.WSClient({
          appId,
          appSecret,
          autoReconnect: true,
          // 僵死看门狗（第0层）：TCP 半开时 readyState 仍 OPEN、巡检看不见，pong 超时让 SDK 自己杀
          pingTimeout: PING_TIMEOUT_SECONDS,
          // 握手卡死兜底：不等 OS 层 TCP 超时（1-2 分钟），15s 无响应即失败进重试
          handshakeTimeoutMs: 15_000,
          onReady,
          onReconnecting,
          onError,
        } as unknown as ConstructorParameters<typeof sdk.WSClient>[0]) as unknown as FeishuWsLike
      this.ws = this.wsFactory()
      // dispatcher 要在 start 时递给 ws（注册回调已在上面完成）
      this.pendingDispatcher = dispatcher
    }
    try {
      await this.ws.start({ eventDispatcher: this.pendingDispatcher })
    } catch (error) {
      // 网络级启动失败不再向上抛（第0层语义）：start=监督器上岗，连没连上是独立状态，
      // 由监督器无限重试；凭据类永久错误在上面闸里已抛。原语义（抛给 BridgeService 告警）
      // 会让"启动那一下网络抖动"变成永久掉线，正是 2026-10-30 事故的另一半形态。
      this.lastError = error instanceof Error ? error.message : String(error)
      console.warn(`[bridge:feishu] 长连接首次建立失败（${this.lastError}），监督器接手重试`)
    }
    this.started = true
    if (this.supervisorTimer === undefined) {
      this.supervisorTimer = setInterval(() => this.superviseTick(), SUPERVISE_TICK_MS)
      this.supervisorTimer.unref()
    }
  }

  async stop(): Promise<void> {
    if (this.supervisorTimer !== undefined) {
      clearInterval(this.supervisorTimer)
      this.supervisorTimer = undefined
    }
    this.supervisorGeneration += 1 // 作废睡眠中的旧重启任务
    if (!this.started) return
    this.started = false
    this.ws?.close({ force: true })
  }

  async sendText(conversationId: string, text: string): Promise<void> {
    await this.send(conversationId, 'text', JSON.stringify({ text }))
  }

  async sendProposalCard(conversationId: string, card: ProposalCardView): Promise<void> {
    await this.send(conversationId, 'interactive', proposalCardContent(card))
  }

  /** 提案卡直发个人会话（2026-11-01 审批落账）：同一张卡、同一套按钮 value，回调仍经
   *  handleCardAction 按平台身份鉴权——单聊与群聊对回调链没有区别。 */
  async sendProposalCardToUser(openId: string, card: ProposalCardView): Promise<void> {
    await this.send(openId, 'interactive', proposalCardContent(card), 'open_id')
  }

  /** 终态卡（card.action 应答体）：标题即结果（绿/灰），按钮区撤掉——
   *  没有可点的按钮，自然不会"以为没生效再点一遍"（2026-10-29 真机冒烟实证的 UX 问题）。 */
  private processedCard(proposalId: string, outcome: CardActionResult): Record<string, unknown> {
    const confirmed = outcome === 'confirmed'
    return {
      config: { wide_screen_mode: true, update_multi: true },
      header: {
        template: confirmed ? 'green' : 'default',
        title: { tag: 'plain_text', content: `记账提案 ${proposalId} · ${confirmed ? '已确认入账' : '已拒绝'}` },
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: confirmed ? '✅ **已确认入账**，金额已记入账本。' : '❌ **已拒绝**，这笔没有入账。',
          },
        },
        { tag: 'hr' },
        { tag: 'note', elements: [{ tag: 'plain_text', content: '本提案已处理完成，此卡片仅作留档' }] },
      ],
    }
  }

  // ---------- 入站归一（dispatcher 直接调；单测也直接调） ----------

  /** im.message.receive_v1 → InboundMessage；形状不符或空文本丢弃；
   *  非文本消息按 unsupported 标记交 handler（回指引由 BridgeService 过完白名单闸再决定）。 */
  async handleMessageEvent(data: unknown): Promise<void> {
    const d = data as FeishuMessageEventData
    const msg = d.message
    if (msg?.message_id === undefined || msg.chat_id === undefined) return
    const senderId = d.sender?.sender_id?.open_id ?? d.sender?.sender_id?.user_id ?? d.sender?.sender_id?.union_id ?? ''
    if (senderId === '') return
    const handler = this.messageHandler
    if (handler === undefined) return
    if (msg.message_type !== 'text') {
      await handler({
        platform: this.platform,
        platformUserid: senderId,
        conversationId: msg.chat_id,
        text: '',
        msgId: msg.message_id,
        unsupported: true,
      })
      return
    }
    let text = ''
    try {
      const parsed = JSON.parse(msg.content ?? '{}') as { text?: unknown }
      if (typeof parsed.text === 'string') text = parsed.text
    } catch {
      text = ''
    }
    // 群聊 @机器人 的占位符（@_user_N）剥掉再进对话
    text = text.replace(/@_user_\d+/g, '').trim()
    if (text === '') return
    await handler({
      platform: this.platform,
      platformUserid: senderId,
      conversationId: msg.chat_id,
      text,
      msgId: msg.message_id,
    })
  }

  /** approval（OA 审批事件）→ ApprovalNotice：只抽 instance_code，详情由消费方回查 API。
   *  SDK v2 事件形状做过扁平化（im 事件实测），这里两种形状都兜（data.event.instance_code / 顶层）。
   *  形状不符打 warn（对抗审查 P3-1：静默丢会让"审批通过了系统毫无反应"无从排查）。 */
  async handleApprovalEvent(data: unknown): Promise<void> {
    const d = data as { event?: { instance_code?: unknown }; instance_code?: unknown }
    const raw = d?.event?.instance_code ?? d?.instance_code
    const handler = this.approvalHandler
    if (typeof raw !== 'string' || raw === '') {
      console.warn('[bridge:feishu] 审批事件形状不符（拿不到 instance_code），已忽略：', JSON.stringify(data)?.slice(0, 200))
      return
    }
    if (handler === undefined) {
      console.warn('[bridge:feishu] 收到审批事件但没有订阅者（approval handler 未挂），已忽略：', raw)
      return
    }
    await handler({ instanceCode: raw })
  }

  /** card.action.trigger → CardAction；形状不符/动作未知丢弃。
   *  handler 给出处理结果时返回终态卡：SDK 会把 dispatcher 的非空返回值作为应答数据
   *  发回平台（源码 handleEventData：result → respPayload.data）——平台原生的"点击即改脸"
   *  通道，随点击应答原子生效。卡面变更不走事后 HTTP patch：那条路会把整个处理链
   *  （业务+两次平台 HTTP）拖过 3 秒应答窗口，平台判定点击失败→客户端回滚卡面并重推回调
   *  （2026-10-29 真机实证：卡片"变回去"+回调投递两次）。 */
  async handleCardEvent(data: unknown): Promise<Record<string, unknown> | undefined> {
    const d = data as {
      operator?: { open_id?: string; user_id?: string; union_id?: string }
      action?: { value?: unknown }
      context?: { open_chat_id?: string; open_message_id?: string }
      open_chat_id?: string
      open_message_id?: string
    }
    const userid = d.operator?.open_id ?? d.operator?.user_id ?? d.operator?.union_id ?? ''
    // v2 卡片回调会话 id 在 context 下；顶层兜底（webhook/旧 schema 变体）
    const chatId = d.context?.open_chat_id ?? d.open_chat_id ?? ''
    // 被点的卡片消息 id：处理完原地改脸用；拿不到就缺省（退回纯文字反馈）
    const messageId = d.context?.open_message_id ?? d.open_message_id
    let value: unknown = d.action?.value
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value)
      } catch {
        value = undefined
      }
    }
    const v = value !== undefined && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
    const kind = v?.kind === 'todo' ? ('todo' as const) : ('proposal' as const)
    const rawAction = v?.action
    const action =
      rawAction === 'confirm' || rawAction === 'reject' || rawAction === 'ack' || rawAction === 'done'
        ? rawAction
        : undefined
    const proposalId = kind === 'proposal' && typeof v?.proposalId === 'string' ? v.proposalId : ''
    const todoId = kind === 'todo' && typeof v?.todoId === 'number' ? v.todoId : 0
    const handler = this.cardHandler
    if (handler === undefined || userid === '' || chatId === '') return

    if (proposalId === '' && todoId <= 0) return
    let cardAction: CardAction
    if (kind === 'todo') {
      if (todoId <= 0 || (action !== 'ack' && action !== 'done')) return
      cardAction = { platform: this.platform, platformUserid: userid, conversationId: chatId, kind, todoId, action, messageId }
    } else {
      if (proposalId === '' || (action !== 'confirm' && action !== 'reject')) return
      cardAction = { platform: this.platform, platformUserid: userid, conversationId: chatId, kind, proposalId, action, messageId }
    }
    const outcome = await handler(cardAction)
    if (outcome === undefined) return
    // 飞书契约：card.action.trigger 的应答数据是信封 {card:{type:'raw', data:<完整卡片>}}——
    // 返回裸卡片平台静默不更新（2026-10-29 真机实证：落账成功、卡面不变；官方文档 Handle card callbacks）
    if (outcome === 'confirmed' || outcome === 'rejected') {
      return { card: { type: 'raw', data: this.processedCard(proposalId, outcome) } }
    }
    if (outcome === 'acked' || outcome === 'done') {
      return { card: { type: 'raw', data: this.todoTerminalCard(todoId, outcome) } }
    }
    return
  }

  /** 待办卡终态（2026-10-31 待办预警方案 P2；同日二批改词）：与提案终态卡同一设计——标题即结果，
   *  按钮区撤掉，没有可点的按钮就不会"以为没生效再点一遍"。 */
  private todoTerminalCard(todoId: number, outcome: 'acked' | 'done'): Record<string, unknown> {
    const done = outcome === 'done'
    return {
      config: { wide_screen_mode: true },
      header: {
        template: done ? 'green' : 'default',
        title: { tag: 'plain_text', content: `待办 #${todoId} · ${done ? '已完成' : '已暂不处理'}` },
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content:
              done
                ? '✅ **已完成**，待办中心里这条已闭环。'
                : '收到，这条暂不处理、不再推送（待办中心仍可见，到期升级时会再提醒一次）。',
          },
        },
        { tag: 'hr' },
        { tag: 'note', elements: [{ tag: 'plain_text', content: '本卡片已处理完成，仅作留档' }] },
      ],
    }
  }

  // ---------- 内部 ----------

  /** handler 调用统一走这：回调抛错/拒绝不许炸监督器（审计落库失败等都不该变成进程崩溃）。 */
  private fireSafe(name: string, fn: () => Promise<void> | void): void {
    try {
      void Promise.resolve(fn()).catch((e) => console.warn(`[bridge:feishu] ${name} 回调失败：`, e instanceof Error ? e.message : e))
    } catch (e) {
      console.warn(`[bridge:feishu] ${name} 回调同步失败：`, e instanceof Error ? e.message : e)
    }
  }

  /** 监督器巡检一步（定时器每 10s 调一次；onError 即时踢一脚；测试直接调来驱动状态机）。 */
  superviseTick(): void {
    try {
      if (!this.started) return
      const state = this.ws?.getConnectionStatus?.().state
      if (state === undefined) return // 假客户端没实现状态机：监督器不作为（测试只钉归一化行为）
      if (state === 'connected') {
        this.markConnected()
        return
      }
      if (state === 'connecting' || state === 'reconnecting') {
        // SDK 自己在连（重连配额内），监督器不动手重启；但"不在连接态"本身要记断开转移——
        // 对抗审查 P0-1：SDK 自愈成功（最常见恢复路径）也必须触发补抓，否则抖动窗口内的
        // 审批单要等到下次 terminalError 级断线才被扫到
        this.markDisconnected()
        return
      }
      // failed（SDK 重连配额用尽，2026-10-30 事故形态）或 idle（已关闭/启动即失败）：监督器接管
      this.markDisconnected()
      if (this.restartTask === undefined) this.restartTask = this.restartConnection()
    } catch (e) {
      // 巡检自身异常（回调同步抛等）不许打断定时器链：监督器自己不能成为崩溃点（对抗审查 P2-8）
      console.warn('[bridge:feishu] 监督器巡检异常：', e instanceof Error ? e.message : e)
    }
  }

  private markConnected(): void {
    this.backoffMs = 0
    this.lastError = undefined
    this.lastConnectedAt = new Date().toISOString()
    const firstConnect = !this.everConnected
    const restored = this.everConnected && this.disconnected
    this.everConnected = true
    if (this.disconnected) {
      this.disconnected = false
      console.log('[bridge:feishu] 长连接已恢复')
      this.fireSafe('connectionChange', () => this.connectionChangeHandler?.({ connected: true }))
    }
    // 首次连上也触发补抓：启动补抓（main.ts）在连接建立前就可能扫完（列表 API 当时不通），
    // 这里的重扫兜住缺口；与启动补抓幂等（占坑键去重），多跑一轮成本≈0
    if (firstConnect || restored) this.fireSafe('reconnect', () => this.reconnectHandler?.())
  }

  private markDisconnected(): void {
    if (this.disconnected) return
    this.disconnected = true
    this.lastDisconnectedAt = new Date().toISOString()
    // 还没连上过谈不上"断开"（启动即网络不通的静默重试期）：只记状态不发事件
    if (!this.everConnected) return
    this.fireSafe('connectionChange', () => this.connectionChangeHandler?.({ connected: false, error: this.lastError }))
  }

  /** 当前这轮重启该睡多久（0=首次进退避，取第一档）。 */
  private currentBackoff(): number {
    const schedule = this.opts.restartBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS
    if (this.backoffMs === 0) return schedule[0]!
    const idx = schedule.indexOf(this.backoffMs)
    return idx === -1 ? schedule[0]! : schedule[idx]!
  }

  /** 退避加码（用尽序列后停在最后一档=封顶）。 */
  private advanceBackoff(): void {
    const schedule = this.opts.restartBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS
    const idx = schedule.indexOf(this.backoffMs)
    this.backoffMs = schedule[Math.min(Math.max(idx, 0) + 1, schedule.length - 1)]!
  }

  private async restartConnection(): Promise<void> {
    const gen = this.supervisorGeneration
    try {
      const delay = this.currentBackoff()
      console.warn(
        `[bridge:feishu] 长连接已断（${this.lastError ?? '原因未知'}），${Math.round(delay / 1000)}s 后监督器重建` +
          `（进程内第 ${this.restartCount + 1} 次）`,
      )
      await sleep(delay)
      if (!this.started || gen !== this.supervisorGeneration) return // 服务停了或已被新一轮 start 接管：别再碰 ws
      const state = this.ws?.getConnectionStatus?.().state
      if (state === 'connected') return // 睡的当口 SDK 自己连上了：收尾交给下一轮巡检
      this.restartCount += 1
      // 真连路径一律新造 WSClient（终态死亡的旧实例状态机有内部残留）；旧实例先收掉，
      // 否则其内部清扫定时器随重启次数泄漏（对抗审查 P2-6）；假路径复用注入实例不 close
      if (this.wsFactory !== undefined) {
        this.ws?.close({ force: true })
        this.ws = this.wsFactory()
      }
      await this.ws?.start({ eventDispatcher: this.pendingDispatcher })
      this.advanceBackoff() // 是否真连上由下一轮巡检判定：连上则清零，没连上则已加码
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      console.warn(`[bridge:feishu] 监督器重建失败：${this.lastError}（继续退避重试，永不放弃）`)
      this.advanceBackoff()
    } finally {
      // 只清自己这代的任务：旧代残余不许碰新一代的 restartTask 槽位（对抗审查 P2-7）
      if (gen === this.supervisorGeneration) this.restartTask = undefined
    }
  }

  private async send(conversationId: string, msgType: string, content: string, receiveIdType: 'chat_id' | 'open_id' = 'chat_id'): Promise<void> {
    const client = this.client
    if (client === undefined) throw new Error('飞书适配器未启动，发不出消息')
    const r = await client.im.v1.message.create({
      data: { receive_id: conversationId, msg_type: msgType, content },
      params: { receive_id_type: receiveIdType },
    })
    if (r.code !== undefined && r.code !== 0) {
      throw new Error(`飞书消息发送失败 code=${r.code}${r.msg === undefined ? '' : `: ${r.msg}`}`)
    }
  }

  async sendUserText(openId: string, text: string): Promise<void> {
    await this.send(openId, 'text', JSON.stringify({ text }), 'open_id')
  }

  /** 待办卡直发个人会话（2026-10-31 待办预警方案 §六）：跃迁即时卡带按钮（value={kind:'todo',
   *  todoId, action}），晨报卡纯展示。渲染同提案卡的 v1 互动卡片 schema（老而稳）。 */
  async sendUserCard(openId: string, card: TodoCardView): Promise<void> {
    const elements: Record<string, unknown>[] = []
    if (card.lines.length > 0) {
      elements.push({ tag: 'div', text: { tag: 'lark_md', content: card.lines.join('\n') } })
    }
    if (card.kind === 'todo-item' && card.todoId !== undefined) {
      const buttons: Record<string, unknown>[] = [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '暂不处理' },
          type: 'default',
          value: { kind: 'todo', todoId: card.todoId, action: 'ack' },
        },
      ]
      if (card.canDone === true) {
        buttons.push({
          tag: 'button',
          text: { tag: 'plain_text', content: '已完成' },
          type: 'primary',
          value: { kind: 'todo', todoId: card.todoId, action: 'done' },
        })
      }
      elements.push({ tag: 'hr' })
      elements.push({ tag: 'action', actions: buttons })
    }
    if (card.note !== undefined && card.note !== '') {
      elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: card.note }] })
    }
    const content = {
      config: { wide_screen_mode: true },
      header: { template: card.template, title: { tag: 'plain_text', content: card.title } },
      elements,
    }
    await this.send(openId, 'interactive', JSON.stringify(content), 'open_id')
  }
}

/** 提案卡正文（群发与单聊直发共用）：v1 互动卡片 schema 稳定（官方文档全集齐），按钮 value
 *  原样回传到 card.action.trigger；update_multi 允许卡片被程序多次更新（确认/拒绝后原地改脸用）。 */
function proposalCardContent(card: ProposalCardView): string {
  return JSON.stringify({
    config: { wide_screen_mode: true, update_multi: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: `记账提案 ${card.id}` } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**摘要**\n${card.summary}` } },
      { tag: 'hr' },
      { tag: 'note', elements: [{ tag: 'plain_text', content: `${card.createdBy} 创建于 ${card.createdAt}` }] },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '确认入账' },
            type: 'primary',
            value: { proposalId: card.id, action: 'confirm' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '拒绝' },
            type: 'danger',
            value: { proposalId: card.id, action: 'reject' },
          },
        ],
      },
    ],
  })
}

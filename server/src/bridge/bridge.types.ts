import type { TodoCardView } from '../todos/todos.types.js'

/** 融合层 adapter 接缝（2026-10-28 融合方案 P0，平台无关）：
 *  钉钉 Stream 与飞书长连接结构同构（调研档 §二），一套接口两平台各写一个实现；
 *  约定俗成的实现纪律：
 *  - adapter 只做"平台协议 ↔ 归一化结构"的翻译，不碰业务（身份/会话/提案都在 BridgeService）；
 *  - 入站回调（消息/卡片点击）必须先在 adapter 内验证平台签名，再交给 handler；
 *  - 出站 sendProposalCard 由 adapter 负责把提案渲染成平台互动卡片，卡片按钮回调
 *    归一成 CardAction（带 proposalId）交回。
 */

/** 平台入站消息（adapter 归一后入站）。 */
export interface InboundMessage {
  platform: string
  /** 平台侧用户 id（通讯录 userid）。 */
  platformUserid: string
  /** 平台侧会话 id（单聊/群聊），会话映射的键。 */
  conversationId: string
  /** 消息纯文本（富消息由 adapter 抽文本，P0 只承接文本）。 */
  text: string
  /** 平台消息 id（重推去重用）。 */
  msgId: string
  /** adapter 标记"这条消息类型承接不了"（图片/文件等）：文本为空，BridgeService 在白名单/
   *  RBAC 闸之后回一句指引（不在 adapter 直接回——避免组织内任何人借回信探测白名单）。 */
  unsupported?: true
}

/** 平台卡片按钮回调（确认/拒绝/待办知晓与完成）。账号开通走平台 OA 审批（2026-10-29 用户拍板，
 *  不走对话卡——ApprovalNotice 是那条路的入口）。
 *  kind（2026-10-31 待办预警方案 P2）：缺省=记账提案（老调用/老测试兼容）；'todo'=待办卡按钮。 */
export interface CardAction {
  platform: string
  platformUserid: string
  conversationId: string
  /** 记账提案卡的提案 id（kind=proposal 时必有）。 */
  proposalId?: string
  /** 待办卡的义务 id（kind=todo 时必有）。 */
  todoId?: number
  kind?: 'proposal' | 'todo'
  action: 'confirm' | 'reject' | 'ack' | 'done'
  reason?: string
  /** 被点的那张卡片消息的平台 id（飞书 card.action 的 context.open_message_id）：审计留痕用。 */
  messageId?: string
}

/** 卡片动作的处理结果：handler 据此让平台把被点的那张卡原生改脸成终态
 *  （飞书走 card.action 回调应答通道——应答体即新卡片；返回 undefined 表示无可改脸，
 *  平台只收纯应答、卡面不动）。acked/done=待办卡的两种终态。 */
export type CardActionResult = 'confirmed' | 'rejected' | 'acked' | 'done'

/** 平台 OA 审批事件（adapter 归一出口，飞书 2026-10-29 先行；钉钉复制时同构实现）。
 *  只带实例码：审批结果/发起人/表单一律由消费方回查平台实例 API，不信任事件体字段
 *  （事件 schema 变体多，防伪造/防解析脆）。 */
export interface ApprovalNotice {
  instanceCode: string
}

/** 出站提案卡（BridgeService → adapter 渲染）。 */
export interface ProposalCardView {
  id: string
  summary: string
  createdBy: string
  createdAt: string
}

/** 出站待办卡（2026-10-31 待办预警方案 §六；结构定义在 todos/todos.types.ts——
 *  卡片是义务域的投影，这里只 re-export 给 adapter 实现者）。 */
export type { TodoCardView } from '../todos/todos.types.js'
/** 卡片回写端口同源 re-export（BridgeService 构造依赖用它）。 */
export type { TodoCardActionPort } from '../todos/todos.types.js'

/** 融合层对 agent 对话域的最小依赖（AgentService 结构性满足；测试用桩替换）。 */
export interface BridgeTurnRunner {
  createSession(username: string): { id: string }
  chat(
    sessionId: string,
    message: string,
    context: unknown,
    username: string,
    onEvent: (e: { event: string; data: unknown }) => void,
    source?: string,
  ): Promise<{ finalText: string }>
}

/** 平台 adapter：一个平台一个实现（dingtalk / feishu / mock）。契约约定：
 *  - start() 的 reject 只留给永久性错误（凭据缺失/形状不对）；网络级失败由实现内部的
 *    连接监督器接管无限重试（2026-10-30 第0层），不再向外抛——"起了"与"连上了"是两个状态；
 *  - start() 可重复调用（BridgeService 有幂等护栏），真实实现内部需自行幂等；
 *  - onMessage/onCardAction 注册的 handler 由 BridgeService 兜异常并负责回信/审计，
 *    adapter 只需把平台回调转交给 handler，不要在其外再包业务逻辑。 */
export interface BridgeAdapter {
  readonly platform: string
  /** 真实平台=连接闸的对象（服务账号缺失时 BridgeService 拒绝 start 真实适配器；
   *  按标志而非名字判，防止"真适配器取个 mock 名"绕闸——对抗审查 P3-2）。 */
  readonly isReal: boolean
  /** 建立与平台的长连接（钉钉 Stream / 飞书 WebSocket，均为出站连接免公网）。 */
  start(): Promise<void>
  stop(): Promise<void>
  readonly connected: boolean
  sendText(conversationId: string, text: string): Promise<void>
  sendProposalCard(conversationId: string, card: ProposalCardView): Promise<void>
  /** 按「平台用户 id」直发单聊（飞书 receive_id_type=open_id）：审批通过/开通结果发给
   *  当事人个人，而不是某个已知会话——TA 可能从没跟机器人说过话，没有现成 chat_id。 */
  sendUserText(openId: string, text: string): Promise<void>
  /** 按「平台用户 id」直发单聊卡片（2026-10-31 待办预警方案 §六：跃迁即时卡/晨报卡走
   *  个人会话而不是群——待办是个人责任，不是房间广播）。 */
  sendUserCard(openId: string, card: TodoCardView): Promise<void>
  /** 按「平台用户 id」直发单聊提案卡（2026-11-01 审批落账：审批批了 → 提案卡进老板
   *  单聊，不等长连接扫描）。可选：适配器没实现时 BridgeService 降级为 sendUserText
   *  文本指路，不让审批链路断在出站形态上。 */
  sendProposalCardToUser?(openId: string, card: ProposalCardView): Promise<void>
  /** 注册入站处理器（BridgeService 在 start 时挂上）。
   *  卡片 handler 的返回值是处理结果（CardActionResult）：真实 adapter 据此走平台原生的
 *  "点击即改脸"应答通道把被点的卡改成终态（飞书长连接应答体即新卡片内容）。
 *  纪律：handler 内别做慢操作链——平台对卡片回调有 3 秒应答窗口，超时视为点击失败
 *  （客户端回滚卡面并重推回调；2026-10-29 真机实证）。 */
  onMessage(handler: (msg: InboundMessage) => Promise<void>): void
  onCardAction(handler: (action: CardAction) => Promise<CardActionResult | void>): void
  /** OA 审批事件订阅（平台支持才实现；mock 不实现）。消费方在装配处挂上
   *  FeishuApprovalService.handleEvent——不经 BridgeService（审批是平台特定链路）。
   *  返回值放宽为 void | Promise<unknown>：handleEvent 带回处理结果状态（补抓用），
   *  事件路径的装配处忽略它。 */
  onApprovalEvent?(handler: (notice: ApprovalNotice) => void | Promise<unknown>): void
  /** 断线重连成功回调（2026-10-30 第2层补抓挂点；飞书实现，mock 不实现）。装配处接
   *  FeishuApprovalService.backfillMissed('reconnect')：把断连期间错过的事件按实例列表
   *  API 对账补上。进程冷启动的补抓在 main.ts（trigger='startup'）。 */
  onReconnect?(handler: () => Promise<void> | void): void
  /** 连接断开/恢复转移回调（2026-10-30 第3层可观测；飞书实现，mock 不实现）。
   *  adapter 不碰库：落审计由装配处接线（bridge.connection.lost/restored）。 */
  onConnectionChange?(handler: (change: { connected: boolean; error?: string }) => Promise<void> | void): void
  /** 连接状态明细（2026-10-30 第3层可观测，bridge/status 端点透出；实现可选。
   *  返回 unknown：平台各自的明细结构不同，端点原样透出不深究字段）。 */
  connectionState?(): unknown
}

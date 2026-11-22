/** Mock adapter（融合方案 P0）：平台未定（钉钉/飞书待用户拍板）期间的接缝验证件。
 *  不连任何外部服务；测试用它精确驱动入站（emit* 返回的 Promise 等完整处理链走完，
 *  卡片动作的返回值=处理结果，真实平台据此改脸）并断言出站（texts/cards/userTexts）。
 *  真实 adapter 实现后此文件保留做开发自测。OA 审批事件不模拟（平台特定链路，
 *  FeishuApprovalService 测试直接调 handleEvent）。 */
import type { BridgeAdapter, CardAction, CardActionResult, InboundMessage, ProposalCardView, TodoCardView } from './bridge.types.js'

export interface MockOutboundText {
  conversationId: string
  text: string
}

export interface MockOutboundCard {
  conversationId: string
  card: ProposalCardView
}

export interface MockOutboundUserText {
  openId: string
  text: string
}

export interface MockOutboundUserCard {
  openId: string
  card: TodoCardView
}

export interface MockOutboundProposalCardTo {
  openId: string
  card: ProposalCardView
}

export class MockAdapter implements BridgeAdapter {
  readonly platform = 'mock'
  readonly isReal = false
  connected = false
  texts: MockOutboundText[] = []
  cards: MockOutboundCard[] = []
  userTexts: MockOutboundUserText[] = []
  userCards: MockOutboundUserCard[] = []
  proposalCardsTo: MockOutboundProposalCardTo[] = []

  private messageHandler: ((msg: InboundMessage) => Promise<void>) | undefined
  private cardHandler: ((action: CardAction) => Promise<CardActionResult | void>) | undefined

  async start(): Promise<void> {
    this.connected = true
  }

  async stop(): Promise<void> {
    this.connected = false
  }

  async sendText(conversationId: string, text: string): Promise<void> {
    this.texts.push({ conversationId, text })
  }

  async sendProposalCard(conversationId: string, card: ProposalCardView): Promise<void> {
    this.cards.push({ conversationId, card })
  }

  async sendUserText(openId: string, text: string): Promise<void> {
    this.userTexts.push({ openId, text })
  }

  async sendUserCard(openId: string, card: TodoCardView): Promise<void> {
    this.userCards.push({ openId, card })
  }

  async sendProposalCardToUser(openId: string, card: ProposalCardView): Promise<void> {
    this.proposalCardsTo.push({ openId, card })
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): void {
    this.messageHandler = handler
  }

  onCardAction(handler: (action: CardAction) => Promise<CardActionResult | void>): void {
    this.cardHandler = handler
  }

  /** 测试驱动：模拟平台来了一条消息，Promise 在 BridgeService 处理完后落定。 */
  emitMessage(msg: InboundMessage): Promise<void> {
    if (this.messageHandler === undefined) throw new Error('bridge 未启动，没有入站处理器')
    return this.messageHandler(msg)
  }

  /** 测试驱动：模拟平台卡片按钮点击，返回值=BridgeService 的处理结果（改脸依据）。 */
  emitCardAction(action: CardAction): Promise<CardActionResult | void> {
    if (this.cardHandler === undefined) throw new Error('bridge 未启动，没有卡片处理器')
    return this.cardHandler(action)
  }
}

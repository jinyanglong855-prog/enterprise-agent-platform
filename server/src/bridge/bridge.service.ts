/**
 * 融合层服务（2026-10-28 融合架构方案 P0，平台无关部分）：
 * - 身份白名单：bridge_identities 默认拒绝——没有 allowed=1 条目的平台用户一律不响应
 *   （方案 §6 风险1：入口开放到平台侧，白名单是 P0 硬要求，不是可选项）。
 * - 会话映射：平台 (platform, conversationId) ↔ agent_sessions，dangling（会话被删）自动重建。
 * - 消息入站：白名单 → 走 AgentService.chat（同一 runtime/互斥/持久化，source='bridge'）
 *   → 终文回平台 → 轮次里新产生的单笔提案自动补发平台确认卡（确认卡片流是内核件，
 *   方案 §2 场景无关插槽）；批量导入卡不桥接（平台卡片尺寸放不下，回文本指引去管理后台）。
 * - 卡片动作：确认/拒绝直调 FinanceProposalsService（账本审计 source 保持 'confirm'，
 *   融合层另落 bridge.card.action 留平台痕迹）。
 * - RBAC 闸（2026-10-28 对抗审查 P1-2）：白名单只回答"谁能进来"，进来之后仍按映射账号的
 *   权限点干活——消息过 agent:write、卡片动作过 finance:write，与 REST 同权（不因桥入放权）。
 * - 真实平台闸（对抗审查 P1-1，2026-10-28 收紧后随服务账号落地放宽）：最小权限服务账号缺失或
 *   被停用时 start() 拒绝真实适配器（isReal 标志，不按名字判——防"真适配器取个 mock 名"绕闸）
 *   连接（agent 子进程会拒绝启动 runtime，见 AgentService）——方案 §6 风险1"否则不连"的代码化；
 *   服务账号在即放行，白名单/RBAC 闸照常把守。
 * 平台相关（签名校验、卡片渲染、Stream/长连接）全部在 adapter 实现里，本文件不出现平台名。
 */
import type { DB } from '../db/database.js'
import { nowIso } from '../db/database.js'
import { config } from '../config.js'
import type { AuditService } from '../audit/audit.service.js'
import type { RbacService } from '../rbac/rbac.service.js'
import { BadRequestError, NotFoundError } from '../errors.js'
import { CHAT_MESSAGE_MAX } from '../agent/agent.service.js'
import type { FinanceProposalsService } from '../finance/finance-proposals.service.js'
import type { BridgeAdapter, BridgeTurnRunner, CardAction, CardActionResult, InboundMessage, ProposalCardView, TodoCardActionPort, TodoCardView } from './bridge.types.js'

export interface BridgeIdentity {
  platform: string
  platform_userid: string
  username: string
  display_name: string
  allowed: number
  created_at: string
  updated_at: string | null
}

interface IdentityRow {
  username: string
  display_name: string
}

export class BridgeService {
  private readonly adapters = new Map<string, BridgeAdapter>()
  private readonly started = new Set<string>()
  /** 平台消息重推去重（平台超时未 ack 会重发；内存级即可，重启后重推最多多答一句）。 */
  private readonly seenMessages = new Map<string, number>()
  /** 已补发过卡片的提案 id（补卡时间盒的另一重保险；时间盒后重启不再重发旧提案，此集合防的是同轮内极端重扫）。 */
  private readonly sentProposals = new Set<string>()

  constructor(
    private readonly db: DB,
    private readonly audit: AuditService,
    private readonly proposals: FinanceProposalsService,
    private readonly agent: BridgeTurnRunner,
    private readonly rbac: RbacService,
    /** 待办卡回写端口（2026-10-31 待办预警方案 P2）：可注入缺省无（待办域未装配时按钮自然不可用）。 */
    private readonly todos?: TodoCardActionPort,
  ) {}

  /** 注册平台 adapter（main 装配 mock；真实平台 adapter 落地后在此追加）。 */
  registerAdapter(adapter: BridgeAdapter): void {
    this.adapters.set(adapter.platform, adapter)
  }

  adapterNames(): string[] {
    return [...this.adapters.keys()]
  }

  isConnected(platform: string): boolean {
    return this.adapters.get(platform)?.connected ?? false
  }

  /** 连接状态明细（2026-10-30 第3层可观测：重启次数/最近错误/最近断连时间等）。
   *  adapter 可选实现；未实现返回 undefined（端点侧直接省略该字段）。 */
  connectionDetail(platform: string): unknown {
    return this.adapters.get(platform)?.connectionState?.()
  }

  /** 启动：未启用或适配器缺失都不算错误（P0 平台未定，启动日志说清楚状态即可）。 */
  async start(): Promise<void> {
    if (!config.bridgeEnabled) {
      console.log('[bridge] 未启用（设 ADMIN_BRIDGE_ENABLED=1 开启），融合层不连接平台')
      return
    }
    const name = config.bridgeAdapter
    if (this.started.has(name)) return
    const adapter = this.adapters.get(name)
    if (adapter === undefined) {
      console.warn(
        `[bridge] 适配器 "${name}" 未注册（平台未实现？），融合层不启动。已注册：${this.adapterNames().join('、') || '无'}`,
      )
      return
    }
    if (adapter.isReal && this.rbac.agentServiceUsername() === undefined) {
      console.warn(
        `[bridge] 适配器 "${name}" 是真实平台：最小权限服务账号缺失或被停用，不允许连接` +
          `（方案 §6 风险1"否则不连"；服务账号在即放行，RBAC/白名单闸照常把守）。`,
      )
      return
    }
    adapter.onMessage((msg) => this.handleMessage(msg))
    adapter.onCardAction((action) => this.handleCardAction(action))
    try {
      await adapter.start()
    } catch (error) {
      // 连接失败不拖垮服务（launchd KeepAlive 重启循环比断桥更伤，对抗审查 P1-3）：大声报，状态如实=未连接
      const m = error instanceof Error ? error.message : String(error)
      console.warn(`[bridge] 适配器 "${name}" 启动失败，融合层未连接：${m}`)
      return
    }
    this.started.add(name)
    const allowed = this.db.prepare('SELECT COUNT(*) AS n FROM bridge_identities WHERE allowed = 1').get() as { n: number }
    console.log(`[bridge] 已启动 "${name}" 适配器（白名单 ${allowed.n} 人）`)
  }

  async shutdown(): Promise<void> {
    for (const name of this.started) {
      await this.adapters.get(name)?.stop().catch(() => {})
    }
    this.started.clear()
  }

  // ---------- 身份白名单（管理后台 REST 管理，admin:manage） ----------

  listIdentities(): BridgeIdentity[] {
    return this.db
      .prepare('SELECT * FROM bridge_identities ORDER BY platform, platform_userid')
      .all() as BridgeIdentity[]
  }

  upsertIdentity(
    caller: string,
    input: { platform: string; platformUserid: string; username: string; displayName?: string; allowed?: boolean },
    source = 'ui',
  ): BridgeIdentity {
    const platform = (input.platform ?? '').trim()
    const userid = (input.platformUserid ?? '').trim()
    const username = (input.username ?? '').trim()
    if (platform === '' || userid === '' || username === '') {
      throw new BadRequestError('platform / platformUserid / username 都不能为空。')
    }
    const user = this.rbac.findUser(username)
    if (user === undefined || user.disabled_at !== null) {
      throw new BadRequestError(`系统里没有启用的用户 "${username}"，先建账号再做平台映射。`)
    }
    if (user.is_service === 1) {
      throw new BadRequestError('不能把平台账号映射到服务账号（服务账号不代表人）。')
    }
    const allowed = input.allowed === true ? 1 : 0
    this.db
      .prepare(
        `INSERT INTO bridge_identities (platform, platform_userid, username, display_name, allowed, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(platform, platform_userid) DO UPDATE SET
           username = excluded.username, display_name = excluded.display_name,
           allowed = excluded.allowed, updated_at = excluded.updated_at`,
      )
      .run(platform, userid, username, (input.displayName ?? '').trim(), allowed, nowIso(), nowIso())
    this.audit.log({
      username: caller,
      source,
      action: 'bridge.identity.upsert',
      targetId: `${platform}/${userid}`,
      detail: { username, allowed: allowed === 1 },
    })
    return this.requireIdentity(platform, userid)
  }

  setIdentitySwitch(
    caller: string,
    platform: string,
    userid: string,
    patch: { allowed?: boolean; displayName?: string },
  ): BridgeIdentity {
    const row = this.requireIdentity(platform, userid)
    const allowed = patch.allowed === undefined ? row.allowed : patch.allowed ? 1 : 0
    const displayName = patch.displayName === undefined ? row.display_name : patch.displayName.trim()
    this.db
      .prepare('UPDATE bridge_identities SET allowed = ?, display_name = ?, updated_at = ? WHERE platform = ? AND platform_userid = ?')
      .run(allowed, displayName, nowIso(), platform, userid)
    this.audit.log({
      username: caller,
      source: 'ui',
      action: 'bridge.identity.update',
      targetId: `${platform}/${userid}`,
      detail: { allowed: allowed === 1, displayName },
    })
    return this.requireIdentity(platform, userid)
  }

  private requireIdentity(platform: string, userid: string): BridgeIdentity {
    const row = this.db
      .prepare('SELECT * FROM bridge_identities WHERE platform = ? AND platform_userid = ?')
      .get(platform, userid) as BridgeIdentity | undefined
    if (row === undefined) throw new NotFoundError(`没有 ${platform} 平台用户 ${userid} 的映射。`)
    return row
  }

  /** 白名单判定：条目存在且 allowed=1，且映射的系统用户存在未停用。 */
  private identityOf(platform: string, userid: string): IdentityRow | undefined {
    const row = this.db
      .prepare('SELECT username, display_name FROM bridge_identities WHERE platform = ? AND platform_userid = ? AND allowed = 1')
      .get(platform, userid) as IdentityRow | undefined
    if (row === undefined) return undefined
    const user = this.rbac.findUser(row.username)
    if (user === undefined || user.disabled_at !== null) return undefined
    return row
  }

  // ---------- 入站消息与卡片动作 ----------

  async handleMessage(msg: InboundMessage): Promise<void> {
    const adapter = this.adapters.get(msg.platform)
    const reply = async (text: string) => {
      try {
        await adapter?.sendText(msg.conversationId, text)
      } catch (error) {
        // 回信失败不能反向炸回 adapter 的回调链（契约：handler 异常责任在 BridgeService）
        console.warn('[bridge] 回信失败：', error instanceof Error ? error.message : error)
      }
    }
    if (adapter === undefined) return
    // 重推去重：同一平台同一 msgId 只处理一次。打标之后、进轮次之前的任何意外失败都要
    // 把标放开（对抗审查 P2-3）：否则平台 at-least-once 重推会撞标被静默丢，用户零回音。
    const dedupeKey = `${msg.platform}:${msg.msgId}`
    if (this.seenMessages.has(dedupeKey)) return
    this.seenMessages.set(dedupeKey, Date.now())
    if (this.seenMessages.size > 500) {
      for (const k of [...this.seenMessages.keys()].slice(0, 250)) this.seenMessages.delete(k)
    }

    try {
      const identity = this.identityOf(msg.platform, msg.platformUserid)
      if (identity === undefined) {
        this.audit.log({
          username: '-',
          source: 'bridge',
          action: 'bridge.message.reject',
          detail: { platform: msg.platform, platform_userid: msg.platformUserid, reason: '不在白名单或账号停用' },
          ok: false,
        })
        // 指路 OA 审批（2026-10-29 用户拍板：账号开通走平台审批，不走对话卡）。
        // 单名与 FeishuApprovalService.FEISHU_APPROVAL_NAME 人工同源，改一处必须同步另一处。
        await reply(
          '本系统账号需要管理员审批开通：请在飞书「工作台 → 审批」里搜索《智能体系统账号开通》发起申请' +
            '（填登录用户名和姓名），审批通过后你的账号会自动开通，初始密码会私聊发给你。',
        )
        return
      }
      // RBAC 闸：白名单只管"能进来"，进来后按映射账号的权限点干活（对抗审查 P1-2）
      if (!this.rbac.hasPermission(identity.username, 'agent:write')) {
        this.audit.log({
          username: identity.username,
          source: 'bridge',
          action: 'bridge.message.reject',
          detail: { platform: msg.platform, platform_userid: msg.platformUserid, reason: '映射账号缺 agent:write' },
          ok: false,
        })
        await reply('这个账号在系统里没有对话权限：请管理员检查它的角色配置。')
        return
      }
      // 非文本消息（图片/文件等）：过完闸才回指引——白名单外的人得不到任何回音（二轮对抗审查 P3-7）
      if (msg.unsupported === true) {
        await reply('这类消息（图片/文件/富文本等）暂时承接不了，请直接发文字；文件请传管理后台的文件工作区。')
        return
      }

      const text = msg.text.trim()
      if (text === '') return
      if (text.length > CHAT_MESSAGE_MAX) {
        await reply(`消息超过 ${CHAT_MESSAGE_MAX} 字上限，请拆开发，或把内容丢进管理后台的文件工作区再让 agent 处理。`)
        return
      }

      this.audit.log({
        username: identity.username,
        source: 'bridge',
        action: 'bridge.message',
        detail: { platform: msg.platform, conversation: msg.conversationId, chars: text.length },
      })
      const sessionId = this.sessionFor(msg.platform, msg.conversationId, identity.username)
      try {
        const startedIso = nowIso()
        const r = await this.agent.chat(sessionId, text, undefined, identity.username, () => {}, 'bridge')
        await reply(r.finalText)
        try {
          await this.emitPendingCards(adapter, msg.conversationId, startedIso)
        } catch (cardError) {
          // 补卡失败不算轮次失败（回答已经送达）：只留服务端日志，管理后台仍能看到该提案
          console.warn('[bridge] 补卡失败（轮次本身成功）：', cardError instanceof Error ? cardError.message : cardError)
        }
      } catch (error) {
        // chat 内部已把失败如实落库（agent_messages status=error），这里把原因带回平台
        const m = error instanceof Error ? error.message : String(error)
        // 互斥冲突（上一轮还在跑）：消息没进轮次。放开去重是防"若平台仍重推"的保险——
        // 长连接下 handler 正常 resolve 即 200、平台通常不重推（2026-10-29 官方文档核订），
        // 重发实际靠用户手动；真机冒烟确认重推行为后决定本行去留（首轮对抗审查 P2-2）
        if (error instanceof BadRequestError && m.includes('处理中')) this.seenMessages.delete(dedupeKey)
        await reply(`本轮没有完成：${m}`)
      }
    } catch (error) {
      // 进轮次之前的意外失败（审计/会话映射等基础设施性异常）：消息没被处理过。放开去重是
      // 防"若平台仍重推"的保险（长连接下 resolve 即 200、平台通常不重推；真机冒烟后定去留）——
      // 否则重推撞标会静默丢消息（二轮对抗审查 P2-3①）
      this.seenMessages.delete(dedupeKey)
      const m = error instanceof Error ? error.message : String(error)
      console.warn('[bridge] 消息处理意外失败（已放开重推去重）：', m)
      await reply(`这条消息没有处理成功：${m}`)
    }
  }

  /** 卡片点击处理：业务落库后返回处理结果，真实 adapter 据此走平台原生应答通道把卡面
   *  改成终态（随点击应答原子生效——不要在这里追加平台 HTTP 调用，3 秒应答窗口会爆，
   *  2026-10-29 真机实证）。返回 undefined=无可改脸（白名单外/无权限/提案不存在等）。 */
  async handleCardAction(action: CardAction): Promise<CardActionResult | undefined> {
    const adapter = this.adapters.get(action.platform)
    if (adapter === undefined) return
    const reply = async (text: string) => {
      try {
        await adapter.sendText(action.conversationId, text)
      } catch (error) {
        console.warn('[bridge] 回信失败：', error instanceof Error ? error.message : error)
      }
    }
    const identity = this.identityOf(action.platform, action.platformUserid)
    if (identity === undefined) {
      this.audit.log({
        username: '-',
        source: 'bridge',
        action: 'bridge.card.reject',
        targetId: action.kind === 'todo' ? String(action.todoId ?? '') : action.proposalId ?? '',
        detail: { platform: action.platform, kind: action.kind ?? 'proposal', platform_userid: action.platformUserid, reason: '不在白名单或账号停用' },
        ok: false,
      })
      return
    }
    // 待办卡分支（2026-10-31 待办预警方案 P2）：ack/done 是义务域写操作，与 REST 同权（todo:write）。
    // 3 秒应答窗口纪律：只做一次服务调用+一条回信，不在回调链里做平台 HTTP。
    if (action.kind === 'todo') {
      if (!this.rbac.hasPermission(identity.username, 'todo:write')) {
        this.audit.log({
          username: identity.username,
          source: 'bridge',
          action: 'bridge.card.reject',
          targetId: String(action.todoId ?? ''),
          detail: { platform: action.platform, kind: 'todo', platform_userid: action.platformUserid, reason: '映射账号缺 todo:write' },
          ok: false,
        })
        await reply('这个账号在系统里没有待办操作权限，不能处理待办卡。')
        return
      }
      this.audit.log({
        username: identity.username,
        source: 'bridge',
        action: 'bridge.card.action',
        targetId: String(action.todoId ?? ''),
        detail: { platform: action.platform, kind: 'todo', platform_userid: action.platformUserid, action: action.action, messageId: action.messageId },
      })
      if (this.todos === undefined || typeof action.todoId !== 'number') return
      try {
        const r = this.todos.todoCardAction(identity.username, action.todoId, action.action === 'done' ? 'done' : 'ack')
        await reply(r.phrase)
        return r.outcome
      } catch (error) {
        const m = error instanceof Error ? error.message : String(error)
        await reply(`没有处理成功：${m}`)
        // 已闭环的待办再点一遍：照样回终态让卡面改脸（与提案卡同一 UX 纪律，2026-10-29 实证）
        const st = this.db.prepare('SELECT status FROM obligations WHERE id = ?').get(action.todoId) as { status: string } | undefined
        if (st?.status === 'done') return 'done'
        return
      }
    }
    // 提案卡分支（kind 缺省=proposal，老调用兼容）：没有提案 id 的回调直接丢
    if (typeof action.proposalId !== 'string' || action.proposalId === '') return
    // RBAC 闸：确认/拒绝是记账写操作，与 REST 同权（finance:write）（对抗审查 P1-2）
    if (!this.rbac.hasPermission(identity.username, 'finance:write')) {
      this.audit.log({
        username: identity.username,
        source: 'bridge',
        action: 'bridge.card.reject',
        targetId: action.proposalId,
        detail: { platform: action.platform, platform_userid: action.platformUserid, reason: '映射账号缺 finance:write' },
        ok: false,
      })
      await reply('这个账号在系统里没有记账权限，不能确认或拒绝提案。')
      return
    }
    this.audit.log({
      username: identity.username,
      source: 'bridge',
      action: 'bridge.card.action',
      targetId: action.proposalId,
      detail: { platform: action.platform, platform_userid: action.platformUserid, action: action.action, messageId: action.messageId },
    })
    try {
      if (action.action === 'confirm') {
        const r = this.proposals.confirm({ username: identity.username, source: 'bridge' }, action.proposalId)
        const count = r.entries?.length ?? 0
        const head = r.entry !== undefined ? `已入账 ${r.entry.id}` : `已入账 ${count} 笔（批次 ${r.batch ?? ''}）`
        await reply(`${head}：${r.proposal.summary}`)
        return 'confirmed'
      } else {
        const r = this.proposals.reject({ username: identity.username, source: 'bridge' }, action.proposalId, action.reason ?? '')
        await reply(`已拒绝 ${r.id}${(action.reason ?? '').trim() === '' ? '' : `：${action.reason!.trim()}`}`)
        return 'rejected'
      }
    } catch (error) {
      // 已处理过/编号不存在等业务拒绝：原样带回平台，不吞。
      // 提案若已在终态（典型=同一张卡被点第二遍），照样返回终态让卡面改脸——
      // 卡面不变会让用户以为没生效再点一遍（2026-10-29 真机冒烟实证）
      const status = this.db
        .prepare('SELECT status FROM finance_proposals WHERE id = ?')
        .get(action.proposalId) as { status: string } | undefined
      const m = error instanceof Error ? error.message : String(error)
      await reply(`没有处理成功：${m}`)
      if (status?.status === 'confirmed' || status?.status === 'rejected') return status.status
      return
    }
  }

  // ---------- 内部 ----------

  /** 按平台用户直发单聊（OA 审批进场通知员工/老板用）。adapter 缺失必须抛（对抗审查
   *  P2-4：静默成功会让"密码已发"变成假象，调用方的回滚/兜底逻辑收不到信号）。 */
  async sendUserTo(platform: string, openId: string, text: string): Promise<void> {
    const adapter = this.adapters.get(platform)
    if (adapter === undefined) throw new Error(`平台 "${platform}" 的适配器未注册，发不了单聊`)
    await adapter.sendUserText(openId, text)
  }

  /** 按平台用户直发单聊卡片（2026-10-31 待办预警方案 §六：跃迁即时卡/晨报卡）。
   *  同 sendUserTo 纪律：adapter 缺失必须抛——静默失败会让"已提醒"变成假象。 */
  async sendUserCardTo(platform: string, openId: string, card: TodoCardView): Promise<void> {
    const adapter = this.adapters.get(platform)
    if (adapter === undefined) throw new Error(`平台 "${platform}" 的适配器未注册，发不了单聊卡片`)
    await adapter.sendUserCard(openId, card)
  }

  /** 按平台用户直发单聊提案卡（2026-11-01 审批落账：审批批了立刻把提案卡塞进老板单聊）。
   *  适配器没实现该形态时降级为文本指路（卡片是提醒形态，不是落账前提——提案已在库里，
   *  网页「提案」页随时能确认）；adapter 缺失仍必须抛，同 sendUserTo 纪律。 */
  async sendProposalCardToUser(platform: string, openId: string, card: ProposalCardView): Promise<void> {
    const adapter = this.adapters.get(platform)
    if (adapter === undefined) throw new Error(`平台 "${platform}" 的适配器未注册，发不了单聊提案卡`)
    if (typeof adapter.sendProposalCardToUser === 'function') {
      await adapter.sendProposalCardToUser(openId, card)
      return
    }
    await adapter.sendUserText(openId, `记账提案 ${card.id} 待确认：${card.summary}\n（${card.createdBy} ${card.createdAt}）请到管理后台「提案」页确认或拒绝。`)
  }

  /**
   * 平台会话 → 应用会话：一条 SQL 同时查存在性与归属——
   * dangling（对话域被删）重建；改绑（平台号换了映射用户）也重建，旧会话上下文不跟人走（对抗审查 P2-3）。
   * 归档会话不自动翻案（chat 会明说）。
   */
  private sessionFor(platform: string, conversationId: string, username: string): string {
    const row = this.db
      .prepare('SELECT session_id FROM bridge_sessions WHERE platform = ? AND conversation_id = ?')
      .get(platform, conversationId) as { session_id: string } | undefined
    if (row !== undefined) {
      const session = this.db
        .prepare('SELECT created_by FROM agent_sessions WHERE id = ?')
        .get(row.session_id) as { created_by: string } | undefined
      if (session !== undefined && session.created_by === username) return row.session_id
      if (session !== undefined) {
        this.audit.log({
          username,
          source: 'bridge',
          action: 'bridge.session.rebind',
          targetId: row.session_id,
          detail: { platform, conversationId },
        })
      }
    }
    const created = this.agent.createSession(username)
    this.db
      .prepare(
        `INSERT INTO bridge_sessions (platform, conversation_id, session_id, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(platform, conversation_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at`,
      )
      .run(platform, conversationId, created.id, nowIso())
    return created.id
  }

  /**
   * 轮次结束后补卡：只补本轮（startedIso 之后创建）的 agent 提案——created_by 按 runtime
   * 服务号过滤（2026-10-28 最小权限服务账号：agent 经 propose 出的提案都是服务号建的，
   * 老板自己在网页 REST 建的提案不会被桥补卡）；web 里积压的旧提案不往平台倾倒
   * （刻意不做 catch-up，避免启用/重启后一次齐发几十张卡，对抗审查 P2-1）。
   */
  private async emitPendingCards(
    adapter: BridgeAdapter,
    conversationId: string,
    startedIso: string,
  ): Promise<void> {
    const svc = this.rbac.agentServiceUsername()
    const pending = this.proposals
      .list('pending')
      .proposals.filter(
        (p) => p.created_by === svc && p.created_at >= startedIso && !this.sentProposals.has(p.id),
      )
    for (const p of pending) {
      if (p.kind === 'single') {
        await adapter.sendProposalCard(conversationId, {
          id: p.id,
          summary: p.summary,
          createdBy: p.created_by,
          createdAt: p.created_at,
        })
      } else {
        await adapter.sendText(
          conversationId,
          `提案 ${p.id} 是批量导入卡，明细多、平台卡片放不下——请到管理后台「提案」页确认。`,
        )
      }
      // 发送成功才标记（二轮对抗审查 P3-5）：标记在先会让发送失败的卡"看起来发过"
      this.sentProposals.add(p.id)
      if (this.sentProposals.size > 500) {
        for (const id of [...this.sentProposals].slice(0, 250)) this.sentProposals.delete(id)
      }
    }
  }
}

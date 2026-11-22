/**
 * 对话网关服务（2026-10-27 框架定版：对话域完整化）：
 * - 会话与消息持久化（agent_sessions / agent_messages，账本同库）：多会话、历史回看、
 *   刷新与服务重启后继续旧会话（DSH session/resume 原生续聊）。
 * - 管理一个专属 DSH SDK runtime 子进程（方案 §4：与 3080 常驻服务解耦），把对话框
 *   消息转成 agent 轮次并把事件流式吐回；中断=kill 子进程，下一轮重建 runtime 后先
 *   resume 原会话，已生成的半截回答如实落库（status=interrupted）。
 *
 * 身份（2026-10-28 融合方案 §6 风险1 最小权限服务账号）：网关在 spawn runtime 时用本进程
 * jwt 密钥直签**专用服务号**（is_service=1 的 "agent"，权限=工具门面最小集，无 admin:manage）
 * 注入环境（ADMIN_AGENT_TOKEN）——不再是 boss 全权令牌；平台侧消息若被提示注入，
 * 爆炸半径收在工具门面内。token 不进浏览器，也不落盘。对话归属（谁在聊）仍按入口传真实用户。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import jwt from 'jsonwebtoken'
import type { DB } from '../db/database.js'
import { nowIso } from '../db/database.js'
import { config } from '../config.js'
import { DshRuntime, RuntimeDiedError, TurnTimeoutError, type TurnEvent } from './dsh-runtime.js'
import type { RbacService } from '../rbac/rbac.service.js'
import type { AuditService } from '../audit/audit.service.js'
import { BadRequestError, NotFoundError } from '../errors.js'

/** 对话框上下文（前端随消息带：老板正在看什么）。 */
export interface ChatContext {
  page?: string
  entryId?: string
}

/** 发给前端的一条 SSE 事件。 */
export type ChatStreamEvent =
  | { event: 'status'; data: { phase: 'thinking' | 'fresh-context' } }
  | { event: 'tool'; data: { name: string } }
  | { event: 'assistant'; data: { text: string } }
  | { event: 'final'; data: { text: string; sessionId: string; interrupted?: boolean } }
  | { event: 'error'; data: { message: string } }

export interface AgentSessionRow {
  id: string
  title: string
  dsh_session_id: string
  created_by: string
  created_at: string
  updated_at: string
  archived: number
}

export interface AgentMessageRow {
  id: number
  session_id: string
  role: 'user' | 'assistant'
  content: string
  tools: string
  status: 'ok' | 'interrupted' | 'error'
  created_at: string
}

const DEFAULT_DSH_BIN = join(
  process.cwd(),
  'node_modules',
  '.bin',
  'dsh',
)
// 补丁/preset 所在目录（框架复制到别的公司时用 ADMIN_DSH_PATCH_DIR 指到自己的工作区）
const WORKSPACE_DIR = process.env.ADMIN_DSH_PATCH_DIR
  ?? join(process.env.HOME ?? '', '.dsh', 'default-workspace')
const TITLE_MAX = 24
// 轮次超时可调（测试用短超时验证僵尸 runtime 回收）；agent 直签给子进程的服务身份令牌
// 豁免常规 TTL：常驻 runtime 可能活几个月，30 天过期会让财务工具批量 401 静默坏死——
// 本机单人部署、令牌只进子进程环境不落盘不外发，随进程重启换新，签 10 年。
const TURN_TIMEOUT_MS = Number(process.env.ADMIN_AGENT_TURN_TIMEOUT_MS ?? 180_000)
const AGENT_TOKEN_TTL = '3650d'
/** 对话消息长度上限（网关 REST 与融合层桥入共用同一口径）。 */
export const CHAT_MESSAGE_MAX = 4000

export class AgentService {
  private runtime: DshRuntime | undefined
  /** 正在跑轮次的应用会话 id（stop 的靶子；无进行中轮次时为空）。 */
  private activeSessionId: string | undefined
  /** 防并发轮次：一个 runtime 同时只跑一轮。 */
  private turn: Promise<void> | undefined
  /** 用户点了停止的会话：chat 收尾时把 RuntimeDiedError 转成 interrupted 而非 error。 */
  private stopping = new Set<string>()

  constructor(
    private readonly db: DB,
    private readonly rbac: RbacService,
    private readonly audit: AuditService,
  ) {}

  // ---------- 会话与消息（持久化） ----------

  createSession(username: string): AgentSessionRow {
    const row: AgentSessionRow = {
      id: randomUUID(),
      title: '新会话',
      dsh_session_id: randomUUID(),
      created_by: username,
      created_at: nowIso(),
      updated_at: nowIso(),
      archived: 0,
    }
    this.db
      .prepare(
        `INSERT INTO agent_sessions (id, title, dsh_session_id, created_by, created_at, updated_at, archived)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.title, row.dsh_session_id, row.created_by, row.created_at, row.updated_at, 0)
    this.audit.log({ username, source: 'ui', action: 'agent.session.create', targetId: row.id })
    return row
  }

  /** 列表只看自己的（2026-10-31 数据分割：对话是个人层资产，见方案 §1.6）。 */
  listSessions(includeArchived: boolean, username: string): AgentSessionRow[] {
    return this.db
      .prepare(
        `SELECT * FROM agent_sessions WHERE created_by = ? ${includeArchived ? '' : 'AND archived = 0'}
         ORDER BY updated_at DESC, id DESC`,
      )
      .all(username) as AgentSessionRow[]
  }

  getSession(id: string): AgentSessionRow {
    const row = this.db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(id) as
      | AgentSessionRow
      | undefined
    if (!row) throw new NotFoundError('会话不存在或已删除。')
    return row
  }

  /** 归属校验：会话只属于创建人，管理员也不例外（个人层无后门）。
   *  越权统一报"不存在"而非"无权"——不向探测者泄露他人会话的存在性。 */
  private ownedSession(id: string, username: string): AgentSessionRow {
    const row = this.getSession(id)
    if (row.created_by !== username) throw new NotFoundError('会话不存在或已删除。')
    return row
  }

  getMessages(sessionId: string, username: string): AgentMessageRow[] {
    this.ownedSession(sessionId, username)
    return this.db
      .prepare('SELECT * FROM agent_messages WHERE session_id = ? ORDER BY id ASC')
      .all(sessionId) as AgentMessageRow[]
  }

  renameSession(id: string, title: string, username: string): AgentSessionRow {
    this.ownedSession(id, username)
    const clean = title.trim().slice(0, 50)
    if (!clean) throw new BadRequestError('标题不能为空。')
    this.db
      .prepare('UPDATE agent_sessions SET title = ?, updated_at = ? WHERE id = ?')
      .run(clean, nowIso(), id)
    this.audit.log({ username, source: 'ui', action: 'agent.session.rename', targetId: id })
    return this.getSession(id)
  }

  setArchived(id: string, archived: boolean, username: string): AgentSessionRow {
    this.ownedSession(id, username)
    if (archived && this.activeSessionId === id) {
      throw new BadRequestError('这个会话正在生成回答，先停止再归档')
    }
    this.db
      .prepare('UPDATE agent_sessions SET archived = ?, updated_at = ? WHERE id = ?')
      .run(archived ? 1 : 0, nowIso(), id)
    this.audit.log({
      username,
      source: 'ui',
      action: 'agent.session.archive',
      targetId: id,
      detail: { archived },
    })
    return this.getSession(id)
  }

  /** 删除会话：应用层级联删两张表（事务）。DSH 侧会话库记录不动（历史留日志，协议不提供删除）。 */
  deleteSession(id: string, username: string): void {
    this.ownedSession(id, username)
    if (this.activeSessionId === id) {
      throw new BadRequestError('这个会话正在生成回答，先停止再删除')
    }
    const del = this.db.transaction(() => {
      this.db.prepare('DELETE FROM agent_messages WHERE session_id = ?').run(id)
      this.db.prepare('DELETE FROM agent_sessions WHERE id = ?').run(id)
    })
    del()
    this.audit.log({ username, source: 'ui', action: 'agent.session.delete', targetId: id })
  }

  // ---------- runtime 与轮次 ----------

  private buildRuntime(): DshRuntime {
    const patches = [
      join(WORKSPACE_DIR, 'glm-route.patch.yml'),
      join(WORKSPACE_DIR, 'finance-desk-rest.patch.yml'),
    ]
    const logDir = join(config.dataDir, 'agent-logs')
    mkdirSync(logDir, { recursive: true })
    // 子进程只拿运行必需的环境；网关自己的敏感配置（JWT 密钥等）不陪葬
    const { ADMIN_JWT_SECRET: _secret, ADMIN_BOSS_PASSWORD: _pwd, ...baseEnv } = process.env
    // launchd 拉起时 PATH 只有系统目录：dsh 垫片要 exec node（/usr/local/bin）、
    // mcp-kb 要 uv（~/.local/bin），缺了子进程秒退（2026-10-26 实测），按位置拼一份
    const childPath = [
      join(process.execPath, '..'),
      '/opt/homebrew/bin',
      process.env.HOME ? join(process.env.HOME, '.local/bin') : undefined,
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ]
      .filter((p): p is string => p !== undefined)
      .join(':')
    const runtime = new DshRuntime({
      dshBin: process.env.ADMIN_DSH_BIN ?? DEFAULT_DSH_BIN,
      patches,
      cwd: process.env.HOME ?? '/',
      provider: process.env.ADMIN_DSH_PROVIDER ?? 'zai-coding-cn',
      // 缺省 glm-5.3-flash（用户 2026-10-26 拍板"全部默认 flash"）：glm-route 补丁的模型目录
      // 只声明 flash/highspeed，rc.4 起对目录外模型严格拒绝（rc.2 时代 glm-5.3 能混过去）
      model: process.env.ADMIN_DSH_MODEL ?? 'glm-5.3-flash',
      env: {
        ...baseEnv,
        PATH: childPath,
        HOME: process.env.HOME ?? '/',
        // agent 的后端服务身份（2026-10-28 最小权限服务账号，融合方案 §6 风险1）：
        // 专用服务号（无 admin:manage），seed 幂等保证存在；缺位即拒启——绝不回退 boss 全权令牌
        ADMIN_API_BASE: `http://127.0.0.1:${config.port}`,
        ADMIN_AGENT_TOKEN: jwt.sign({ sub: this.requireServiceUser() }, config.jwtSecret, {
          expiresIn: AGENT_TOKEN_TTL,
        }),
        // 文件工作区（任务全图 §0.6 对话入口）：file-tools 插件按它锁死读写根
        ADMIN_WORKSPACE_DIR: join(config.dataDir, 'workspace'),
      },
      logFile: join(logDir, 'dsh-runtime.log'),
    })
    runtime.setOnDied(() => {
      // 崩溃即弃：下一轮 chat() 会换新 runtime（自动拉起的落点）
      if (this.runtime === runtime) this.runtime = undefined
    })
    return runtime
  }

  /** 服务号令牌的 sub：缺位即抛（seed 保证存在；管理员停用服务号=显式要求网关拒启）。 */
  private requireServiceUser(): string {
    const svc = this.rbac.agentServiceUsername()
    if (svc === undefined) {
      throw new Error('agent 服务账号缺失或被停用（seed 应创建 is_service=1 的 "agent"），拒绝以 boss 令牌启动 runtime')
    }
    return svc
  }

  private async getRuntime(): Promise<DshRuntime> {
    if (this.runtime?.alive) return this.runtime
    this.runtime = this.buildRuntime()
    return this.runtime
  }

  private static contextPrefix(context: ChatContext | undefined): string {
    if (!context) return ''
    const bits: string[] = []
    if (context.page) bits.push(`当前页面：${context.page}`)
    if (context.entryId) bits.push(`正在看的账目编号：${context.entryId}`)
    return bits.length ? `[系统上下文：${bits.join('；')}]\n` : ''
  }

  /** 该会话是否在 runtime 侧跑过轮次（有 assistant 回答=跑过）：决定换新进程后要不要 resume。 */
  private hasTurned(sessionId: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM agent_messages WHERE session_id = ? AND role = 'assistant' LIMIT 1")
        .get(sessionId) !== undefined
    )
  }

  private insertMessage(
    sessionId: string,
    role: 'user' | 'assistant',
    content: string,
    status: 'ok' | 'interrupted' | 'error',
    tools: string[] = [],
  ): void {
    this.db
      .prepare(
        'INSERT INTO agent_messages (session_id, role, content, tools, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(sessionId, role, content, JSON.stringify(tools), status, nowIso())
    this.db.prepare('UPDATE agent_sessions SET updated_at = ? WHERE id = ?').run(nowIso(), sessionId)
  }

  /**
   * 跑一轮对话：onEvent 流式回调（SSE 控制器逐条写出），Promise 在轮次结束（idle/出错/被停）时落定。
   * 用户消息与 assistant 回答都落库；被停=已生成半截按 interrupted 落库；
   * runtime 崩溃/超时=按 error 落库并把错误流出。
   */
  async chat(
    sessionId: string,
    message: string,
    context: ChatContext | undefined,
    username: string,
    onEvent: (e: ChatStreamEvent) => void,
    /** 审计来源（2026-10-28 融合层：平台桥入的消息标 bridge，其余仍是 ui）。 */
    source: 'ui' | 'bridge' = 'ui',
  ): Promise<{ finalText: string; sessionId: string }> {
    const session = this.ownedSession(sessionId, username)
    if (session.archived) throw new NotFoundError('会话已归档，先取消归档再继续对话。')
    if (this.turn) {
      throw new BadRequestError('上一条消息还在处理中，请等它结束再发')
    }
    // 同步占住互斥槽：检查与占用之间不能有 await（否则同 tick 双请求可双双通过）
    let releaseTurn!: () => void
    this.turn = new Promise<void>((resolve) => {
      releaseTurn = resolve
    })
    this.activeSessionId = sessionId
    try {
      // 用户消息先落库（说了就是说了，后面轮次成败不影响这行）
      this.insertMessage(sessionId, 'user', message, 'ok')
      if (session.title === '新会话' && message.trim()) {
        this.db
          .prepare('UPDATE agent_sessions SET title = ? WHERE id = ?')
          .run(message.trim().slice(0, TITLE_MAX), sessionId)
      }

      let lastAssistant = ''
      const tools: string[] = []
      try {
        const runtime = await this.getRuntime()
        // 子进程不持有该会话（服务重启/进程重建/崩溃自愈后）且历史上有轮次：先 resume 原生续聊。
        // resume 失败（DSH 会话库没这条，或超时遗留的 already-owned）→ 降级按新上下文继续，如实告知；
        // 原因留服务端日志供追查（会话库缺失 vs already-owned 僵尸是两种不同的病）。
        if (!runtime.hasSession(session.dsh_session_id) && this.hasTurned(sessionId)) {
          try {
            await runtime.resume(session.dsh_session_id)
          } catch (resumeError) {
            console.warn(
              `[agent] 会话 ${sessionId} resume 失败，降级新上下文继续：`,
              resumeError instanceof Error ? resumeError.message : resumeError,
            )
            onEvent({ event: 'status', data: { phase: 'fresh-context' } })
          }
        }
        const r = await runtime.run(
          session.dsh_session_id,
          AgentService.contextPrefix(context) + message,
          (e: TurnEvent) => {
            if (e.kind === 'status' && e.status === 'running')
              onEvent({ event: 'status', data: { phase: 'thinking' } })
            else if (e.kind === 'assistant' && e.text) {
              lastAssistant = e.text
              onEvent({ event: 'assistant', data: { text: e.text } })
            } else if (e.kind === 'tool') {
              if (!tools.includes(e.name)) tools.push(e.name)
              onEvent({ event: 'tool', data: { name: e.name } })
            }
          },
          TURN_TIMEOUT_MS,
        )
        const finalText = r.finalText || lastAssistant
        this.insertMessage(sessionId, 'assistant', finalText, 'ok', tools)
        this.audit.log({
          username,
          source,
          action: 'agent.chat',
          targetId: sessionId,
          detail: { chars: message.length, tools: tools.length },
        })
        onEvent({ event: 'final', data: { text: finalText, sessionId } })
        return { finalText, sessionId }
      } catch (error) {
        if (this.stopping.has(sessionId)) {
          // 用户主动停止：已生成的半截回答如实入库，不算错误
          const partial = lastAssistant || '（已停止，本轮没有生成内容）'
          this.insertMessage(sessionId, 'assistant', partial, 'interrupted', tools)
          onEvent({ event: 'final', data: { text: partial, sessionId, interrupted: true } })
          return { finalText: partial, sessionId }
        }
        // 进程死了（崩溃）或轮次超时（子进程那一轮可能还在跑，留着就是僵尸）：
        // 两种都把 runtime 关闭弃掉，下一轮重建（超时弃掉也顺带解了 already-owned 的死结）
        if (
          (error instanceof RuntimeDiedError || error instanceof TurnTimeoutError)
          && this.runtime !== undefined
        ) {
          const dead = this.runtime
          this.runtime = undefined
          void dead.close().catch(() => {})
        }
        const msg = error instanceof Error ? error.message : String(error)
        this.insertMessage(sessionId, 'assistant', `（本轮出错：${msg}）`, 'error', tools)
        this.audit.log({
          username,
          source,
          action: 'agent.chat',
          targetId: sessionId,
          detail: { failed: true, error: msg.slice(0, 200) },
          ok: false,
        })
        onEvent({ event: 'error', data: { message: msg } })
        throw error
      }
    } finally {
      this.turn = undefined
      this.activeSessionId = undefined
      // 无论哪条路径收尾都清停止标记：残留会把之后真正的崩溃误判成"用户停止"
      this.stopping.delete(sessionId)
      releaseTurn()
    }
  }

  /**
   * 中断正在进行的轮次：kill 子进程 → runtime 侧 pending 轮次立刻失败 →
   * chat() 的 stopping 分支收尾（interrupted 落库 + SSE final）。
   * 线协议没有 cancel，这是协议约束下能做到的进程级中断。
   */
  stop(sessionId: string, username: string): { stopped: boolean } {
    this.ownedSession(sessionId, username)
    if (this.activeSessionId !== sessionId) return { stopped: false }
    this.stopping.add(sessionId)
    const runtime = this.runtime
    this.runtime = undefined
    this.audit.log({
      username,
      source: 'ui',
      action: 'agent.session.stop',
      targetId: sessionId,
      detail: { requested: true },
    })
    // close() 异步杀进程；chat 侧不等这里，靠 RuntimeDiedError 收尾
    void runtime?.close().catch(() => {})
    return { stopped: true }
  }

  /** 优雅关停（进程退出钩子用）。 */
  async shutdown(): Promise<void> {
    await this.runtime?.close()
    this.runtime = undefined
  }

  /** 配置自检（启动日志用）：补丁文件与 dsh 二进制是否在位。 */
  static checkSetup(): { ok: boolean; problems: string[] } {
    const problems: string[] = []
    const dshBin = process.env.ADMIN_DSH_BIN ?? DEFAULT_DSH_BIN
    if (!existsSync(dshBin)) problems.push(`dsh 可执行文件不存在：${dshBin}`)
    for (const f of ['glm-route.patch.yml', 'finance-desk-rest.patch.yml']) {
      const p = join(WORKSPACE_DIR, f)
      if (!existsSync(p)) problems.push(`补丁文件不存在：${p}`)
    }
    if (!process.env.ZAI_CODING_CN_API_KEY) {
      problems.push('环境变量 ZAI_CODING_CN_API_KEY 未设置（模型调用会失败）')
    }
    return { ok: problems.length === 0, problems }
  }
}

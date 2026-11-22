/**
 * DSH SDK 协议客户端：spawn `dsh --profile sdk` 子进程，走按换行分帧的 JSON-RPC 驱动 agent 轮次。
 *
 * 为什么自写这层薄客户端而不用 @deepseek-ai/dsh-sdk-client：npm 上的 TS 客户端
 * (0.0.1-rc.1) 与本机运行时 (0.2.0-rc.2) 版本不同代、peer 依赖解不开；本地克隆是
 * 0.2.1-alpha.2，与生产 0.2.0-rc.2 也不匹配。协议本身极小（3 请求 + 4 通知），
 * 传输类直接复用运行时同版本的 @deepseek-ai/dsh-sdk-protocol（官方纯库），
 * 本文件只补：spawn 生命周期、initialize 握手、会话 resume、idle 等待与关闭阶梯。
 * 协议事实源：node_modules/@deepseek-ai/dsh-sdk-protocol/lib/types/*.d.ts（0.2.1-rc.4）。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, openSync } from 'node:fs'
import { JsonRpcLineTransport, JsonRpcResponseError } from '@deepseek-ai/dsh-sdk-protocol'

export interface DshRuntimeOptions {
  /** dsh 可执行文件路径。 */
  dshBin: string
  /** 有序 --patch 文件（模型路由在前，preset 在后）。 */
  patches: string[]
  /** 运行时工作目录（记录进 SDK 会话头）。 */
  cwd: string
  /** 模型路由（必须与补丁挂载的适配器一致，握手前服务端会校验）。 */
  provider: string
  model: string
  /** 子进程环境（整体替换；网关负责带上模型 key 与 ADMIN_AGENT_TOKEN）。 */
  env: NodeJS.ProcessEnv
  /** 运行时 stderr/日志落点。 */
  logFile: string
  /** initialize 握手超时（毫秒）。 */
  initializeTimeoutMs?: number
}

/** 一次 agent 轮次里网关关心的事件（SSE 直接映射）。 */
export type TurnEvent =
  | { kind: 'status'; status: 'running' | 'idle' }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; name: string }
  | { kind: 'tool-result'; name: string; isError: boolean }

export interface TurnResult {
  sessionId: string
  /** 根会话本轮最后一条 assistant/message 的纯文本。 */
  finalText: string
}

interface PendingTurn {
  sessionId: string
  rootSessionId: string
  resolve: (r: TurnResult) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
  finalText: string
  /** turn/end kind=error 的可读原因；idle 时据此拒绝轮次而非交空文本（2026-10-29 401 被吞成空回复的教训）。 */
  turnError?: string
}

/** runtime 子进程意外退出。 */
export class RuntimeDiedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RuntimeDiedError'
  }
}

/**
 * 轮次超时（网关侧放弃等待）。子进程那一轮可能还在跑：服务层必须把 runtime
 * 关闭弃掉（等价于 stop 的 kill），否则留下一个"僵尸轮次"——stop 按钮够不着它，
 * 同会话重试还会撞 already-owned，只能重启整个管理服务才能解围。
 */
export class TurnTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TurnTimeoutError'
  }
}

/**
 * 模型/agent 侧轮次失败（turn/end kind=error，如鉴权 401）。runtime 进程本身健康：
 * 服务层照普通错误上报即可，不要像崩溃/超时那样弃掉整个 runtime。
 */
export class TurnFailedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TurnFailedError'
  }
}

const SHUTDOWN_TIMEOUT_MS = 2000

export class DshRuntime {
  private child?: ChildProcess
  private transport?: JsonRpcLineTransport
  private readonly opts: DshRuntimeOptions
  private pending: PendingTurn | undefined
  private starting: Promise<void> | undefined
  private closed = false
  /** 子进程曾经意外退出（close() 不算）；死亡后 start() 会换新子进程。 */
  private died = false
  private onDied: (() => void) | undefined
  /** 当前轮的事件透传（assistant 按整条消息完成粒度）。 */
  private onTurnEvent: ((e: TurnEvent) => void) | undefined
  /** 本子进程会话库已持有的 DSH 会话 id（run/resume 成功后记入；换进程即清空）。 */
  private owned = new Set<string>()

  constructor(opts: DshRuntimeOptions) {
    this.opts = opts
  }

  /** 是否处于可用状态（已关闭或已知死亡=不可用；未启动=可用，走惰性启动）。 */
  get alive(): boolean {
    if (this.closed || this.died) return false
    if (!this.child) return true
    return this.child.exitCode === null && this.child.signalCode === null
  }

  setOnDied(cb: () => void): void {
    this.onDied = cb
  }

  /** 惰性启动 + 握手；重复调用复用进行中的启动。 */
  async start(): Promise<void> {
    if (this.closed) throw new RuntimeDiedError('runtime 已关闭，拒绝复用（请新建实例）')
    if (this.alive && this.transport) return
    if (this.starting) return this.starting
    this.starting = this.doStart().finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  private async doStart(): Promise<void> {
    this.died = false
    const args = ['--profile', 'sdk']
    for (const p of this.opts.patches) args.push('--patch', p)
    // 常见启动失败（bin 缺失/不可执行）提前给出可读报错，别等 transport 的笼统拒绝抢先
    if (!existsSync(this.opts.dshBin)) {
      this.died = true
      throw new RuntimeDiedError(`dsh 启动失败：找不到可执行文件 ${this.opts.dshBin}（检查安装或 ADMIN_DSH_BIN）`)
    }
    const out = openSync(this.opts.logFile, 'a')
    const child = spawn(this.opts.dshBin, args, {
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdio: ['pipe', 'pipe', out],
    })
    this.child = child
    const transport = new JsonRpcLineTransport(child.stdout!, child.stdin!)
    transport.onNotification((method, params) => this.handleNotification(method, params))
    transport.start()
    this.transport = transport
    // 子进程死后 stdin/stdout 是已断的管道：SDK 再写入会以 EPIPE 在 Socket 上发 'error'，
    // 没人监听会崩掉整个管理服务进程（2026-10-26 实测两次）。错误已在 exit 生命周期处理，这里只保进程不崩。
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream?.on('error', () => {})
    }

    // spawn 本身失败（二进制缺失/权限等）只发 'error' 不发 'exit'；
    // 不监听会以 unhandled 'error' 崩掉整个管理服务进程（对抗审查 A6）。
    let failStart: ((e: Error) => void) | undefined
    child.once('error', (err) => {
      this.died = true
      this.transport?.close()
      this.transport = undefined
      this.child = undefined
      failStart?.(new RuntimeDiedError(`dsh 启动失败：${err.message}（检查 dsh 二进制与依赖安装，或 ADMIN_DSH_BIN 配置）`))
    })

    child.once('exit', (code, signal) => {
      this.died = true
      this.owned.clear()
      const err = new RuntimeDiedError(
        `dsh runtime 退出（code=${code ?? '-'} signal=${signal ?? '-'}），日志尾部见 ${this.opts.logFile}`,
      )
      this.transport?.close()
      this.transport = undefined
      this.child = undefined
      if (this.pending) {
        const p = this.pending
        this.clearPending()
        p.reject(err)
      }
      // initialize 握手还在等的时候子进程就退了：立即失败，别干等超时
      failStart?.(err)
      if (!this.closed) this.onDied?.()
    })

    const timeout = this.opts.initializeTimeoutMs ?? 30_000
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        transport.request('initialize', {
          cwd: this.opts.cwd,
          provider: this.opts.provider,
          model: this.opts.model,
        }),
        new Promise<never>((_, reject) => {
          failStart = reject
          timer = setTimeout(() => reject(new Error(`initialize 握手超时（${timeout}ms）`)), timeout)
        }),
      ])
    } catch (error) {
      await this.close()
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    // 方法名事实源：协议 types.d.ts —— 通知用点号（session.event/session.status），请求用斜杠（session/prompt）
    if (method === 'session.status') {
      const p = this.pending
      const sessionId = params['sessionId']
      if (p && sessionId === p.rootSessionId && params['status'] === 'idle') {
        this.clearPending()
        if (p.turnError) p.reject(new TurnFailedError(p.turnError))
        else p.resolve({ sessionId: p.sessionId, finalText: p.finalText })
      }
      return
    }
    if (method !== 'session.event') return
    const event = params['event'] as
      | { type?: string; data?: Record<string, unknown>; sessionId?: string }
      | undefined
    if (!event) return
    const p = this.pending
    const evSession = params['sessionId']
    if (!p || evSession !== p.rootSessionId) return
    const data = event.data ?? {}
    if (event.type === 'assistant/message') {
      const blocks = (data['message'] as { content?: Array<{ type?: string; text?: string }> } | undefined)
        ?.content ?? []
      const text = blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('')
      if (text) {
        p.finalText = text
        this.onTurnEvent?.({ kind: 'assistant', text })
      }
    } else if (event.type === 'turn/end') {
      // 错误形状照 2026-10-29 真机抓包：reason:{kind:'error', error:{message, code}}（协议 types 未定型，以此为准）
      const reason = data['reason'] as
        | { kind?: string; error?: { message?: string; code?: string } }
        | undefined
      if (reason?.kind === 'error') {
        const msg = reason.error?.message ?? '未知错误'
        const code = reason.error?.code
        p.turnError = code ? `模型调用失败（${code}）：${msg}` : msg
      }
    } else if (event.type === 'tool/call') {
      const name = typeof data['name'] === 'string' ? data['name'] : 'tool'
      this.onTurnEvent?.({ kind: 'tool', name })
    }
  }

  /** 本子进程会话库是否已持有该会话（决定续聊前要不要 resume）。 */
  hasSession(sessionId: string): boolean {
    return this.owned.has(sessionId)
  }

  /**
   * 让本子进程接管一个已存在的 DSH 会话（0.2.1-rc.3+ 的 session/resume）：
   * 服务重启/子进程重建后继续旧会话前必须先 resume，否则对已落盘会话直接 prompt
   * 会被 runtime 以"会话已存在"拒绝（rc.2 时代的崩溃雷）。
   * 失败（会话在 runtime 会话库里不存在等）原样转成可读错误抛出，调用方降级。
   */
  async resume(sessionId: string): Promise<void> {
    await this.start()
    const transport = this.transport
    if (!transport || !this.alive) throw new RuntimeDiedError('runtime 未在运行')
    try {
      await transport.request('session/resume', { sessionId })
      this.owned.add(sessionId)
    } catch (error) {
      throw error instanceof JsonRpcResponseError
        ? new Error(`runtime 拒绝 resume：${error.message}`)
        : error instanceof Error
          ? error
          : new Error(String(error))
    }
  }

  /**
   * 跑一个 agent 轮次：入队 prompt，等整个 agent 回到 idle。
   * onEvent 只会收到该轮内根会话的 assistant 消息文本。
   *
   * 轮次状态必须在发出 prompt 前就位：真 runtime 会把 prompt 回执和后续轮次事件
   * 放进同一个读取批次，transport 在一个同步循环里逐帧派发——若等回执的 await
   * 恢复后才装 pending，同批到达的全部事件（含 idle）会被当孤儿帧丢弃，轮次永远
   * 等不到结束信号（2026-10-19 实测挂死的根因）。
   */
  async run(
    sessionId: string,
    text: string,
    onEvent: (e: TurnEvent) => void,
    turnTimeoutMs = 180_000,
  ): Promise<TurnResult> {
    await this.start()
    const transport = this.transport
    if (!transport || !this.alive) throw new RuntimeDiedError('runtime 未在运行')
    if (this.pending) throw new Error('上一轮对话还在进行中，请稍候')

    return new Promise<TurnResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.sessionId === sessionId) {
          this.clearPending()
          reject(new TurnTimeoutError(`agent 轮次超时（${Math.round(turnTimeoutMs / 1000)}s），已放弃等待`))
        }
      }, turnTimeoutMs)
      const pending: PendingTurn = {
        sessionId,
        rootSessionId: sessionId,
        resolve,
        reject,
        timer,
        finalText: '',
      }
      this.onTurnEvent = onEvent
      this.pending = pending
      transport
        .request('session/prompt', {
          sessionId,
          contentBlocks: [{ type: 'text', text }],
        })
        .catch((error: unknown) => {
          // 回执失败（被拒/传输断）：拆掉刚装上的轮次状态，把错误还给调用方
          if (this.pending !== pending) return
          this.clearPending()
          pending.reject(
            error instanceof JsonRpcResponseError
              ? new Error(`runtime 拒绝 prompt：${error.message}`)
              : error instanceof Error
                ? error
                : new Error(String(error)),
          )
        })
      // 只有回执通过、轮次正常收尾才算"本进程持有该会话"；中途崩溃走 exit 回调清空全表
      pending.resolve = (r) => {
        this.owned.add(sessionId)
        resolve(r)
      }
    })
  }

  private clearPending(): void {
    const p = this.pending
    this.pending = undefined
    this.onTurnEvent = undefined
    if (p) clearTimeout(p.timer)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.owned.clear()
    const transport = this.transport
    const child = this.child
    this.transport = undefined
    this.child = undefined
    if (transport && child && child.exitCode === null) {
      try {
        await Promise.race([
          transport.request('shutdown', {}),
          new Promise((r) => setTimeout(r, SHUTDOWN_TIMEOUT_MS)),
        ])
      } catch {
        // 忽略：关闭阶梯兜底
      }
    }
    transport?.close()
    if (child && child.exitCode === null) {
      child.kill('SIGTERM')
      const killed = await Promise.race([
        new Promise<boolean>((r) => child.once('exit', () => r(true))),
        new Promise<boolean>((r) => setTimeout(() => r(false), SHUTDOWN_TIMEOUT_MS)),
      ])
      if (!killed) child.kill('SIGKILL')
    }
  }
}

/**
 * kb-rag MCP 客户端（2026-11-02 阶段 3 知识库融合）：以 stdio 拉起 `kb-rag-mcp` 子进程并保持长连接，
 * 首次调用才启动（嵌入模型冷启动约数秒），空闲超时自动停；子进程崩溃/被杀后下一次调用自动重拉。
 *
 * 身份：子进程 env 里的 KB_CALLER 决定 kb-rag 侧读写范围（规则表在 kb-rag 仓库 scopes.json），
 * 管理台缺省 company-console——只读公司项目与 Shared。这是读范围的事实源，本文件不再做路径过滤。
 *
 * 协议细节交给官方 SDK（@modelcontextprotocol/sdk）：握手、分帧、请求超时、结果校验都不自写。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

export interface KbMcpClientOptions {
  command: string
  args: string[]
  /** 追加到子进程 env（在 SDK 默认安全子集之上），KB_CALLER 放这里。 */
  env?: Record<string, string>
  /** 空闲多久自动关掉子进程；0 或负数=不自动停。 */
  idleMs: number
  /** 诊断日志出口（缺省 console.warn），测试里可换成收集器。 */
  log?: (message: string) => void
}

export class KbMcpClient {
  private client?: Client
  private starting?: Promise<Client>
  private idleTimer?: NodeJS.Timeout
  private lastError?: string
  /** 飞行中的调用数：>0 时不装空闲计时器，先完成的请求不能把后完成的请求连子进程一起关掉 */
  private inflight = 0
  private readonly log: (message: string) => void

  constructor(private readonly opts: KbMcpClientOptions) {
    this.log = opts.log ?? ((m) => console.warn(`[knowledge:mcp] ${m}`))
  }

  /** 子进程是否在线（已完成握手）。 */
  get running(): boolean {
    return this.client !== undefined
  }

  /** 最近一次启动/调用失败的原因（给状态接口做人话提示）。 */
  get lastFailure(): string | undefined {
    return this.lastError
  }

  /** 调一个工具，返回拼接后的文本内容；任何失败都把连接丢掉，下一次调用重新拉起。 */
  async callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<string> {
    const client = await this.ensure()
    this.clearIdle()
    this.inflight += 1
    try {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs })
      this.lastError = undefined
      return textOf(result)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.lastError = message
      await this.drop(`工具 ${name} 调用失败：${message}`)
      throw new Error(message)
    } finally {
      this.inflight -= 1
      if (this.inflight === 0) this.armIdle()
    }
  }

  /** 主动关闭（进程退出阶梯里调）。 */
  async close(): Promise<void> {
    this.clearIdle()
    const client = this.client
    this.client = undefined
    this.starting = undefined
    if (client !== undefined) {
      await client.close().catch(() => {})
    }
  }

  private async ensure(): Promise<Client> {
    if (this.client !== undefined) return this.client
    if (this.starting !== undefined) return this.starting
    this.starting = this.spawn().finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  private async spawn(): Promise<Client> {
    const transport = new StdioClientTransport({
      command: this.opts.command,
      args: this.opts.args,
      env: { ...getDefaultEnvironment(), ...(this.opts.env ?? {}) },
      stderr: 'pipe',
    })
    // stderr 是子进程唯一的诊断通道（stdout 是协议）；只记日志不干预
    transport.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString('utf8').trim()
      if (line !== '') this.log(`子进程 stderr：${line.slice(0, 300)}`)
    })
    const client = new Client({ name: 'company-admin', version: '1.0.0' })
    transport.onclose = () => {
      // 子进程自己退了（崩溃/被杀/空闲关闭）：清引用，下次调用重拉
      if (this.client === client) {
        this.client = undefined
        this.clearIdle()
      }
    }
    transport.onerror = (error) => {
      this.lastError = error.message
      this.log(`传输错误：${error.message}`)
    }
    try {
      await client.connect(transport)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.lastError = message
      await client.close().catch(() => {})
      throw new Error(`知识库子进程启动失败：${message}`)
    }
    this.client = client
    this.lastError = undefined
    this.armIdle()
    return client
  }

  private async drop(reason: string): Promise<void> {
    this.log(reason)
    await this.close()
  }

  private armIdle(): void {
    this.clearIdle()
    if (this.opts.idleMs <= 0 || this.client === undefined) return
    this.idleTimer = setTimeout(() => {
      void this.close()
    }, this.opts.idleMs)
    this.idleTimer.unref()
  }

  private clearIdle(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer)
      this.idleTimer = undefined
    }
  }
}

/** MCP 工具结果里的文本块拼成一个字符串；isError 的结果按失败处理（kb-rag 的工具不返回 isError，这是兜底）。 */
function textOf(result: unknown): string {
  const r = result as { content?: unknown; isError?: boolean }
  const blocks = Array.isArray(r.content) ? (r.content as { type?: string; text?: string }[]) : []
  const text = blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
  if (r.isError === true) throw new Error(text || '知识库工具返回错误')
  return text
}

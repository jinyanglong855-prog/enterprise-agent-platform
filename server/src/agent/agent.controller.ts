/**
 * 对话网关 REST 面（2026-10-27 框架定版：对话域完整化）：
 * - 会话 CRUD：GET/POST /api/agent/sessions、GET …/:id/messages、PATCH …/:id（title/archived）、
 *   DELETE …/:id（应用层级联删）、POST …/:id/stop（中断当前轮次）
 * - POST /api/agent/chat —— SSE 流式（前端 fetch ReadableStream 读；EventSource 不支持 POST）
 * - 文件工作区：POST/GET /api/agent/files、GET /api/agent/files/:dir/:name
 *
 * 权限点（2026-10-27 起对话域独立）：读=agent:read，改（发消息/建删改会话/停）=agent:write。
 * chat 过 agent:write（对话框能替老板写账，入口按写权限收口）；写操作本身仍只经财务 REST 工具
 * （审计来源=agent）。旧 reset/session 端点已删（自家前后端同步切换）。
 */
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { requirePermission } from '../auth/guard.js'
import { AgentService, CHAT_MESSAGE_MAX, type ChatContext } from './agent.service.js'
import { BadRequestError, NotFoundError } from '../errors.js'
import { AuditService } from '../audit/audit.service.js'
import { inboxDir, listTextFiles, outboxDir, safeResolve, saveTextFile } from './workspace.js'
import { existsSync, readFileSync } from 'node:fs'

@Controller('api/agent')
export class AgentController {
  constructor(
    private readonly agent: AgentService,
    private readonly audit: AuditService,
  ) {}

  @Get('sessions')
  listSessions(@Req() req: Request, @Query('includeArchived') includeArchived?: string): unknown {
    const auth = requirePermission(req, 'agent:read')
    return { sessions: this.agent.listSessions(includeArchived === '1', auth.username) }
  }

  @Post('sessions')
  createSession(@Req() req: Request): unknown {
    const auth = requirePermission(req, 'agent:write')
    return { session: this.agent.createSession(auth.username) }
  }

  @Get('sessions/:id/messages')
  messages(@Req() req: Request, @Param('id') id: string): unknown {
    const auth = requirePermission(req, 'agent:read')
    return { messages: this.agent.getMessages(id, auth.username) }
  }

  @Patch('sessions/:id')
  patchSession(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: { title?: unknown; archived?: unknown },
  ): unknown {
    const auth = requirePermission(req, 'agent:write')
    let row
    if (body?.title !== undefined) {
      if (typeof body.title !== 'string') throw new BadRequestError('title 需要字符串。')
      row = this.agent.renameSession(id, body.title, auth.username)
    }
    if (body?.archived !== undefined) {
      if (typeof body.archived !== 'boolean') throw new BadRequestError('archived 需要布尔值。')
      row = this.agent.setArchived(id, body.archived, auth.username)
    }
    if (row === undefined) throw new BadRequestError('需要 title 或 archived 至少一个字段。')
    return { session: row }
  }

  @Delete('sessions/:id')
  deleteSession(@Req() req: Request, @Param('id') id: string): unknown {
    const auth = requirePermission(req, 'agent:write')
    this.agent.deleteSession(id, auth.username)
    return { ok: true }
  }

  @Post('sessions/:id/stop')
  stop(@Req() req: Request, @Param('id') id: string): unknown {
    const auth = requirePermission(req, 'agent:write')
    return this.agent.stop(id, auth.username)
  }

  /** 老板往对话丢文件 / agent 存解析规则后的文件：文本落到工作区（dir=inbox|outbox）。
   *  返回 name/path/lines 供前端拼短提示注入消息（大表内容不进 4000 字消息体）。
   *  写路径进审计（agent.file.save，只记元信息不记内容）。 */
  @Post('files')
  saveFile(@Req() req: Request, @Body() body: { content?: unknown; dir?: unknown; name?: unknown }): unknown {
    const auth = requirePermission(req, 'agent:write')
    if (typeof body?.name !== 'string' || typeof body?.content !== 'string') {
      throw new BadRequestError('需要 name 与 content 两个字符串字段。')
    }
    if (body.dir !== undefined && body.dir !== 'inbox' && body.dir !== 'outbox') {
      throw new BadRequestError('dir 只认 inbox|outbox。')
    }
    const label = body.dir === 'outbox' ? 'outbox' : 'inbox'
    const dir = label === 'outbox' ? outboxDir() : inboxDir()
    const saved = saveTextFile(dir, body.name, body.content)
    this.audit.log({
      username: auth.username,
      source: 'ui',
      action: 'agent.file.save',
      targetId: `${label}/${saved.name}`,
      detail: { bytes: saved.bytes, lines: saved.lines, overwritten: saved.overwritten },
    })
    return { name: saved.name, path: saved.path, relative: `${label}/${saved.name}`, bytes: saved.bytes, lines: saved.lines, overwritten: saved.overwritten }
  }

  /** 工作区文件清单（inbox + outbox）：老板/agent 找回之前丢过的文件。 */
  @Get('files')
  listFiles(@Req() req: Request): unknown {
    requirePermission(req, 'agent:read')
    return { inbox: listTextFiles(inboxDir()), outbox: listTextFiles(outboxDir()) }
  }

  /** 读回一个工作区文件的文本（inbox/outbox 各自封口）：前端预览、agent 之外的用途。 */
  @Get('files/:dir/:name')
  readFile(@Req() req: Request, @Param('dir') dir: string, @Param('name') name: string): unknown {
    requirePermission(req, 'agent:read')
    if (dir !== 'inbox' && dir !== 'outbox') throw new BadRequestError('dir 只认 inbox|outbox。')
    const root = dir === 'inbox' ? inboxDir() : outboxDir()
    const full = safeResolve(root, name)
    if (existsSync(full) === false) throw new NotFoundError(`工作区里没有文件 ${dir}/${name}。用 file_list 看现有文件。`)
    return { name, relative: `${dir}/${name}`, content: readFileSync(full, 'utf8') }
  }

  @Post('chat')
  async chat(
    @Req() req: Request,
    @Body() body: { message?: unknown; sessionId?: unknown; context?: ChatContext },
    @Res() res: Response,
  ): Promise<void> {
    const auth = requirePermission(req, 'agent:write')
    const message = typeof body?.message === 'string' ? body.message.trim() : ''
    // 前置校验在写 SSE 头之前：坏了直接 400 JSON，别让 HTTP 层永远 200
    if (message === '') throw new BadRequestError('消息不能为空')
    if (message.length > CHAT_MESSAGE_MAX) throw new BadRequestError(`消息过长（上限 ${CHAT_MESSAGE_MAX} 字）`)
    // 上下文只认白名单字段并限长（直通提示词的内容要收口）
    const rawContext = body?.context
    const context =
      rawContext && typeof rawContext === 'object'
        ? {
            page: typeof rawContext.page === 'string' ? rawContext.page.slice(0, 100) : undefined,
            entryId: typeof rawContext.entryId === 'string' ? rawContext.entryId.slice(0, 64) : undefined,
          }
        : undefined
    res.status(200).setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders?.()

    let wroteAny = false
    const write = (e: { event: string; data: unknown }) => {
      wroteAny = true
      res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
    }

    // sessionId 缺省=自动开新会话（老调用习惯兼容）；给了就聊指定会话
    let sessionId: string
    if (typeof body?.sessionId === 'string' && body.sessionId) {
      sessionId = body.sessionId
    } else {
      sessionId = this.agent.createSession(auth.username).id
    }

    try {
      await this.agent.chat(sessionId, message, context, auth.username, (e) => write(e))
    } catch (error) {
      // chat 内部异常通常已作为 error 事件流出；互斥等前置异常发生在任何事件之前，
      // 这里补发一条，避免前端只看到"对话流中断"而看不到真实原因
      if (!wroteAny) {
        write({ event: 'error', data: { message: error instanceof Error ? error.message : '对话失败' } })
      }
    }
    res.end()
  }
}

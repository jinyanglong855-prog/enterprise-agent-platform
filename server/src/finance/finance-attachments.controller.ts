/** 附件路由（证据维 B3）：上传/列表/下载/摘除。上传走 JSON base64（无 multipart 依赖，单机场景量级够）。 */
import { Body, Controller, Delete, Get, Param, Post, Query, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { FinanceAttachmentsService, type AttachmentInput } from './finance-attachments.service.js'
import { requirePermission } from '../auth/guard.js'
import { BadRequestError } from '../errors.js'
import { actorOf } from './finance.controller.js'

@Controller('api/finance')
export class FinanceAttachmentsController {
  constructor(private readonly attachments: FinanceAttachmentsService) {}

  @Post('entries/:id/attachments')
  add(@Req() req: Request, @Param('id') id: string, @Body() body: AttachmentInput): unknown {
    const auth = requirePermission(req, 'finance:write')
    return this.attachments.add(actorOf(auth, req), id, body)
  }

  @Get('entries/:id/attachments')
  listByEntry(@Req() req: Request, @Param('id') id: string): unknown {
    requirePermission(req, 'finance:read')
    return this.attachments.listByEntry(id)
  }

  @Get('attachments/:id/download')
  download(@Req() req: Request, @Param('id') id: string, @Query('inline') inline: string | undefined, @Res() res: Response): void {
    requirePermission(req, 'finance:read')
    const numeric = Number(id)
    if (!Number.isInteger(numeric) || numeric <= 0) throw new BadRequestError(`附件 id 应为正整数，收到："${id}"。`)
    const { record, bytes } = this.attachments.read(numeric)
    // filename* 兜中文文件名（RFC 5987）；ascii 名同时给 filename 兜旧客户端
    const asciiFallback = record.file_name.replace(/[^\x20-\x7e]/g, '_') || 'attachment'
    res.setHeader('Content-Type', record.mime)
    res.setHeader('Content-Length', String(bytes.length))
    res.setHeader(
      'Content-Disposition',
      `${inline === '1' ? 'inline' : 'attachment'}; filename="${asciiFallback}"; filename*=UTF-8''${encodeURI(record.file_name)}`,
    )
    res.end(bytes)
  }

  @Delete('attachments/:id')
  remove(@Req() req: Request, @Param('id') id: string, @Body() body: { reason?: string }): unknown {
    const auth = requirePermission(req, 'finance:write')
    const numeric = Number(id)
    if (!Number.isInteger(numeric) || numeric <= 0) throw new BadRequestError(`附件 id 应为正整数，收到："${id}"。`)
    this.attachments.remove(actorOf(auth, req), numeric, typeof body?.reason === 'string' ? body.reason : '')
    return { removed: numeric }
  }
}

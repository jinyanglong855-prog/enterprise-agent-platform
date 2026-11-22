/** 确认卡片提案路由（授权维）：agent 出提案，老板确认/拒绝；确认落库审计 source 强制=confirm。 */
import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common'
import type { Request } from 'express'
import { FinanceProposalsService } from './finance-proposals.service.js'
import type { EntryInput } from './finance.types.js'
import { requirePermission } from '../auth/guard.js'
import { actorOf } from './finance.controller.js'
import { BadRequestError } from '../errors.js'

@Controller('api/finance/proposals')
export class FinanceProposalsController {
  constructor(private readonly proposals: FinanceProposalsService) {}

  @Get()
  list(@Req() req: Request, @Query() query: Record<string, string>): unknown {
    requirePermission(req, 'finance:read')
    return this.proposals.list(query.status)
  }

  @Post()
  create(@Req() req: Request, @Body() body: EntryInput): unknown {
    const auth = requirePermission(req, 'finance:write')
    return this.proposals.create(actorOf(auth, req), body)
  }

  /** 批量导入提案（对话入口）：agent 把解析好的一批账交上来，老板在卡片上确认后才事务落库。 */
  @Post('import')
  createImport(@Req() req: Request, @Body() body: { rows?: EntryInput[]; note?: string }): unknown {
    const auth = requirePermission(req, 'finance:write')
    if (!Array.isArray(body?.rows)) throw new BadRequestError('需要 rows（账目数组）字段。')
    return this.proposals.createImport(actorOf(auth, req), body.rows, typeof body.note === 'string' ? body.note : '')
  }

  @Post(':id/confirm')
  confirm(@Req() req: Request, @Param('id') id: string): unknown {
    const auth = requirePermission(req, 'finance:write')
    // 确认动作本身就是授权：来源写死 confirm，不随调用方 header 漂移
    return this.proposals.confirm({ username: auth.username, source: 'confirm' }, id)
  }

  @Post(':id/reject')
  reject(@Req() req: Request, @Param('id') id: string, @Body() body: { reason?: string }): unknown {
    const auth = requirePermission(req, 'finance:write')
    const reason = typeof body?.reason === 'string' ? body.reason : ''
    return this.proposals.reject(actorOf(auth, req), id, reason)
  }
}

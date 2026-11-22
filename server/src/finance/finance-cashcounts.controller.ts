/** 盘点路由（B2）：记一次盘点 + 历史清单。 */
import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common'
import type { Request } from 'express'
import { FinanceCashCountsService } from './finance-cashcounts.service.js'
import { requirePermission } from '../auth/guard.js'
import { actorOf } from './finance.controller.js'

@Controller('api/finance/cash-counts')
export class FinanceCashCountsController {
  constructor(private readonly cashCounts: FinanceCashCountsService) {}

  @Post()
  create(@Req() req: Request, @Body() body: { account?: unknown; counted?: unknown; as_of?: unknown; note?: unknown }): unknown {
    const auth = requirePermission(req, 'finance:write')
    return this.cashCounts.create(actorOf(auth, req), body)
  }

  @Get()
  list(@Req() req: Request, @Query() query: Record<string, string>): unknown {
    requirePermission(req, 'finance:read')
    return this.cashCounts.list({ account: query.account, limit: query.limit !== undefined ? Number(query.limit) : undefined })
  }
}

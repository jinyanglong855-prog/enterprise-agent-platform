/** 征期数据包路由：GET /api/finance/filing?period=YYYY-MM|YYYY-Qn（缺省=当前征期的上一期）。只读，finance:read。 */
import { Controller, Get, Query, Req } from '@nestjs/common'
import type { Request } from 'express'
import { FinanceFilingService } from './finance-filing.service.js'
import { requirePermission } from '../auth/guard.js'

@Controller('api/finance')
export class FinanceFilingController {
  constructor(private readonly filingService: FinanceFilingService) {}

  @Get('filing')
  filing(@Req() req: Request, @Query() query: Record<string, string>): unknown {
    requirePermission(req, 'finance:read')
    return this.filingService.pack(query.period)
  }
}

/** 报表与打包路由（C4/A8/F5/E5）：全部只读。 */
import { Controller, Get, Param, Query, Req } from '@nestjs/common'
import type { Request } from 'express'
import { FinanceReportsService } from './finance-reports.service.js'
import { requirePermission } from '../auth/guard.js'

@Controller('api/finance/reports')
export class FinanceReportsController {
  constructor(private readonly reports: FinanceReportsService) {}

  @Get('evidence-checklist')
  evidenceChecklist(@Req() req: Request, @Query() query: Record<string, string>): unknown {
    requirePermission(req, 'finance:read')
    return this.reports.evidenceChecklist(query.month)
  }

  @Get('counterparty-statement')
  counterpartyStatement(@Req() req: Request, @Query() query: Record<string, string>): unknown {
    requirePermission(req, 'finance:read')
    return this.reports.counterpartyStatement({ counterparty: query.counterparty, from: query.from, to: query.to })
  }

  @Get('inspection-pack')
  inspectionPack(@Req() req: Request, @Query() query: Record<string, string>): unknown {
    requirePermission(req, 'finance:read')
    return this.reports.inspectionPack({ from: query.from, to: query.to })
  }

  @Get('archive/:year')
  annualArchive(@Req() req: Request, @Param('year') year: string): unknown {
    requirePermission(req, 'finance:read')
    return this.reports.annualArchive(year)
  }
}

/** 票-账猜挂路由（A5/A6）：只读建议，挂联仍走票夹的写接口。 */
import { Controller, Get, Param, Req } from '@nestjs/common'
import type { Request } from 'express'
import { FinanceMatchesService } from './finance-matches.service.js'
import { requirePermission } from '../auth/guard.js'

@Controller('api/finance')
export class FinanceMatchesController {
  constructor(private readonly matches: FinanceMatchesService) {}

  @Get('invoices/:id/matches')
  forInvoice(@Req() req: Request, @Param('id') id: string): unknown {
    requirePermission(req, 'finance:read')
    return this.matches.forInvoice(id)
  }

  @Get('entries/:id/matches')
  forEntry(@Req() req: Request, @Param('id') id: string): unknown {
    requirePermission(req, 'finance:read')
    return this.matches.forEntry(id)
  }
}

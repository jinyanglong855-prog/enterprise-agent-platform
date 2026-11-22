/** 银行对账路由（口袋维）：即时对照报告，纯读不落库。 */
import { Body, Controller, Post, Req } from '@nestjs/common'
import type { Request } from 'express'
import { FinanceReconciliationService, type ReconciliationInput } from './finance-reconciliation.service.js'
import { requirePermission } from '../auth/guard.js'

@Controller('api/finance/reconciliation')
export class FinanceReconciliationController {
  constructor(private readonly reconciliation: FinanceReconciliationService) {}

  @Post('preview')
  preview(@Req() req: Request, @Body() body: ReconciliationInput): unknown {
    requirePermission(req, 'finance:read')
    return this.reconciliation.preview(body)
  }
}

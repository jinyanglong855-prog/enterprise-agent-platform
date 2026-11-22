/** 工资个税计算路由：POST /api/finance/payroll/calc。纯计算不落库，finance:read。 */
import { Body, Controller, Post, Req } from '@nestjs/common'
import type { Request } from 'express'
import { FinancePayrollService, type PayrollCalcRequest } from './finance-payroll.service.js'
import { requirePermission } from '../auth/guard.js'

@Controller('api/finance')
export class FinancePayrollController {
  constructor(private readonly payrollService: FinancePayrollService) {}

  @Post('payroll/calc')
  calc(@Req() req: Request, @Body() body: PayrollCalcRequest): unknown {
    requirePermission(req, 'finance:read')
    return this.payrollService.calc(body)
  }
}

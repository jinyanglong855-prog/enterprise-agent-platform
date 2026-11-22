/** 工资落账/工资条/导出路由（工资域）。独立前缀不与 payslips/:id 抢路由。
 *  读 payroll:read；生成提案/推工资条 payroll:write（推送是对外动作，前端二次确认）。 */
import { Body, Controller, Get, Post, Query, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { FinancePayrollPostingService } from './finance-payroll-posting.service.js'
import { requirePermission } from '../auth/guard.js'
import { BadRequestError } from '../errors.js'
import { actorOf } from './finance.controller.js'

@Controller('api/finance/payroll-posting')
export class FinancePayrollPostingController {
  constructor(private readonly payrollPosting: FinancePayrollPostingService) {}

  /** ?month=YYYY-MM → 该月落账状态（工资单计数/合计/提案/能否生成）。 */
  @Get()
  status(@Req() req: Request, @Query() query: Record<string, string>): unknown {
    requirePermission(req, 'payroll:read')
    return this.payrollPosting.status(requireMonth(query.month))
  }

  /** 手动生成该月落账提案（通常不用点：全部确认后自动生成；这里兜"卡片丢了/自动没成"）。 */
  @Post()
  async post(@Req() req: Request, @Body() body: { month?: string }): Promise<unknown> {
    const auth = requirePermission(req, 'payroll:write')
    return this.payrollPosting.postMonth(actorOf(auth, req), requireMonth(body?.month))
  }

  @Post('push')
  async push(@Req() req: Request, @Body() body: { month?: string }): Promise<unknown> {
    const auth = requirePermission(req, 'payroll:write')
    return this.payrollPosting.pushPayslips(actorOf(auth, req), requireMonth(body?.month))
  }

  @Get('export')
  export(@Req() req: Request, @Query() query: Record<string, string>, @Res({ passthrough: true }) res: Response): string {
    requirePermission(req, 'payroll:read')
    const out = this.payrollPosting.exportCsv(requireMonth(query.month))
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`)
    return out.csv
  }
}

function requireMonth(v: unknown): string {
  if (typeof v !== 'string' || v.trim() === '') throw new BadRequestError('缺 month（YYYY-MM）。')
  return v
}

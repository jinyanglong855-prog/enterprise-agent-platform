/** 工资单路由（工资域）：月度工资表/个人工资单/生成/改/确认/删。 */
import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req } from '@nestjs/common'
import type { Request } from 'express'
import { FinancePayslipsService, type OpeningInput, type PayslipInput } from './finance-payslips.service.js'
import { FinancePayrollPostingService } from './finance-payroll-posting.service.js'
import { requirePermission } from '../auth/guard.js'
import { BadRequestError } from '../errors.js'
import { actorOf } from './finance.controller.js'
import { intOrThrow } from './finance-roster.controller.js'

@Controller('api/finance/payslips')
export class FinancePayslipsController {
  constructor(
    private readonly payslips: FinancePayslipsService,
    private readonly payrollPosting: FinancePayrollPostingService,
  ) {}

  /** ?month=YYYY-MM → 月度工资表；?employee_id=&year= → 个人全年工资单。 */
  @Get()
  list(@Req() req: Request, @Query() query: Record<string, string>): unknown {
    requirePermission(req, 'payroll:read')
    if (query.employee_id !== undefined) {
      return this.payslips.listByEmployee(intOrThrow(query.employee_id), query.year ?? '')
    }
    if (query.month === undefined) throw new BadRequestError('缺 month（YYYY-MM）或 employee_id+year。')
    return this.payslips.register(query.month)
  }

  @Post('generate')
  generate(@Req() req: Request, @Body() body: { month?: string }): unknown {
    const auth = requirePermission(req, 'payroll:write')
    if (typeof body?.month !== 'string') throw new BadRequestError('缺 month（YYYY-MM）。')
    return this.payslips.generate(actorOf(auth, req), body.month)
  }

  /** 期初累计（开账）：?employee_id=&year= 读；PUT 写（整条覆盖）；DELETE 删。静态路由声明在 :id 之前。 */
  @Get('opening')
  getOpening(@Req() req: Request, @Query() query: Record<string, string>): unknown {
    requirePermission(req, 'payroll:read')
    return { opening: this.payslips.getOpening(intOrThrow(query.employee_id ?? ''), query.year ?? '') }
  }

  @Put('opening')
  setOpening(@Req() req: Request, @Body() body: OpeningInput): unknown {
    const auth = requirePermission(req, 'payroll:write')
    return this.payslips.setOpening(actorOf(auth, req), body ?? {})
  }

  @Delete('opening')
  deleteOpening(@Req() req: Request, @Query() query: Record<string, string>): unknown {
    const auth = requirePermission(req, 'payroll:write')
    return this.payslips.deleteOpening(actorOf(auth, req), intOrThrow(query.employee_id ?? ''), query.year ?? '')
  }

  @Get(':id')
  detail(@Req() req: Request, @Param('id') id: string): unknown {
    requirePermission(req, 'payroll:read')
    return this.payslips.detail(intOrThrow(id))
  }

  @Patch(':id')
  update(@Req() req: Request, @Param('id') id: string, @Body() body: PayslipInput): unknown {
    const auth = requirePermission(req, 'payroll:write')
    return this.payslips.update(actorOf(auth, req), intOrThrow(id), body)
  }

  /** 确认后若该月不再有草稿 → 自动生成落账提案（没确认完/已有提案 → posting.status='skipped'，不打扰）。 */
  @Post(':id/confirm')
  async confirm(@Req() req: Request, @Param('id') id: string): Promise<unknown> {
    const auth = requirePermission(req, 'payroll:write')
    const actor = actorOf(auth, req)
    const record = this.payslips.confirm(actor, intOrThrow(id))
    const posting = await this.payrollPosting.postMonth(actor, record.month, { auto: true })
    return { ...record, posting }
  }

  @Post(':id/unconfirm')
  unconfirm(@Req() req: Request, @Param('id') id: string): unknown {
    const auth = requirePermission(req, 'payroll:write')
    return this.payslips.unconfirm(actorOf(auth, req), intOrThrow(id))
  }

  @Delete(':id')
  remove(@Req() req: Request, @Param('id') id: string): unknown {
    const auth = requirePermission(req, 'payroll:write')
    return this.payslips.remove(actorOf(auth, req), intOrThrow(id))
  }
}

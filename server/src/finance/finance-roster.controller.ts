/** 名册路由（工资域）：员工登记/平台同步。工资是敏感面，走独立
 *  payroll:read/payroll:write，与一般财务读写解耦。个人工资单视图挂在
 *  /api/finance/payslips?employee_id=&year=。 */
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common'
import type { Request } from 'express'
import { FinanceRosterService, type EmployeeInput } from './finance-roster.service.js'
import { requirePermission } from '../auth/guard.js'
import { BadRequestError } from '../errors.js'
import { actorOf } from './finance.controller.js'

@Controller('api/finance/employees')
export class FinanceRosterController {
  constructor(private readonly roster: FinanceRosterService) {}

  @Get()
  list(@Req() req: Request, @Query() query: Record<string, string>): unknown {
    requirePermission(req, 'payroll:read')
    return this.roster.list({ include_archived: query.include_archived === 'true' })
  }

  @Post()
  create(@Req() req: Request, @Body() body: EmployeeInput): unknown {
    const auth = requirePermission(req, 'payroll:write')
    return this.roster.create(actorOf(auth, req), body)
  }

  @Post('sync')
  async sync(@Req() req: Request): Promise<unknown> {
    const auth = requirePermission(req, 'payroll:write')
    return this.roster.syncFromPlatform(actorOf(auth, req))
  }

  @Patch(':id')
  update(@Req() req: Request, @Param('id') id: string, @Body() body: EmployeeInput): unknown {
    const auth = requirePermission(req, 'payroll:write')
    return this.roster.update(actorOf(auth, req), intOrThrow(id), body)
  }

  @Delete(':id')
  archive(@Req() req: Request, @Param('id') id: string): unknown {
    const auth = requirePermission(req, 'payroll:write')
    return this.roster.archive(actorOf(auth, req), intOrThrow(id))
  }

  @Post(':id/unarchive')
  unarchive(@Req() req: Request, @Param('id') id: string): unknown {
    const auth = requirePermission(req, 'payroll:write')
    return this.roster.unarchive(actorOf(auth, req), intOrThrow(id))
  }
}

export function intOrThrow(value: string): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) throw new BadRequestError(`id 应为正整数，收到："${value}"。`)
  return n
}

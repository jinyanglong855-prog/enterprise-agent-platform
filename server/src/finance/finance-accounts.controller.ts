/** 账户路由（口袋维）：列表带余额（期初+Σ已收付）、建档、停用/改期初。 */
import { Body, Controller, Get, Param, Patch, Post, Req } from '@nestjs/common'
import type { Request } from 'express'
import { FinanceAccountsService, type AccountInput } from './finance-accounts.service.js'
import { requirePermission } from '../auth/guard.js'
import { BadRequestError } from '../errors.js'
import { actorOf } from './finance.controller.js'

@Controller('api/finance/accounts')
export class FinanceAccountsController {
  constructor(private readonly accounts: FinanceAccountsService) {}

  @Get()
  list(@Req() req: Request): unknown {
    requirePermission(req, 'finance:read')
    return this.accounts.list()
  }

  @Post()
  create(@Req() req: Request, @Body() body: AccountInput): unknown {
    const auth = requirePermission(req, 'finance:write')
    return this.accounts.create(actorOf(auth, req), body)
  }

  @Patch(':id')
  update(@Req() req: Request, @Param('id') id: string, @Body() body: AccountInput): unknown {
    const auth = requirePermission(req, 'finance:write')
    const numId = Number(id)
    if (!Number.isInteger(numId) || numId <= 0) throw new BadRequestError(`账户 id 应为正整数，收到："${id}"。`)
    return this.accounts.update(actorOf(auth, req), numId, body)
  }
}

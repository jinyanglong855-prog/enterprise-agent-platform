/** 银行流水行路由（B1）：模板/导入/清单/比对报告/人工配对/删行。 */
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common'
import type { Request } from 'express'
import { FinanceBankLinesService } from './finance-banklines.service.js'
import { requirePermission } from '../auth/guard.js'
import { BadRequestError } from '../errors.js'
import { actorOf } from './finance.controller.js'

@Controller('api/finance/bank-lines')
export class FinanceBankLinesController {
  constructor(private readonly bankLines: FinanceBankLinesService) {}

  @Get('template')
  template(@Req() req: Request): unknown {
    requirePermission(req, 'finance:read')
    return this.bankLines.template()
  }

  @Post('import')
  importLines(@Req() req: Request, @Body() body: { account?: unknown; text?: unknown }): unknown {
    const auth = requirePermission(req, 'finance:write')
    return this.bankLines.importLines(actorOf(auth, req), body)
  }

  @Get('report')
  report(@Req() req: Request, @Query() query: Record<string, string>): unknown {
    requirePermission(req, 'finance:read')
    return this.bankLines.report({ account: query.account, from: query.from, to: query.to })
  }

  @Get()
  list(@Req() req: Request, @Query() query: Record<string, string>): unknown {
    requirePermission(req, 'finance:read')
    return this.bankLines.list({
      account: query.account,
      month: query.month,
      matched: query.matched,
      limit: query.limit !== undefined ? intOrThrow(query.limit) : undefined,
    })
  }

  @Patch(':id')
  setMatch(@Req() req: Request, @Param('id') id: string, @Body() body: { matched_entry_id?: unknown }): unknown {
    const auth = requirePermission(req, 'finance:write')
    if (typeof body?.matched_entry_id !== 'string') throw new BadRequestError('需要 matched_entry_id 字段（配对的账目编号，空串=解除配对）。')
    return this.bankLines.setMatch(actorOf(auth, req), intOrThrow(id), body.matched_entry_id)
  }

  @Delete(':id')
  remove(@Req() req: Request, @Param('id') id: string): unknown {
    const auth = requirePermission(req, 'finance:write')
    this.bankLines.remove(actorOf(auth, req), intOrThrow(id))
    return { removed: Number(id) }
  }
}

function intOrThrow(value: string): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) throw new BadRequestError(`id 应为正整数，收到："${value}"。`)
  return n
}

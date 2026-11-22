/** 票路由（证据维）：票登记/状态/多对多挂联账目。 */
import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req } from '@nestjs/common'
import type { Request } from 'express'
import { FinanceInvoicesService, type InvoiceFilter, type InvoiceInput } from './finance-invoices.service.js'
import { requirePermission } from '../auth/guard.js'
import { BadRequestError } from '../errors.js'
import { actorOf } from './finance.controller.js'

@Controller('api/finance/invoices')
export class FinanceInvoicesController {
  constructor(private readonly invoices: FinanceInvoicesService) {}

  @Get()
  list(@Req() req: Request, @Query() query: Record<string, string>): unknown {
    requirePermission(req, 'finance:read')
    const filter: InvoiceFilter = {
      kind: query.kind,
      status: query.status,
      counterparty: query.counterparty,
      month: query.month,
      number: query.number,
      limit: query.limit !== undefined ? intOrThrow(query.limit) : undefined,
    }
    return this.invoices.list(filter)
  }

  // missing/output-summary/quota 必须声明在 :id 之前：Nest 按声明顺序匹配路由
  @Get('missing')
  listMissing(@Req() req: Request, @Query() query: Record<string, string>): unknown {
    requirePermission(req, 'finance:read')
    return this.invoices.listMissing({
      month: query.month,
      limit: query.limit !== undefined ? intOrThrow(query.limit) : undefined,
    })
  }

  @Get('output-summary')
  outputSummary(@Req() req: Request, @Query() query: Record<string, string>): unknown {
    requirePermission(req, 'finance:read')
    return this.invoices.outputSummary(query.year)
  }

  @Get('quota')
  getQuota(@Req() req: Request): unknown {
    requirePermission(req, 'finance:read')
    return this.invoices.getQuota()
  }

  @Put('quota')
  setQuota(@Req() req: Request, @Body() body: { quota_total?: unknown; quota_used?: unknown; as_of?: unknown }): unknown {
    const auth = requirePermission(req, 'finance:write')
    return this.invoices.setQuota(actorOf(auth, req), body)
  }

  @Get(':id')
  getOne(@Req() req: Request, @Param('id') id: string): unknown {
    requirePermission(req, 'finance:read')
    return this.invoices.getOne(id)
  }

  @Post()
  create(@Req() req: Request, @Body() body: InvoiceInput): unknown {
    const auth = requirePermission(req, 'finance:write')
    return this.invoices.create(actorOf(auth, req), body)
  }

  @Patch(':id')
  update(@Req() req: Request, @Param('id') id: string, @Body() body: InvoiceInput): unknown {
    const auth = requirePermission(req, 'finance:write')
    return this.invoices.update(actorOf(auth, req), id, body)
  }

  @Post(':id/links')
  link(@Req() req: Request, @Param('id') id: string, @Body() body: { entry_id?: string }): unknown {
    const auth = requirePermission(req, 'finance:write')
    if (typeof body?.entry_id !== 'string') throw new BadRequestError('需要 entry_id 字段（要挂联的账目编号）。')
    return this.invoices.link(actorOf(auth, req), id, body.entry_id)
  }

  @Delete(':id/links/:entryId')
  unlink(@Req() req: Request, @Param('id') id: string, @Param('entryId') entryId: string): unknown {
    const auth = requirePermission(req, 'finance:write')
    return this.invoices.unlink(actorOf(auth, req), id, entryId)
  }
}

function intOrThrow(value: string): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) throw new BadRequestError(`limit 应为正整数，收到："${value}"。`)
  return n
}

/** 财务路由：条目增改查删 / 月度汇总 / 建档 / 审计查询。写路径统一带 actor（来源=ui|agent|confirm）。 */
import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req } from '@nestjs/common'
import type { Request } from 'express'
import { FinanceService } from './finance.service.js'
import type { ActorSource, EntryInput } from './finance.types.js'
import { AuditService } from '../audit/audit.service.js'
import { requirePermission } from '../auth/guard.js'
import { BadRequestError } from '../errors.js'

const SOURCE_VALUES = ['ui', 'agent', 'confirm']

@Controller('api/finance')
export class FinanceController {
  constructor(
    private readonly finance: FinanceService,
    private readonly audit: AuditService,
  ) {}

  @Post('entries')
  create(@Req() req: Request, @Body() body: EntryInput): unknown {
    const auth = requirePermission(req, 'finance:write')
    return this.finance.create(actorOf(auth, req), body)
  }

  @Patch('entries/:id')
  update(@Req() req: Request, @Param('id') id: string, @Body() body: EntryInput): unknown {
    const auth = requirePermission(req, 'finance:write')
    return this.finance.update(actorOf(auth, req), id, body)
  }

  @Delete('entries/:id')
  remove(@Req() req: Request, @Param('id') id: string, @Body() body: { reason?: string }): unknown {
    const auth = requirePermission(req, 'admin:manage')
    this.finance.softDelete(actorOf(auth, req), id, typeof body?.reason === 'string' ? body.reason : '')
    return { deleted: id }
  }

  /** 冲销（出数后的唯一修正路径）：追加反向条目，原条目只补标记。 */
  @Post('entries/:id/reverse')
  reverse(@Req() req: Request, @Param('id') id: string, @Body() body: { reason?: string }): unknown {
    const auth = requirePermission(req, 'finance:write')
    return this.finance.reverse(actorOf(auth, req), id, typeof body?.reason === 'string' ? body.reason : '')
  }

  @Get('entries')
  list(@Req() req: Request, @Query() query: Record<string, string>): unknown {
    requirePermission(req, 'finance:read')
    return this.finance.list({
      id: query.id,
      type: query.type,
      status: query.status,
      counterparty: query.counterparty,
      month: query.month,
      due_before: query.due_before,
      account: query.account,
      outstanding: query.outstanding === '1',
      limit: query.limit !== undefined ? intOrThrow(query.limit) : undefined,
    })
  }

  @Get('entries/:id')
  getOne(@Req() req: Request, @Param('id') id: string): unknown {
    requirePermission(req, 'finance:read')
    return this.finance.getOne(id)
  }

  @Get('summary')
  summary(@Req() req: Request, @Query() query: Record<string, string>): unknown {
    requirePermission(req, 'finance:read')
    return this.finance.summary(query.month)
  }

  @Get('profile')
  profileGet(@Req() req: Request): unknown {
    requirePermission(req, 'finance:read')
    return this.finance.profileGet()
  }

  @Put('profile')
  profileSet(@Req() req: Request, @Body() body: { key?: string; value?: string }): unknown {
    const auth = requirePermission(req, 'finance:write')
    if (typeof body.key !== 'string' || typeof body.value !== 'string') {
      throw new BadRequestError('需要 key 和 value 两个字符串字段。')
    }
    return this.finance.profileSet(actorOf(auth, req), body.key, body.value)
  }

  @Get('audit')
  auditRecent(@Req() req: Request, @Query() query: Record<string, string>): unknown {
    requirePermission(req, 'admin:manage')
    return this.audit.recent(query.limit !== undefined ? Number(query.limit) : 50)
  }

  // ------------------------------------------------------------- 出数标记（按月冻结，只许冲销）

  @Get('periods')
  periods(@Req() req: Request): unknown {
    requirePermission(req, 'finance:read')
    return this.finance.listReported()
  }

  @Put('periods/:month/reported')
  markReported(@Req() req: Request, @Param('month') month: string): unknown {
    const auth = requirePermission(req, 'finance:write')
    return this.finance.markReported(actorOf(auth, req), month)
  }

  @Delete('periods/:month/reported')
  unmarkReported(@Req() req: Request, @Param('month') month: string): unknown {
    const auth = requirePermission(req, 'admin:manage')
    return this.finance.unmarkReported(actorOf(auth, req), month)
  }
}

function actorOf(auth: { username: string }, req: Request): { username: string; source: ActorSource } {
  const header = String(req.headers['x-actor-source'] ?? 'ui')
  const source = SOURCE_VALUES.includes(header) ? (header as ActorSource) : 'ui'
  return { username: auth.username, source }
}

export { actorOf }

function intOrThrow(value: string): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) throw new BadRequestError(`limit 应为正整数，收到："${value}"。`)
  return n
}

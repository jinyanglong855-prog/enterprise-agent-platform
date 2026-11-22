/** 导入路由：预览（不写库）/ 提交（事务原子）/ 固定模板。
 *  提交只放行界面与确认卡片两个来源：agent 没有直接落库的入口，批量账只能经 finance_proposals（kind=import）由老板确认。 */
import { Body, Controller, Get, Post, Req } from '@nestjs/common'
import type { Request } from 'express'
import { FinanceImportsService, type ImportMapping } from './finance-imports.service.js'
import type { EntryInput } from './finance.types.js'
import { actorOf } from './finance.controller.js'
import { requirePermission } from '../auth/guard.js'
import { BadRequestError, ForbiddenError } from '../errors.js'

@Controller('api/finance/imports')
export class FinanceImportsController {
  constructor(private readonly imports: FinanceImportsService) {}

  @Post('preview')
  preview(@Req() req: Request, @Body() body: { text?: string; mapping?: ImportMapping }): unknown {
    requirePermission(req, 'finance:read')
    if (typeof body?.text !== 'string') throw new BadRequestError('需要 text（CSV/TSV 文本）字段。')
    return this.imports.preview(body.text, body.mapping ?? undefined)
  }

  @Post('commit')
  commit(@Req() req: Request, @Body() body: { rows?: EntryInput[]; skip_duplicates?: boolean; note?: string }): unknown {
    const auth = requirePermission(req, 'finance:write')
    const actor = actorOf(auth, req)
    if (actor.source === 'agent') {
      throw new ForbiddenError('agent 不能直接批量落库：请用批量提案（finance_proposals kind=import），由老板在卡片上确认导入。')
    }
    if (!Array.isArray(body?.rows)) throw new BadRequestError('需要 rows（账目数组）字段。')
    return this.imports.commit(actor, body.rows, {
      skip_duplicates: body.skip_duplicates === true,
      note: typeof body.note === 'string' ? body.note : '',
    })
  }

  @Get('template')
  template(@Req() req: Request): unknown {
    requirePermission(req, 'finance:read')
    return this.imports.template()
  }
}

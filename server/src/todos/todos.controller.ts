/** 义务域 REST 面（2026-10-31 待办预警方案 §三/§七）：人工待办 CRUD + 视图 + 路由配置 + 扫描触发。
 *  权限点：读=todo:read，写=todo:write，路由配置与扫描触发=admin:manage（企业级配置面）。
 *  企业视图（scope=enterprise）同样要 admin:manage——全员待办是经营信息，不对普通岗位开放。 */
import { Body, Controller, Get, Param, Patch, Post, Put, Query, Req } from '@nestjs/common'
import type { Request } from 'express'
import { requirePermission } from '../auth/guard.js'
import { BadRequestError } from '../errors.js'
import { TodosService } from './todos.service.js'
// 值导入（不是 import type）：Nest 靠 design:paramtypes 元数据解析控制器构造依赖，
// type-only 导入会让元数据里这个参数变成 Function，DI 起来就是 UnknownDependenciesException
import { ObligationScannerService } from './obligation-scanner.service.js'
import type { RunSummary } from './obligation-scanner.service.js'
import type { CompleteResult } from './todos.types.js'

@Controller('api/todos')
export class TodosController {
  constructor(
    private readonly todos: TodosService,
    private readonly scanner: ObligationScannerService,
  ) {}

  @Get()
  list(
    @Req() req: Request,
    @Query('scope') scope?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ): unknown {
    const auth = requirePermission(req, 'todo:read')
    if (scope !== 'mine' && scope !== 'pool' && scope !== 'enterprise') {
      throw new BadRequestError("scope 只认 mine | pool | enterprise。")
    }
    if (scope === 'enterprise') requirePermission(req, 'admin:manage')
    const limitNum = limit !== undefined ? Number(limit) : undefined
    return this.todos.listFor(auth.username, { scope, status, limit: limitNum })
  }

  @Get('summary')
  summary(@Req() req: Request): unknown {
    const auth = requirePermission(req, 'todo:read')
    return this.todos.summaryFor(auth.username)
  }

  @Get('owners')
  owners(@Req() req: Request): unknown {
    requirePermission(req, 'todo:write')
    return this.todos.owners()
  }

  /** 全月历投影（2026-11-01 用户定稿）：企业每月固定事项（报税/社保等）整月预列——
   *  提早=提示、当天/已逾期=预警；不占待办、不推送，进临期窗口才由扫描生成正式待办。 */
  @Get('recurring')
  recurring(@Req() req: Request, @Query('month') month?: string): unknown {
    requirePermission(req, 'todo:read')
    return this.scanner.recurringMonth(month ?? '')
  }

  @Post()
  async create(@Req() req: Request, @Body() body: Record<string, unknown>): Promise<unknown> {
    const auth = requirePermission(req, 'todo:write')
    return { item: await this.todos.create(auth.username, body) }
  }

  @Patch(':id')
  update(@Req() req: Request, @Param('id') id: string, @Body() body: Record<string, unknown>): unknown {
    const auth = requirePermission(req, 'todo:write')
    return { item: this.todos.update(auth.username, id, body) }
  }

  /** 「已完成」：人工待办直接完成（可带备注）；推导型交扫描服务先核实源头再处置
   *  （outcome=resolved/pending/unverifiable/forced，见 todos.types CompleteResult）。
   *  body 可空：{ note?: string; force?: boolean }，force 只对推导型有意义（必填 note）。 */
  @Post(':id/done')
  done(@Req() req: Request, @Param('id') id: string, @Body() body?: { note?: unknown; force?: unknown }): CompleteResult | Promise<CompleteResult> {
    const auth = requirePermission(req, 'todo:write')
    const row = this.todos.getVisible(auth.username, id)
    if (row.origin === 'scan') {
      return this.scanner.completeDerived(auth.username, row.id, { note: body?.note, force: body?.force === true })
    }
    return { outcome: 'done', item: this.todos.done(auth.username, row.id, body?.note) }
  }

  @Post(':id/dismiss')
  dismiss(@Req() req: Request, @Param('id') id: string, @Body() body: { reason?: unknown }): unknown {
    const auth = requirePermission(req, 'todo:write')
    return { item: this.todos.dismiss(auth.username, id, body?.reason) }
  }

  @Post(':id/ack')
  ack(@Req() req: Request, @Param('id') id: string): unknown {
    const auth = requirePermission(req, 'todo:write')
    return { item: this.todos.ack(auth.username, id) }
  }

  @Get('routes')
  routes(@Req() req: Request): unknown {
    requirePermission(req, 'admin:manage')
    return { routes: this.todos.routes() }
  }

  @Put('routes/:sourceType')
  setRoute(@Req() req: Request, @Param('sourceType') sourceType: string, @Body() body: Record<string, unknown>): unknown {
    const auth = requirePermission(req, 'admin:manage')
    return { route: this.todos.setRoute(auth.username, sourceType, body) }
  }

  @Get('scan-runs')
  scanRuns(@Req() req: Request, @Query('limit') limit?: string): unknown {
    requirePermission(req, 'admin:manage')
    return this.todos.listScanRuns(limit !== undefined ? Number(limit) : undefined)
  }

  /** 手动触发全量扫描（幂等；不推晨报——晨报跟每日调度走，手动扫是排查工具）。 */
  @Post('scan')
  scan(@Req() req: Request): Promise<RunSummary> {
    requirePermission(req, 'admin:manage')
    return this.scanner.runAll('manual')
  }
}

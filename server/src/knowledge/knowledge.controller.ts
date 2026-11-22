/** 知识库 REST 面（2026-11-02 阶段 3）：状态 / 搜索 / 问答，权限点 knowledge:read（缺省只有老板角色持有；
 *  要给员工开放在角色权限页勾选）。读范围由 kb-rag 侧按调用者身份（ADMIN_KB_CALLER）过滤。
 *  值导入 KnowledgeService（Nest 靠 design:paramtypes 解析构造依赖，type-only 导入会让 DI 起不来）。 */
import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common'
import type { Request } from 'express'
import { requirePermission } from '../auth/guard.js'
import { actorOf } from '../finance/finance.controller.js'
import { KnowledgeService } from './knowledge.service.js'

@Controller('api/knowledge')
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Get('status')
  status(@Req() req: Request): unknown {
    requirePermission(req, 'knowledge:read')
    return this.knowledge.status()
  }

  @Get('search')
  search(@Req() req: Request, @Query('q') q?: string, @Query('k') k?: string): Promise<unknown> {
    const auth = requirePermission(req, 'knowledge:read')
    // `?k=`（空串）按没传处理回退缺省，不让 Number('')=0 变成 400
    return this.knowledge.search(q ?? '', k === undefined || k === '' ? undefined : Number(k), actorOf(auth, req))
  }

  @Post('ask')
  ask(@Req() req: Request, @Body() body: { question?: string; k?: number }): Promise<unknown> {
    const auth = requirePermission(req, 'knowledge:read')
    return this.knowledge.ask(body?.question ?? '', body?.k, actorOf(auth, req))
  }
}

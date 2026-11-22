/**
 * 系统审计端点（2026-10-27 框架定版）：审计有表有记录但一直没有查询界面，
 * 补 GET /api/audit 给系统审计页用；财务台的 GET /api/finance/audit 保留不动。
 * 只读：审计记录没有任何修改/删除入口（审计的完整性底线）。
 * 权限（2026-10-28 融合方案）：admin:manage 或 audit:read——后者为本端点唯一非管理消费方
 * agent 运行时服务号（audit_query 工具）而设，服务号无需 admin:manage。
 */
import { Controller, Get, Query, Req } from '@nestjs/common'
import type { Request } from 'express'
import { authOf, requireAuth } from '../auth/guard.js'
import { ForbiddenError } from '../errors.js'
import { AuditService } from './audit.service.js'

@Controller('api/audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(
    @Req() req: Request,
    @Query('limit') limit?: string,
    @Query('action') action?: string,
    @Query('username') username?: string,
  ): unknown {
    const auth = requireAuth(authOf(req))
    if (!auth.permissions.includes('admin:manage') && !auth.permissions.includes('audit:read')) {
      throw new ForbiddenError('缺少权限：admin:manage 或 audit:read')
    }
    const parsedLimit = limit !== undefined && limit !== '' ? Number(limit) : Number.NaN
    return {
      items: this.audit.list({
        limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
        action: action || undefined,
        username: username || undefined,
      }),
    }
  }
}

/** 融合层 P1 数据通道 REST 面（2026-11-01）：agent 只读平台工具的唯一入口。
 *  读路径全走 platform:read（服务号 agent-runtime 恰含它；无此权限的岗位 403），
 *  登记册管理走 admin:manage；数据读取留审计（方案 §6 风险1"数据读取都留痕"）。
 *  本控制器只有 GET 与登记册 PUT，不新增任何对平台的写路径。 */
import { Controller, Get, Param, Put, Query, Req, Body } from '@nestjs/common'
import type { Request } from 'express'
import { requirePermission } from '../auth/guard.js'
import { PlatformDataService } from './platform-data.service.js'
import { actorOf } from '../finance/finance.controller.js'

@Controller('api/platform')
export class PlatformDataController {
  constructor(private readonly platformData: PlatformDataService) {}

  @Get('contacts/departments')
  departments(@Req() req: Request): Promise<unknown> {
    return this.platformData.departments(actorOf(requirePermission(req, 'platform:read'), req))
  }

  @Get('contacts/members')
  members(@Req() req: Request, @Query('department_id') departmentId?: string): Promise<unknown> {
    return this.platformData.members(actorOf(requirePermission(req, 'platform:read'), req), departmentId ?? '')
  }

  @Get('approvals/definitions')
  approvalDefinitions(@Req() req: Request): Promise<unknown> {
    return this.platformData.approvalDefinitions(actorOf(requirePermission(req, 'platform:read'), req))
  }

  @Get('approvals/instances')
  approvalInstances(@Req() req: Request, @Query('code') code?: string, @Query('hours') hours?: string): Promise<unknown> {
    return this.platformData.approvalInstances(actorOf(requirePermission(req, 'platform:read'), req), code, hours)
  }

  @Get('approvals/instances/:code')
  approvalDetail(@Req() req: Request, @Param('code') code: string): Promise<unknown> {
    return this.platformData.approvalDetail(actorOf(requirePermission(req, 'platform:read'), req), code)
  }

  @Get('approvals/registry')
  registry(@Req() req: Request): unknown {
    requirePermission(req, 'admin:manage')
    return { definitions: this.platformData.listRegistry() }
  }

  @Put('approvals/registry')
  setRegistry(@Req() req: Request, @Body() body: { definitions?: unknown }): unknown {
    const auth = requirePermission(req, 'admin:manage')
    return this.platformData.setRegistry(actorOf(auth, req), body?.definitions)
  }
}

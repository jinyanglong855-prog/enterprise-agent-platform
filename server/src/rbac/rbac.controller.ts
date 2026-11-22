/** 拼装台面 REST 面（2026-10-30 执行计划 P1）：企业管理员把固定权限点拼成自己企业的岗位角色，
 *  再把角色绑到用户。权限点清单只读（加权限点=底层系统发版，不做界面扩展）；
 *  技术角色 boss/agent-runtime 界面置灰+REST 拒绝（护栏在服务层，测试钉住）；
 *  管理动作一律 admin:manage 且全进审计。 */
import { Body, Controller, Delete, Get, Param, Post, Put, Req } from '@nestjs/common'
import type { Request } from 'express'
import { requirePermission } from '../auth/guard.js'
import { BadRequestError } from '../errors.js'
import { RbacService } from './rbac.service.js'

@Controller('api/rbac')
export class RbacController {
  constructor(private readonly rbac: RbacService) {}

  @Get('permissions')
  listPermissions(@Req() req: Request): unknown {
    requirePermission(req, 'admin:manage')
    return { permissions: this.rbac.listPermissions() }
  }

  @Get('roles')
  listRoles(@Req() req: Request): unknown {
    requirePermission(req, 'admin:manage')
    return { roles: this.rbac.listRoles() }
  }

  @Post('roles')
  createRole(
    @Req() req: Request,
    @Body() body: { name?: unknown; permissions?: unknown },
  ): unknown {
    const auth = requirePermission(req, 'admin:manage')
    return { role: this.rbac.createRole({ username: auth.username, source: 'ui' }, body?.name, body?.permissions) }
  }

  @Put('roles/:name/permissions')
  updateRole(
    @Req() req: Request,
    @Param('name') name: string,
    @Body() body: { permissions?: unknown },
  ): unknown {
    const auth = requirePermission(req, 'admin:manage')
    return { role: this.rbac.updateRolePermissions({ username: auth.username, source: 'ui' }, name, body?.permissions) }
  }

  @Delete('roles/:name')
  deleteRole(@Req() req: Request, @Param('name') name: string): unknown {
    const auth = requirePermission(req, 'admin:manage')
    this.rbac.deleteRole({ username: auth.username, source: 'ui' }, name)
    return { deleted: name }
  }

  @Get('users')
  listUsers(@Req() req: Request): unknown {
    requirePermission(req, 'admin:manage')
    return { users: this.rbac.listUsersWithRoles() }
  }

  @Post('users/:username/roles')
  assignRole(
    @Req() req: Request,
    @Param('username') username: string,
    @Body() body: { role?: unknown },
  ): unknown {
    const auth = requirePermission(req, 'admin:manage')
    if (typeof body?.role !== 'string') throw new BadRequestError('role 需要字符串。')
    return this.rbac.assignUserRole({ username: auth.username, source: 'ui' }, username, body.role)
  }

  @Delete('users/:username/roles/:role')
  removeRole(
    @Req() req: Request,
    @Param('username') username: string,
    @Param('role') role: string,
  ): unknown {
    const auth = requirePermission(req, 'admin:manage')
    return this.rbac.removeUserRole({ username: auth.username, source: 'ui' }, username, role)
  }
}

/** 鉴权与权限路由：finance:read / finance:write / admin:manage。agent 工具调用走同一套（source 头区分来源）。 */
import { ForbiddenError, UnauthorizedError } from '../errors.js'
import type { AuthContext } from './auth.service.js'
import type { Permission } from '../rbac/rbac.service.js'

/** 从请求取鉴权上下文（中间件解析 Bearer 后挂在 req.auth）。 */
export function authOf(req: object): AuthContext | undefined {
  return (req as { auth?: AuthContext }).auth
}

export function requireAuth(ctx: AuthContext | undefined): AuthContext {
  if (ctx === undefined) throw new UnauthorizedError()
  return ctx
}

export function requirePermission(req: object, permission: Permission): AuthContext {
  const ctx = authOf(req)
  if (ctx === undefined) throw new UnauthorizedError()
  if (!ctx.permissions.includes(permission)) {
    throw new ForbiddenError(`缺少权限：${permission}`)
  }
  return ctx
}

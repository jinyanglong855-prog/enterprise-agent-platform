/**
 * 拼装台面前端 API（2026-10-30 执行计划 P1）：角色 CRUD + 用户绑定。
 * 权限点 admin:manage（未授权账号请求 403 由 request 拦截器统一提示）。
 */
import { requestClient } from './request';

export interface RoleView {
  name: string;
  permissions: string[];
  technical: boolean;
  users: number;
}

export interface UserWithRoles {
  username: string;
  displayName: string;
  isService: boolean;
  disabled: boolean;
  roles: string[];
}

export function listPermissionsApi(): Promise<{ permissions: string[] }> {
  return requestClient.get('/rbac/permissions');
}

export function listRolesApi(): Promise<{ roles: RoleView[] }> {
  return requestClient.get('/rbac/roles');
}

export function createRoleApi(body: {
  name: string;
  permissions: string[];
}): Promise<{ role: RoleView }> {
  return requestClient.post('/rbac/roles', body);
}

export function updateRolePermissionsApi(
  name: string,
  permissions: string[],
): Promise<{ role: RoleView }> {
  return requestClient.put(
    `/rbac/roles/${encodeURIComponent(name)}/permissions`,
    {
      permissions,
    },
  );
}

export function deleteRoleApi(name: string): Promise<{ deleted: string }> {
  return requestClient.delete(`/rbac/roles/${encodeURIComponent(name)}`);
}

export function listUsersApi(): Promise<{ users: UserWithRoles[] }> {
  return requestClient.get('/rbac/users');
}

export function assignRoleApi(
  username: string,
  role: string,
): Promise<{ alreadyBound: boolean; roles: string[]; username: string }> {
  return requestClient.post(
    `/rbac/users/${encodeURIComponent(username)}/roles`,
    { role },
  );
}

export function removeRoleApi(
  username: string,
  role: string,
): Promise<{ roles: string[]; username: string }> {
  return requestClient.delete(
    `/rbac/users/${encodeURIComponent(username)}/roles/${encodeURIComponent(role)}`,
  );
}

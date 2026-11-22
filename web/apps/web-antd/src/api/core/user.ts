import type { UserInfo } from '@vben/types';

import { requestClient } from '#/api/request';

interface MeResponse {
  displayName: string;
  /** 飞书绑定（个人中心展示）：未绑定为 null */
  feishuBinding: null | {
    boundAt: string;
    name: string;
    openId: string;
  };
  permissions: string[];
  username: string;
}

/**
 * 当前登录者原始信息（含飞书绑定）；getUserInfoApi 是它的 Vben 映射版
 */
export async function getMeApi(): Promise<MeResponse> {
  return requestClient.get<MeResponse>('/auth/me');
}

/**
 * /auth/me 原始信息 → Vben UserInfo。auth store 用它和 me.permissions 一起刷新
 * 用户信息与权限码，保证菜单（roles）和页内按钮（accessCodes）同源
 */
export function toUserInfo(me: MeResponse): UserInfo {
  return {
    avatar: '',
    desc: '',
    homePath: '/workbench',
    realName: me.displayName || me.username,
    // Vben 前端模式的菜单过滤（meta.authority）只对照 roles 数组——后端权限码必须并进
    // 这里菜单才会按权限显隐（'boss' 是角色名，其余是权限码，两者在 hasAuthority 里同列）
    roles: ['boss', ...me.permissions],
    token: '',
    userId: me.username,
    username: me.username,
  };
}

/**
 * 获取用户信息（管理后端 GET /api/auth/me → 映射成 Vben UserInfo）
 */
export async function getUserInfoApi(): Promise<UserInfo> {
  return toUserInfo(await getMeApi());
}

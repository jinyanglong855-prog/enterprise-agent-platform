import type { Recordable, UserInfo } from '@vben/types';

import { ref } from 'vue';
import { useRouter } from 'vue-router';

import { LOGIN_PATH } from '@vben/constants';
import { preferences } from '@vben/preferences';
import { resetAllStores, useAccessStore, useUserStore } from '@vben/stores';

import { notification } from 'ant-design-vue';
import { defineStore } from 'pinia';

import {
  feishuLoginApi,
  getMeApi,
  loginApi,
  logoutApi,
  toUserInfo,
} from '#/api';
import { $t } from '#/locales';

export const useAuthStore = defineStore('auth', () => {
  const accessStore = useAccessStore();
  const userStore = useUserStore();
  const router = useRouter();

  const loginLoading = ref(false);

  /** 拿到 accessToken 之后的公共落场：存 token → 拉用户信息与权限码 → 跳转 → 成功提示。 */
  async function establishSession(
    accessToken: string,
    onSuccess?: () => Promise<void> | void,
  ) {
    accessStore.setAccessToken(accessToken);

    const fetchUserInfoResult = await fetchUserInfo();

    if (accessStore.loginExpired) {
      accessStore.setLoginExpired(false);
    } else {
      onSuccess
        ? await onSuccess?.()
        : await router.push(
            fetchUserInfoResult.homePath || preferences.app.defaultHomePath,
          );
    }

    if (fetchUserInfoResult?.realName) {
      notification.success({
        description: `${$t('authentication.loginSuccessDesc')}:${fetchUserInfoResult?.realName}`,
        duration: 3,
        message: $t('authentication.loginSuccess'),
      });
    }
    return fetchUserInfoResult;
  }

  /**
   * 异步处理登录操作
   * Asynchronously handle the login process
   * @param params 登录表单数据
   */
  async function authLogin(
    params: Recordable<any>,
    onSuccess?: () => Promise<void> | void,
  ) {
    // 异步处理用户登录操作并获取 accessToken
    let userInfo: null | UserInfo = null;
    try {
      loginLoading.value = true;
      const { accessToken } = await loginApi(params);

      // 如果成功获取到 accessToken
      if (accessToken) {
        userInfo = await establishSession(accessToken, onSuccess);
      }
    } finally {
      loginLoading.value = false;
    }

    return {
      userInfo,
    };
  }

  /** 飞书 OAuth 登录：授权回调页用 code 换系统会话，落场与密码登录完全一致。 */
  async function feishuLogin(code: string, redirectUri: string) {
    let userInfo: null | UserInfo = null;
    try {
      loginLoading.value = true;
      const { accessToken } = await feishuLoginApi(code, redirectUri);
      if (accessToken) {
        userInfo = await establishSession(accessToken);
      }
    } finally {
      loginLoading.value = false;
    }
    return {
      userInfo,
    };
  }

  async function logout(redirect: boolean = true) {
    try {
      await logoutApi();
    } catch {
      // 不做任何处理
    }
    resetAllStores();
    accessStore.setLoginExpired(false);

    // 已经在登录页时不能再带 redirect：此时 currentRoute.fullPath 就是登录页本身，
    // 再编码一层会得到「登录页?redirect=编码后的登录页」，下一次又在这个基础上再包一层，
    // 反复登出会让 URL 逐跳变长，且没有上限。
    // On the login page the current route is the login page itself, so carrying it as
    // `redirect` would nest one more encoded layer on every repeat.
    const currentRoute = router.currentRoute.value;
    const alreadyOnLogin = currentRoute.path === LOGIN_PATH;

    // 回登录页带上当前路由地址
    await router.replace({
      path: LOGIN_PATH,
      query:
        redirect && !alreadyOnLogin
          ? { redirect: encodeURIComponent(currentRoute.fullPath) }
          : {},
    });
  }

  /**
   * 一次 /auth/me 同时刷新用户信息与权限码。登录和每次整页加载（路由守卫）都走这里：
   * 菜单按 userInfo.roles 过滤、页内按钮按 accessStore.accessCodes 显隐，两者若不同源，
   * 服务端新增权限点后会出现「菜单看得见、页面是空白」——权限码此前只在登录时写一次并持久化。
   */
  async function fetchUserInfo() {
    const me = await getMeApi();
    const userInfo = toUserInfo(me);
    userStore.setUserInfo(userInfo);
    accessStore.setAccessCodes(me.permissions);
    return userInfo;
  }

  function $reset() {
    loginLoading.value = false;
  }

  return {
    $reset,
    authLogin,
    feishuLogin,
    fetchUserInfo,
    loginLoading,
    logout,
  };
});

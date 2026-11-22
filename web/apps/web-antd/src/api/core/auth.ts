import { requestClient } from '#/api/request';

export namespace AuthApi {
  /** 登录接口参数 */
  export interface LoginParams {
    password?: string;
    username?: string;
  }

  /** 登录接口返回值（管理后端返回 {token, user}，这里映射成 Vben 的 accessToken 形状） */
  export interface LoginResult {
    accessToken: string;
  }
}

/**
 * 登录（管理后端 POST /api/auth/login，JWT 30 天，无 refresh 端点）
 */
export async function loginApi(data: AuthApi.LoginParams) {
  const body = await requestClient.post<{ token: string }>('/auth/login', data);
  return { accessToken: body.token } as AuthApi.LoginResult;
}

/**
 * 退出登录：后端无 logout 端点（JWT 无状态），仅前端清状态
 */
export async function logoutApi() {
  await Promise.resolve();
}

/**
 * 飞书 OAuth 登录：飞书授权回调带来的 code + 授权时用的回调地址原样传给后端
 * （后端用它调飞书换 token，要求与授权跳转完全一致），换回系统会话
 */
export async function feishuLoginApi(code: string, redirectUri: string) {
  const body = await requestClient.post<{ token: string }>('/auth/feishu', {
    code,
    redirectUri,
  });
  return { accessToken: body.token } as AuthApi.LoginResult;
}

/**
 * 飞书 OAuth 回调地址，写死为与飞书后台「安全设置→重定向 URL」配置完全一致的值——
 * 飞书逐字符比对，跟着浏览器地址栏走（localhost vs 127.0.0.1）会报 20029。
 * 端口或域名变更时：这里与飞书后台两处同步改。
 */
export const FEISHU_REDIRECT_URI = 'http://127.0.0.1:5666/feishu-callback';

/**
 * 构造飞书授权页跳转地址：授权完成飞书带 code 回跳 /feishu-callback；
 * state 防 CSRF（回调页与 sessionStorage 比对）
 */
export function buildFeishuAuthorizeUrl(appId: string) {
  const state = crypto.randomUUID().replaceAll('-', '');
  sessionStorage.setItem('feishu-sso-state', state);
  const query = new URLSearchParams({
    app_id: appId,
    redirect_uri: FEISHU_REDIRECT_URI,
    state,
  });
  return `https://accounts.feishu.cn/open-apis/authen/v1/authorize?${query.toString()}`;
}

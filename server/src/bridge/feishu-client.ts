/**
 * 飞书开放平台 HTTP 客户端（2026-11-01 融合 P1 数据通道抽出）：tenant_access_token 自管
 * + 统一 call() + 错误带飞书业务码。从 feishu-approval.service 的私有实现提炼成共享件，
 * 只读数据通道（platform-data.service）使用；审批服务保持自有实现不动（已在线上验证过，
 * 合并属重构另行安排）。
 *
 * 错误语义（契约文档坑 16/19/21，真机实证）：code!==0 一律抛 FeishuApiError，
 * 常见码的"人话"提示在调用方（platform-data.service）翻译——这里只保证 code/msg/path 不丢。
 */
export class FeishuApiError extends Error {
  constructor(
    readonly code: number,
    readonly msg: string,
    readonly path: string,
  ) {
    super(`飞书 API ${path} 失败 code=${code}: ${msg}`)
    this.name = 'FeishuApiError'
  }
}

import { config } from '../config.js'

export class FeishuClient {
  private token: { value: string; expiresAt: number } | undefined

  constructor(private readonly fetchFn: typeof fetch) {}

  async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const token = await this.accessToken()
    const r = await this.fetchFn(`https://open.feishu.cn/open-apis${path}`, {
      method,
      headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    const j = (await r.json()) as { code?: number; msg?: string }
    if (j.code !== 0) throw new FeishuApiError(j.code ?? -1, j.msg ?? '', path)
    return j as T
  }

  private async accessToken(): Promise<string> {
    if (this.token !== undefined && Date.now() < this.token.expiresAt) return this.token.value
    const { config } = await import('../config.js')
    const r = await this.fetchFn('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: config.feishuAppId, app_secret: config.feishuAppSecret }),
      signal: AbortSignal.timeout(10_000),
    })
    const j = (await r.json()) as { code?: number; msg?: string; tenant_access_token?: string; expire?: number }
    if (typeof j.tenant_access_token !== 'string' || j.tenant_access_token === '') {
      throw new Error(`拿不到 tenant_access_token：${j.msg ?? `code=${j.code ?? '?'}`}（检查 ADMIN_FEISHU_APP_ID/SECRET）`)
    }
    this.token = { value: j.tenant_access_token, expiresAt: Date.now() + Math.max(60, (j.expire ?? 7200) - 60) * 1000 }
    return this.token.value
  }
}

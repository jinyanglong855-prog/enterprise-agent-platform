/** 登录与 JWT 签发/校验（HS256，30 天）。 */
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import type { RbacService } from '../rbac/rbac.service.js'
import type { AuditService } from '../audit/audit.service.js'
import { config } from '../config.js'
import { BadRequestError, UnauthorizedError } from '../errors.js'
import type { DB } from '../db/database.js'
import type { Permission } from '../rbac/rbac.service.js'

export interface AuthContext {
  username: string
  displayName: string
  permissions: Permission[]
}

export class AuthService {
  /** 测试注入口：替换后 loginViaFeishuCode 对飞书开放平台的两次调用走假实现。 */
  fetchFn?: typeof fetch

  constructor(
    private readonly rbac: RbacService,
    private readonly audit: AuditService,
    private readonly db: DB,
  ) {}

  login(username: string, password: string): { token: string; user: { username: string; displayName: string; permissions: Permission[] } } {
    const user = this.rbac.findUser((username ?? '').trim())
    const ok = user !== undefined && user.disabled_at === null && bcrypt.compareSync(password ?? '', user.password_hash)
    if (!ok) {
      this.audit.log({ username: username ?? '(空)', source: 'ui', action: 'auth.login', ok: false })
      throw new UnauthorizedError('用户名或密码不对')
    }
    return this.issueSession(user.username, 'ui')
  }

  /**
   * 飞书 OAuth 授权码登录：code → user_access_token → open_id → 绑定表 → 系统 JWT。
   * 绑定表就是 bridge_identities（融合层白名单，默认拒绝）——未绑定的飞书身份一律 401，
   * 授权再成功也进不来；绑定/解绑沿用「融合层」白名单管理界面。
   * redirectUri 由前端原样回传（换 token 时飞书要求与授权跳转一致；它是公开值，无保密性）。
   */
  async loginViaFeishuCode(code: string, redirectUri: string): Promise<{ token: string; user: { username: string; displayName: string; permissions: Permission[] } }> {
    const trimmedCode = (code ?? '').trim()
    const trimmedRedirect = (redirectUri ?? '').trim()
    if (trimmedCode === '' || trimmedRedirect === '') throw new BadRequestError('缺少授权码或回调地址。')
    const fail = (reason: string, identity: string) => {
      this.audit.log({ username: identity, source: 'feishu-sso', action: 'auth.login', detail: { reason }, ok: false })
      return new UnauthorizedError(reason)
    }
    const fetchFn = this.fetchFn ?? globalThis.fetch
    const tokenRes = await fetchFn('https://open.feishu.cn/open-apis/authen/v2/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: config.feishuAppId,
        client_secret: config.feishuAppSecret,
        code: trimmedCode,
        redirect_uri: trimmedRedirect,
      }),
    }).catch(() => undefined)
    const tokenBody = (tokenRes !== undefined && tokenRes.ok
      ? (await tokenRes.json().catch(() => undefined) as { access_token?: string } | undefined)
      : undefined)
    const userToken = tokenBody?.access_token
    if (typeof userToken !== 'string' || userToken === '') {
      throw fail('飞书授权失败：授权码无效或已过期，请重试飞书登录。', '-')
    }
    const infoRes = await fetchFn('https://open.feishu.cn/open-apis/authen/v1/user_info', {
      headers: { authorization: `Bearer ${userToken}` },
    }).catch(() => undefined)
    const info = (infoRes !== undefined && infoRes.ok
      ? (await infoRes.json().catch(() => undefined) as { data?: { open_id?: string } } | undefined)
      : undefined)
    const openId = info?.data?.open_id ?? ''
    if (openId === '') throw fail('飞书授权成功但没有取到用户身份，请重试。', '-')
    const binding = this.db
      .prepare("SELECT username FROM bridge_identities WHERE platform = 'feishu' AND platform_userid = ? AND allowed = 1")
      .get(openId) as { username?: string } | undefined
    const user = binding?.username !== undefined ? this.rbac.findUser(binding.username) : undefined
    if (user === undefined || user.disabled_at !== null) {
      throw fail('这个飞书账号还没有绑定系统账号：请管理员在「融合层」绑定后再用飞书登录。', openId)
    }
    return this.issueSession(user.username, 'feishu-sso')
  }

  /** 当前账号的飞书绑定（个人中心展示）：open_id + 平台显示名 + 绑定时间；未绑定返回 null。 */
  feishuBindingOf(username: string): { openId: string; name: string; boundAt: string } | null {
    const row = this.db
      .prepare(
        "SELECT platform_userid, COALESCE(NULLIF(display_name, ''), '（未留名）') AS name, created_at FROM bridge_identities WHERE platform = 'feishu' AND username = ? AND allowed = 1 ORDER BY created_at LIMIT 1",
      )
      .get(username) as { platform_userid?: string; name?: string; created_at?: string } | undefined
    if (row?.platform_userid === undefined) return null
    return { openId: row.platform_userid, name: row.name ?? '', boundAt: row.created_at ?? '' }
  }

  /** 签发 JWT + 登录成功审计（密码登录与飞书登录共用的唯一出口；调用方保证用户存在且未禁用）。 */
  private issueSession(username: string, source: string): { token: string; user: { username: string; displayName: string; permissions: Permission[] } } {
    const permissions = [...this.rbac.permissionsOf(username)]
    const token = jwt.sign({ sub: username }, config.jwtSecret, { expiresIn: config.jwtTtlSeconds })
    this.audit.log({ username, source, action: 'auth.login', ok: true })
    const user = this.rbac.findUser(username)
    return { token, user: { username, displayName: user?.display_name ?? username, permissions } }
  }

  /** 校验 Bearer 令牌并加载权限；失败抛 401。 */
  verifyBearer(header: string | undefined): AuthContext {
    const token = (header ?? '').replace(/^Bearer\s+/i, '').trim()
    if (token === '') throw new UnauthorizedError()
    let payload: { sub?: string }
    try {
      payload = jwt.verify(token, config.jwtSecret) as { sub?: string }
    } catch {
      throw new UnauthorizedError()
    }
    const username = payload.sub ?? ''
    const user = this.rbac.findUser(username)
    if (user === undefined || user.disabled_at !== null) throw new UnauthorizedError()
    return { username, displayName: user.display_name, permissions: [...this.rbac.permissionsOf(username)] }
  }

  /** 本人改密：旧密码验证 + 新密码最短 8 位 + 审计。 */
  changePassword(username: string, oldPassword: string, newPassword: string): void {
    const user = this.rbac.findUser(username)
    if (user === undefined || user.disabled_at !== null || !bcrypt.compareSync(oldPassword ?? '', user.password_hash)) {
      this.audit.log({ username, source: 'ui', action: 'auth.password', ok: false })
      throw new UnauthorizedError('旧密码不对')
    }
    if (newPassword.length < 8) {
      throw new BadRequestError('新密码至少 8 位。')
    }
    this.rbac.setPasswordHash(user.username, bcrypt.hashSync(newPassword, 10))
    this.audit.log({ username: user.username, source: 'ui', action: 'auth.password', ok: true })
  }

  /** 老板是否还在用初始密码（启动提示用；改过密就不再唠叨）。按角色找老板账号，不写死用户名。 */
  bossStillUsesInitialPassword(): boolean {
    const name = this.rbac.bossUsername()
    if (name === undefined) return false
    const boss = this.rbac.findUser(name)
    return boss !== undefined && bcrypt.compareSync(config.bossInitialPassword, boss.password_hash)
  }
}

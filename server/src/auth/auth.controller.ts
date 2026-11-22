/** 鉴权路由：登录 / 当前用户 / 本人改密。 */
import { Body, Controller, Get, Post, Put, Req } from '@nestjs/common'
import type { Request } from 'express'
import { AuthService } from './auth.service.js'
import { authOf, requireAuth } from './guard.js'

@Controller('api/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  login(@Body() body: { username?: string; password?: string }): unknown {
    return this.auth.login(body.username ?? '', body.password ?? '')
  }

  /** 飞书 OAuth 授权码登录（回调页调用）：code 换 open_id → 绑定表映射 → 系统会话。 */
  @Post('feishu')
  feishuLogin(@Body() body: { code?: string; redirectUri?: string }): Promise<unknown> {
    return this.auth.loginViaFeishuCode(body.code ?? '', body.redirectUri ?? '')
  }

  @Get('me')
  me(@Req() req: Request): unknown {
    const auth = requireAuth(authOf(req))
    return { ...auth, feishuBinding: this.auth.feishuBindingOf(auth.username) }
  }

  @Put('password')
  changePassword(@Req() req: Request, @Body() body: { oldPassword?: string; newPassword?: string }): unknown {
    const auth = requireAuth(authOf(req))
    this.auth.changePassword(auth.username, body.oldPassword ?? '', body.newPassword ?? '')
    return { ok: true }
  }
}

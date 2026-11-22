/** 融合层 REST 面（2026-10-28 方案 P0）：身份白名单管理 + 桥接状态 + 飞书组织映射。
 *  白名单是安全闸（方案 §6 风险1），管理动作一律 admin:manage 并进审计；
 *  入站消息/卡片不走 REST（平台 adapter 长连接直入服务层），这里只管"谁能进来"。 */
import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common'
import type { Request } from 'express'
import { requirePermission } from '../auth/guard.js'
import { config } from '../config.js'
import { BadRequestError } from '../errors.js'
import { BridgeService } from './bridge.service.js'
import { FeishuApprovalService } from './feishu-approval.service.js'

@Controller('api/bridge')
export class BridgeController {
  constructor(
    private readonly bridge: BridgeService,
    private readonly feishuApproval: FeishuApprovalService,
  ) {}

  @Get('status')
  status(@Req() req: Request): unknown {
    requirePermission(req, 'admin:manage')
    return {
      enabled: config.bridgeEnabled,
      configuredAdapter: config.bridgeAdapter,
      registeredAdapters: this.bridge.adapterNames(),
      connected: this.bridge.isConnected(config.bridgeAdapter),
      // 连接状态明细（2026-10-30 第3层）：断连时间/最近错误/监督器重启次数，排障不用再翻日志
      connection: this.bridge.connectionDetail(config.bridgeAdapter),
      identities: this.bridge.listIdentities().length,
    }
  }

  @Get('identities')
  list(@Req() req: Request): unknown {
    requirePermission(req, 'admin:manage')
    return { identities: this.bridge.listIdentities() }
  }

  @Post('identities')
  create(
    @Req() req: Request,
    @Body() body: { platform?: unknown; platformUserid?: unknown; username?: unknown; displayName?: unknown; allowed?: unknown },
  ): unknown {
    const auth = requirePermission(req, 'admin:manage')
    const identity = this.bridge.upsertIdentity(auth.username, {
      platform: typeof body?.platform === 'string' ? body.platform : '',
      platformUserid: typeof body?.platformUserid === 'string' ? body.platformUserid : '',
      username: typeof body?.username === 'string' ? body.username : '',
      displayName: typeof body?.displayName === 'string' ? body.displayName : undefined,
      allowed: body?.allowed === true,
    })
    return { identity }
  }

  @Patch('identities/:platform/:userid')
  update(
    @Req() req: Request,
    @Param('platform') platform: string,
    @Param('userid') userid: string,
    @Body() body: { allowed?: unknown; displayName?: unknown },
  ): unknown {
    const auth = requirePermission(req, 'admin:manage')
    const patch: { allowed?: boolean; displayName?: string } = {}
    if (body?.allowed !== undefined) {
      if (typeof body.allowed !== 'boolean') throw new BadRequestError('allowed 需要布尔值。')
      patch.allowed = body.allowed
    }
    if (body?.displayName !== undefined) {
      if (typeof body.displayName !== 'string') throw new BadRequestError('displayName 需要字符串。')
      patch.displayName = body.displayName
    }
    return { identity: this.bridge.setIdentitySwitch(auth.username, platform, userid, patch) }
  }

  // ---------- 飞书组织映射（部门 → 角色；OA 审批进场按它配权限） ----------

  @Get('org-rules')
  listRules(@Req() req: Request): unknown {
    requirePermission(req, 'admin:manage')
    return {
      rules: this.feishuApproval.listOrgRulesWithNames(),
      approvalConfigured: this.feishuApproval.approvalCode() !== undefined,
      permChangeConfigured: this.feishuApproval.approvalPermCode() !== undefined,
    }
  }

  /** 组织架构镜像 + 可用角色（映射配置页一次拉齐：选部门下拉 + 选角色下拉）。 */
  @Get('departments')
  departments(@Req() req: Request): unknown {
    requirePermission(req, 'admin:manage')
    const roles = this.feishuApproval.availableRoles()
    return { ...this.feishuApproval.listDepartments(), roles }
  }

  /** 手动触发组织同步（启动/定时也各自触发，都进审计）。 */
  @Post('org-sync')
  async syncOrg(@Req() req: Request): Promise<unknown> {
    const auth = requirePermission(req, 'admin:manage')
    try {
      return await this.feishuApproval.syncFromFeishu('ui', auth.username)
    } catch (error) {
      // 同步失败最常见=通讯录权限没配：真实原因透给操作者（前端统一 toast），不笼统 500（对抗审查 P2-1）
      throw new BadRequestError(`组织同步失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  @Post('org-rules')
  createRule(
    @Req() req: Request,
    @Body() body: { departmentId?: unknown; departmentName?: unknown; role?: unknown },
  ): unknown {
    const auth = requirePermission(req, 'admin:manage')
    return { rule: this.feishuApproval.createOrgRule(auth.username, body) }
  }

  @Delete('org-rules/:id')
  deleteRule(@Req() req: Request, @Param('id') id: string): unknown {
    const auth = requirePermission(req, 'admin:manage')
    const numeric = Number(id)
    if (!Number.isInteger(numeric) || numeric <= 0) throw new BadRequestError('id 需要正整数。')
    this.feishuApproval.deleteOrgRule(auth.username, numeric)
    return { deleted: numeric }
  }

  /** 映射补配后对存量账号生效（对抗审查 P2-2：开通时落的角色不会因事后补映射自动更新）。 */
  @Post('org-rules/apply')
  applyRules(@Req() req: Request, @Body() body: { username?: unknown }): unknown {
    const auth = requirePermission(req, 'admin:manage')
    if (typeof body?.username !== 'string') throw new BadRequestError('username 需要字符串。')
    return this.feishuApproval.applyOrgRules(auth.username, body.username)
  }
}

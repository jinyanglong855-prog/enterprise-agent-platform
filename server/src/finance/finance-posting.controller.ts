/** 审批落账规则路由（2026-11-01 融合方案 §5 P2）：哪张飞书审批定义批了、记哪类账。
 *  管理面（admin:manage）：规则是把"飞书审批 → 账本提案"接起来的配置，与平台登记册同一权限面；
 *  落账本身仍走提案确认（finance:write，老板点卡/网页确认），这里不直接写账。 */
import { Body, Controller, Get, Put, Query, Req } from '@nestjs/common'
import type { Request } from 'express'
import { FinancePostingService, type RulesInput } from './finance-posting.service.js'
import { FeishuApprovalService } from '../bridge/feishu-approval.service.js'
import { requirePermission } from '../auth/guard.js'
import { actorOf } from './finance.controller.js'

@Controller('api/finance/posting-rules')
export class FinancePostingController {
  constructor(
    private readonly posting: FinancePostingService,
    private readonly feishuApproval: FeishuApprovalService,
  ) {}

  @Get()
  list(@Req() req: Request): unknown {
    requirePermission(req, 'admin:manage')
    return { rules: this.posting.listRules() }
  }

  /** 整表覆盖保存；保存即订阅规则里各定义的审批事件（契约坑 20 双层订阅：不订只有补抓能追到）。
   *  订阅失败不挡保存——规则已存、补抓兜底、main.ts 10 分钟自愈重订；响应里如实带订阅健康度。 */
  @Put()
  async set(@Req() req: Request, @Body() body: RulesInput): Promise<unknown> {
    const auth = requirePermission(req, 'admin:manage')
    const saved = this.posting.setRules(actorOf(auth, req), body)
    const subscribed = await this.feishuApproval.ensurePostingSubscriptions()
    return { ...saved, subscribed, subscription_healthy: this.feishuApproval.subscriptionHealthy() }
  }

  /** 预览解析：贴一个审批实例码，看按当前规则会解析出什么金额/事由/申请人（不建提案不落账）。
   *  配 field_map 前后各看一次，就知道启发式认不认得这张表单。 */
  @Get('preview')
  async preview(@Req() req: Request, @Query('instance_code') instanceCode: string | undefined): Promise<unknown> {
    requirePermission(req, 'admin:manage')
    const code = (instanceCode ?? '').trim()
    const inst = await this.feishuApproval.fetchInstanceDetail(code)
    return this.posting.preview(code, inst)
  }
}

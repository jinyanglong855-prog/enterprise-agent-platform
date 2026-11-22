/** 启动入口：挂全局鉴权中间件，仅监听 127.0.0.1（P1 本机边界）。 */
import 'reflect-metadata'
import { json } from 'express'
import { NestFactory } from '@nestjs/core'
import { createRuntimeModule, registerAuthMiddleware, BODY_LIMIT } from './app.module.js'
import { config } from './config.js'
import { AgentService } from './agent/agent.service.js'
import { parseDailyScanAt } from './todos/obligation-scanner.service.js'

async function bootstrap(): Promise<void> {
  const { dynamicModule, services } = createRuntimeModule()
  const app = await NestFactory.create(dynamicModule, { logger: ['log', 'warn', 'error'] })
  // Nest/express 默认 json body 上限 100kb：附件 base64（8MB 文件→~11MB 文本）和批量导入
  // 都会被 413 挡在服务校验之前（对抗审查 P1：8MB/1MB 承诺不成立）。
  app.use(json({ limit: BODY_LIMIT }))
  registerAuthMiddleware(app, services.auth)

  await app.listen(config.port, '127.0.0.1')
  console.log(`[admin-server] 已启动 http://127.0.0.1:${config.port}（数据目录 ${config.dataDir}）`)
  if (services.auth.bossStillUsesInitialPassword()) {
    console.log('[admin-server] ⚠ boss 还在用初始密码，请尽快改密：登录后 PUT /api/auth/password（传 oldPassword/newPassword）。')
  }
  // 对话网关自检：dsh 二进制/补丁/模型 key 缺位时启动就喊出来，别等老板发消息才炸
  const setup = AgentService.checkSetup()
  if (!setup.ok) {
    console.warn(`[admin-server] ⚠ 对话网关自检未通过：${setup.problems.join('；')}`)
  }
  // 融合层（2026-10-28 方案 P0）：默认关；启用后按 ADMIN_BRIDGE_ADAPTER 连平台（出站长连接，免公网）
  await services.bridge.start()
  // OA 审批进场（2026-10-29）：账号开通定义幂等建一次；权限变更定义已于 2026-10-31 休眠
  // （方案 B：权限全部管理员配置，员工侧申请通道关闭，存量定义 code 留 app_meta 供事件路由
  //  关闭通道，不再新建——ensurePermSubscription 只订已存在的，全新部署是空操作）。
  // 周期自愈（方案B 审查 P2-1）：定义没建成 **或最近一次事件订阅失败** 时 10 分钟一轮重试，
  // 两样都好才停表；订阅失败期间审批事件靠对账补抓兜底不丢单，只是"实时"暂退化为"分钟级"。
  const definitionsReady = () =>
    services.feishuApproval.approvalCode() !== undefined && services.feishuApproval.subscriptionHealthy()
  const ensureDefinitions = async () => {
    await services.feishuApproval.ensureDefinition()
    await services.feishuApproval.ensurePermSubscription()
    // 审批落账规则（2026-11-01 P2）：规则里登记的企业自建审批定义逐个订阅事件（保存规则时也订，
    // 这里兜启动时的首轮失败；⭐定时器在两健康检查都过后会停表——其后改规则若订阅失败，重订靠
    // 管理员再保存一次（PUT 响应如实报 subscription_healthy）或重启，期间审批单由补抓兜底不丢）
    await services.feishuApproval.ensurePostingSubscriptions()
  }
  await ensureDefinitions()
  const ensureTimer = setInterval(() => {
    if (definitionsReady()) {
      clearInterval(ensureTimer)
      return
    }
    void ensureDefinitions()
  }, 10 * 60 * 1000)
  ensureTimer.unref()
  // 断线补抓（2026-10-30 第2层）：进程停机期间错过的审批事件，启动即对账补处理
  // （长连接中途断开的补抓在 adapter 重连回调里；两者幂等，靠实例占坑键去重）
  void services.feishuApproval.backfillMissed('startup')
  // 组织架构同步（2026-10-29 第二步）：启动拉一次 + 每 24h 刷新；失败只 warn 降级（权限没配时
  // 映射配置先用已有镜像，配好后等下一轮或手动 POST /api/bridge/org-sync）。凭据没配时不跑
  // （对抗审查 P3-1：与适配器注册同条件，免得无凭据部署每天两条注定失败的告警）
  const hasFeishuCreds = config.feishuAppId !== '' && config.feishuAppSecret !== ''
  const syncOrgs = (trigger: 'startup' | 'schedule') => {
    if (!hasFeishuCreds) return Promise.resolve()
    return services.feishuApproval.syncFromFeishu(trigger).then(
      (r) => console.log(`[feishu-approval] 组织架构已同步：${r.count} 个部门（${trigger}）`),
      (e) => console.warn(`[feishu-approval] 组织架构同步失败（${trigger}）：${e instanceof Error ? e.message : e}`),
    )
  }
  void syncOrgs('startup')
  const orgTimer = setInterval(() => void syncOrgs('schedule'), 24 * 3600 * 1000)
  orgTimer.unref()
  // 义务扫描（2026-10-31 待办预警方案 P1）：启动即对账一轮（幂等，停机期间到期的义务补进场），
  // 之后每天 08:30 全量扫+晨报（app_meta 落标，补跑/重启不重发；时点可用 ADMIN_DAILY_SCAN_AT
  // "HH:MM" 改）。手动触发走 POST /api/todos/scan（排查用，不推晨报）。
  const runScans = (trigger: 'startup' | 'schedule') => {
    services.obligationScanner
      .runAll(trigger)
      .then((r) => {
        const created = r.scanners.reduce((n, s) => n + s.created, 0)
        const failed = r.scanners.filter((s) => s.error !== undefined).length
        console.log(
          `[todos] 义务扫描完成（${trigger}）：新建 ${created}、升级 ${r.escalated}、晨报 ${r.digest}` +
            (failed > 0 ? `；${failed} 个扫描器失败（详见 scan_runs）` : ''),
        )
      })
      .catch((e) => console.warn(`[todos] 义务扫描失败（${trigger}）：`, e instanceof Error ? e.message : e))
  }
  void runScans('startup')
  const scanAt = parseDailyScanAt(process.env.ADMIN_DAILY_SCAN_AT)
  if (scanAt.invalid !== undefined) {
    console.warn(`[todos] ADMIN_DAILY_SCAN_AT="${scanAt.invalid}" 不是 HH:MM，按 08:30 调度`)
  }
  const scheduleNextScan = (): void => {
    const now = new Date()
    const next = new Date(now)
    next.setHours(scanAt.hour, scanAt.minute, 0, 0)
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
    const timer = setTimeout(() => {
      runScans('schedule')
      scheduleNextScan()
    }, next.getTime() - now.getTime())
    timer.unref()
  }
  scheduleNextScan()
  // 优雅关停：收掉对话 runtime 子进程、知识库 MCP 子进程与平台长连接（不收也会随进程退出断，这里只是干净利落）
  const bye = async (signal: string) => {
    await services.agent.shutdown().catch(() => {})
    await services.knowledge.shutdown().catch(() => {})
    await services.bridge.shutdown().catch(() => {})
    await app.close().catch(() => {})
    process.exit(0)
  }
  process.once('SIGINT', () => void bye('SIGINT'))
  process.once('SIGTERM', () => void bye('SIGTERM'))
}

void bootstrap()

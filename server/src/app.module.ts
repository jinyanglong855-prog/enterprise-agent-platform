/** 应用装配：服务手动实例化后以 useValue 注册进 Nest（不依赖构造器元数据注入）。 */
import type { DynamicModule } from '@nestjs/common'
import { openDatabase, type DB } from './db/database.js'
import { config, ensureDataDir } from './config.js'
import { RbacService } from './rbac/rbac.service.js'
import { AuditService } from './audit/audit.service.js'
import { FinanceService } from './finance/finance.service.js'
import { FinanceAccountsService } from './finance/finance-accounts.service.js'
import { FinanceInvoicesService } from './finance/finance-invoices.service.js'
import { FinanceProposalsService } from './finance/finance-proposals.service.js'
import { FinancePostingService } from './finance/finance-posting.service.js'
import { FinancePostingController } from './finance/finance-posting.controller.js'
import { FinancePayrollPostingService } from './finance/finance-payroll-posting.service.js'
import { FinancePayrollPostingController } from './finance/finance-payroll-posting.controller.js'
import { FinanceImportsService } from './finance/finance-imports.service.js'
import { FinanceFilingService } from './finance/finance-filing.service.js'
import { FinanceReconciliationService } from './finance/finance-reconciliation.service.js'
import { FinancePayrollService } from './finance/finance-payroll.service.js'
import { FinanceAttachmentsService } from './finance/finance-attachments.service.js'
import { FinanceMatchesService } from './finance/finance-matches.service.js'
import { FinanceBankLinesService } from './finance/finance-banklines.service.js'
import { FinanceCashCountsService } from './finance/finance-cashcounts.service.js'
import { FinanceReportsService } from './finance/finance-reports.service.js'
import { FinanceController } from './finance/finance.controller.js'
import { FinanceAccountsController } from './finance/finance-accounts.controller.js'
import { FinanceInvoicesController } from './finance/finance-invoices.controller.js'
import { FinanceProposalsController } from './finance/finance-proposals.controller.js'
import { FinanceImportsController } from './finance/finance-imports.controller.js'
import { FinanceFilingController } from './finance/finance-filing.controller.js'
import { FinanceReconciliationController } from './finance/finance-reconciliation.controller.js'
import { FinancePayrollController } from './finance/finance-payroll.controller.js'
import { FinanceRosterService } from './finance/finance-roster.service.js'
import { FinanceRosterController } from './finance/finance-roster.controller.js'
import { FinancePayslipsService } from './finance/finance-payslips.service.js'
import { FinancePayslipsController } from './finance/finance-payslips.controller.js'
import { FinanceAttachmentsController } from './finance/finance-attachments.controller.js'
import { FinanceMatchesController } from './finance/finance-matches.controller.js'
import { FinanceBankLinesController } from './finance/finance-banklines.controller.js'
import { FinanceCashCountsController } from './finance/finance-cashcounts.controller.js'
import { FinanceReportsController } from './finance/finance-reports.controller.js'
import { AuthController } from './auth/auth.controller.js'
import { AuthService, type AuthContext } from './auth/auth.service.js'
import { AuditController } from './audit/audit.controller.js'
import { AgentService } from './agent/agent.service.js'
import { AgentController } from './agent/agent.controller.js'
import { BridgeService } from './bridge/bridge.service.js'
import { BridgeController } from './bridge/bridge.controller.js'
import { FeishuApprovalService } from './bridge/feishu-approval.service.js'
import { PlatformDataService } from './bridge/platform-data.service.js'
import { PlatformDataController } from './bridge/platform-data.controller.js'
import { MockAdapter } from './bridge/mock.adapter.js'
import { FeishuAdapter } from './bridge/feishu.adapter.js'
import { RbacController } from './rbac/rbac.controller.js'
import { TodosService } from './todos/todos.service.js'
import { TodosController } from './todos/todos.controller.js'
import { ObligationScannerService } from './todos/obligation-scanner.service.js'
import { SupplyService } from './supply/supply.service.js'
import { SupplyImportsService } from './supply/supply-imports.service.js'
import { SupplyBitableService } from './supply/supply-bitable.service.js'
import { SupplyController } from './supply/supply.controller.js'
import { KbMcpClient } from './knowledge/kb-mcp-client.js'
import { KnowledgeService } from './knowledge/knowledge.service.js'
import { KnowledgeController } from './knowledge/knowledge.controller.js'

export interface Services {
  db: DB
  rbac: RbacService
  audit: AuditService
  finance: FinanceService
  accounts: FinanceAccountsService
  invoices: FinanceInvoicesService
  imports: FinanceImportsService
  proposals: FinanceProposalsService
  posting: FinancePostingService
  payrollPosting: FinancePayrollPostingService
  filing: FinanceFilingService
  reconciliation: FinanceReconciliationService
  payroll: FinancePayrollService
  roster: FinanceRosterService
  payslips: FinancePayslipsService
  attachments: FinanceAttachmentsService
  matches: FinanceMatchesService
  bankLines: FinanceBankLinesService
  cashCounts: FinanceCashCountsService
  reports: FinanceReportsService
  auth: AuthService
  agent: AgentService
  bridge: BridgeService
  feishuApproval: FeishuApprovalService
  platformData: PlatformDataService
  todos: TodosService
  obligationScanner: ObligationScannerService
  supply: SupplyService
  supplyImports: SupplyImportsService
  supplyBitable: SupplyBitableService
  knowledge: KnowledgeService
}

export function buildServices(): Services {
  ensureDataDir()
  const db = openDatabase(config.dbPath)
  const audit = new AuditService(db)
  const rbac = new RbacService(db, audit)
  rbac.seed()
  const finance = new FinanceService(db, audit)
  const accounts = new FinanceAccountsService(db, audit)
  const invoices = new FinanceInvoicesService(db, audit)
  const imports = new FinanceImportsService(db, audit, finance)
  const proposals = new FinanceProposalsService(db, audit, finance, imports)
  const filing = new FinanceFilingService(db, finance)
  const reconciliation = new FinanceReconciliationService(db)
  const payroll = new FinancePayrollService(db, finance)
  const attachments = new FinanceAttachmentsService(db, audit)
  const matches = new FinanceMatchesService(db)
  const bankLines = new FinanceBankLinesService(db, audit)
  const cashCounts = new FinanceCashCountsService(db, audit)
  const reports = new FinanceReportsService(db, finance)
  const auth = new AuthService(rbac, audit, db)
  const agent = new AgentService(db, rbac, audit)
  // 义务域（2026-10-31 待办预警方案）：待办服务先于桥（桥的待办卡回写端口要它），
  // 扫描服务最后（要桥推卡）。调度在 main.ts（每天 08:30 全量扫+晨报）。
  const todos = new TodosService(db, rbac, audit)
  const bridge = new BridgeService(db, audit, proposals, agent, rbac, todos)
  // 审批落账插槽（2026-11-01 融合方案 §5 P2）：飞书审批批了 → 提案卡进老板单聊 → 确认落账。
  // 钩子注入 feishu-approval（类型只依赖插槽文件，运行时由装配处接，避免 bridge→finance 环）
  const posting = new FinancePostingService(db, audit, proposals, rbac, bridge, { platform: 'feishu' })
  // P0 平台未定：mock 适配器常驻注册（ADMIN_BRIDGE_ADAPTER=mock 时可跑通全链路自测）；
  // 飞书（P1 第一平台）：凭据齐了才注册——缺凭据时注册一个永远起不来的适配器只会制造噪声
  bridge.registerAdapter(new MockAdapter())
  const feishuApproval = new FeishuApprovalService(db, audit, rbac, bridge, { posting: posting.hook() })
  // P1 数据通道（2026-11-01）：只读平台数据面。凭据缺失时服务照常装配——接口会在
  // 取 token 时报错（人话提示检查 ADMIN_FEISHU_APP_ID/SECRET），不制造第二个拒连闸。
  const platformData = new PlatformDataService(db, audit)
  // 工资域（2026-11-01 A3）：名册同步走平台数据通道（身份只读），工资单算数复用无状态计算器
  const roster = new FinanceRosterService(db, audit, platformData)
  const payslips = new FinancePayslipsService(db, audit, payroll)
  // 工资单接落账（2026-11-02）：与审批落账共用 posting 公共体；守卫回注工资单服务（已落账月锁死/pending 提案随变动作废）
  const payrollPosting = new FinancePayrollPostingService(db, audit, posting, proposals, bridge, { platform: 'feishu' })
  payslips.setPostingGuard(payrollPosting.guard())
  if (config.feishuAppId !== '' && config.feishuAppSecret !== '') {
    const feishu = new FeishuAdapter()
    // OA 审批事件：长连接进来直通审批服务（平台特定链路，不过 BridgeService）。
    // handleEvent 内部已兜错，这里再挂 catch 防 audit 落库异常演成 unhandledRejection
    feishu.onApprovalEvent((n) => {
      feishuApproval.handleEvent(n).catch((e) => console.warn('[bridge:feishu] 审批事件处理异常：', e instanceof Error ? e.message : e))
    })
    // 断线重连 → 补抓错过的审批（2026-10-30 第2层；进程冷启动的补抓在 main.ts）
    feishu.onReconnect(() => feishuApproval.backfillMissed('reconnect'))
    // 连接断开/恢复 → 审计留痕（2026-10-30 第3层；adapter 不碰库，落库在装配处接线）
    feishu.onConnectionChange((c) => {
      audit.log({
        username: '-',
        source: 'system',
        action: c.connected ? 'bridge.connection.restored' : 'bridge.connection.lost',
        targetId: 'feishu',
        detail: c.error === undefined ? { platform: 'feishu' } : { platform: 'feishu', error: c.error },
        ok: c.connected,
      })
    })
    bridge.registerAdapter(feishu)
  }
  // 生产供应链域（2026-11-01 生产任务全图 v0）：物料/库存/采购单；先于扫描服务（安全线与到货逾期两个扫描器读它）
  const supply = new SupplyService(db, audit)
  const supplyImports = new SupplyImportsService(db, audit, supply)
  // 通道 B（2026-11-01 v0.5）：多维表格只读同步复用导入层；凭据缺失同 platformData——装配照常、调用时人话报错
  const supplyBitable = new SupplyBitableService(db, audit, supplyImports)
  const obligationScanner = new ObligationScannerService(db, rbac, finance, invoices, proposals, bridge, todos, supply, roster, supplyBitable)
  // 知识库（2026-11-02 阶段 3）：kb-rag MCP 子进程首次调用才拉起、空闲自动停；未配置 ADMIN_KB_RAG_DIR 时
  // 服务照常装配、接口 503 人话提示（与飞书凭据缺失同一口径：不制造第二个拒连闸）
  const kbArgs = config.kbMcpArgs ?? (config.kbRagDir === '' ? undefined : ['--directory', config.kbRagDir, 'run', 'kb-rag-mcp'])
  const kbClient = kbArgs === undefined
    ? undefined
    : new KbMcpClient({ command: config.kbMcpCommand, args: kbArgs, env: { KB_CALLER: config.kbCaller }, idleMs: config.kbIdleMs })
  const knowledge = new KnowledgeService(audit, kbClient, config.kbCaller)
  return { db, rbac, audit, finance, accounts, invoices, imports, proposals, posting, payrollPosting, filing, reconciliation, payroll, roster, payslips, attachments, matches, bankLines, cashCounts, reports, auth, agent, bridge, feishuApproval, platformData, todos, obligationScanner, supply, supplyImports, supplyBitable, knowledge }
}

/** 建带已装配服务的 Nest 动态模块（NestFactory.create 直接收）。 */
export function createRuntimeModule(services: Services = buildServices()): { dynamicModule: DynamicModule; services: Services } {
  class RuntimeModule {}

  const dynamicModule: DynamicModule = {
    module: RuntimeModule,
    controllers: [
      FinanceController,
      FinanceAccountsController,
      FinanceInvoicesController,
      FinanceProposalsController,
      FinancePostingController,
      FinancePayrollPostingController,
      FinanceImportsController,
      FinanceFilingController,
      FinanceReconciliationController,
      FinancePayrollController,
      FinanceRosterController,
      FinancePayslipsController,
      FinanceAttachmentsController,
      FinanceMatchesController,
      FinanceBankLinesController,
      FinanceCashCountsController,
      FinanceReportsController,
      AuthController,
      AuditController,
      AgentController,
      BridgeController,
      PlatformDataController,
      RbacController,
      TodosController,
      SupplyController,
      KnowledgeController,
    ],
    providers: [
      { provide: FinanceService, useValue: services.finance },
      { provide: FinanceAccountsService, useValue: services.accounts },
      { provide: FinanceInvoicesService, useValue: services.invoices },
      { provide: FinanceProposalsService, useValue: services.proposals },
      { provide: FinancePostingService, useValue: services.posting },
      { provide: FinancePayrollPostingService, useValue: services.payrollPosting },
      { provide: FinanceImportsService, useValue: services.imports },
      { provide: FinanceFilingService, useValue: services.filing },
      { provide: FinanceReconciliationService, useValue: services.reconciliation },
      { provide: FinancePayrollService, useValue: services.payroll },
      { provide: FinanceRosterService, useValue: services.roster },
      { provide: FinancePayslipsService, useValue: services.payslips },
      { provide: FinanceAttachmentsService, useValue: services.attachments },
      { provide: FinanceMatchesService, useValue: services.matches },
      { provide: FinanceBankLinesService, useValue: services.bankLines },
      { provide: FinanceCashCountsService, useValue: services.cashCounts },
      { provide: FinanceReportsService, useValue: services.reports },
      { provide: AuditService, useValue: services.audit },
      { provide: AuthService, useValue: services.auth },
      { provide: AgentService, useValue: services.agent },
      { provide: BridgeService, useValue: services.bridge },
      { provide: FeishuApprovalService, useValue: services.feishuApproval },
      { provide: PlatformDataService, useValue: services.platformData },
      { provide: RbacService, useValue: services.rbac },
      { provide: TodosService, useValue: services.todos },
      { provide: ObligationScannerService, useValue: services.obligationScanner },
      { provide: SupplyService, useValue: services.supply },
      { provide: SupplyImportsService, useValue: services.supplyImports },
      { provide: SupplyBitableService, useValue: services.supplyBitable },
      { provide: KnowledgeService, useValue: services.knowledge },
    ],
  }

  return { dynamicModule, services }
}

/** JSON body 上限（main 与测试共用）：express 默认 100kb 会把附件 base64（≤8MB 文件）和批量导入挡成 413，
 *  16MB 覆盖两者——真正的门是服务层自己的大小校验，这层只保证请求能到门。 */
export const BODY_LIMIT = '16mb'

/** 全局鉴权中间件（main 与测试共用）：每请求解析 Bearer 到 req.auth；权限点校验在路由内做。 */
export function registerAuthMiddleware(app: { use: (fn: unknown) => unknown }, auth: AuthService): void {
  app.use((req: { headers: Record<string, unknown>; auth?: AuthContext }, _res: unknown, next: () => void) => {
    try {
      req.auth = auth.verifyBearer(String(req.headers['authorization'] ?? ''))
    } catch {
      req.auth = undefined
    }
    next()
  })
}

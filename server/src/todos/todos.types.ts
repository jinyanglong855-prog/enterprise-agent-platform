/** 义务域共享类型（2026-10-31 待办预警方案 §四/§六）：预警/待办/晨报 = 同一实体的三种投影。
 *  本文件只放类型与取值集，不碰库不碰平台——bridge.types 从这里拿卡片视图，保持依赖单向。 */

export const OBLIGATION_STATUSES = ['open', 'resolved', 'dismissed', 'done', 'escalated'] as const
export type ObligationStatus = (typeof OBLIGATION_STATUSES)[number]

/** 活跃态：还欠人处理的两种状态（其余三个都是终态）。 */
export const ACTIVE_STATUSES: readonly ObligationStatus[] = ['open', 'escalated']

export const SEVERITIES = ['info', 'warn', 'critical'] as const
export type ObligationSeverity = (typeof SEVERITIES)[number]

/** obligations 表行（唯一事实源在原表：本表是投影+处置层，见 schema.ts 注释）。 */
export interface ObligationRow {
  id: number
  source_type: string
  source_ref: string
  dedupe_key: string
  title: string
  detail: string
  owner_type: 'user' | 'role'
  owner_id: string
  due_date: string
  severity: ObligationSeverity
  status: ObligationStatus
  origin: 'scan' | 'manual'
  first_seen_at: string
  escalated_at: string | null
  last_notified: string
  resolved_at: string | null
  dismissed_by: string
  dismissed_reason: string
  dismissed_at: string | null
  done_by: string
  done_at: string | null
  /** 完成备注（人工 done / 推导核实闭合时可填）。 */
  done_note: string
  /** 推导项被人改过到期/严重度/责任人：扫描刷新只更新标题/说明/source_ref，不覆盖这三项。 */
  user_edited: number
  created_by: string
  created_at: string
}

/** 「已完成」的结果（推导型要先核实源头）：
 *  done=人工待办直接完成；resolved=核实源头已消失，闭合；pending=源头仍在，不关并恢复提醒；
 *  unverifiable=这类事项系统无法核实（申报缴费），需填备注强制确认；forced=备注强制确认（落 dismissed）。 */
export type CompleteOutcome = 'done' | 'resolved' | 'pending' | 'unverifiable' | 'forced'

export interface CompleteResult {
  outcome: CompleteOutcome
  /** pending/unverifiable 时给人看的说明（扫描器当前看到的事实或"无法核实"的原因）。 */
  message?: string
  item: ObligationRow
}

/** 推导型扫描器的产出（scanner 纯函数返回，落库与推送由扫描服务统一做）。 */
export interface ObligationCandidate {
  sourceType: string
  /** 幂等键：同源同事只一条；due_date 进键（账期变了=换一条，旧的自动闭合）。 */
  dedupeKey: string
  title: string
  detail: string
  /** 深链信息（原表 id 等）：视图跳转与追溯用。 */
  sourceRef: Record<string, unknown>
  dueDate?: string
  severity: ObligationSeverity
}

/** 扫描器定义：key=source_type 前缀（obligations.source_type 取这个值）。 */
export interface ScannerDef {
  key: string
  label: string
  /** now 注入：测试可拨时钟；扫描器内部不得自己取当前时间。 */
  scan(now: Date): ObligationCandidate[] | Promise<ObligationCandidate[]>
  /** 这类义务怎么闭合：true（缺省）=源头消失即自动 resolved（应收付掉、提案确认掉）；
   *  false=系统无法从数据得知"做完了"（申报缴费这类外部动作），只靠人填备注确认完成关闭，
   *  候选不再出现也不自动闭合——否则到期未办的义务会随日期窗口滑出被标成"已处理"。 */
  closeOnAbsence?: boolean
}

/** 出站待办卡（BridgeService → adapter 渲染）：跃迁即时卡（单条，带按钮）与晨报卡（汇总，无按钮）。 */
export interface TodoCardView {
  kind: 'todo-item' | 'todo-digest'
  title: string
  template: 'blue' | 'orange' | 'red'
  /** 正文行（lark_md 语法可用）；adapter 原样渲染，业务拼装在扫描服务。 */
  lines: string[]
  note?: string
  /** item 卡才有：卡片按钮回传的义务 id。 */
  todoId?: number
  /** item 卡：manual 待办才有「完成」按钮（推导型卡上只有「暂不处理」；核实式完成在待办中心做）。 */
  canDone?: boolean
}

/** 卡片回写端口（BridgeService 处理待办卡按钮时调，TodosService 结构性满足）：
 *  用端口类型而非直接依赖，避免 bridge ↔ todos 循环构造。 */
export interface TodoCardActionPort {
  todoCardAction(actor: string, todoId: number, action: 'ack' | 'done'): { outcome: 'acked' | 'done'; phrase: string }
}

/** 全月历投影的阶段（2026-11-01 用户定稿：企业每月固定事项整月显示）：提早=提示，当天/已逾期=预警。 */
export type RecurringPhase = 'early' | 'overdue' | 'today'

export interface RecurringItem {
  /** 与义务行同构的 dedupe_key：一旦扫描生成正式待办，日历投影就让位给真待办。 */
  key: string
  title: string
  due: string
  channel: string
  phase: RecurringPhase
  severity: 'critical' | 'warn'
}

/** recurringMonth 的返回。 */
export interface RecurringMonth {
  month: string
  items: RecurringItem[]
}

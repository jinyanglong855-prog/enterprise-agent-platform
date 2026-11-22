/**
 * 待办中心前端 API（2026-10-31 待办预警方案 P2）：义务域 REST 的薄封装。
 * 读=todo:read，写=todo:write，企业视图/路由配置/扫描触发=admin:manage（403 由 request 拦截器统一提示）。
 */
import { requestClient } from './request';

export type ObligationStatus =
  | 'dismissed'
  | 'done'
  | 'escalated'
  | 'open'
  | 'resolved';
export type ObligationSeverity = 'critical' | 'info' | 'warn';

export interface Obligation {
  id: number;
  source_type: string;
  source_ref: string;
  dedupe_key: string;
  title: string;
  detail: string;
  owner_type: 'role' | 'user';
  owner_id: string;
  due_date: string;
  severity: ObligationSeverity;
  status: ObligationStatus;
  origin: 'manual' | 'scan';
  first_seen_at: string;
  escalated_at: null | string;
  last_notified: string;
  resolved_at: null | string;
  dismissed_by: string;
  dismissed_reason: string;
  dismissed_at: null | string;
  done_by: string;
  done_at: null | string;
  /** 完成备注（人工完成 / 推导核实闭合时可填）。 */
  done_note: string;
  /** 推导型被人改过到期/严重度/责任人：扫描刷新不再覆盖这三项。 */
  user_edited: number;
  created_by: string;
  created_at: string;
}

/** 「已完成」的结果：done=人工待办直接完成；resolved=系统核实源头已处理，闭合；
 *  pending=源头还在，没关（提醒恢复）；unverifiable=这类事系统无法核实（征期），要填备注强制确认；
 *  forced=按备注强制确认完成（落 dismissed，永久）。 */
export type CompleteOutcome =
  | 'done'
  | 'forced'
  | 'pending'
  | 'resolved'
  | 'unverifiable';

export interface CompleteResult {
  outcome: CompleteOutcome;
  message?: string;
  item: Obligation;
}

export interface TodoSummary {
  overdue: number;
  today: number;
  upcoming7: number;
  undated: number;
}

export interface TodoRoute {
  source_type: string;
  owner_type: 'role' | 'user';
  owner_id: string;
  enabled: number;
}

export interface TodoInput {
  title: string;
  detail?: string;
  ownerType?: 'role' | 'user';
  ownerId?: string;
  dueDate?: string;
  severity?: ObligationSeverity;
}

export interface ScanResult {
  trigger: string;
  ranAt: string;
  scanners: {
    scanner: string;
    label: string;
    found: number;
    created: number;
    deduped: number;
    autoResolved: number;
    error?: string;
    skipped?: true;
  }[];
  escalated: number;
  repushed: number;
  digest: string;
}

export function listTodosApi(params: {
  scope: 'enterprise' | 'mine' | 'pool';
  status?: 'active' | 'all' | ObligationStatus;
  limit?: number;
}): Promise<{ count: number; items: Obligation[] }> {
  return requestClient.get('/todos', { params });
}

export function todoSummaryApi(): Promise<TodoSummary> {
  return requestClient.get('/todos/summary');
}

export function todoOwnersApi(): Promise<{
  users: { username: string; displayName: string }[];
  roles: string[];
}> {
  return requestClient.get('/todos/owners');
}

export function createTodoApi(body: TodoInput): Promise<{ item: Obligation }> {
  return requestClient.post('/todos', body);
}

export function updateTodoApi(
  id: number,
  body: Partial<TodoInput>,
): Promise<{ item: Obligation }> {
  // requestClient 只封装了 get/post/put/delete；PATCH 走通用 request
  return requestClient.request(`/todos/${id}`, { data: body, method: 'PATCH' });
}

/** 「已完成」：人工待办直接完成（note 可选）；推导型由后端先核实源头，看 outcome 决定下一步。
 *  force=true 只对推导型有意义：人坚持已完成，必须带 note（后端 400 兜底）。 */
export function doneTodoApi(
  id: number,
  body: { note?: string; force?: boolean } = {},
): Promise<CompleteResult> {
  return requestClient.post(`/todos/${id}/done`, body);
}

/** 静默（备注必填，永久关闭）：界面上已并入「已完成→强制确认」流程，保留给需要直接关的场景。 */
export function dismissTodoApi(
  id: number,
  reason: string,
): Promise<{ item: Obligation }> {
  return requestClient.post(`/todos/${id}/dismiss`, { reason });
}

/** 暂不处理：不再推送这条（待办中心仍可见），到期升级时再提醒一次。 */
export function ackTodoApi(id: number): Promise<{ item: Obligation }> {
  return requestClient.post(`/todos/${id}/ack`);
}

export function todoRoutesApi(): Promise<{ routes: TodoRoute[] }> {
  return requestClient.get('/todos/routes');
}

export function setTodoRouteApi(
  sourceType: string,
  body: { ownerType?: 'role' | 'user'; ownerId?: string; enabled?: boolean },
): Promise<{ route: TodoRoute }> {
  return requestClient.put(
    `/todos/routes/${encodeURIComponent(sourceType)}`,
    body,
  );
}

export function runScanApi(): Promise<ScanResult> {
  return requestClient.post('/todos/scan');
}

export function scanRunsApi(
  limit = 30,
): Promise<{ count: number; runs: Record<string, unknown>[] }> {
  return requestClient.get('/todos/scan-runs', { params: { limit } });
}

/** 全月历投影条目（2026-11-01 用户定稿）：企业每月固定事项（报税/社保等）整月预列——
 *  提早=提示（early），当天/已逾期=预警（today/overdue）；不占待办、不推送，进临期窗口才生成正式待办。 */
export type RecurringPhase = 'early' | 'overdue' | 'today';

export interface RecurringItem {
  key: string;
  title: string;
  due: string;
  channel: string;
  phase: RecurringPhase;
  severity: 'critical' | 'warn';
}

export function recurringTodosApi(
  month: string,
): Promise<{ month: string; items: RecurringItem[] }> {
  return requestClient.get('/todos/recurring', { params: { month } });
}

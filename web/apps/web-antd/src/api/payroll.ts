import { requestClient } from '#/api/request';

/** 期初累计（开账）：年中启用，截至 through_month 月末的累计；之后从下个月开始出单。 */
export interface OpeningRecord {
  id: number;
  employee_id: number;
  year: string;
  through_month: string;
  gross: number;
  social: number;
  extra_deduct: number;
  relief: number;
  withheld: number;
  note: string;
  updated_at: string;
  updated_by: string;
}

export interface OpeningInput {
  employee_id: number;
  year: string;
  through_month: string;
  gross?: number;
  social?: number;
  extra_deduct?: number;
  relief?: number;
  withheld?: number;
  note?: string;
}

/** 与后端 finance-roster/finance-payslips 服务对齐的类型与接口（工资域，payroll:read/write）。 */

export interface EmployeeRecord {
  id: number;
  name: string;
  open_id: string;
  department: string;
  hire_date: string;
  leave_date: string;
  base_salary: number;
  social: number;
  extra_deduct: number;
  note: string;
  updated_at: string;
  updated_by: string;
  archived_at: null | string;
}

export interface EmployeeInput {
  base_salary?: number;
  department?: string;
  extra_deduct?: number;
  hire_date?: string;
  leave_date?: string;
  name?: string;
  note?: string;
  open_id?: string;
  social?: number;
}

export interface PayslipRecord {
  id: number;
  employee_id: number;
  employee_name: string;
  department: string;
  month: string;
  gross: number;
  social: number;
  extra_deduct: number;
  relief: number;
  months_count: number;
  gross_prev: number;
  social_prev: number;
  extra_prev: number;
  relief_prev: number;
  withheld_prev: number;
  taxable_cum: number;
  tax: number;
  net: number;
  negative_diff: number;
  status: string;
  note: string;
}

export interface PayslipRegister {
  month: string;
  count: number;
  rows: PayslipRecord[];
  totals: { gross: number; social: number; tax: number; net: number };
  note: string;
}

export interface RosterSyncResult {
  created: number;
  updated: number;
  skipped_archived: number;
  missing_on_platform: string[];
  pending_bind: Array<{ name: string; open_id: string }>;
  truncated: boolean;
  root_members: 'synced' | 'unavailable';
  note: string;
}

export async function listEmployeesApi(
  includeArchived = false,
): Promise<{ count: number; employees: EmployeeRecord[] }> {
  return requestClient.get('/finance/employees', {
    params: includeArchived ? { include_archived: 'true' } : {},
  });
}

export async function createEmployeeApi(
  input: EmployeeInput,
): Promise<EmployeeRecord> {
  return requestClient.post('/finance/employees', input);
}

export async function updateEmployeeApi(
  id: number,
  input: EmployeeInput,
): Promise<EmployeeRecord> {
  // requestClient 只封装了 get/post/put/delete；PATCH 走通用 request
  return requestClient.request(`/finance/employees/${id}`, {
    data: input,
    method: 'PATCH',
  });
}

export async function archiveEmployeeApi(id: number): Promise<EmployeeRecord> {
  return requestClient.delete(`/finance/employees/${id}`);
}

export async function getOpeningApi(
  employeeId: number,
  year: string,
): Promise<null | OpeningRecord> {
  return (
    (
      await requestClient.get(
        `/finance/payslips/opening?employee_id=${employeeId}&year=${year}`,
      )
    )?.opening ?? null
  );
}

export async function setOpeningApi(
  input: OpeningInput,
): Promise<OpeningRecord> {
  return requestClient.put('/finance/payslips/opening', input);
}

export async function deleteOpeningApi(
  employeeId: number,
  year: string,
): Promise<{ removed: number }> {
  return requestClient.delete(
    `/finance/payslips/opening?employee_id=${employeeId}&year=${year}`,
  );
}

export async function unarchiveEmployeeApi(
  id: number,
): Promise<EmployeeRecord> {
  return requestClient.post(`/finance/employees/${id}/unarchive`);
}

export async function syncRosterApi(): Promise<RosterSyncResult> {
  return requestClient.post('/finance/employees/sync');
}

export async function registerApi(month: string): Promise<PayslipRegister> {
  return requestClient.get('/finance/payslips', {
    params: { month },
  });
}

export async function employeeYearApi(
  employeeId: number,
  year: string,
): Promise<{ employee: { id: number; name: string }; rows: PayslipRecord[] }> {
  return requestClient.get('/finance/payslips', {
    params: { employee_id: String(employeeId), year },
  });
}

export async function generatePayslipsApi(month: string): Promise<
  PayslipRegister & {
    created: number;
    no_hire_date: string[];
    skipped: number;
    skipped_in_opening: Array<{ name: string; through_month: string }>;
    skipped_no_salary: string[];
    skipped_out_of_order: Array<{ later_month: string; name: string }>;
  }
> {
  return requestClient.post('/finance/payslips/generate', { month });
}

export async function updatePayslipApi(
  id: number,
  input: {
    extra_deduct?: number;
    gross?: number;
    note?: string;
    relief?: number;
    social?: number;
  },
): Promise<PayslipRecord> {
  return requestClient.request(`/finance/payslips/${id}`, {
    data: input,
    method: 'PATCH',
  });
}

/** 确认：最后一张确认落地时后端顺手跑自动落账，posting 带结果（skipped/created/duplicate/failed）。 */
export async function confirmPayslipApi(
  id: number,
): Promise<PayslipRecord & { posting?: PayrollPostOutcome }> {
  return requestClient.post(`/finance/payslips/${id}/confirm`);
}

export async function unconfirmPayslipApi(id: number): Promise<PayslipRecord> {
  return requestClient.post(`/finance/payslips/${id}/unconfirm`);
}

export async function deletePayslipApi(
  id: number,
): Promise<{ removed: number }> {
  return requestClient.delete(`/finance/payslips/${id}`);
}

// ---------- 工资单接落账 / 工资条推送 / 导出（2026-11-02 财务线残余②；payroll:read/write） ----------

/** 某月落账状态：工资单计数、合计、该月落账提案（不含被拒的）、现在能不能手动生成提案。 */
export interface PayrollPostingStatus {
  month: string;
  payslips: {
    confirmed: number;
    draft: number;
    draft_names: string[];
    total: number;
  };
  totals: { gross: number; net: number; social: number; tax: number };
  /** pending=等老板确认；confirmed=已进账本（entry_id） */
  proposal: null | { entry_id: string; id: string; status: string };
  postable: boolean;
  /** 不能生成时的人话原因（草稿未确认/已有提案/已落账） */
  reason: string;
}

export type PayrollPostOutcome =
  | {
      card: 'failed' | 'sent';
      proposal: string;
      status: 'created';
      summary: string;
    }
  | { error: string; status: 'failed' }
  | { proposal: string; proposalStatus: string; status: 'duplicate' }
  | { reason: string; status: 'skipped' };

export interface PayslipPushResult {
  month: string;
  sent: string[];
  skipped: Array<{ name: string; reason: string }>;
}

export async function payrollPostingStatusApi(
  month: string,
): Promise<PayrollPostingStatus> {
  return requestClient.get('/finance/payroll-posting', { params: { month } });
}

/** 手动兜底：自动落账没成（卡片发失败/当时账户没建档等）时人点一下再生成。 */
export async function postPayrollMonthApi(
  month: string,
): Promise<PayrollPostOutcome> {
  return requestClient.post('/finance/payroll-posting', { month });
}

export async function pushPayslipsApi(
  month: string,
): Promise<PayslipPushResult> {
  return requestClient.post('/finance/payroll-posting/push', { month });
}

/** CSV 走同一 requestClient（带令牌）拿 Blob，前端自己触发下载；后端已带 BOM 与合计行。 */
export async function exportPayslipsCsvApi(month: string): Promise<Blob> {
  return requestClient.get('/finance/payroll-posting/export', {
    params: { month },
    responseType: 'blob',
  });
}

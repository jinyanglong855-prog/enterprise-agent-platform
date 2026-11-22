import { requestClient } from '#/api/request';

/** 与后端 finance.types.ts 对齐的取值集与中文标签（界面单一事实源）。 */
export const TYPE_VALUES = [
  'income',
  'expense',
  'reimburse',
  'invoice',
  'payroll',
  'tax',
] as const;
export const STATUS_VALUES = [
  'cancelled',
  'issued',
  'paid',
  'partial',
  'pending',
  'received',
  'unpaid',
] as const;

export type EntryType = (typeof TYPE_VALUES)[number];
export type EntryStatus = (typeof STATUS_VALUES)[number];

export const TYPE_LABELS: Record<EntryType, string> = {
  expense: '支出',
  income: '收入',
  invoice: '发票',
  payroll: '工资',
  reimburse: '报销',
  tax: '税费',
};

export const STATUS_LABELS: Record<EntryStatus, string> = {
  cancelled: '已作废',
  issued: '已开票',
  paid: '已收付',
  partial: '部分收付',
  pending: '待定',
  received: '已收票',
  unpaid: '未收付',
};

export interface Followup {
  created_by: string;
  date: string;
  note: string;
}

export interface EntryRecord {
  account: string;
  amount: number;
  approved_by: string;
  category: string;
  counterparty: string;
  created_by: string;
  date: string;
  due_date: string;
  followups?: Followup[];
  id: string;
  invoice_no: string;
  note: string;
  paid_amount: number;
  reverses: string;
  reversed_by: string;
  status: EntryStatus;
  type: EntryType;
  updated_at: string;
  updated_by: string;
}

/** create/update 的输入：全部可选（update 按需传，语义=md 工具行级补丁）。 */
export interface EntryInput {
  account?: string;
  amount?: number;
  category?: string;
  counterparty?: string;
  date?: string;
  due_date?: string;
  followup_note?: string;
  invoice_no?: string;
  note?: string;
  paid_amount?: number;
  status?: EntryStatus;
  type?: EntryType;
}

// ----------------------------------------------------------- 批量导入（§0.6 输入通道）

/** 映射规则："这张表怎么解读"（与后端 ImportMapping 同构；台账页不传=固定模板）。 */
export interface ImportMapping {
  columns: Partial<Record<string, number | string>>;
  default_account?: string;
  default_status?: string;
  default_type?: string;
  delimiter?: string;
  has_header?: boolean;
  sign_decides_type?: boolean;
  status_map?: Record<string, string>;
  type_map?: Record<string, string>;
}

export interface ImportRowResult {
  duplicate_in_batch?: boolean;
  duplicate_of?: string;
  error?: string;
  input?: EntryInput;
  line: number;
  raw: string[];
}

export interface ImportPreview {
  delimiter: string;
  duplicates: number;
  has_header: boolean;
  header: string[];
  invalid: number;
  rows: ImportRowResult[];
  total: number;
  valid: number;
}

export async function importPreviewApi(
  text: string,
  mapping?: ImportMapping,
): Promise<ImportPreview> {
  return requestClient.post('/finance/imports/preview', { text, mapping });
}

export async function importCommitApi(
  rows: EntryInput[],
  opts?: { note?: string; skip_duplicates?: boolean },
): Promise<{ batch: string; created: EntryRecord[]; skipped: number }> {
  return requestClient.post('/finance/imports/commit', {
    note: opts?.note,
    rows,
    skip_duplicates: opts?.skip_duplicates,
  });
}

export async function importTemplateApi(): Promise<{
  csv: string;
  example: string[][];
  header: string[];
  mapping: ImportMapping;
}> {
  return requestClient.get('/finance/imports/template');
}

export interface EntryFilter {
  account?: string;
  counterparty?: string;
  due_before?: string;
  limit?: number;
  month?: string;
  /** 未结清=true：未取消、未收/付完、不在冲销对里——工作台应收/应付未收付深链用。 */
  outstanding?: boolean;
  status?: EntryStatus;
  type?: EntryType;
}

export async function listEntriesApi(
  filter: EntryFilter,
): Promise<{ count: number; records: EntryRecord[] }> {
  const params: Record<string, string> = {};
  if (filter.account) params.account = filter.account;
  if (filter.counterparty) params.counterparty = filter.counterparty;
  // 逾期口径在后端：due_date 已到且未结（排除已付/作废/冲销对），前端只做展示分桶
  if (filter.due_before) params.due_before = filter.due_before;
  if (filter.month) params.month = filter.month;
  if (filter.outstanding) params.outstanding = '1';
  if (filter.status) params.status = filter.status;
  if (filter.type) params.type = filter.type;
  params.limit = String(filter.limit ?? 100);
  return requestClient.get('/finance/entries', { params });
}

// ----------------------------------------------------------- 汇总（BI 看板数据源）

export interface SummaryRow {
  count: number;
  outstanding: number;
  paid: number;
  total: number;
  type: string;
}

export interface SummaryCategoryRow {
  category: string;
  count: number;
  total: number;
}

export interface FinanceSummary {
  byCategory: SummaryCategoryRow[];
  byType: SummaryRow[];
  count: number;
  month: string;
  payableOutstanding: number;
  receivableOutstanding: number;
}

export async function getSummaryApi(month?: string): Promise<FinanceSummary> {
  return requestClient.get('/finance/summary', {
    params: month ? { month } : {},
  });
}

export async function getEntryApi(id: string): Promise<EntryRecord> {
  return requestClient.get(`/finance/entries/${id}`);
}

export async function createEntryApi(input: EntryInput): Promise<EntryRecord> {
  return requestClient.post('/finance/entries', input);
}

export async function updateEntryApi(
  id: string,
  input: EntryInput,
): Promise<EntryRecord> {
  // requestClient 只封装了 get/post/put/delete；PATCH 走通用 request
  return requestClient.request(`/finance/entries/${id}`, {
    data: input,
    method: 'PATCH',
  });
}

/** 软删除（界面删除按钮；agent 作废走 update status=cancelled，两回事）。 */
export async function deleteEntryApi(
  id: string,
  reason: string,
): Promise<void> {
  await requestClient.delete(`/finance/entries/${id}`, { data: { reason } });
}

/** 冲销（出数后的唯一修正路径）：追加反向条目，原条目只补标记。 */
export async function reverseEntryApi(
  id: string,
  reason: string,
): Promise<EntryRecord> {
  return requestClient.post(`/finance/entries/${id}/reverse`, { reason });
}

// ----------------------------------------------------------- 账户（口袋维）

export const ACCOUNT_KIND_LABELS: Record<string, string> = {
  alipay: '支付宝',
  bank: '银行',
  cash: '现金',
  other: '其他',
  wechat: '微信',
};

export interface AccountRecord {
  archived: boolean;
  balance: number;
  created_at: string;
  created_by: string;
  id: number;
  kind: string;
  name: string;
  note: string;
  opening_balance: number;
}

export async function listAccountsApi(): Promise<{
  accounts: AccountRecord[];
  count: number;
}> {
  return requestClient.get('/finance/accounts');
}

export async function createAccountApi(input: {
  kind?: string;
  name: string;
  note?: string;
  opening_balance?: number;
}): Promise<AccountRecord> {
  return requestClient.post('/finance/accounts', input);
}

export async function updateAccountApi(
  id: number,
  input: {
    archived?: boolean;
    kind?: string;
    note?: string;
    opening_balance?: number;
  },
): Promise<AccountRecord> {
  // requestClient 只封装了 get/post/put/delete；PATCH 走通用 request
  return requestClient.request(`/finance/accounts/${id}`, {
    data: input,
    method: 'PATCH',
  });
}

// ----------------------------------------------------------- 出数（按月冻结）

export interface ReportedMonth {
  month: string;
  reported_at: string;
  reported_by: string;
}

export async function listPeriodsApi(): Promise<{ months: ReportedMonth[] }> {
  return requestClient.get('/finance/periods');
}

export async function markReportedApi(
  month: string,
): Promise<{ month: string }> {
  return requestClient.put(`/finance/periods/${month}/reported`);
}

export async function unmarkReportedApi(
  month: string,
): Promise<{ month: string }> {
  return requestClient.delete(`/finance/periods/${month}/reported`);
}

// ----------------------------------------------------------- 财务设置（建档参数）

export interface FinanceProfile {
  profile: Record<string, string>;
}

export async function getFinanceProfileApi(): Promise<FinanceProfile> {
  return requestClient.get('/finance/profile');
}

export async function setFinanceProfileApi(
  key: string,
  value: string,
): Promise<{ key: string; value: string }> {
  return requestClient.put('/finance/profile', { key, value });
}

// ----------------------------------------------------------- 确认卡片提案

export interface ImportPayload {
  note: string;
  rows: EntryInput[];
}

export type ProposalKind = 'import' | 'single';

export interface ProposalRecord {
  created_at: string;
  created_by: string;
  entry_id: string;
  id: string;
  /** single=单笔记账卡；import=批量导入卡（payload={rows,note}）。 */
  kind: ProposalKind;
  payload: EntryInput | ImportPayload;
  reason: string;
  resolved_at: string;
  resolved_by: string;
  status: 'confirmed' | 'pending' | 'rejected';
  summary: string;
}

export function isImportPayload(
  payload: EntryInput | ImportPayload,
): payload is ImportPayload {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    Array.isArray((payload as ImportPayload).rows)
  );
}

export async function listProposalsApi(
  status?: string,
): Promise<{ count: number; proposals: ProposalRecord[] }> {
  return requestClient.get('/finance/proposals', {
    params: status ? { status } : {},
  });
}

/** 批量导入提案（agent 通道落库的唯一入口，台账页不用它）。 */
export async function proposeImportApi(
  rows: EntryInput[],
  note?: string,
): Promise<ProposalRecord> {
  return requestClient.post('/finance/proposals/import', { note, rows });
}

export async function confirmProposalApi(id: string): Promise<{
  batch?: string;
  entries?: EntryRecord[];
  entry?: EntryRecord;
  proposal: ProposalRecord;
}> {
  return requestClient.post(`/finance/proposals/${id}/confirm`, {});
}

export async function rejectProposalApi(
  id: string,
  reason: string,
): Promise<ProposalRecord> {
  return requestClient.post(`/finance/proposals/${id}/reject`, { reason });
}

// ----------------------------------------------------------- 票夹（证据维）

export const INVOICE_KIND_LABELS: Record<string, string> = {
  internal: '内部凭证',
  purchase: '进项',
  sales: '销项',
};

export const INVOICE_STATUS_LABELS: Record<string, string> = {
  held: '在手',
  red: '已红冲',
  voided: '已作废',
};

export interface InvoiceRecord {
  amount: number;
  counterparty: string;
  created_by: string;
  date: string;
  entry_ids: string[];
  id: string;
  kind: string;
  note: string;
  number: string;
  /** 红冲执行日（status=red 时有值；义务维口径：红冲冲减执行当月）。老红票可能为空串。 */
  red_date: string;
  status: string;
  updated_at: string;
  updated_by: string;
}

export interface InvoiceInput {
  /** 仅建票时传；update 传了后端直接 400（票面金额不可改） */
  amount?: number;
  counterparty?: string;
  date?: string;
  kind?: string;
  note?: string;
  number?: string;
  status?: string;
}

export async function listInvoicesApi(filter: {
  counterparty?: string;
  kind?: string;
  limit?: number;
  month?: string;
  /** 票号精确过滤（台账抽屉"去票夹"深链用）。 */
  number?: string;
  status?: string;
}): Promise<{ count: number; total: number; invoices: InvoiceRecord[] }> {
  const params: Record<string, string> = {};
  if (filter.counterparty) params.counterparty = filter.counterparty;
  if (filter.kind) params.kind = filter.kind;
  if (filter.month) params.month = filter.month;
  if (filter.number) params.number = filter.number;
  if (filter.status) params.status = filter.status;
  params.limit = String(filter.limit ?? 100);
  return requestClient.get('/finance/invoices', { params });
}

export async function createInvoiceApi(
  input: InvoiceInput,
): Promise<InvoiceRecord> {
  return requestClient.post('/finance/invoices', input);
}

export async function updateInvoiceApi(
  id: string,
  input: InvoiceInput,
): Promise<InvoiceRecord> {
  // requestClient 只封装了 get/post/put/delete；PATCH 走通用 request
  return requestClient.request(`/finance/invoices/${id}`, {
    data: input,
    method: 'PATCH',
  });
}

/** 挂联账目（幂等）：一张票可挂多笔账，一笔账也可收多张票。 */
export async function linkInvoiceApi(
  id: string,
  entryId: string,
): Promise<InvoiceRecord> {
  return requestClient.post(`/finance/invoices/${id}/links`, {
    entry_id: entryId,
  });
}

export async function unlinkInvoiceApi(
  id: string,
  entryId: string,
): Promise<InvoiceRecord> {
  return requestClient.delete(`/finance/invoices/${id}/links/${entryId}`);
}

/** 缺票清单：expense/reimburse 既没挂"在手"的票也没填票号的账目（工资/税费不是发票，不纳入；废票不算证据）。
 *  entries 受 limit 截断，total 是真实条数。 */
export async function listMissingInvoicesApi(filter: {
  limit?: number;
  month?: string;
}): Promise<{
  count: number;
  entries: {
    amount: number;
    category: string;
    counterparty: string;
    date: string;
    id: string;
    note: string;
    paid_amount: number;
    type: string;
  }[];
  total: number;
}> {
  const params: Record<string, string> = {};
  if (filter.month) params.month = filter.month;
  params.limit = String(filter.limit ?? 100);
  return requestClient.get('/finance/invoices/missing', { params });
}

/** 销项计税汇总（义务维，A5 残余 2026-11-01）：开票按票期、红冲按执行日冲减执行当月；
 *  legacy_red 标记该月含"没记执行日的老红票按票期估算"；备料非核算，申报以电子税务局为准。 */
export interface InvoiceOutputSummary {
  note: string;
  rows: {
    issued: number;
    legacy_red: boolean;
    month: string;
    net: number;
    red: number;
  }[];
  total: { issued: number; red: number; net: number };
  year: string;
}

export async function invoiceOutputSummaryApi(
  year?: string,
): Promise<InvoiceOutputSummary> {
  const params: Record<string, string> = {};
  if (year) params.year = year;
  return requestClient.get('/finance/invoices/output-summary', { params });
}

/** 数电票额度跟踪（A5 残余最小形态）：额度在电子税务局侧，这里只做手工抄入的参考跟踪；
 *  month_sales=票夹当月销项（按票期自动算），供核对抄入的"已用"没抄歪。 */
export interface InvoiceQuota {
  as_of: string;
  configured: boolean;
  month_sales: number;
  note: string;
  quota_total: number;
  quota_used: number;
  remaining: number;
  updated_at: string;
  warn: boolean;
}

export async function getInvoiceQuotaApi(): Promise<InvoiceQuota> {
  return requestClient.get('/finance/invoices/quota');
}

export async function setInvoiceQuotaApi(input: {
  as_of?: string;
  quota_total: number;
  quota_used: number;
}): Promise<InvoiceQuota> {
  return requestClient.put('/finance/invoices/quota', input);
}

// ----------------------------------------------------------- 银行对账（口袋维）

export interface ReconciliationFlow {
  amount: number;
  counterparty: string;
  date: string;
  direction: 'in' | 'out';
  id: string;
  moved: number;
  note: string;
  reverses: string;
  type: string;
}

export interface ReconciliationReport {
  account: string;
  account_archived: boolean;
  as_of: string;
  /** 截止 as_of（含）账面余额=期初+Σ已收付 */
  book_balance: number;
  /** 今天的账面余额（全时段） */
  book_balance_current: number;
  statement_balance: number;
  /** 账面 − 对账单：0=对上了；正=账面比银行多；负=账面比银行少 */
  difference: number;
  flows_after: ReconciliationFlow[];
  net_after: number;
  hint: string;
}

/** 对账报告即时算不落库：对账单余额由人从网银抄过来。 */
export async function reconcilePreviewApi(input: {
  account: string;
  as_of?: string;
  statement_balance: number | string;
}): Promise<ReconciliationReport> {
  return requestClient.post('/finance/reconciliation/preview', input);
}

// ----------------------------------------------------------- 附件归档（B3 证据维）

export interface AttachmentRecord {
  created_at: string;
  created_by: string;
  entry_id: string;
  ext: string;
  file_name: string;
  id: number;
  mime: string;
  note: string;
  sha256: string;
  size: number;
}

export async function listAttachmentsApi(
  entryId: string,
): Promise<{ attachments: AttachmentRecord[]; count: number }> {
  return requestClient.get(`/finance/entries/${entryId}/attachments`);
}

/** 上传走 JSON base64（后端无 multipart 依赖）；8MB 上限后端拦。 */
export async function addAttachmentApi(
  entryId: string,
  input: { data_base64: string; file_name: string; note?: string },
): Promise<AttachmentRecord> {
  return requestClient.post(`/finance/entries/${entryId}/attachments`, input);
}

/** 软删除：只摘引用不删文件（证据不物理消灭）。 */
export async function deleteAttachmentApi(
  id: number,
  reason: string,
): Promise<void> {
  await requestClient.delete(`/finance/attachments/${id}`, {
    data: { reason },
  });
}

/** 下载（带登录态）：拿 Blob 后由调用方触发浏览器保存。 */
export async function downloadAttachmentApi(id: number): Promise<Blob> {
  return requestClient.get(`/finance/attachments/${id}/download`, {
    responseType: 'blob',
  });
}

/** 文件 → base64（不含 data: 前缀），上传弹窗用。 */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.onload = () => {
      const result = String(reader.result ?? '');
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}

// ----------------------------------------------------------- 票-账猜挂（A5/A6，只读建议）

export interface InvoiceMatchSuggestion {
  amount: number;
  counterparty: string;
  date: string;
  entry_id: string;
  number: string;
  reason: string;
  score: number;
  status: string;
  type: string;
}

export interface EntryMatchSuggestion {
  amount: number;
  counterparty: string;
  date: string;
  invoice_id: string;
  kind: string;
  number: string;
  reason: string;
  score: number;
  status: string;
}

/** 给一笔账猜该收的票（挂联写操作仍走 linkInvoiceApi）。 */
export async function listEntryMatchesApi(
  entryId: string,
): Promise<{ entry_id: string; suggestions: EntryMatchSuggestion[] }> {
  return requestClient.get(`/finance/entries/${entryId}/matches`);
}

/** 给一张票猜该挂的账。 */
export async function listInvoiceMatchesApi(
  invoiceId: string,
): Promise<{ invoice_id: string; suggestions: InvoiceMatchSuggestion[] }> {
  return requestClient.get(`/finance/invoices/${invoiceId}/matches`);
}

// ----------------------------------------------------------- 银行流水逐笔比对（B1 口袋维）

export interface BankLineRecord {
  account: string;
  amount: number;
  batch: string;
  counterparty: string;
  created_at: string;
  created_by: string;
  date: string;
  direction: 'in' | 'out';
  id: number;
  matched_entry_id: string;
  note: string;
  ref: string;
}

export interface BankReport {
  account: string;
  bank_only: BankLineRecord[];
  book_only: {
    counterparty: string;
    date: string;
    direction: 'in' | 'out';
    entry_id: string;
    moved: number;
    note: string;
    reverses: string;
    type: string;
  }[];
  from: string;
  hint: string;
  matched: {
    entry_date: string;
    entry_id: string;
    how: 'auto' | 'manual';
    line: BankLineRecord;
  }[];
  to: string;
  totals: {
    auto: number;
    bank_in: number;
    bank_out: number;
    book_in: number;
    book_out: number;
    manual: number;
    matched: number;
  };
}

export async function bankTemplateApi(): Promise<{
  csv: string;
  example: string[][];
  header: string[];
}> {
  return requestClient.get('/finance/bank-lines/template');
}

/** 幂等导入：同账户同指纹的行跳过（重复导入同一份对账单不翻倍）。 */
export async function importBankLinesApi(
  account: string,
  text: string,
): Promise<{
  account: string;
  batch: string;
  inserted: number;
  skipped: number;
  total: number;
}> {
  return requestClient.post('/finance/bank-lines/import', { account, text });
}

export async function listBankLinesApi(filter: {
  account?: string;
  limit?: number;
  matched?: 'no' | 'yes';
  month?: string;
}): Promise<{ count: number; lines: BankLineRecord[] }> {
  const params: Record<string, string> = {};
  if (filter.account) params.account = filter.account;
  if (filter.matched) params.matched = filter.matched;
  if (filter.month) params.month = filter.month;
  params.limit = String(filter.limit ?? 200);
  return requestClient.get('/finance/bank-lines', { params });
}

export async function bankReportApi(input: {
  account: string;
  from?: string;
  to?: string;
}): Promise<BankReport> {
  const params: Record<string, string> = { account: input.account };
  if (input.from) params.from = input.from;
  if (input.to) params.to = input.to;
  return requestClient.get('/finance/bank-lines/report', { params });
}

/** 人工确认配对（空串=解除）；金额不等也允许，差异在报告里可见。 */
export async function setBankLineMatchApi(
  id: number,
  matchedEntryId: string,
): Promise<BankLineRecord> {
  return requestClient.request(`/finance/bank-lines/${id}`, {
    data: { matched_entry_id: matchedEntryId },
    method: 'PATCH',
  });
}

export async function deleteBankLineApi(id: number): Promise<void> {
  await requestClient.delete(`/finance/bank-lines/${id}`);
}

// ----------------------------------------------------------- 现金盘点（B2 口袋维）

export interface CashCountRecord {
  account: string;
  as_of: string;
  book: number;
  counted: number;
  created_at: string;
  created_by: string;
  diff: number;
  id: number;
  note: string;
}

/** 记一次盘点：只记录差异不调平——调账走正常记账/冲销。 */
export async function createCashCountApi(input: {
  account: string;
  as_of?: string;
  counted: number | string;
  note?: string;
}): Promise<CashCountRecord> {
  return requestClient.post('/finance/cash-counts', input);
}

export async function listCashCountsApi(filter?: {
  account?: string;
  limit?: number;
}): Promise<{ count: number; records: CashCountRecord[] }> {
  const params: Record<string, string> = {};
  if (filter?.account) params.account = filter.account;
  if (filter?.limit) params.limit = String(filter.limit);
  return requestClient.get('/finance/cash-counts', { params });
}

// ----------------------------------------------------------- 报表与打包（C4/A8/F5/E5，全部只读）

export interface EvidenceChecklist {
  bank_matched: number;
  count: number;
  entries: {
    amount: number;
    category: string;
    counterparty: string;
    date: string;
    evidence: {
      attachments: number;
      bank_matches: number;
      invoice_no: string;
      linked_held_invoices: number;
    };
    id: string;
    missing: string[];
    type: string;
    voucher_ok: boolean;
  }[];
  hint: string;
  missing_voucher: number;
  month: string;
  with_voucher: number;
}

export async function evidenceChecklistApi(
  month?: string,
): Promise<EvidenceChecklist> {
  return requestClient.get('/finance/reports/evidence-checklist', {
    params: month ? { month } : {},
  });
}

export interface CounterpartyStatement {
  closing: { payable: number; receivable: number };
  counterparty: string;
  from: string;
  hint: string;
  lines: {
    amount: number;
    category: string;
    counterparty: string;
    date: string;
    id: string;
    note: string;
    paid: number;
    status: string;
    type: string;
  }[];
  opening: { payable: number; receivable: number };
  to: string;
  totals: {
    income: number;
    outflow: number;
    paid_out: number;
    received: number;
  };
}

export async function counterpartyStatementApi(input: {
  counterparty: string;
  from?: string;
  to?: string;
}): Promise<CounterpartyStatement> {
  const params: Record<string, string> = { counterparty: input.counterparty };
  if (input.from) params.from = input.from;
  if (input.to) params.to = input.to;
  return requestClient.get('/finance/reports/counterparty-statement', {
    params,
  });
}

export async function inspectionPackApi(input: {
  from?: string;
  to?: string;
}): Promise<{
  entry_count: number;
  from: string;
  invoice_count: number;
  markdown: string;
  to: string;
  truncated: boolean;
}> {
  const params: Record<string, string> = {};
  if (input.from) params.from = input.from;
  if (input.to) params.to = input.to;
  return requestClient.get('/finance/reports/inspection-pack', { params });
}

export interface AnnualArchive {
  data: Record<string, unknown>;
  generated_at: string;
  kind: string;
  manifest: {
    bundle_sha256: string;
    sections: Record<string, { count: number; sha256: string }>;
  };
  notes: string[];
  year: string;
}

export async function annualArchiveApi(year: string): Promise<AnnualArchive> {
  return requestClient.get(`/finance/reports/archive/${year}`);
}

// ---------- 审批落账规则（2026-11-01 融合方案 §5 P2；admin:manage） ----------

/** 哪张飞书审批定义批了、记哪类账。code=飞书管理后台该定义的 approval_code；field_map 不配走启发式。 */
export interface PostingRule {
  account: string;
  category: string;
  code: string;
  enabled: boolean;
  field_map: { amount?: string; reason?: string };
  name: string;
  type: string;
}

/** 预览解析结果：按当前规则解析某张实例会得到什么（不建提案不落账）。 */
export interface PostingPreview {
  amount: null | number;
  amount_source: string;
  counterparty: string;
  date: string;
  instance_code: string;
  note: string;
  reason: string;
  rule: Pick<PostingRule, 'account' | 'category' | 'code' | 'name' | 'type'>;
  serial_number: string;
}

export async function listPostingRulesApi(): Promise<{ rules: PostingRule[] }> {
  return requestClient.get('/finance/posting-rules');
}

/** 整表覆盖保存；保存即订阅各定义的审批事件，响应带订阅数与健康度（订阅失败不挡保存，补抓兜底）。 */
export async function savePostingRulesApi(rules: PostingRule[]): Promise<{
  rules: PostingRule[];
  subscribed: number;
  subscription_healthy: boolean;
}> {
  return requestClient.put('/finance/posting-rules', { rules });
}

export async function previewPostingApi(
  instanceCode: string,
): Promise<PostingPreview> {
  return requestClient.get('/finance/posting-rules/preview', {
    params: { instance_code: instanceCode },
  });
}

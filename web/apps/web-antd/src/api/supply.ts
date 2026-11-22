/**
 * 生产供应链前端 API（2026-11-01 生产任务全图 v0）：/api/supply 薄封装。
 * 读=supply:read，写=supply:write；导入预览不落库、提交事务原子（错误行整批拒绝）。
 * 本域没有金额字段——"值多少钱"在财务域。
 */
import { requestClient } from './request';

export interface StockReading {
  warehouse: string;
  /** 批次号；''=总量行（没按批次报）。 */
  batchNo: string;
  /** 效期 YYYY-MM-DD；''=未报（效期跟着批次走）。 */
  expiryDate: string;
  quantity: number;
  snapshotDate: string;
}

export interface SupplyItem {
  id: number;
  code: string;
  name: string;
  unit: string;
  category: string;
  /** 人话数量；null=未设安全线（不参与安全线预警）。 */
  safetyStock: null | number;
  note: string;
  archived: boolean;
  aliases: string[];
  stock: StockReading[];
  totalQuantity: number;
  belowSafety: boolean;
}

export interface SupplySummary {
  items: number;
  archived: number;
  belowSafety: number;
  openPos: number;
  overduePos: number;
  /** 临期批次数（含已过期；临期窗口=域设置 supply.settings，缺省 90 天）。 */
  expiringBatches: number;
  /** 其中已过期批次数。 */
  expiredBatches: number;
  lastSnapshotDate: string;
}

/** 安线名单按物料合计比（2026-11-01 用户拍板）：quantity=各仓最新读数合计，warehouses=分仓明细。 */
export interface BelowSafetyItem {
  itemId: number;
  code: string;
  name: string;
  unit: string;
  /** 如「主仓 5、备用仓 10」。 */
  warehouses: string;
  quantity: number;
  safetyStock: number;
  snapshotDate: string;
}

export interface ExpiringItem {
  itemId: number;
  code: string;
  name: string;
  unit: string;
  warehouse: string;
  batchNo: string;
  expiryDate: string;
  quantity: number;
  /** <0=已过期。 */
  daysLeft: number;
}

export interface ExpiringInfo {
  today: string;
  warnDays: number;
  items: ExpiringItem[];
}

export interface MonthlyReportMover {
  code: string;
  name: string;
  unit: string;
  /** null=该时点还没数（月初没盘过）。 */
  startQuantity: null | number;
  endQuantity: null | number;
  change: number;
}

/** 生产/供应链月报（R1，数量口径）：库存变动/采购/批次/预警四块 + notes 口径说明。 */
export interface SupplyMonthlyReport {
  month: string;
  /** 月末与今天取早者：当月=截至今天。 */
  asOf: string;
  /** 当月没过完=true。 */
  partial: boolean;
  stock: {
    activeItems: number;
    reportedItems: number;
    belowSafety: number;
    movers: MonthlyReportMover[];
    moversTotal: number;
  };
  purchase: {
    orderedPos: number;
    orderedLines: number;
    orderedQty: number;
    receivedLines: number;
    receivedQty: number;
    cancelledLines: number;
    openNow: number;
    overdueAsOf: number;
  };
  batches: {
    expiring: number;
    expired: number;
    /** rows 只列前 20；超出按 rowsTotal 如实说"共 N 条"。 */
    rowsTotal: number;
    rows: {
      batchNo: string;
      code: string;
      daysLeft: number;
      expiryDate: string;
      name: string;
      quantity: number;
      unit: string;
      warehouse: string;
    }[];
  };
  alerts: {
    raised: number;
    raisedBySource: Record<string, number>;
    closed: number;
    openNow: number;
  };
  notes: string[];
}

export interface PoRow {
  id: number;
  po_no: string;
  item_id: number;
  supplier: string;
  qty_milli: number;
  ordered_date: string;
  promised_date: string;
  status: 'cancelled' | 'open' | 'received';
  received_date: string;
  note: string;
  code: string;
  name: string;
  unit: string;
}

export type SupplyImportKind = 'inventory' | 'items' | 'pos';

export interface ImportRowResult {
  line: number;
  raw: string[];
  error?: string;
  duplicate_in_batch?: boolean;
}

export interface ImportPreviewInfo {
  kind: SupplyImportKind;
  kindLabel: string;
  delimiter: string;
  header: string[];
  /** 剥除的金额类列（不碰钱守门的可见证据）。 */
  strippedMoneyColumns: string[];
  /** 非阻断提示（库存类）：首次出现的仓库名 / 总量行顶掉批次行——不拦，只把后果说在前面。 */
  hints: string[];
  total: number;
  valid: number;
  invalid: number;
  rows: ImportRowResult[];
}

export interface ImportCommitInfo {
  batch: string;
  kind: SupplyImportKind;
  created: number;
  updated: number;
  skipped: number;
  itemsCreated: string[];
  /** 落到已归档物料名下的编码（默认列表看不见，勾"含归档"才见）。 */
  archivedTargets: string[];
  /** 库里已收货/已取消、被文件里的状态倒翻未遂的采购单号（状态与到货日按库里的算）。 */
  protectedClosed: string[];
  strippedMoneyColumns: string[];
  hints: string[];
}

export function supplySummaryApi(): Promise<SupplySummary> {
  return requestClient.get<SupplySummary>('/supply/summary');
}

export function listItemsApi(
  params: { archived?: boolean; query?: string } = {},
): Promise<{ items: SupplyItem[] }> {
  return requestClient.get('/supply/items', {
    params: {
      archived: params.archived ? 1 : undefined,
      query: params.query || undefined,
    },
  });
}

export function belowSafetyApi(): Promise<{ items: BelowSafetyItem[] }> {
  return requestClient.get('/supply/below-safety');
}

export function expiringApi(): Promise<ExpiringInfo> {
  return requestClient.get('/supply/expiring');
}

/** month 缺省=当月；格式 YYYY-MM。 */
export function monthlyReportApi(month?: string): Promise<SupplyMonthlyReport> {
  return requestClient.get('/supply/report/monthly', {
    params: { month: month || undefined },
  });
}

/** 通道 B：飞书多维表格只读同步。读登记册=supply:read，改登记册=admin:manage，同步=supply:write。 */
export interface BitableRegistry {
  appToken: string;
  tables: { inventory: string; items: string; pos: string };
  updatedAt: string;
  updatedBy: string;
  lastSync: Partial<
    Record<
      SupplyImportKind,
      {
        at: string;
        by: string;
        batch: string;
        created: number;
        skipped: number;
        updated: number;
      }
    >
  >;
}

export interface BitableSyncResult {
  kind: SupplyImportKind;
  kindLabel: string;
  dryRun: boolean;
  fetched: number;
  batch?: string;
  created?: number;
  updated?: number;
  skipped?: number;
  itemsCreated?: string[];
  archivedTargets?: string[];
  protectedClosed?: string[];
  unchanged?: boolean;
  valid?: number;
  invalid?: number;
  errors?: { error: string; line: number }[];
  /** 导入层的非阻断提示（试跑与真同步都带）。 */
  hints?: string[];
  error?: string;
}

export function bitableRegistryApi(): Promise<{
  registry: BitableRegistry | null;
}> {
  return requestClient.get('/supply/bitable');
}

export function setBitableRegistryApi(body: {
  appToken: string;
  tables: { inventory: string; items: string; pos: string };
}): Promise<{
  registry: BitableRegistry;
}> {
  return requestClient.put('/supply/bitable', body);
}

export function bitableSyncApi(body: {
  dryRun?: boolean;
  kinds?: SupplyImportKind[];
}): Promise<{ results: BitableSyncResult[] }> {
  return requestClient.post('/supply/bitable/sync', body);
}

/** 域设置（企业建档参数）：临期窗口天数——名单/扫描器/晨报/月报同一个数。读=supply:read，改=admin:manage。 */
export interface SupplySettings {
  expiryWarnDays: number;
  /** 没设过=null（用缺省 90）。 */
  updatedAt: null | string;
  updatedBy: string;
}

export function supplySettingsApi(): Promise<{
  range: { expiryWarnDays: [number, number] };
  settings: SupplySettings;
}> {
  return requestClient.get('/supply/settings');
}

export function setSupplySettingsApi(body: {
  expiryWarnDays: number;
}): Promise<{ settings: SupplySettings }> {
  return requestClient.put('/supply/settings', body);
}

export interface ItemInput {
  category?: string;
  code?: string;
  name?: string;
  note?: string;
  safetyStock?: null | number;
  unit?: string;
}

export function createItemApi(body: ItemInput): Promise<{ item: SupplyItem }> {
  return requestClient.post('/supply/items', body);
}

export function updateItemApi(
  id: number,
  body: Partial<ItemInput>,
): Promise<{ item: SupplyItem }> {
  return requestClient.request(`/supply/items/${id}`, {
    data: body,
    method: 'PATCH',
  });
}

export function archiveItemApi(id: number): Promise<{ archived: boolean }> {
  return requestClient.post(`/supply/items/${id}/archive`, {});
}

export function unarchiveItemApi(id: number): Promise<{ archived: boolean }> {
  return requestClient.post(`/supply/items/${id}/unarchive`, {});
}

export function setAliasesApi(
  id: number,
  aliases: string[],
): Promise<{ aliases: string[] }> {
  return requestClient.put(`/supply/items/${id}/aliases`, { aliases });
}

/** 列表有页长（limit）：total 是同一筛选的真实总数，pos.length < total 时要向人说明"只列了前 N 张"。 */
export function listPosApi(
  params: {
    itemId?: number;
    overdue?: boolean;
    status?: 'all' | PoRow['status'];
  } = {},
): Promise<{ limit: number; pos: PoRow[]; total: number }> {
  return requestClient.get('/supply/pos', {
    params: {
      overdue: params.overdue ? 1 : undefined,
      status:
        params.status && params.status !== 'all' ? params.status : undefined,
    },
  });
}

export interface PoUpdateInput {
  note?: string;
  receivedDate?: string;
  status?: PoRow['status'];
}

export function updatePoApi(
  id: number,
  body: PoUpdateInput,
): Promise<{ po: PoRow }> {
  return requestClient.request(`/supply/pos/${id}`, {
    data: body,
    method: 'PATCH',
  });
}

export function importPreviewApi(
  kind: SupplyImportKind,
  text: string,
): Promise<ImportPreviewInfo> {
  return requestClient.post('/supply/imports/preview', { kind, text });
}

export function importCommitApi(
  kind: SupplyImportKind,
  text: string,
  note = '',
): Promise<ImportCommitInfo> {
  return requestClient.post('/supply/imports/commit', { kind, note, text });
}

export function importTemplateApi(kind: SupplyImportKind): Promise<{
  csv: string;
  example: string[][];
  header: string[];
  kind: string;
  kindLabel: string;
}> {
  return requestClient.get('/supply/imports/template', { params: { kind } });
}

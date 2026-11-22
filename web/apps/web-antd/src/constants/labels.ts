import type { EntryStatus } from '#/api/finance';
import type { PoRow } from '#/api/supply';

/**
 * 界面侧状态/颜色字典（2026-11-02 界面术语与文案规范 §二）：各页面只许 import，不许再各自声明。
 * 字段级中文标签的权威在 api/finance.ts（TYPE_LABELS / STATUS_LABELS / INVOICE_*_LABELS），与接口类型放在一起。
 */

/** 账目状态 → 标签颜色。 */
export const ENTRY_STATUS_COLORS: Record<EntryStatus, string> = {
  cancelled: 'default',
  issued: 'blue',
  paid: 'green',
  partial: 'orange',
  pending: 'purple',
  received: 'cyan',
  unpaid: 'default',
};

/** 发票状态 → 标签颜色（held 在手 / red 红冲 / voided 作废）。 */
export const INVOICE_STATUS_COLORS: Record<string, string> = {
  held: 'green',
  red: 'red',
  voided: 'default',
};

/** 采购单状态 → 中文。 */
export const PO_STATUS_LABELS: Record<PoRow['status'], string> = {
  open: '未到货',
  received: '已到货',
  cancelled: '已取消',
};

/** 待办来源（自动检查项）→ 中文名。行内标签与停用/恢复检查的提示共用一份，名词必须一致。 */
export const TODO_SOURCE_LABELS: Record<string, string> = {
  'scan.filing': '合规日历',
  'scan.receivable': '应收到期',
  'scan.payable': '应付到期',
  'scan.proposal_pending': '待确认记账',
  'scan.zero_role_account': '账号治理',
  'scan.missing_invoice': '缺票清单',
  'scan.supply.below_safety': '库存安全线',
  'scan.supply.po_overdue': '到货逾期',
  'scan.supply.expiry_near': '效期临近',
  'scan.payroll.roster': '员工名册比对',
  'scan.payroll.social': '社保增减员',
  'scan.finance.profile': '财务建档参数',
  manual: '手工待办',
};

/** 待办紧急度 → 颜色。 */
export const TODO_SEVERITY_COLOR: Record<string, string> = {
  critical: 'red',
  warn: 'orange',
  info: 'blue',
};

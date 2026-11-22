/** 领域常量与类型：取值集与 dsh-finance-tools.mjs 逐字一致（REST 化要求行为一致）。
 *  行为对齐的已知偏差清单见模块 README，不在此逐条复制。 */

export const TYPE_VALUES = ['income', 'expense', 'reimburse', 'invoice', 'payroll', 'tax'] as const
export type EntryType = (typeof TYPE_VALUES)[number]

export const STATUS_VALUES = ['unpaid', 'paid', 'partial', 'pending', 'issued', 'received', 'cancelled'] as const
export type EntryStatus = (typeof STATUS_VALUES)[number]

/** 现金流出类（分类明细与应付余额只统计这些）。 */
export const OUT_TYPES: readonly EntryType[] = ['expense', 'reimburse', 'payroll', 'tax']

/** 各类型 create 时的默认状态。 */
export const DEFAULT_STATUS: Record<EntryType, EntryStatus> = {
  income: 'unpaid',
  expense: 'unpaid',
  reimburse: 'pending',
  invoice: 'issued',
  payroll: 'unpaid',
  tax: 'unpaid',
}

export const PROFILE_TEMPLATE_KEYS = [
  '主体类型',
  '纳税人身份',
  '征收方式',
  '开票信息',
  '代账联系人',
  '对公账户',
  '常用收款账户',
  '员工人数',
  '社保基数上下限',
  '社保比例',
  '公积金比例',
  '常用分类',
  '更新日期',
] as const

export const ID_PATTERN = /^FIN-\d{8}-\d{3}$/
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/
/** 建档参数名规则（与工具一致：中文/字母/数字/下划线/连字符，≤20 字）。 */
export const PROFILE_KEY_PATTERN = /^[A-Za-z0-9_\u4e00-\u9fa5-]{1,20}$/

/** 写操作来源：界面 / agent 工具 / 确认卡片 / 平台桥（2026-10-28 融合层；桥入卡片确认落库时仍强制 confirm）。 */
export type ActorSource = 'ui' | 'agent' | 'confirm' | 'bridge'

export interface Actor {
  username: string
  source: ActorSource
}

/** 账户类型（口袋的现实形态；只影响展示分组）。 */
export const ACCOUNT_KIND_VALUES = ['bank', 'wechat', 'alipay', 'cash', 'other'] as const
export type AccountKind = (typeof ACCOUNT_KIND_VALUES)[number]

/** 票的方向：销项（开出去）/ 进项（收进来）/ 内部凭证。 */
export const INVOICE_KIND_VALUES = ['sales', 'purchase', 'internal'] as const
export type InvoiceKind = (typeof INVOICE_KIND_VALUES)[number]

/** 票状态：held=在手有效 / voided=已作废 / red=已红冲。 */
export const INVOICE_STATUS_VALUES = ['held', 'voided', 'red'] as const
export type InvoiceStatus = (typeof INVOICE_STATUS_VALUES)[number]

/** 提案状态：待确认 / 已确认入账 / 已拒绝。 */
export const PROPOSAL_STATUS_VALUES = ['pending', 'confirmed', 'rejected'] as const
export type ProposalStatus = (typeof PROPOSAL_STATUS_VALUES)[number]

/** create/update 可填字段（金额单位=元，正数；与工具参数同名）。 */
export interface EntryInput {
  type?: string
  amount?: number | string
  date?: string
  status?: string
  counterparty?: string
  category?: string
  account?: string
  invoice_no?: string
  due_date?: string
  paid_amount?: number | string
  note?: string
  followup_note?: string
}

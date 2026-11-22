/** 生产供应链域共享类型（2026-11-01 生产任务全图 v0）：物料 / 库存快照 / 采购单行。
 *  只放类型与取值集与数量换算，不碰库不碰平台。结构级守门：这里没有任何金额类型——
 *  "值多少钱"属于财务域，本域只有数量（毫单位 INTEGER，边界层换算）与日期。 */
import { BadRequestError } from '../errors.js'

/** 数量精度：1 单位 = 1000 毫单位（与账本"分"同一思路，小数不漂）。 */
export const QTY_SCALE = 1000

/** 数量上限（单位）：毫单位 1e15 仍在 2^53 安全整数内且 SQLite INTEGER 放得下；超出按 400 拒绝不 500。 */
export const QTY_MAX = 1e12

/** 用户输入数量（数字，≤3 位小数）→ 毫单位。越界精度拒绝不四舍五入（报数要跟实物对得上）。 */
export function qtyToMilli(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new BadRequestError(`数量 "${String(value)}" 不是数字。`)
  if (Math.abs(value) > QTY_MAX) throw new BadRequestError(`数量 "${value}" 超出可接受范围（最多 ${QTY_MAX} 单位）。`)
  // 小数位用最短往返字符串判：浮点乘 1000 再比差在大数上会误判（1e9 量级的舍入误差已超 1e-6）
  if (!/^-?\d+(\.\d{1,3})?$/.test(String(value))) {
    throw new BadRequestError(`数量 "${value}" 超过 3 位小数，改精确些再报。`)
  }
  return Math.round(value * QTY_SCALE)
}

/** 毫单位 → 展示数量（去掉多余的 0：12500 → 12.5，12000 → 12）。 */
export function milliToQty(milli: number): number {
  return Math.round(milli) / QTY_SCALE
}

/** 毫单位 → 人话数量串（展示与候选标题共用；Number→String 本就去尾零）。 */
export function fmtQty(milli: number): string {
  return String(milliToQty(milli))
}

/** 批次临期预警窗口缺省值（天）：效期落在今天+N 天内的批次进场（已过期另算 critical）。
 *  阈值是企业建档参数不是代码常量（全图 §0.4-5）：真值存 app_meta `supply.settings`，
 *  GET/PUT /api/supply/settings 读改，这里只是没设过时的缺省。2026-11-02 从 30 改 90：
 *  宠物食品效期以月计，临期货要走促销/退换/调仓，一个月周转不够；企业按自家经验在设置里改。
 *  按物料分窗口是下一步（物料表加字段），现在全域一个数。 */
export const DEFAULT_EXPIRY_WARN_DAYS = 90
export const SUPPLY_SETTINGS_KEY = 'supply.settings'
/** 临期窗口可设范围（天）。 */
export const EXPIRY_WARN_DAYS_MIN = 1
export const EXPIRY_WARN_DAYS_MAX = 365

export const PO_STATUS_VALUES = ['open', 'received', 'cancelled'] as const
export type PoStatus = (typeof PO_STATUS_VALUES)[number]

export const PO_STATUS_LABELS: Record<PoStatus, string> = {
  open: '未到货',
  received: '已到货',
  cancelled: '已取消',
}

/** 非标文件金额列守门：导入解析时这些列头一律剥除（不进库），并在预览里披露剥了哪些。
 *  只对模板外的多余列生效（模板列按全名匹配，"数量"不会被误剥）；宁可多剥多披露——
 *  结构上任何多余列都进不了库，这个正则只决定"披露名单"的完整度。 */
export const MONEY_COLUMN_RE = /(金额|单价|价格|总价|总额|合计|含税|不含税|税额|货款|折后|折扣|amount|price|cost)/i

export interface SupplyItemRow {
  id: number
  code: string
  name: string
  unit: string
  category: string
  safety_milli: number | null
  note: string
  archived_at: string | null
  created_at: string
  created_by: string
  updated_at: string
  updated_by: string
}

export interface SupplySnapshotRow {
  id: number
  item_id: number
  warehouse: string
  /** 批次号；''=该行是仓库总量报数（不分批）。 */
  batch_no: string
  /** 效期 YYYY-MM-DD；''=无效期（跟批次走：有效期必有批次）。 */
  expiry_date: string
  qty_milli: number
  snapshot_date: string
  source: string
  fp: string
  created_at: string
  created_by: string
}

export interface SupplyPoRow {
  id: number
  po_no: string
  item_id: number
  supplier: string
  qty_milli: number
  ordered_date: string
  promised_date: string
  status: PoStatus
  received_date: string
  note: string
  fp: string
  created_at: string
  created_by: string
  updated_at: string | null
}

/** 物料行视图（列表/详情共用）：带最新库存合计与安全线判定。 */
export interface ItemView {
  id: number
  code: string
  name: string
  unit: string
  category: string
  /** 人话数量；null=未设安全线。 */
  safetyStock: number | null
  note: string
  archived: boolean
  aliases: string[]
  /** 各仓库最新一次报数的行（按批次分行；batchNo=''=总量行；同仓同日既有批次行又有总量行时只给批次行）。 */
  stock: { warehouse: string; batchNo: string; expiryDate: string; quantity: number; snapshotDate: string }[]
  /** 全仓合计（最新读数之和，跨仓跨批次）。 */
  totalQuantity: number
  /** 全仓合计低于安全线（2026-11-01 用户拍板"按物料合计比"；未设安全线恒 false）。 */
  belowSafety: boolean
}

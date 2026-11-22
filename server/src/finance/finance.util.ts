/** 数值/日期/校验工具：语义与 dsh-finance-tools.mjs 一致（金额边界=元，库内=分）。 */
import { BadRequestError } from '../errors.js'
import { DATE_PATTERN, MONTH_PATTERN } from './finance.types.js'

/** 元 → 分（INTEGER）。两位小数安全，避免浮点累加误差。 */
export function yuanToCents(value: number): number {
  return Math.round(value * 100)
}

export function centsToYuan(cents: number): number {
  return cents / 100
}

/** 解析金额：去逗号/人民币符号/空格，必须为正数（allowZero=true 时允许 0），保留两位小数。 */
export function parseAmount(value: number | string | undefined, label: string, allowZero = false): number {
  const cleaned = String(value ?? '').replace(/[,¥\s]/g, '')
  const n = Number(cleaned)
  if (!Number.isFinite(n) || (allowZero ? n < 0 : n <= 0)) {
    throw new BadRequestError(`${label} 应为${allowZero ? '不小于 0' : '正'}的金额数字（元），收到："${value ?? ''}"。`)
  }
  return r2(n)
}

export function parseDate(value: string | undefined, label: string): string | undefined {
  if (value === undefined || String(value).trim() === '') return undefined
  const v = String(value).trim()
  if (!DATE_PATTERN.test(v)) {
    throw new BadRequestError(`${label} 格式应为 YYYY-MM-DD，收到："${value}"。`)
  }
  const [y, m, d] = v.split('-').map(Number) as [number, number, number] // DATE_PATTERN 已保证三段均为数字
  const dt = new Date(y, m - 1, d)
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) {
    throw new BadRequestError(`${label} 不是真实存在的日期，收到："${value}"。`)
  }
  return v
}

export function parseMonth(value: string, label = 'month'): string {
  const v = value.trim()
  if (!MONTH_PATTERN.test(v)) {
    throw new BadRequestError(`${label} 格式应为 YYYY-MM，收到："${value}"。`)
  }
  return v
}

export function localDate(d = new Date()): string {
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

export function localMonth(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export function r2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/** 解析可正可负的金额（账户期初、对账单余额：透支/欠款起步是现实），但必须是有限数字。 */
export function parseSignedAmount(value: number | string, label: string): number {
  const cleaned = String(value).replace(/[,¥\s]/g, '')
  const n = Number(cleaned)
  if (!Number.isFinite(n)) {
    throw new BadRequestError(`${label} 应为数字（元，可为负），收到："${value}"。`)
  }
  return r2(n)
}


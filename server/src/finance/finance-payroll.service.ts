/** 工资个税计算器（任务全图 §4 缺口第 6 条，A7/C2 的"算数"件）：工资薪金累计预扣法。
 *  边界：无状态计算器——员工月工资、个人社保、此前累计都由调用方给参数（账本推不出 per-员工
 *  累计数，那是人事台名册的事）；社保个人部分不替老板定（比例×基数按人不同），建档参数只回显不代算；
 *  本工具只算数不落库不申报，正式申报在自然人电子税务局（扣缴端），以官方口径为准（persona 硬规则三）。
 *  政策事实源：个人所得税法（2019-01-01 施行，减除费用 5000/月）+ 国家税务总局公告 2018 年第 61 号
 *  （累计预扣法公式与按月换算税率表）。数字全部整数分运算，申报口径四舍五入到分。 */
import type { DB } from '../db/database.js'
import { BadRequestError } from '../errors.js'
import type { FinanceService } from './finance.service.js'
import { centsToYuan } from './finance.util.js'

/** 按月换算的累计预扣率表（61 号公告附件，2019 年起稳定）：累计应纳税所得额上限（分）→ [预扣率(基点), 速算扣除数(分)]。 */
export const WITHHOLDING_BRACKETS: ReadonlyArray<readonly [number, number, number]> = [
  [36_000_00, 300, 0],
  [144_000_00, 1000, 2_520_00],
  [300_000_00, 2000, 16_920_00],
  [420_000_00, 2500, 31_920_00],
  [660_000_00, 3000, 52_920_00],
  [960_000_00, 3500, 85_920_00],
  [Number.POSITIVE_INFINITY, 4500, 181_920_00],
]

/** 每月减除费用（个税法 2019 起）。 */
export const MONTHLY_STANDARD_DEDUCT_CENTS = 500_000

export const PAYROLL_POLICY_NOTE =
  '按个人所得税法（2019-01-01 施行）与国家税务总局公告 2018 年第 61 号累计预扣法口径；如政策调整，以最新官方口径为准。'

/** 计算入参：金额一律元（REST 边界与 entries/filing 一致），内部转分运算。 */
export interface PayrollCalcRequest {
  /** 本次发放所属月份 1-12。 */
  month: number
  /** 本年首次发薪月份 1-12（年中入职填实际首月；缺省=1），决定累计减除费用月数。 */
  start_month?: number
  /** 本月应发工资（税前，含奖金津贴）。 */
  gross: number
  /** 本年此前月份累计应发（不含本月）。 */
  gross_prev?: number
  /** 本月个人承担的社保公积金（三险一金个人部分，不是公司部分）。 */
  social_this?: number
  /** 此前累计个人社保公积金。 */
  social_prev?: number
  /** 本年累计专项附加扣除及其他依法扣除（含本月；子女教育/房贷利息/赡养老人等）。 */
  extra_deduct_cum?: number
  /** 本年累计减免税额（含本月；一般没有就 0）。 */
  relief_cum?: number
  /** 此前累计已预扣税额（1 月首薪=0）。 */
  withheld_prev?: number
}

export interface PayrollCalcResult {
  month: number
  months_count: number
  /** 本月与累计口径（元）。 */
  gross: number
  gross_prev: number
  social_this: number
  social_prev: number
  cum_income: number
  cum_standard_deduct: number
  cum_social: number
  cum_extra_deduct: number
  taxable_cum: number
  bracket: { level: number; rate: string; quick_deduct: number }
  tax_cum: number
  relief_cum: number
  withheld_prev: number
  /** 本月应预扣税额（为负按 0，差额进 negative_diff 留待下期继续抵减，不退）。 */
  tax_this: number
  negative_diff: number
  /** 实发 = 应发 − 个人社保公积金 − 个人所得税。 */
  net_pay: number
  notes: string[]
  policy: string
  /** 建档社保参数回显（原文，不做结构化计算——硬算等于编数）。 */
  profile_echo: Record<string, string>
}

export class FinancePayrollService {
  constructor(
    private readonly db: DB,
    private readonly finance: FinanceService,
  ) {}

  calc(req: PayrollCalcRequest): PayrollCalcResult {
    const month = intField(req.month, 'month')
    if (month < 1 || month > 12) throw new BadRequestError('month 应为 1-12 的月份整数。')
    const startMonth = req.start_month === undefined ? 1 : intField(req.start_month, 'start_month')
    if (startMonth < 1 || startMonth > 12) throw new BadRequestError('start_month 应为 1-12 的月份整数。')
    if (startMonth > month) throw new BadRequestError(`start_month（${startMonth}）不能晚于 month（${month}）：本年首次发薪月不可能晚于本次发放月。`)
    const gross = centsField(req.gross, 'gross')
    const grossPrev = centsField(req.gross_prev ?? 0, 'gross_prev')
    const socialThis = centsField(req.social_this ?? 0, 'social_this')
    const socialPrev = centsField(req.social_prev ?? 0, 'social_prev')
    const extraDeductCum = centsField(req.extra_deduct_cum ?? 0, 'extra_deduct_cum')
    const reliefCum = centsField(req.relief_cum ?? 0, 'relief_cum')
    const withheldPrev = centsField(req.withheld_prev ?? 0, 'withheld_prev')

    const monthsCount = month - startMonth + 1
    const cumIncome = gross + grossPrev
    const cumStandardDeduct = MONTHLY_STANDARD_DEDUCT_CENTS * monthsCount
    const cumSocial = socialThis + socialPrev
    const taxableCum = cumIncome - cumStandardDeduct - cumSocial - extraDeductCum
    const bracket = bracketOf(taxableCum)
    // 申报口径四舍五入到分；应纳税所得额 ≤0 时累计税额为 0
    const taxCumRaw = taxableCum > 0 ? Math.round((taxableCum * bracket.rateBp) / 10_000) - bracket.quickDeduct - reliefCum : 0
    const diff = taxCumRaw - withheldPrev
    const taxThis = Math.max(0, diff)
    const notes: string[] = []
    if (diff < 0) {
      notes.push(`累计应预扣比已预扣少 ${centsToYuan(-diff)} 元：本月按 0 预扣，差额留待以后月份继续抵减（累计预扣法不多退）。`)
    }
    if (taxableCum <= 0) {
      notes.push('累计应纳税所得额 ≤0（收入不足减除费用与扣除），本月不计税。')
    }
    notes.push('个税由公司在自然人电子税务局（扣缴端）全员全额申报，次月 15 日内；本结果是预扣参考，以申报表预填为准。')
    if (socialThis === 0) {
      notes.push('本月个人社保公积金按 0 计算：若实际有代扣（三险一金个人部分），把数补进来重算，否则个税会偏高、实发偏高。')
    }
    return {
      month,
      months_count: monthsCount,
      gross: centsToYuan(gross),
      gross_prev: centsToYuan(grossPrev),
      social_this: centsToYuan(socialThis),
      social_prev: centsToYuan(socialPrev),
      cum_income: centsToYuan(cumIncome),
      cum_standard_deduct: centsToYuan(cumStandardDeduct),
      cum_social: centsToYuan(cumSocial),
      cum_extra_deduct: centsToYuan(extraDeductCum),
      taxable_cum: centsToYuan(taxableCum),
      bracket: { level: bracket.level, rate: `${bracket.rateBp / 100}%`, quick_deduct: centsToYuan(bracket.quickDeduct) },
      tax_cum: centsToYuan(Math.max(0, taxCumRaw)),
      relief_cum: centsToYuan(reliefCum),
      withheld_prev: centsToYuan(withheldPrev),
      tax_this: centsToYuan(taxThis),
      negative_diff: centsToYuan(Math.max(0, -diff)),
      net_pay: centsToYuan(gross - socialThis - taxThis),
      notes,
      policy: PAYROLL_POLICY_NOTE,
      profile_echo: this.profileEcho(),
    }
  }

  /** 社保基数/比例按档案原文回显（格式自由，与征期包同一纪律：不硬算）。 */
  private profileEcho(): Record<string, string> {
    const profile = this.finance.profileGet().profile
    const echo: Record<string, string> = {}
    for (const key of ['社保基数上下限', '社保比例', '公积金比例'] as const) {
      const value = (profile[key] ?? '').trim()
      if (value !== '') echo[key] = value
    }
    return echo
  }
}

function bracketOf(taxableCum: number): { level: number; rateBp: number; quickDeduct: number } {
  for (let i = 0; i < WITHHOLDING_BRACKETS.length; i++) {
    const [upper, rateBp, quick] = WITHHOLDING_BRACKETS[i]!
    if (taxableCum <= upper) return { level: i + 1, rateBp, quickDeduct: quick }
  }
  const last = WITHHOLDING_BRACKETS[WITHHOLDING_BRACKETS.length - 1]!
  return { level: WITHHOLDING_BRACKETS.length, rateBp: last[1], quickDeduct: last[2] }
}

function intField(value: unknown, name: string): number {
  const n = toNumber(value, name)
  const int = Math.round(n)
  if (int !== n) throw new BadRequestError(`${name} 应为整数（收到：${JSON.stringify(value) ?? 'undefined'}）。`)
  return int
}

/** 模型面对面的入参归一：数字常以字符串形式出现（"3"/"10000"），收下；其余形状拒绝并给可读报错。 */
function toNumber(value: unknown, name: string): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const n = Number(value.trim())
    if (Number.isFinite(n)) return n
    throw new BadRequestError(`${name} 应为数字，收到看不懂的："${value}"。`)
  }
  throw new BadRequestError(`${name} 应为数字，收到：${JSON.stringify(value) ?? 'undefined'}。`)
}

/** 金额字段：元（两位小数内的数）→ 分。拒绝负数/非有限数/超两位小数（超了四舍五入等于悄悄改数）。 */
function centsField(value: unknown, name: string): number {
  const n = toNumber(value, name)
  if (n < 0) throw new BadRequestError(`${name} 不能为负数。`)
  const cents = Math.round(n * 100)
  // 容忍浮点表示误差（19.99 元 → 1998.999…），只拒真超过两位小数的数
  if (Math.abs(n * 100 - cents) > 0.01) {
    throw new BadRequestError(`${name} 最多两位小数（收到 ${n} 元）。`)
  }
  return cents
}

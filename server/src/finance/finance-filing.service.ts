/** 征期数据包（任务全图 §4 缺口第 3 条，义务维"提醒 → 备好料"）：按月或按季把本期申报要用的数字
 *  从账本与建档参数里算出来打包成清单，老板/代账照着在电子税务局填。
 *  边界（persona 硬规则三）：不做正式核算、不代报税——每个数带口径与"以官方/专管员为准"；账本里没有的数
 *  （销项/进项税额、社保基数的结构化值）不硬算，只回显档案参数或给占位提示。
 *  数字全部工具算数、政策口径带来源（2026-10-15 宁波调研），年度更新点与 SOP 参考节 A/B 同步。 */
import type { DB } from '../db/database.js'
import { BadRequestError } from '../errors.js'
import type { FinanceService } from './finance.service.js'
import { OUT_TYPES, type EntryType } from './finance.types.js'
import { centsToYuan, parseMonth, r2 } from './finance.util.js'

/** 小规模纳税人现行优惠（财税公告延续至 2027-12-31；来源：国家税务总局政策库，2026-10-15 宁波调研 §二）：
 *  月销售额 ≤10 万（按季 ≤30 万）免征增值税；超过则**全额**按 3% 征收率减按 1%（不是只对超出部分）。 */
export const SMALL_SCALE_VAT = {
  monthExemptCents: 100_000_00,
  quarterExemptCents: 300_000_00,
  reducedRate: 0.01,
  validUntil: '2027-12-31',
} as const

export interface FilingPeriod {
  kind: 'month' | 'quarter'
  key: string
  label: string
  months: string[]
  from: string
  to: string
}

export interface FilingNode {
  name: string
  due_rule: string
  channel: string
  note: string
}

export interface FilingPack {
  period: FilingPeriod
  identity: { 主体类型: string; 纳税人身份: string; 征收方式: string; 员工人数: string; missing: string[] }
  figures: {
    /** 本期收入发生额（income；冲销相抵、作废剔除；含未收款）——申报销售额的账本参考，须与开票额对照 */
    sales: number
    sales_by_month: { month: string; total: number }[]
    /** 本期流出发生额（expense/reimburse/payroll/tax） */
    outflow: number
    /** 利润参考 = sales − outflow（不是应纳税所得额：成本票/扣除项以税局口径为准） */
    profit_ref: number
    payroll: number
    /** 本期发票登记额（证据维，供与申报销售额核对） */
    invoice_total: number
    receivable_outstanding: number
    payable_outstanding: number
  }
  vat: {
    /** 能否按账本给出免征/预估判断（小规模才能；一般纳税人要销项进项税额，账本没有） */
    applicable: boolean
    basis: number
    exempt: boolean | null
    estimated: number | null
    note: string
  }
  nodes: FilingNode[]
  profile_echo: Record<string, string>
  notes: string[]
}

const ETAX = '宁波市电子税务局 etax.ningbo.chinatax.gov.cn（计划单列市独立系统）'
const HOLIDAY_NOTE = '遇法定节假日顺延，以当年官方"申报纳税期限通知"为准'
const PROFILE_ECHO_KEYS = ['员工人数', '纳税期限', '社保基数上下限', '社保比例', '公积金比例', '代账联系人'] as const

export class FinanceFilingService {
  constructor(
    private readonly db: DB,
    private readonly finance: FinanceService,
  ) {}

  /** period 缺省=当前征期对应的上一期：一般纳税人按月报上月，其余按季报上季。 */
  pack(rawPeriod?: string, now = new Date()): FilingPack {
    // HTTP 重复参数（?period=A&period=B）会以数组溜进来，按非法输入回 400 而不是 trim 抛 500
    if (rawPeriod !== undefined && typeof rawPeriod !== 'string') {
      throw new BadRequestError('period 只能传一个（收到重复参数）。')
    }
    const profile = this.finance.profileGet().profile
    const identity = readIdentity(profile)
    const period = parsePeriod(rawPeriod, identity.纳税人身份, now)
    const { figures, reversalYuan } = this.aggregate(period)
    const vat = judgeVat(identity, period, figures.sales, (profile['纳税期限'] ?? '').trim())
    const nodes = buildNodes(identity, period, figures.payroll)
    const notes = buildNotes(identity, vat, figures, reversalYuan)
    const profileEcho: Record<string, string> = {}
    for (const key of PROFILE_ECHO_KEYS) profileEcho[key] = profile[key] ?? ''
    return { period, identity, figures, vat, nodes, profile_echo: profileEcho, notes }
  }

  // --------------------------------------------------------------- 内部

  /** 口径与 finance.summary 一致：作废剔除、冲销条目按负计入与原条目相抵、发票登记不进收付。
   *  reversalYuan 另行带出本期冲销条目合计（原值），供 notes 提示跨期冲销口径。 */
  private aggregate(period: FilingPeriod): { figures: FilingPack['figures']; reversalYuan: number } {
    const rows = this.db
      .prepare(
        `SELECT type, amount_cents, reverses, substr(date, 1, 7) AS month
         FROM finance_entries
         WHERE deleted_at IS NULL AND date >= ? AND date <= ? AND status != 'cancelled'`,
      )
      .all(period.from, period.to) as { type: EntryType; amount_cents: number; reverses: string; month: string }[]
    let salesCents = 0
    let outflowCents = 0
    let payrollCents = 0
    let invoiceCents = 0
    let reversalCents = 0
    const byMonth = new Map<string, number>(period.months.map((m) => [m, 0]))
    for (const row of rows) {
      const signed = row.reverses !== '' ? -row.amount_cents : row.amount_cents
      if (row.reverses !== '') reversalCents += row.amount_cents
      if (row.type === 'income') {
        salesCents += signed
        byMonth.set(row.month, (byMonth.get(row.month) ?? 0) + signed)
      } else if (row.type === 'invoice') {
        invoiceCents += signed
      } else if (OUT_TYPES.includes(row.type)) {
        outflowCents += signed
        if (row.type === 'payroll') payrollCents += signed
      }
    }
    const lastMonth = period.months[period.months.length - 1]!
    const s = this.finance.summary(lastMonth) as { receivableOutstanding: number; payableOutstanding: number }
    return {
      figures: {
        sales: centsToYuan(salesCents),
        sales_by_month: period.months.map((m) => ({ month: m, total: centsToYuan(byMonth.get(m) ?? 0) })),
        outflow: centsToYuan(outflowCents),
        profit_ref: centsToYuan(salesCents - outflowCents),
        payroll: centsToYuan(payrollCents),
        invoice_total: centsToYuan(invoiceCents),
        receivable_outstanding: s.receivableOutstanding,
        payable_outstanding: s.payableOutstanding,
      },
      reversalYuan: centsToYuan(reversalCents),
    }
  }
}

// ------------------------------------------------------------------- 纯函数（便于单测）

function readIdentity(profile: Record<string, string>): FilingPack['identity'] {
  const pick = (k: string): string => (profile[k] ?? '').trim()
  const identity = { 主体类型: pick('主体类型'), 纳税人身份: pick('纳税人身份'), 征收方式: pick('征收方式'), 员工人数: pick('员工人数'), missing: [] as string[] }
  for (const k of ['主体类型', '纳税人身份', '征收方式'] as const) {
    if (identity[k] === '' || identity[k] === '待查' || identity[k].startsWith('待')) identity.missing.push(k)
  }
  return identity
}

export function parsePeriod(raw: string | undefined, taxpayer: string, now = new Date()): FilingPeriod {
  const spec = (raw ?? '').trim()
  if (spec === '') return previousPeriod(defaultKind(taxpayer), now)
  const q = spec.match(/^(\d{4})-[Qq]([1-4])$/)
  if (q) return quarterPeriod(Number(q[1]), Number(q[2]))
  if (/^\d{4}-\d{2}$/.test(spec)) return monthPeriod(parseMonth(spec, 'period'))
  throw new BadRequestError(`period 格式应为 YYYY-MM（月）或 YYYY-Qn（季，n=1..4），收到："${spec}"。`)
}

/** 缺省征期种类：小规模先认（"小规模（待转一般）"这类写法仍按季）；只认出"一般"才按月；没填默认按季。 */
function defaultKind(taxpayer: string): 'month' | 'quarter' {
  if (isSmallScale(taxpayer)) return 'quarter'
  if (isGeneralTaxpayer(taxpayer)) return 'month'
  return 'quarter'
}

function monthPeriod(month: string): FilingPeriod {
  const [y, m] = month.split('-')
  return { kind: 'month', key: month, label: `${y} 年 ${Number(m)} 月`, months: [month], from: `${month}-01`, to: `${month}-31` }
}

function quarterPeriod(year: number, q: number): FilingPeriod {
  const months = [q * 3 - 2, q * 3 - 1, q * 3].map((m) => `${year}-${String(m).padStart(2, '0')}`)
  return {
    kind: 'quarter',
    key: `${year}-Q${q}`,
    label: `${year} 年第 ${q} 季度（${months[0]} ~ ${months[2]}）`,
    months,
    from: `${months[0]}-01`,
    to: `${months[2]}-31`,
  }
}

/** 征期里报的是上一期：10 月征期报三季度 / 报 9 月。 */
function previousPeriod(kind: 'month' | 'quarter', now: Date): FilingPeriod {
  const y = now.getFullYear()
  const m = now.getMonth() + 1
  if (kind === 'month') {
    return m === 1 ? monthPeriod(`${y - 1}-12`) : monthPeriod(`${y}-${String(m - 1).padStart(2, '0')}`)
  }
  const q = Math.ceil(m / 3)
  return q === 1 ? quarterPeriod(y - 1, 4) : quarterPeriod(y, q - 1)
}

function isGeneralTaxpayer(taxpayer: string): boolean {
  return taxpayer.includes('一般')
}

function isSmallScale(taxpayer: string): boolean {
  return taxpayer.includes('小规模')
}

function judgeVat(identity: FilingPack['identity'], period: FilingPeriod, sales: number, filingCycle: string): FilingPack['vat'] {
  const basisCents = Math.round(sales * 100)
  if (isSmallScale(identity.纳税人身份)) {
    // 小规模默认按季申报（征期常态）：单月包不下增值税结论，除非档案明确「按月申报」——
    // 否则月线（10 万）判断会与实际申报依据（季 30 万免征线）打架，agent 照读结构化字段就会讲错。
    const monthlyFiling = /按月|月报/.test(filingCycle)
    if (period.kind === 'month' && !monthlyFiling) {
      return {
        applicable: true,
        basis: sales,
        exempt: null,
        estimated: null,
        note: '小规模默认按季申报：单月包不下增值税结论，免征线按季 30 万——用 finance_filing 查该季度（period=YYYY-Qn）拿结论；若已备案按月申报，把「纳税期限=按月申报」补进档案，月包才按月线（≤10 万）判断。',
      }
    }
    const threshold = period.kind === 'quarter' ? SMALL_SCALE_VAT.quarterExemptCents : SMALL_SCALE_VAT.monthExemptCents
    const exempt = basisCents <= threshold
    const thresholdLabel = period.kind === 'quarter' ? '季度销售额 ≤30 万' : '月销售额 ≤10 万（档案：按月申报）'
    // 政策有效期哨兵：期末越过 validUntil 还照给结论，等于拿过期政策报数
    const expiryNote =
      period.to > SMALL_SCALE_VAT.validUntil
        ? `；注意：本期截至 ${period.to}，已超出优惠标注有效期 ${SMALL_SCALE_VAT.validUntil}，以上判断待按最新政策核实`
        : ''
    // 反向不对称：按月申报的老板查季度包，季线结论不是他的申报依据，只当对照
    const monthlyFilingNote = period.kind === 'quarter' && monthlyFiling
      ? '；注意：档案「纳税期限=按月申报」，增值税实际按月线（≤10 万）申报判断，本季度包的季线结论仅供对照'
      : ''
    return {
      applicable: true,
      basis: sales,
      exempt,
      estimated: exempt ? 0 : r2(sales * SMALL_SCALE_VAT.reducedRate),
      note: exempt
        ? `小规模纳税人：${thresholdLabel}，本期免征增值税（优惠有效至 ${SMALL_SCALE_VAT.validUntil}）。免税收入照常申报。${expiryNote}${monthlyFilingNote}`
        : `小规模纳税人：本期销售额超过免征线，全额按 3% 征收率减按 1% 预估（不是只对超出部分；优惠有效至 ${SMALL_SCALE_VAT.validUntil}）。附加税费随增值税申报，比例以电子税务局预填为准。${expiryNote}${monthlyFilingNote}`,
    }
  }
  if (isGeneralTaxpayer(identity.纳税人身份)) {
    return {
      applicable: false,
      basis: sales,
      exempt: null,
      estimated: null,
      note: '一般纳税人：增值税=销项税额−进项税额，账本不区分税额，以开票系统与进项认证数为准；本包只给销售额账本参考。',
    }
  }
  return {
    applicable: false,
    basis: sales,
    exempt: null,
    estimated: null,
    note: '档案未填「纳税人身份」，判断不了免征与税率：先用 finance_profile 补齐（小规模/一般）。',
  }
}

function buildNodes(identity: FilingPack['identity'], period: FilingPeriod, payroll: number): FilingNode[] {
  const nodes: FilingNode[] = []
  const entity = identity.主体类型
  const method = identity.征收方式
  const taxpayer = identity.纳税人身份
  if (isSmallScale(taxpayer)) {
    nodes.push({
      name: '增值税及附加申报（小规模按季）',
      due_rule: `季度终了后 15 日内（1/4/7/10 月征期），${HOLIDAY_NOTE}`,
      channel: ETAX,
      note: period.kind === 'month'
        ? '单月包的增值税结论只在档案「纳税期限=按月申报」时给出；小规模默认按季申报，以免征线季 30 万为准（季度结论查季度包）。'
        : '附加（城建/教育/地方教育）随增值税一起申报。',
    })
  } else if (isGeneralTaxpayer(taxpayer)) {
    nodes.push({
      name: '增值税及附加申报（一般纳税人按月）',
      due_rule: `月度期满后 15 日内，${HOLIDAY_NOTE}`,
      channel: ETAX,
      note: '销项/进项以开票系统与进项认证为准。',
    })
  }
  if (entity.includes('公司')) {
    nodes.push({
      name: '企业所得税季度预缴',
      due_rule: `1/4/7/10 月征期，${HOLIDAY_NOTE}`,
      channel: ETAX,
      note: '预缴基数（可弥补亏损、扣除项）以税局口径为准，本包利润参考仅供对照。',
    })
  }
  if (entity.includes('个体')) {
    if (method.includes('定期定额')) {
      nodes.push({
        name: '个体户经营所得（定期定额）',
        due_rule: '一般无需逐月申报；超定额一定幅度须主动补申报',
        channel: ETAX,
        note: '以定额通知书为准；可把定额记进档案（finance_profile 自定义键）便于对照。',
      })
    } else {
      nodes.push({
        name: '个体户经营所得个税季预缴',
        due_rule: `1/4/7/10 月征期，${HOLIDAY_NOTE}；年度汇算次年 3 月 31 日前`,
        channel: ETAX,
        note: '经营所得 5%-35% 累进，应纳税所得额以税局口径（成本票、扣除项）为准，本包利润参考仅供对照。',
      })
    }
  }
  if (payroll > 0) {
    nodes.push({
      name: '个税代扣代缴（工资）',
      due_rule: `次月 15 日内（累计预扣法），${HOLIDAY_NOTE}`,
      channel: '自然人电子税务局（扣缴端）',
      note: `本期账本工资发放 ${payroll} 元，全员全额申报。`,
    })
  }
  nodes.push({
    name: '社保公积金月度缴纳',
    due_rule: '每月征期内申报缴费（当月申报当月缴）',
    channel: '宁波市电子税务局社保费模块 / 宁波人社 12333',
    note: identity.员工人数 === '' ? '档案未填员工人数；无雇工个体户老板可按灵活就业参保，口径以 12333 为准。' : `档案员工人数 ${identity.员工人数}；基数与比例见 profile_echo。`,
  })
  return nodes
}

function buildNotes(identity: FilingPack['identity'], vat: FilingPack['vat'], figures: FilingPack['figures'], reversalYuan: number): string[] {
  const notes = [
    '本包是申报备料，不是核算结果：每个数以电子税务局预填、专管员或代账口径为准；申报操作由老板/代账在电子税务局完成。',
    '销售额=账本收入发生额（含未收款，剔除作废与冲销对，发票登记不计），请与开票额对照；本期发票登记额另列在 invoice_total。',
    '社保基数与比例按档案原文回显、不做结构化计算（格式自由，硬算等于编数）。',
  ]
  if (identity.missing.length > 0) notes.push(`档案缺：${identity.missing.join('、')}——补齐后征期节点与税率判断才准确。`)
  if (vat.applicable && vat.exempt === false) notes.push('增值税预估=销售额×1%，仅供对照；减免、差额征税等特殊情形以申报表预填为准。')
  if (reversalYuan > 0) notes.push(`本期含冲销条目合计 ${reversalYuan} 元（冲销对按负相抵，净额已计入销售额/流出/发票额对应口径）：往期账在本期冲回的，申报口径与代账确认。`)
  if (figures.sales < 0) notes.push('本期销售额为负数即"净冲回"（冲销额超过本期新收入），不是本期亏损；申报含义与代账确认。')
  const entity = identity.主体类型
  if (entity !== '' && !entity.includes('公司') && !entity.includes('个体')) {
    notes.push(`主体类型「${entity}」没识别出公司/个体户，所得税节点没列——确认后在 finance_profile 改成规范写法。`)
  }
  return notes
}

/** 工资单（2026-11-01 财务残余 A3）：某月某人一张单 + 累计预扣快照。
 *  算数全部复用无状态计算器 FinancePayrollService.calc（61 号公告累计预扣法，不在这里
 *  重写税法）——本服务只负责"把累计数从同年此前工资单求出来、把结果存成快照"。
 *  一致性规则：一份工资单的"此前累计"是快照，事后不改；要改某月，它之后的月份必须先删
 *  （只许删同年最后一月、只许删草稿），改完再往后重新生成。确认=锁定（可撤回，有审计）。
 *  落账（2026-11-02）：该月全部确认后由 finance-payroll-posting 生成一笔提案走老板确认链路；本服务只
 *  通过 PayrollPostingGuard 守两条一致性（已落账的月锁死、pending 提案随工资单变动作废），算数不变。 */
import type { DB } from '../db/database.js'
import { nowIso } from '../db/database.js'
import { BadRequestError, NotFoundError } from '../errors.js'
import type { AuditService } from '../audit/audit.service.js'
import type { Actor } from './finance.types.js'
import type { FinancePayrollService } from './finance-payroll.service.js'
import { parseAmount, parseMonth, centsToYuan, yuanToCents } from './finance.util.js'

export interface PayslipInput {
  gross?: unknown
  social?: unknown
  extra_deduct?: unknown
  relief?: unknown
  note?: unknown
}

export interface PayslipRecord {
  id: number
  employee_id: number
  employee_name: string
  department: string
  month: string
  gross: number
  social: number
  extra_deduct: number
  relief: number
  months_count: number
  gross_prev: number
  social_prev: number
  extra_prev: number
  relief_prev: number
  withheld_prev: number
  taxable_cum: number
  tax: number
  net: number
  negative_diff: number
  status: string
  note: string
  created_at: string
  created_by: string
  updated_at: string
  updated_by: string
}

interface PayslipRow {
  id: number
  employee_id: number
  month: string
  gross_cents: number
  social_cents: number
  extra_deduct_cents: number
  relief_cents: number
  months_count: number
  gross_prev_cents: number
  social_prev_cents: number
  extra_prev_cents: number
  relief_prev_cents: number
  withheld_prev_cents: number
  taxable_cum_cents: number
  tax_cents: number
  net_cents: number
  negative_diff_cents: number
  status: string
  note: string
  created_at: string
  created_by: string
  updated_at: string
  updated_by: string
  employee_name: string
  department: string
}

interface EmployeeCoreRow {
  id: number
  name: string
  hire_date: string
  base_salary_cents: number
  social_cents: number
  extra_deduct_cents: number
}

export interface PayslipRegister {
  month: string
  count: number
  rows: PayslipRecord[]
  totals: { gross: number; social: number; tax: number; net: number }
  note: string
}

/** 一次生成的逐项结果：计数 + 四份点名名单（没填参数/乱序被挡/期初累计已覆盖该月/入职日期空着照出）。 */
export interface GenerateOutcome {
  created: number
  skipped: number
  skipped_no_salary: string[]
  skipped_out_of_order: Array<{ name: string; later_month: string }>
  skipped_in_opening: Array<{ name: string; through_month: string }>
  no_hire_date: string[]
}

/** 期初累计（开账）：年中启用时，把该年启用前（截至 through_month 月末）的累计数填进来。 */
export interface OpeningInput {
  employee_id?: unknown
  year?: unknown
  through_month?: unknown
  gross?: unknown
  social?: unknown
  extra_deduct?: unknown
  relief?: unknown
  withheld?: unknown
  note?: unknown
}

export interface OpeningRecord {
  id: number
  employee_id: number
  year: string
  through_month: string
  gross: number
  social: number
  extra_deduct: number
  relief: number
  withheld: number
  note: string
  updated_at: string
  updated_by: string
}

interface OpeningRow {
  id: number
  employee_id: number
  year: string
  through_month: string
  gross_cents: number
  social_cents: number
  extra_cents: number
  relief_cents: number
  withheld_cents: number
  note: string
  created_at: string
  created_by: string
  updated_at: string
  updated_by: string
}

/** 落账侧给工资单的守卫（finance-payroll-posting 实现；装配处 setPostingGuard 注入，未注入=不守）。 */
export interface PayrollPostingGuard {
  /** 该月提案已 confirmed 进账本 → 抛 400（verb 用于文案：撤回确认/再生成）。 */
  assertMonthOpen(month: string, verb: string): void
  /** 该月提案还 pending → 作废它（工资单变了，旧提案的数不作数）。 */
  invalidatePending(actor: Actor, month: string, reason: string): void
}

export class FinancePayslipsService {
  private postingGuard: PayrollPostingGuard | undefined

  setPostingGuard(guard: PayrollPostingGuard): void {
    this.postingGuard = guard
  }

  constructor(
    private readonly db: DB,
    private readonly audit: AuditService,
    private readonly payroll: FinancePayrollService,
  ) {}

  /** 生某月工资表：给每位当月在册员工出草稿（已有当月工资单的人跳过，绝不覆盖已有数；
   *  默认应发为 0 的人跳过并按名字报出——0 元工资单是误导，参数没填就不出单；
   *  同年已有更晚月份工资单的人跳过并按名字报出——回头补生成早月份会让晚月份的累计快照失真
   *  （审查 P1-1：生成也要守"链子不许断"，不能只守改/删）；入职日期空着的人照出但点名——
   *  空=按 1 月起算减除费用，年中入职的人会少扣税（审查 P3-3）。
   *  返回工资表 + 本次计数与名单，前端据此逐项提示。 */
  generate(actor: Actor, rawMonth: string): PayslipRegister & GenerateOutcome {
    const month = parseMonth(rawMonth, 'month')
    this.postingGuard?.assertMonthOpen(month, '生成新的工资单')
    const monthNum = Number(month.slice(5, 7))
    const monthEnd = `${month}-31`
    const monthStart = `${month}-01`
    const employees = this.db
      .prepare(
        `SELECT id, name, hire_date, base_salary_cents, social_cents, extra_deduct_cents
         FROM finance_employees
         WHERE archived_at IS NULL
           AND (hire_date = '' OR hire_date <= ?)
           AND (leave_date = '' OR leave_date >= ?)`,
      )
      .all(monthEnd, monthStart) as EmployeeCoreRow[]
    const existing = new Set(
      (this.db.prepare('SELECT employee_id FROM finance_payslips WHERE month = ?').all(month) as { employee_id: number }[])
        .map((r) => r.employee_id),
    )
    const laterStmt = this.db.prepare(
      'SELECT month FROM finance_payslips WHERE employee_id = ? AND substr(month,1,4) = ? AND month > ? ORDER BY month LIMIT 1',
    )
    let created = 0
    let skipped = 0
    const skippedNoSalary: string[] = []
    const skippedOutOfOrder: Array<{ name: string; later_month: string }> = []
    const skippedInOpening: Array<{ name: string; through_month: string }> = []
    const noHireDate: string[] = []
    const insert = this.db.prepare(
      `INSERT INTO finance_payslips
         (employee_id, month, gross_cents, social_cents, extra_deduct_cents, relief_cents, months_count,
          gross_prev_cents, social_prev_cents, extra_prev_cents, relief_prev_cents, withheld_prev_cents,
          taxable_cum_cents, tax_cents, net_cents, negative_diff_cents, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const emp of employees) {
      if (existing.has(emp.id)) {
        skipped++
        continue
      }
      if (emp.base_salary_cents === 0) {
        skippedNoSalary.push(emp.name)
        continue
      }
      const later = laterStmt.get(emp.id, month.slice(0, 4), month) as { month: string } | undefined
      if (later !== undefined) {
        skippedOutOfOrder.push({ name: emp.name, later_month: later.month })
        continue
      }
      // 期初累计已经把这个月算进去了：再出单就是双计（用户拍板的开账口径：截至 through_month 月末）
      const opening = this.openingRow(emp.id, month.slice(0, 4))
      if (opening !== undefined && opening.through_month >= month) {
        skippedInOpening.push({ name: emp.name, through_month: opening.through_month })
        continue
      }
      const computed = this.compute(emp, month, monthNum)
      insert.run(
        emp.id, month, computed.gross, computed.social, computed.extra, computed.relief, computed.monthsCount,
        computed.grossPrev, computed.socialPrev, computed.extraPrev, computed.reliefPrev, computed.withheldPrev,
        computed.taxableCum, computed.tax, computed.net, computed.negativeDiff,
        nowIso(), actor.username, nowIso(), actor.username,
      )
      created++
      if (emp.hire_date === '') noHireDate.push(emp.name)
    }
    // 新出了草稿=该月总数要变：等老板确认的旧落账提案作废，全部确认后再生成新的
    if (created > 0) this.postingGuard?.invalidatePending(actor, month, `${month} 新生成了 ${created} 张工资单，旧提案的数不作数`)
    this.audit.log({
      username: actor.username,
      source: actor.source,
      action: 'payroll.payslip.generate',
      targetId: month,
      detail: {
        created, skipped, skipped_no_salary: skippedNoSalary.length, skipped_out_of_order: skippedOutOfOrder.length,
        skipped_in_opening: skippedInOpening.length, no_hire_date: noHireDate.length,
      },
    })
    return {
      ...this.register(month),
      created,
      skipped,
      skipped_no_salary: skippedNoSalary,
      skipped_out_of_order: skippedOutOfOrder,
      skipped_in_opening: skippedInOpening,
      no_hire_date: noHireDate,
    }
  }

  // ---------- 期初累计（开账） ----------

  getOpening(employeeId: number, rawYear: string): OpeningRecord | null {
    const year = parseYear(rawYear)
    const row = this.openingRow(employeeId, year)
    return row === undefined ? null : toOpening(row)
  }

  /** 写入/覆盖某人某年的期初累计。该年已有工资单时拒绝（已出的单是按旧期初算的快照，改了就不一致）；
   *  through_month 必须在该年内，且不早于本年入职月（入职前不可能有累计）。全 0 合法=前面按 0 登记。 */
  setOpening(actor: Actor, input: OpeningInput): OpeningRecord {
    const employeeId = Number(input.employee_id)
    if (!Number.isInteger(employeeId) || employeeId <= 0) throw new BadRequestError('employee_id 应为正整数。')
    const emp = this.db.prepare('SELECT id, name, hire_date, archived_at FROM finance_employees WHERE id = ?').get(employeeId) as
      | { id: number; name: string; hire_date: string; archived_at: string | null }
      | undefined
    if (emp === undefined) throw new NotFoundError(`名册里没有这位员工（id=${employeeId}）。`)
    if (emp.archived_at !== null) throw new BadRequestError(`${emp.name} 已归档，是只读历史；要改先「恢复」。`)
    const year = parseYear(input.year)
    const through = parseMonth(String(input.through_month ?? ''), 'through_month')
    if (!through.startsWith(`${year}-`)) throw new BadRequestError(`through_month（${through}）必须在 ${year} 年内。`)
    if (emp.hire_date.startsWith(`${year}-`) && through.slice(5, 7) < emp.hire_date.slice(5, 7)) {
      throw new BadRequestError(`${emp.name} ${emp.hire_date} 才入职，期初累计不能截至更早的 ${through}。`)
    }
    this.requireNoPayslipsInYear(employeeId, emp.name, year, '改期初累计')
    const amount = (v: unknown, label: string): number => (v === undefined || v === null || v === '' ? 0 : yuanToCents(parseAmount(v as number | string, label, true)))
    const gross = amount(input.gross, '期初累计应发')
    const social = amount(input.social, '期初累计个人社保公积金')
    const extra = amount(input.extra_deduct, '期初累计专项附加扣除')
    const relief = amount(input.relief, '期初累计减免税额')
    const withheld = amount(input.withheld, '期初累计已预扣个税')
    const note = typeof input.note === 'string' ? input.note.trim() : ''
    this.db
      .prepare(
        `INSERT INTO finance_payroll_openings
           (employee_id, year, through_month, gross_cents, social_cents, extra_cents, relief_cents, withheld_cents, note,
            created_at, created_by, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(employee_id, year) DO UPDATE SET
           through_month=excluded.through_month, gross_cents=excluded.gross_cents, social_cents=excluded.social_cents,
           extra_cents=excluded.extra_cents, relief_cents=excluded.relief_cents, withheld_cents=excluded.withheld_cents,
           note=excluded.note, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
      )
      .run(employeeId, year, through, gross, social, extra, relief, withheld, note, nowIso(), actor.username, nowIso(), actor.username)
    this.audit.log({
      username: actor.username,
      source: actor.source,
      action: 'payroll.opening.set',
      targetId: `${employeeId}:${year}`,
      detail: { employee_id: employeeId, year, through_month: through, gross: centsToYuan(gross), withheld: centsToYuan(withheld) },
    })
    return toOpening(this.openingRow(employeeId, year) as OpeningRow)
  }

  deleteOpening(actor: Actor, employeeId: number, rawYear: string): { removed: number } {
    const year = parseYear(rawYear)
    const row = this.openingRow(employeeId, year)
    if (row === undefined) throw new NotFoundError(`这位员工 ${year} 年没有期初累计。`)
    const emp = this.db.prepare('SELECT name FROM finance_employees WHERE id = ?').get(employeeId) as { name: string } | undefined
    this.requireNoPayslipsInYear(employeeId, emp?.name ?? String(employeeId), year, '删期初累计')
    this.db.prepare('DELETE FROM finance_payroll_openings WHERE id = ?').run(row.id)
    this.audit.log({
      username: actor.username,
      source: actor.source,
      action: 'payroll.opening.delete',
      targetId: `${employeeId}:${year}`,
      detail: { employee_id: employeeId, year, through_month: row.through_month, gross: centsToYuan(row.gross_cents) },
    })
    return { removed: 1 }
  }

  /** 月度工资表（登记页）：当月所有人的单 + 合计。 */
  register(rawMonth: string): PayslipRegister {
    const month = parseMonth(rawMonth, 'month')
    const rows = this.rows(
      `SELECT p.*, e.name AS employee_name, e.department AS department
       FROM finance_payslips p JOIN finance_employees e ON e.id = p.employee_id
       WHERE p.month = ? ORDER BY e.name`,
      month,
    )
    const totals = rows.reduce(
      (acc, r) => ({
        gross: Math.round((acc.gross + r.gross) * 100) / 100,
        social: Math.round((acc.social + r.social) * 100) / 100,
        tax: Math.round((acc.tax + r.tax) * 100) / 100,
        net: Math.round((acc.net + r.net) * 100) / 100,
      }),
      { gross: 0, social: 0, tax: 0, net: 0 },
    )
    return {
      month,
      count: rows.length,
      rows,
      totals,
      note: '草稿=生成后还没定案，可改可删；确认后锁定。合计是本月工资表合计，登记进账本仍走提案卡/台账，不自动落账。',
    }
  }

  detail(id: number): PayslipRecord {
    return this.getJoined(id)
  }

  /** 某人某年的工资单（个人维）：按月升序，含逐月快照。 */
  listByEmployee(employeeId: number, rawYear: string): { employee: { id: number; name: string }; year: string; rows: PayslipRecord[] } {
    const employee = this.db.prepare('SELECT id, name FROM finance_employees WHERE id = ?').get(employeeId) as { id: number; name: string } | undefined
    if (employee === undefined) throw new NotFoundError(`名册里没有这位员工（id=${employeeId}）。`)
    const year = /^\d{4}$/.test(rawYear.trim()) ? rawYear.trim() : (() => { throw new BadRequestError(`year 格式应为 4 位年份，收到："${rawYear}"。`) })()
    const rows = this.rows(
      `SELECT p.*, e.name AS employee_name, e.department AS department
       FROM finance_payslips p JOIN finance_employees e ON e.id = p.employee_id
       WHERE p.employee_id = ? AND substr(p.month, 1, 4) = ? ORDER BY p.month`,
      employeeId, year,
    )
    return { employee, year, rows }
  }

  update(actor: Actor, id: number, input: PayslipInput): PayslipRecord {
    const row = this.getRaw(id)
    if (row.status !== 'draft') {
      throw new BadRequestError('这张工资单已确认锁定；要改先撤回确认（unconfirm），改动留审计。')
    }
    this.requireLatestMonth(row.employee_id, row.month, '改')
    const gross = input.gross === undefined ? row.gross_cents : yuanToCents(parseAmount(input.gross as number | string, '应发工资'))
    const social = input.social === undefined ? row.social_cents : yuanToCents(parseAmount(input.social as number | string, '个人社保公积金', true))
    const extra = input.extra_deduct === undefined ? row.extra_deduct_cents : yuanToCents(parseAmount(input.extra_deduct as number | string, '专项附加扣除', true))
    const relief = input.relief === undefined ? row.relief_cents : yuanToCents(parseAmount(input.relief as number | string, '本月减免税额', true))
    const note = typeof input.note === 'string' ? input.note.trim() : row.note
    const emp = this.db.prepare('SELECT id, name, hire_date, base_salary_cents, social_cents, extra_deduct_cents FROM finance_employees WHERE id = ?')
      .get(row.employee_id) as EmployeeCoreRow
    // 重算仍走计算器：本月数用新值，此前累计沿用快照（快照不可能过期——后面的月份挡着改不了前面）
    const computed = this.computeFrom(emp, row.month, Number(row.month.slice(5, 7)), {
      gross, social, extra, relief,
      grossPrev: row.gross_prev_cents, socialPrev: row.social_prev_cents,
      extraPrev: row.extra_prev_cents, reliefPrev: row.relief_prev_cents,
      withheldPrev: row.withheld_prev_cents,
    })
    this.db
      .prepare(
        `UPDATE finance_payslips SET gross_cents=?, social_cents=?, extra_deduct_cents=?, relief_cents=?, note=?,
           months_count=?, taxable_cum_cents=?, tax_cents=?, net_cents=?, negative_diff_cents=?, updated_at=?, updated_by=?
         WHERE id=?`,
      )
      .run(gross, social, extra, relief, note, computed.monthsCount, computed.taxableCum, computed.tax, computed.net, computed.negativeDiff, nowIso(), actor.username, id)
    this.audit.log({
      username: actor.username,
      source: actor.source,
      action: 'payroll.payslip.update',
      targetId: String(id),
      detail: { employee: emp.name, month: row.month, gross: centsToYuan(gross), tax: centsToYuan(computed.tax) },
    })
    return this.getJoined(id)
  }

  confirm(actor: Actor, id: number): PayslipRecord {
    const row = this.getRaw(id)
    if (row.status === 'confirmed') return this.getJoined(id)
    this.db.prepare('UPDATE finance_payslips SET status=?, updated_at=?, updated_by=? WHERE id=?')
      .run('confirmed', nowIso(), actor.username, id)
    this.audit.log({ username: actor.username, source: actor.source, action: 'payroll.payslip.confirm', targetId: String(id), detail: { month: row.month } })
    return this.getJoined(id)
  }

  unconfirm(actor: Actor, id: number): PayslipRecord {
    const row = this.getRaw(id)
    if (row.status === 'draft') return this.getJoined(id)
    this.postingGuard?.assertMonthOpen(row.month, '撤回确认')
    this.db.prepare('UPDATE finance_payslips SET status=?, updated_at=?, updated_by=? WHERE id=?')
      .run('draft', nowIso(), actor.username, id)
    this.audit.log({ username: actor.username, source: actor.source, action: 'payroll.payslip.unconfirm', targetId: String(id), detail: { month: row.month } })
    this.postingGuard?.invalidatePending(actor, row.month, `${row.month} 有工资单撤回了确认，旧提案的数不作数`)
    return this.getJoined(id)
  }

  remove(actor: Actor, id: number): { removed: number } {
    const row = this.getRaw(id)
    if (row.status !== 'draft') {
      throw new BadRequestError('已确认的工资单不能删；先撤回确认。')
    }
    this.requireLatestMonth(row.employee_id, row.month, '删')
    this.db.prepare('DELETE FROM finance_payslips WHERE id = ?').run(id)
    this.audit.log({
      username: actor.username,
      source: actor.source,
      action: 'payroll.payslip.delete',
      targetId: String(id),
      detail: { employee_id: row.employee_id, month: row.month, gross: centsToYuan(row.gross_cents) },
    })
    return { removed: 1 }
  }

  // ---------- 内部 ----------

  /** 算一份新工资单：此前累计从同年此前工资单求和；start_month 按入职月份（本年入职）。 */
  private compute(emp: EmployeeCoreRow, month: string, monthNum: number): {
    gross: number; social: number; extra: number; relief: number; monthsCount: number;
    grossPrev: number; socialPrev: number; extraPrev: number; reliefPrev: number; withheldPrev: number;
    taxableCum: number; tax: number; net: number; negativeDiff: number;
  } {
    const prev = this.prevSums(emp.id, month)
    return this.computeFrom(emp, month, monthNum, {
      gross: emp.base_salary_cents,
      social: emp.social_cents,
      extra: emp.extra_deduct_cents,
      relief: 0,
      ...prev,
    })
  }

  private computeFrom(
    emp: EmployeeCoreRow,
    month: string,
    monthNum: number,
    v: {
      gross: number; social: number; extra: number; relief: number;
      grossPrev: number; socialPrev: number; extraPrev: number; reliefPrev: number; withheldPrev: number;
    },
  ): {
    gross: number; social: number; extra: number; relief: number; monthsCount: number;
    grossPrev: number; socialPrev: number; extraPrev: number; reliefPrev: number; withheldPrev: number;
    taxableCum: number; tax: number; net: number; negativeDiff: number;
  } {
    const year = month.slice(0, 4)
    const startMonth = emp.hire_date.startsWith(`${year}-`) ? Number(emp.hire_date.slice(5, 7)) : 1
    const calc = this.payroll.calc({
      month: monthNum,
      start_month: startMonth <= monthNum ? startMonth : 1,
      gross: centsToYuan(v.gross),
      gross_prev: centsToYuan(v.grossPrev),
      social_this: centsToYuan(v.social),
      social_prev: centsToYuan(v.socialPrev),
      extra_deduct_cum: centsToYuan(v.extra + v.extraPrev),
      relief_cum: centsToYuan(v.relief + v.reliefPrev),
      withheld_prev: centsToYuan(v.withheldPrev),
    })
    return {
      gross: v.gross,
      social: v.social,
      extra: v.extra,
      relief: v.relief,
      monthsCount: calc.months_count,
      grossPrev: v.grossPrev,
      socialPrev: v.socialPrev,
      extraPrev: v.extraPrev,
      reliefPrev: v.reliefPrev,
      withheldPrev: v.withheldPrev,
      taxableCum: yuanToCents(calc.taxable_cum),
      tax: yuanToCents(calc.tax_this),
      net: yuanToCents(calc.net_pay),
      negativeDiff: yuanToCents(calc.negative_diff),
    }
  }

  private prevSums(employeeId: number, month: string): {
    grossPrev: number; socialPrev: number; extraPrev: number; reliefPrev: number; withheldPrev: number;
  } {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(gross_cents),0) AS gross, COALESCE(SUM(social_cents),0) AS social,
                COALESCE(SUM(extra_deduct_cents),0) AS extra, COALESCE(SUM(relief_cents),0) AS relief,
                COALESCE(SUM(tax_cents),0) AS withheld
         FROM finance_payslips
         WHERE employee_id = ? AND substr(month,1,4) = ? AND month < ?`,
      )
      .get(employeeId, month.slice(0, 4), month) as { gross: number; social: number; extra: number; relief: number; withheld: number }
    // 期初累计并入"此前累计"：年中启用时启用前的数在这里，不在工资单里
    const opening = this.openingRow(employeeId, month.slice(0, 4))
    const o = opening ?? { gross_cents: 0, social_cents: 0, extra_cents: 0, relief_cents: 0, withheld_cents: 0 }
    return {
      grossPrev: row.gross + o.gross_cents,
      socialPrev: row.social + o.social_cents,
      extraPrev: row.extra + o.extra_cents,
      reliefPrev: row.relief + o.relief_cents,
      withheldPrev: row.withheld + o.withheld_cents,
    }
  }

  private openingRow(employeeId: number, year: string): OpeningRow | undefined {
    return this.db.prepare('SELECT * FROM finance_payroll_openings WHERE employee_id = ? AND year = ?').get(employeeId, year) as
      | OpeningRow
      | undefined
  }

  private requireNoPayslipsInYear(employeeId: number, name: string, year: string, verb: string): void {
    const hit = this.db
      .prepare("SELECT month FROM finance_payslips WHERE employee_id = ? AND substr(month,1,4) = ? ORDER BY month DESC LIMIT 1")
      .get(employeeId, year) as { month: string } | undefined
    if (hit !== undefined) {
      throw new BadRequestError(`${name} 在 ${year} 年已有工资单（最晚 ${hit.month}），要${verb}先把该年工资单从最后一月起逐张删掉（已出的单是按旧期初算的）。`)
    }
  }

  /** 后面月份还挂着就挡住：一份单的"此前累计"快照永远等于同年此前各月之和，链子不许断。 */
  private requireLatestMonth(employeeId: number, month: string, verb: string): void {
    const later = this.db
      .prepare('SELECT month FROM finance_payslips WHERE employee_id = ? AND substr(month,1,4) = ? AND month > ? ORDER BY month LIMIT 1')
      .get(employeeId, month.slice(0, 4), month) as { month: string } | undefined
    if (later !== undefined) {
      throw new BadRequestError(`要${verb}这份工资单，得先删同年更晚的 ${later.month} 那份（后面的月份是按它前面各月算的，跳着改链子就断了）。`)
    }
  }

  private getRaw(id: number): PayslipRow {
    const row = this.db.prepare('SELECT * FROM finance_payslips WHERE id = ?').get(id) as PayslipRow | undefined
    if (row === undefined) throw new NotFoundError(`没有这张工资单（id=${id}）。`)
    return row
  }

  private getJoined(id: number): PayslipRecord {
    const row = this.db
      .prepare(
        `SELECT p.*, e.name AS employee_name, e.department AS department
         FROM finance_payslips p JOIN finance_employees e ON e.id = p.employee_id
         WHERE p.id = ?`,
      )
      .get(id) as PayslipRow | undefined
    if (row === undefined) throw new NotFoundError(`没有这张工资单（id=${id}）。`)
    return toRecord(row)
  }

  private rows(sql: string, ...params: unknown[]): PayslipRecord[] {
    return (this.db.prepare(sql).all(...params) as PayslipRow[]).map(toRecord)
  }
}

function toRecord(row: PayslipRow): PayslipRecord {
  return {
    id: row.id,
    employee_id: row.employee_id,
    employee_name: row.employee_name,
    department: row.department,
    month: row.month,
    gross: centsToYuan(row.gross_cents),
    social: centsToYuan(row.social_cents),
    extra_deduct: centsToYuan(row.extra_deduct_cents),
    relief: centsToYuan(row.relief_cents),
    months_count: row.months_count,
    gross_prev: centsToYuan(row.gross_prev_cents),
    social_prev: centsToYuan(row.social_prev_cents),
    extra_prev: centsToYuan(row.extra_prev_cents),
    relief_prev: centsToYuan(row.relief_prev_cents),
    withheld_prev: centsToYuan(row.withheld_prev_cents),
    taxable_cum: centsToYuan(row.taxable_cum_cents),
    tax: centsToYuan(row.tax_cents),
    net: centsToYuan(row.net_cents),
    negative_diff: centsToYuan(row.negative_diff_cents),
    status: row.status,
    note: row.note,
    created_at: row.created_at,
    created_by: row.created_by,
    updated_at: row.updated_at,
    updated_by: row.updated_by,
  }
}

function toOpening(row: OpeningRow): OpeningRecord {
  return {
    id: row.id,
    employee_id: row.employee_id,
    year: row.year,
    through_month: row.through_month,
    gross: centsToYuan(row.gross_cents),
    social: centsToYuan(row.social_cents),
    extra_deduct: centsToYuan(row.extra_cents),
    relief: centsToYuan(row.relief_cents),
    withheld: centsToYuan(row.withheld_cents),
    note: row.note,
    updated_at: row.updated_at,
    updated_by: row.updated_by,
  }
}

function parseYear(value: unknown): string {
  const v = String(value ?? '').trim()
  if (!/^\d{4}$/.test(v)) throw new BadRequestError(`year 应为四位年份，收到："${v}"。`)
  return v
}

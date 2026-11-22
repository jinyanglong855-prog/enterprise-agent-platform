/** 员工名册（2026-11-01 财务残余 A3，融合方案 §3 回流形态）：人 + 算工资的参数。
 *  身份三件（姓名/部门/open_id）从平台通讯录同步，工资参数（默认应发/个人社保/专项附加
 *  月扣）永远本地维护——同步只动身份字段，绝不把人的钱数冲掉。open_id 空=手工登记，
 *  没接平台或不在飞书里的人照样进工资域。删除=归档（工资单引用历史不许悬空）。
 *  同步的纪律：按 open_id 幂等 upsert；平台里没了的人只报告不自动标离职（自动改
 *  钱相关状态=替老板做主），离职日期由人填。 */
import type { DB } from '../db/database.js'
import { nowIso } from '../db/database.js'
import { BadRequestError, NotFoundError } from '../errors.js'
import type { AuditService } from '../audit/audit.service.js'
import type { PlatformDataService } from '../bridge/platform-data.service.js'
import type { Actor } from './finance.types.js'
import { parseAmount, parseDate, yuanToCents, centsToYuan } from './finance.util.js'

export interface EmployeeInput {
  name?: unknown
  open_id?: unknown
  department?: unknown
  hire_date?: unknown
  leave_date?: unknown
  base_salary?: unknown
  social?: unknown
  extra_deduct?: unknown
  note?: unknown
}

export interface EmployeeRecord {
  id: number
  name: string
  open_id: string
  department: string
  hire_date: string
  leave_date: string
  base_salary: number
  social: number
  extra_deduct: number
  note: string
  created_at: string
  created_by: string
  updated_at: string
  updated_by: string
  archived_at: string | null
}

interface EmployeeRow {
  id: number
  name: string
  open_id: string
  department: string
  hire_date: string
  leave_date: string
  base_salary_cents: number
  social_cents: number
  extra_deduct_cents: number
  note: string
  created_at: string
  created_by: string
  updated_at: string
  updated_by: string
  archived_at: string | null
}

export interface RosterSyncResult {
  created: number
  updated: number
  skipped_archived: number
  missing_on_platform: string[]
  /** 与在册手工行同名、没建重复、等人填 open_id 绑定的平台新面孔 */
  pending_bind: Array<{ name: string; open_id: string }>
  truncated: boolean
  /** 根部门直属成员：synced=已并入；unavailable=平台拒绝，需手工登记 */
  root_members: 'synced' | 'unavailable'
  note: string
}

export interface RosterDiff {
  missing: Array<{ id: number; name: string; open_id: string }>
  fresh: Array<{ name: string; open_id: string; department: string }>
  pendingBind: Array<{ name: string; open_id: string }>
  truncated: boolean
  rootMembers: 'synced' | 'unavailable'
}

export class FinanceRosterService {
  constructor(
    private readonly db: DB,
    private readonly audit: AuditService,
    private readonly platform: PlatformDataService,
  ) {}

  list(filter: { include_archived?: boolean } = {}): { employees: EmployeeRecord[]; count: number } {
    const rows = this.db
      .prepare(filter.include_archived === true
        ? 'SELECT * FROM finance_employees ORDER BY archived_at IS NOT NULL, name'
        : 'SELECT * FROM finance_employees WHERE archived_at IS NULL ORDER BY name')
      .all() as EmployeeRow[]
    return { employees: rows.map(toRecord), count: rows.length }
  }

  get(id: number): EmployeeRecord {
    const row = this.db.prepare('SELECT * FROM finance_employees WHERE id = ?').get(id) as EmployeeRow | undefined
    if (row === undefined) throw new NotFoundError(`名册里没有这位员工（id=${id}）。`)
    return toRecord(row)
  }

  create(actor: Actor, input: EmployeeInput): EmployeeRecord {
    const name = this.requireName(input.name)
    const fields = this.moneyAndDateFields(input)
    if (fields.open_id !== '') this.requireOpenIdFree(fields.open_id)
    const id = this.db
      .prepare(
        `INSERT INTO finance_employees
           (name, open_id, department, hire_date, leave_date, base_salary_cents, social_cents,
            extra_deduct_cents, note, created_at, created_by, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        name, fields.open_id, fields.department, fields.hire_date, fields.leave_date,
        fields.base_salary_cents, fields.social_cents, fields.extra_deduct_cents, fields.note,
        nowIso(), actor.username, nowIso(), actor.username,
      ).lastInsertRowid as number
    this.audit.log({
      username: actor.username,
      source: actor.source,
      action: 'payroll.employee.create',
      targetId: String(id),
      detail: { name, open_id: fields.open_id },
    })
    return this.get(id)
  }

  update(actor: Actor, id: number, input: EmployeeInput): EmployeeRecord {
    const row = this.db.prepare('SELECT * FROM finance_employees WHERE id = ?').get(id) as EmployeeRow | undefined
    if (row === undefined) throw new NotFoundError(`名册里没有这位员工（id=${id}）。`)
    if (row.archived_at !== null) {
      throw new BadRequestError('已归档员工是只读历史；要改先「恢复」（unarchive）再改。')
    }
    const name = input.name === undefined ? row.name : this.requireName(input.name)
    // 身份字段：没传就保留原值；open_id 改成空串=解除平台绑定（显式动作才允许）
    const openIdInput = typeof input.open_id === 'string' ? input.open_id.trim() : row.open_id
    if (openIdInput !== row.open_id && openIdInput !== '') this.requireOpenIdFree(openIdInput, id)
    const department = typeof input.department === 'string' ? input.department.trim() : row.department
    const hire = this.optionalDate(input.hire_date, row.hire_date, '入职日期')
    const leave = this.optionalDate(input.leave_date, row.leave_date, '离职日期')
    const base = input.base_salary === undefined ? row.base_salary_cents : yuanToCents(parseAmount(input.base_salary as number | string, '默认应发工资', true))
    const social = input.social === undefined ? row.social_cents : yuanToCents(parseAmount(input.social as number | string, '个人社保公积金（月）', true))
    const extra = input.extra_deduct === undefined ? row.extra_deduct_cents : yuanToCents(parseAmount(input.extra_deduct as number | string, '专项附加扣除（月）', true))
    const note = typeof input.note === 'string' ? input.note.trim() : row.note
    if (hire !== '' && leave !== '' && leave < hire) {
      throw new BadRequestError(`离职日期（${leave}）不能早于入职日期（${hire}）。`)
    }
    // 入职月决定该年减除费用的起算月（start_month）——改了它，受影响年份已出的工资单
    // 快照全部失真（审查 P1-2）。改默认应发不动历史是对的，改入职日期恰恰追溯改写税基，必须守门。
    if (hire !== row.hire_date) {
      const affectedYears = new Set<string>()
      if (hire !== '') affectedYears.add(hire.slice(0, 4))
      if (row.hire_date !== '') affectedYears.add(row.hire_date.slice(0, 4))
      if (row.hire_date === '') {
        // 原来没填=所有已出的单都按 1 月起算：任何年份有单都算受影响
        for (const y of this.payslipYears(id)) affectedYears.add(y)
      }
      for (const year of affectedYears) {
        if (this.hasPayslipsInYear(id, year)) {
          throw new BadRequestError(
            `${row.name} 在 ${year} 年已有工资单，入职日期决定该年个税减除费用从哪个月起算，改了已出的单就全错了；先删掉 ${year} 年的工资单再改入职日期，然后重新生成。`,
          )
        }
      }
    }
    // 离职日期不能早于已出工资单的月份（离职之后不该有单）：要么先删后面的单，要么日期填对
    if (leave !== '' && leave !== row.leave_date) {
      const later = this.db
        .prepare('SELECT month FROM finance_payslips WHERE employee_id = ? AND month > ? ORDER BY month DESC LIMIT 1')
        .get(id, leave.slice(0, 7)) as { month: string } | undefined
      if (later !== undefined) {
        throw new BadRequestError(`${row.name} 在 ${later.month} 还有工资单，离职日期不能早于它；先删掉离职之后月份的工资单。`)
      }
    }
    this.db
      .prepare(
        `UPDATE finance_employees SET name=?, open_id=?, department=?, hire_date=?, leave_date=?,
           base_salary_cents=?, social_cents=?, extra_deduct_cents=?, note=?, updated_at=?, updated_by=?
         WHERE id=?`,
      )
      .run(name, openIdInput, department, hire, leave, base, social, extra, note, nowIso(), actor.username, id)
    this.audit.log({
      username: actor.username,
      source: actor.source,
      action: 'payroll.employee.update',
      targetId: String(id),
      detail: { name, hire_date_changed: hire !== row.hire_date, open_id_changed: openIdInput !== row.open_id },
    })
    return this.get(id)
  }

  archive(actor: Actor, id: number): EmployeeRecord {
    const row = this.db.prepare('SELECT * FROM finance_employees WHERE id = ?').get(id) as EmployeeRow | undefined
    if (row === undefined) throw new NotFoundError(`名册里没有这位员工（id=${id}）。`)
    if (row.archived_at !== null) return toRecord(row)
    this.db.prepare('UPDATE finance_employees SET archived_at=?, updated_at=?, updated_by=? WHERE id=?')
      .run(nowIso(), nowIso(), actor.username, id)
    this.audit.log({
      username: actor.username,
      source: actor.source,
      action: 'payroll.employee.archive',
      targetId: String(id),
      detail: { name: row.name },
    })
    return this.get(id)
  }

  unarchive(actor: Actor, id: number): EmployeeRecord {
    const row = this.db.prepare('SELECT * FROM finance_employees WHERE id = ?').get(id) as EmployeeRow | undefined
    if (row === undefined) throw new NotFoundError(`名册里没有这位员工（id=${id}）。`)
    if (row.archived_at === null) return toRecord(row)
    if (row.open_id !== '') this.requireOpenIdFree(row.open_id, id)
    this.db.prepare('UPDATE finance_employees SET archived_at=NULL, updated_at=?, updated_by=? WHERE id=?')
      .run(nowIso(), actor.username, id)
    this.audit.log({
      username: actor.username,
      source: actor.source,
      action: 'payroll.employee.unarchive',
      targetId: String(id),
      detail: { name: row.name },
    })
    return this.get(id)
  }

  /** 从平台通讯录同步身份三件（部门树内各部门 + 根部门直属成员）。返回逐项计数、
   *  "平台里已查无此人"的名册名单（只报告，不自动标离职）、与手工行同名待人工绑定的名单
   *  （不建重复行）；truncated=部门树或任一部门成员分页护栏触顶（名单可能不全，如实标注）。 */
  /** 拉平台通讯录全员（部门树逐个 + 根部门直属）：同步与差异扫描共用。
   *  根部门直属成员（不在任何子部门里，小公司老板/行政常见）：部门树接口不含根本身，单独拉一次；
   *  平台拒绝时不让整次失败，如实标注交给人手工登记（审查 P2-2）。 */
  private async collectPlatform(actorView: { username: string; source: string }): Promise<{
    byOpenId: Map<string, { name: string; department: string }>
    truncated: boolean
    rootMembers: 'synced' | 'unavailable'
  }> {
    const tree = await this.platform.departments(actorView)
    let truncated = tree.truncated
    const byOpenId = new Map<string, { name: string; department: string }>()
    const absorb = (members: { members: Array<{ name: string; open_id: string }>; truncated: boolean }, deptName: string): void => {
      if (members.truncated) truncated = true
      for (const m of members.members) {
        const prev = byOpenId.get(m.open_id)
        const dept = prev !== undefined && prev.department !== '' ? prev.department : deptName
        byOpenId.set(m.open_id, { name: m.name, department: dept })
      }
    }
    for (const dept of tree.departments) {
      absorb(await this.platform.members(actorView, dept.open_department_id), dept.name)
    }
    let rootMembers: 'synced' | 'unavailable' = 'synced'
    try {
      absorb(await this.platform.members(actorView, '0'), '')
    } catch {
      rootMembers = 'unavailable'
    }
    return { byOpenId, truncated, rootMembers }
  }

  /** 只读差异（2026-11-02 社保增减员提醒 A4/A5 的数据源，义务域每日扫描调用；不写名册、不审计名册）：
   *  missing=在册有 open_id 但平台查无此人（离职/换号/权限不可见都可能，交人核实）；
   *  fresh=平台有、名册完全没有的人（既不按 open_id 在册、也不与手工行同名）；
   *  pendingBind=与在册手工行同名、等人填 open_id 绑定的平台面孔。 */
  async platformDiff(actor: { username: string; source: string }): Promise<RosterDiff> {
    const { byOpenId, truncated, rootMembers } = await this.collectPlatform(actor)
    const rows = this.db.prepare('SELECT * FROM finance_employees WHERE archived_at IS NULL').all() as EmployeeRow[]
    const seen = new Set(rows.filter((r) => r.open_id !== '').map((r) => r.open_id))
    const manualNames = new Set(rows.filter((r) => r.open_id === '').map((r) => r.name))
    const fresh: RosterDiff['fresh'] = []
    const pendingBind: RosterDiff['pendingBind'] = []
    for (const [openId, p] of byOpenId) {
      if (seen.has(openId)) continue
      if (manualNames.has(p.name)) pendingBind.push({ name: p.name, open_id: openId })
      else fresh.push({ name: p.name, open_id: openId, department: p.department })
    }
    const missing = rows.filter((r) => r.open_id !== '' && !byOpenId.has(r.open_id)).map((r) => ({ id: r.id, name: r.name, open_id: r.open_id }))
    return { missing, fresh, pendingBind, truncated, rootMembers }
  }

  async syncFromPlatform(actor: Actor): Promise<RosterSyncResult> {
    const actorView = { username: actor.username, source: actor.source }
    const { byOpenId, truncated, rootMembers } = await this.collectPlatform(actorView)
    let created = 0
    let updated = 0
    let skippedArchived = 0
    const insert = this.db.prepare(
      `INSERT INTO finance_employees (name, open_id, department, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    const rows = this.db.prepare('SELECT * FROM finance_employees').all() as EmployeeRow[]
    const seen = new Set<string>()
    for (const row of rows) {
      if (row.open_id === '') continue
      seen.add(row.open_id)
      const platform = byOpenId.get(row.open_id)
      if (platform === undefined) continue
      if (row.archived_at !== null) {
        skippedArchived++
        continue
      }
      const nextDept = platform.department !== '' ? platform.department : row.department
      if (platform.name !== row.name || nextDept !== row.department) {
        this.db.prepare('UPDATE finance_employees SET name=?, department=?, updated_at=?, updated_by=? WHERE id=?')
          .run(platform.name, nextDept, nowIso(), actor.username, row.id)
        updated++
      }
    }
    // 平台新面孔：与在册手工行（open_id 空）同名的不建第二条——同一真人两条带薪名册会双算
    // （审查 P2-3）；报出来让人在名册里填 open_id 绑定，下次同步自然接上
    const manualByName = new Map<string, number>()
    for (const r of rows) {
      if (r.open_id === '' && r.archived_at === null) manualByName.set(r.name, (manualByName.get(r.name) ?? 0) + 1)
    }
    const pendingBind: Array<{ name: string; open_id: string }> = []
    for (const [openId, platform] of byOpenId) {
      if (seen.has(openId)) continue
      if (manualByName.has(platform.name)) {
        pendingBind.push({ name: platform.name, open_id: openId })
        continue
      }
      insert.run(platform.name, openId, platform.department, nowIso(), actor.username, nowIso(), actor.username)
      created++
    }
    // 平台里查无此 open_id 的在册员工：名单交给人判断（离职/换号/权限不可见都可能）
    const missing = rows
      .filter((r) => r.open_id !== '' && r.archived_at === null && !byOpenId.has(r.open_id))
      .map((r) => r.name)
    this.audit.log({
      username: actor.username,
      source: actor.source,
      action: 'payroll.roster.sync',
      targetId: '-',
      detail: { created, updated, skipped_archived: skippedArchived, missing_on_platform: missing.length, pending_bind: pendingBind.length, truncated, root_members: rootMembers },
    })
    const notes = ['同步只更新姓名/部门，不碰工资参数；平台里查无此人不会自动标离职，请人工确认后填离职日期。']
    if (pendingBind.length > 0) notes.push('同名的手工登记员工没有再建一条：到名册里编辑那个人、填上 open_id 即完成绑定。')
    if (rootMembers === 'unavailable') notes.push('根部门直属成员（不在任何子部门的人）平台拒绝查询，这些人请手工登记。')
    if (truncated) notes.push('平台名单触到分页护栏，可能不全——「查无此人」名单据此打折看。')
    return {
      created,
      updated,
      skipped_archived: skippedArchived,
      missing_on_platform: missing,
      pending_bind: pendingBind,
      truncated,
      root_members: rootMembers,
      note: notes.join(' '),
    }
  }

  private payslipYears(employeeId: number): string[] {
    return (this.db.prepare('SELECT DISTINCT substr(month,1,4) AS y FROM finance_payslips WHERE employee_id = ?').all(employeeId) as { y: string }[])
      .map((r) => r.y)
  }

  private hasPayslipsInYear(employeeId: number, year: string): boolean {
    const row = this.db.prepare('SELECT 1 AS x FROM finance_payslips WHERE employee_id = ? AND substr(month,1,4) = ? LIMIT 1').get(employeeId, year)
    return row !== undefined
  }

  private requireName(value: unknown): string {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new BadRequestError('姓名必填（收到空值）。')
    }
    return value.trim()
  }

  private requireOpenIdFree(openId: string, exceptId?: number): void {
    const row = (exceptId === undefined
      ? this.db.prepare('SELECT id FROM finance_employees WHERE open_id = ?').get(openId)
      : this.db.prepare('SELECT id FROM finance_employees WHERE open_id = ? AND id != ?').get(openId, exceptId)) as { id: number } | undefined
    if (row !== undefined) {
      throw new BadRequestError(`open_id ${openId} 已经绑在另一位员工身上（id=${row.id}），一个人只能有一条名册记录。`)
    }
  }

  private optionalDate(value: unknown, fallback: string, label: string): string {
    if (value === undefined) return fallback
    return parseDate(typeof value === 'string' ? value : undefined, label) ?? ''
  }

  private moneyAndDateFields(input: EmployeeInput): {
    open_id: string
    department: string
    hire_date: string
    leave_date: string
    base_salary_cents: number
    social_cents: number
    extra_deduct_cents: number
    note: string
  } {
    const openId = typeof input.open_id === 'string' ? input.open_id.trim() : ''
    const department = typeof input.department === 'string' ? input.department.trim() : ''
    const hire = parseDate(typeof input.hire_date === 'string' ? input.hire_date : undefined, '入职日期') ?? ''
    const leave = parseDate(typeof input.leave_date === 'string' ? input.leave_date : undefined, '离职日期') ?? ''
    if (hire !== '' && leave !== '' && leave < hire) {
      throw new BadRequestError(`离职日期（${leave}）不能早于入职日期（${hire}）。`)
    }
    return {
      open_id: openId,
      department,
      hire_date: hire,
      leave_date: leave,
      base_salary_cents: yuanToCents(parseAmount(input.base_salary as number | string | undefined ?? 0, '默认应发工资', true)),
      social_cents: yuanToCents(parseAmount(input.social as number | string | undefined ?? 0, '个人社保公积金（月）', true)),
      extra_deduct_cents: yuanToCents(parseAmount(input.extra_deduct as number | string | undefined ?? 0, '专项附加扣除（月）', true)),
      note: typeof input.note === 'string' ? input.note.trim() : '',
    }
  }
}

function toRecord(row: EmployeeRow): EmployeeRecord {
  return {
    id: row.id,
    name: row.name,
    open_id: row.open_id,
    department: row.department,
    hire_date: row.hire_date,
    leave_date: row.leave_date,
    base_salary: centsToYuan(row.base_salary_cents),
    social: centsToYuan(row.social_cents),
    extra_deduct: centsToYuan(row.extra_deduct_cents),
    note: row.note,
    created_at: row.created_at,
    created_by: row.created_by,
    updated_at: row.updated_at,
    updated_by: row.updated_by,
    archived_at: row.archived_at,
  }
}

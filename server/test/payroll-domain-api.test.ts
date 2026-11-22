/** 工资域 HTTP 全链路（2026-11-01 财务残余 A3）：
 *  权限分离（payroll 独立权限点，finance:read 不解锁工资）/ 名册 CRUD 与校验 /
 *  平台通讯录同步（身份只动身份字段、工资参数永不被冲掉、平台查无此人只报告）/
 *  工资单生成与累计预扣链（start_month 按入职、离职当月仍在、链子不许跳改）/
 *  确认锁定/撤回/删除规则/跨年清零/审计。 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import bcrypt from 'bcryptjs'

process.env.ADMIN_DATA_DIR = mkdtempSync(join(tmpdir(), 'admin-payroll-domain-test-'))
delete process.env.ADMIN_JWT_SECRET

const { createRuntimeModule, registerAuthMiddleware } = await import('../src/app.module.js')
const { config } = await import('../src/config.js')

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** 平台假件按真机探针契约形状写（坑 15 教训：不照实现抄）；成员列表可在用例间改。 */
let fakeMembers: Array<{ name: string; open_id: string; department_ids: string[] }> = []
/** 根部门（department_id=0）直属成员：默认无；'error' 模拟平台拒绝根查询。 */
let fakeRootMembers: Array<{ name: string; open_id: string; department_ids: string[] }> | 'error' = []
const fakeFetch: typeof fetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
  const url = String(input)
  const rawPath = url.includes('/open-apis') ? url.slice(url.indexOf('/open-apis') + '/open-apis'.length) : url
  const path = rawPath.includes('?') ? rawPath.slice(0, rawPath.indexOf('?')) : rawPath
  const u = new URL(url)
  if (path === '/auth/v3/tenant_access_token/internal') {
    return jsonRes({ code: 0, msg: 'ok', tenant_access_token: 't-1', expire: 7200 })
  }
  if (path === '/contact/v3/departments/0/children') {
    return jsonRes({
      code: 0,
      data: { items: [{ department_id: 'd1', open_department_id: 'od-d1', name: '技术部', member_count: fakeMembers.length, parent_department_id: '0' }], has_more: false },
    })
  }
  if (path === '/contact/v3/users/find_by_department') {
    if (u.searchParams.get('department_id') === '0') {
      if (fakeRootMembers === 'error') return jsonRes({ code: 99992357, msg: 'not a valid {open_department_id}' })
      return jsonRes({ code: 0, data: { items: fakeRootMembers, has_more: false } })
    }
    return jsonRes({ code: 0, data: { items: fakeMembers, has_more: false } })
  }
  return jsonRes({ code: 99991663, msg: 'fake: unknown path' }, 200)
}

describe('工资域（A3 名册+工资单）', () => {
  let app: import('@nestjs/common').INestApplication
  let base: string
  let token: string
  let clerkToken = ''
  let db: import('better-sqlite3').Database
  let platformData: { setFetchFn(fn: typeof fetch): void }

  const get = (path: string, withToken = token) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${withToken}` } })
  const send = (method: string, path: string, body?: unknown, withToken = token) =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${withToken}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

  let jia = 0 // 甲：2025-03 入职，参数全齐
  let yi = 0 // 乙：2026-03-10 入职（年中入职 start_month）
  let bing = 0 // 丙：2026-02-05 离职（离职当月仍有工资）
  let ding = 0 // 丁：手工登记带 open_id（平台里没有，同步时进 missing 名单）

  before(async () => {
    const { dynamicModule, services } = createRuntimeModule()
    db = services.db
    platformData = services.platformData as unknown as { setFetchFn(fn: typeof fetch): void }
    platformData.setFetchFn(fakeFetch)
    // 记账员：只有 finance:read——验证工资面不被一般财务读写解锁（权限分离的意义所在）
    db.prepare(
      'INSERT INTO users (username, password_hash, display_name, is_service, created_at) VALUES (?, ?, ?, 0, ?)',
    ).run('clerk-pay', bcrypt.hashSync('Clerk-Pay-Pass-1', 10), '记账员', new Date().toISOString())
    app = await (await import('@nestjs/core')).NestFactory.create(dynamicModule, { logger: false })
    registerAuthMiddleware(app, services.auth)
    await app.listen(0, '127.0.0.1')
    const address = app.getHttpServer().address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    base = `http://127.0.0.1:${port}`
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'boss', password: config.bossInitialPassword }),
    })
    token = ((await res.json()) as { token: string }).token
    await send('POST', '/api/rbac/roles', { name: 'ledger-only', permissions: ['finance:read'] })
    await send('POST', '/api/rbac/users/clerk-pay/roles', { role: 'ledger-only' })
    const clerkLogin = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'clerk-pay', password: 'Clerk-Pay-Pass-1' }),
    })
    clerkToken = ((await clerkLogin.json()) as { token: string }).token
  })

  after(async () => {
    await app.close()
    rmSync(process.env.ADMIN_DATA_DIR!, { recursive: true, force: true })
  })

  test('权限分离：无令牌 401；finance:read 解锁不了工资面（403）', async () => {
    assert.equal((await fetch(`${base}/api/finance/employees`)).status, 401)
    assert.equal((await fetch(`${base}/api/finance/payslips?month=2026-01`)).status, 401)
    assert.equal((await get('/api/finance/employees', clerkToken)).status, 403, '记账员只有 finance:read')
    assert.equal((await get('/api/finance/payslips?month=2026-01', clerkToken)).status, 403)
    assert.equal((await send('POST', '/api/finance/payslips/generate', { month: '2026-01' }, clerkToken)).status, 403)
    assert.equal((await send('POST', '/api/finance/employees/sync', undefined, clerkToken)).status, 403)
    assert.equal((await get('/api/finance/employees')).status, 200, 'boss 全权')
  })

  test('名册 CRUD：姓名必填/金额非负/离职不早于入职/open_id 唯一/归档软删', async () => {
    assert.equal((await send('POST', '/api/finance/employees', { name: '  ' })).status, 400)
    assert.equal((await send('POST', '/api/finance/employees', { name: '甲', base_salary: -1 })).status, 400)
    assert.equal((await send('POST', '/api/finance/employees', { name: '甲', hire_date: '2025-03-01', leave_date: '2025-01-01' })).status, 400)
    const jiaRes = (await (await send('POST', '/api/finance/employees', {
      name: '甲', department: '技术部', hire_date: '2025-03-01',
      base_salary: 10000, social: 2000, extra_deduct: 1000,
    })).json()) as { id: number; base_salary: number }
    jia = jiaRes.id
    assert.equal(jiaRes.base_salary, 10000)
    const yiRes = (await (await send('POST', '/api/finance/employees', {
      name: '乙', department: '技术部', hire_date: '2026-03-10', base_salary: 8000, social: 1000,
    })).json()) as { id: number }
    yi = yiRes.id
    const bingRes = (await (await send('POST', '/api/finance/employees', {
      name: '丙', hire_date: '2024-01-01', leave_date: '2026-02-05', base_salary: 9000, social: 1500,
    })).json()) as { id: number }
    bing = bingRes.id
    // 丁的入职日期放远期：留在名册（供同步用例的 missing_on_platform 断言），但不进后面任何月份的工资表
    const dingRes = (await (await send('POST', '/api/finance/employees', { name: '丁', open_id: 'ou-old', base_salary: 5000, hire_date: '2030-01-01' })).json()) as { id: number }
    ding = dingRes.id
    assert.equal((await send('POST', '/api/finance/employees', { name: '戊', open_id: 'ou-old' })).status, 400, 'open_id 一人一条')
    const moved = (await (await send('PATCH', `/api/finance/employees/${yi}`, { department: '市场部' })).json()) as { department: string }
    assert.equal(moved.department, '市场部')
    assert.equal((await send('PATCH', `/api/finance/employees/${yi}`, { leave_date: '2026-01-01' })).status, 400, '离职早于入职')
    const gone = (await (await send('POST', '/api/finance/employees', { name: '己', base_salary: 1 })).json()) as { id: number }
    await send('DELETE', `/api/finance/employees/${gone.id}`)
    const list = (await (await get('/api/finance/employees')).json()) as { employees: { id: number }[]; count: number }
    assert.ok(!list.employees.some((e) => e.id === gone.id), '归档后默认名单不含')
    const all = (await (await get('/api/finance/employees?include_archived=true')).json()) as { employees: { id: number }[] }
    assert.ok(all.employees.some((e) => e.id === gone.id), '显式带归档可见')
    assert.equal((await get(`/api/finance/payslips?employee_id=${jia}&year=2026`, clerkToken)).status, 403)
  })

  test('平台同步：只动身份字段不碰工资参数；幂等；平台查无此人只报告', async () => {
    fakeMembers = [
      { name: '金一', open_id: 'ou-1', department_ids: ['0', 'od-d1'] },
      { name: '金二', open_id: 'ou-2', department_ids: ['od-d1'] },
    ]
    const first = (await (await send('POST', '/api/finance/employees/sync')).json()) as { created: number; updated: number; missing_on_platform: string[] }
    assert.equal(first.created, 2, '金一金二进名册')
    assert.ok(first.missing_on_platform.includes('丁'), '平台里没有丁：报告不自动处理')
    const roster = (await (await get('/api/finance/employees')).json()) as { employees: Array<{ id: number; name: string; open_id: string; department: string; base_salary: number }> }
    const jin1 = roster.employees.find((e) => e.open_id === 'ou-1')!
    assert.equal(jin1.name, '金一')
    assert.equal(jin1.department, '技术部')
    assert.equal(jin1.base_salary, 0, '同步来的新员工工资参数为 0，等老板填')
    // 第二次：幂等
    const second = (await (await send('POST', '/api/finance/employees/sync')).json()) as { created: number; updated: number }
    assert.equal(second.created, 0)
    assert.equal(second.updated, 0)
    // 填工资参数 → 平台改名/调部门 → 再同步：身份更新、工资参数原样
    await send('PATCH', `/api/finance/employees/${jin1.id}`, { base_salary: 12345 })
    fakeMembers = [{ name: '金一改', open_id: 'ou-1', department_ids: ['od-d1'] }]
    const third = (await (await send('POST', '/api/finance/employees/sync')).json()) as { updated: number; created: number }
    assert.equal(third.created, 0)
    assert.equal(third.updated, 1)
    const after = (await (await get('/api/finance/employees')).json()) as { employees: Array<{ id: number; name: string; department: string; base_salary: number }> }
    const jin1After = after.employees.find((e) => e.name === '金一改')!
    assert.equal(jin1After.department, '技术部')
    assert.equal(jin1After.base_salary, 12345, '工资参数绝不被同步冲掉')
    // 归档两位平台来的员工：后面的工资表用例只看甲乙丙丁，顺带验证"归档不进工资表"
    for (const e of after.employees.filter((x) => x.name === '金一改' || x.name === '金二')) {
      assert.equal((await send('DELETE', `/api/finance/employees/${e.id}`)).status, 200)
    }
    // 归档后再同步：平台里还有金一改 → 不复活不更新，skipped_archived 计数如实
    const fourth = (await (await send('POST', '/api/finance/employees/sync')).json()) as { created: number; updated: number; skipped_archived: number }
    assert.equal(fourth.created, 0, '归档的人不会被同步重新建一条')
    assert.equal(fourth.skipped_archived, 1)
  })

  test('生成与累计预扣链：入职月起算/离职当月仍在/此前累计=同年此前工资单之和', async () => {
    const jan = (await (await send('POST', '/api/finance/payslips/generate', { month: '2026-01' })).json()) as {
      created: number; count: number; totals: { gross: number; tax: number }
    }
    assert.equal(jan.created, 2, '甲丙在册；乙还没入职')
    assert.equal(jan.totals.tax, 135, '甲 60 + 丙 75')
    const feb = (await (await send('POST', '/api/finance/payslips/generate', { month: '2026-02' })).json()) as { created: number; count: number }
    assert.equal(feb.created, 2, '丙离职当月（02-05）仍有工资')
    const mar = (await (await send('POST', '/api/finance/payslips/generate', { month: '2026-03' })).json()) as { created: number; count: number }
    assert.equal(mar.created, 2, '乙入职当月（03-10）起算；丙已离职不生成')
    const again = (await (await send('POST', '/api/finance/payslips/generate', { month: '2026-03' })).json()) as { created: number; skipped: number }
    assert.equal(again.created, 0, '重跑不覆盖已有数')
    assert.equal(again.skipped, 2)
    // 逐单核对：甲 1 月（累计预扣第 1 档 3%，应纳税所得 2000 → 60）
    const jiaJan = (await (await get(`/api/finance/payslips?employee_id=${jia}&year=2026`)).json()) as {
      rows: Array<{ month: string; months_count: number; gross: number; gross_prev: number; withheld_prev: number; taxable_cum: number; tax: number; net: number }>
    }
    assert.deepEqual(jiaJan.rows.map((r) => r.month), ['2026-01', '2026-02', '2026-03'])
    const r1 = jiaJan.rows[0]!
    assert.equal(r1.months_count, 1, '2025 年入职：减除费用从 1 月起算')
    assert.equal(r1.taxable_cum, 2000)
    assert.equal(r1.tax, 60)
    assert.equal(r1.net, 7940)
    const r3 = jiaJan.rows[2]!
    assert.equal(r3.months_count, 3)
    assert.equal(r3.gross_prev, 20000, '1+2 月应发之和')
    assert.equal(r3.withheld_prev, 120, '1+2 月已预扣之和')
    assert.equal(r3.taxable_cum, 6000, '30000−15000−6000−3000')
    assert.equal(r3.tax, 60, '累计税 180 − 已预扣 120')
    // 乙 3 月：年中入职 start_month=3，months_count=1
    const yiRows = (await (await get(`/api/finance/payslips?employee_id=${yi}&year=2026`)).json()) as { rows: Array<{ months_count: number; tax: number }> }
    assert.equal(yiRows.rows.length, 1)
    assert.equal(yiRows.rows[0]!.months_count, 1)
    assert.equal(yiRows.rows[0]!.tax, 60, '8000−5000−1000=2000 → 3%')
    // 工资表合计
    const febReg = (await (await get('/api/finance/payslips?month=2026-02')).json()) as { count: number; totals: { gross: number } }
    assert.equal(febReg.count, 2)
    assert.equal(febReg.totals.gross, 19000, '甲 10000 + 丙 9000')
  })

  test('一致性规则：后面月份挂着不许改前面；只许删同年最后一月的草稿；确认锁定可撤回', async () => {
    const reg1 = (await (await get('/api/finance/payslips?month=2026-01')).json()) as { rows: Array<{ id: number; employee_name: string }> }
    const jiaJanId = reg1.rows.find((r) => r.employee_name === '甲')!.id
    const reg3 = (await (await get('/api/finance/payslips?month=2026-03')).json()) as { rows: Array<{ id: number; employee_name: string; status: string }> }
    const jiaMarId = reg3.rows.find((r) => r.employee_name === '甲')!.id
    assert.equal((await send('PATCH', `/api/finance/payslips/${jiaJanId}`, { gross: 11000 })).status, 400, '后面月份还在，1 月锁死')
    // 删 3 月（同年最后一月）→ 2 月可改，3 月重生成拿到新的累计
    assert.equal((await send('DELETE', `/api/finance/payslips/${jiaMarId}`)).status, 200)
    const reg2 = (await (await get('/api/finance/payslips?month=2026-02')).json()) as { rows: Array<{ id: number; employee_name: string }> }
    const jiaFebId = reg2.rows.find((r) => r.employee_name === '甲')!.id
    assert.equal((await send('PATCH', `/api/finance/payslips/${jiaJanId}`, { gross: 11000 })).status, 400, '2 月还在，1 月仍锁死')
    const edited = (await (await send('PATCH', `/api/finance/payslips/${jiaFebId}`, { gross: 12000 })).json()) as { gross: number; tax: number }
    assert.equal(edited.gross, 12000)
    assert.equal(edited.tax, 120, '重算：累计收入 22000−减除 10000−社保 4000−附加 2000=6000 → 累计税 180−已预扣 60=120（1 月从未改过，仍是 60）')
    const marAgain = (await (await send('POST', '/api/finance/payslips/generate', { month: '2026-03' })).json()) as { created: number; skipped: number }
    assert.equal(marAgain.created, 1, '只删了甲的 3 月：重生成只新出甲一张，乙那张原样')
    assert.equal(marAgain.skipped, 1)
    const jiaRows = (await (await get(`/api/finance/payslips?employee_id=${jia}&year=2026`)).json()) as { rows: Array<{ month: string; withheld_prev: number; gross_prev: number }> }
    const r3b = jiaRows.rows[2]!
    assert.equal(r3b.gross_prev, 22000, '10000（1 月，从未改过）+12000（2 月改后）')
    assert.equal(r3b.withheld_prev, 180, '1 月 60 + 2 月 120')
    // 确认锁定 → 撤回 → 删除链
    assert.equal((await send('POST', `/api/finance/payslips/${jiaMarId}`)).status, 404, '3 月是重生成的单，旧 id 已不在')
    const marRows = (await (await get('/api/finance/payslips?month=2026-03')).json()) as { rows: Array<{ id: number; employee_name: string }> }
    const jiaMar2 = marRows.rows.find((r) => r.employee_name === '甲')!.id
    const confirmed = (await (await send('POST', `/api/finance/payslips/${jiaMar2}/confirm`)).json()) as { status: string }
    assert.equal(confirmed.status, 'confirmed')
    assert.equal((await send('PATCH', `/api/finance/payslips/${jiaMar2}`, { gross: 1 })).status, 400, '确认后锁定')
    assert.equal((await send('DELETE', `/api/finance/payslips/${jiaMar2}`)).status, 400, '确认后不能删')
    const reopened = (await (await send('POST', `/api/finance/payslips/${jiaMar2}/unconfirm`)).json()) as { status: string }
    assert.equal(reopened.status, 'draft')
    assert.equal((await send('DELETE', `/api/finance/payslips/${jiaMar2}`)).status, 200)
  })

  test('跨年清零、没填参数不出单、审计', async () => {
    // 庚：刚同步进来还没填默认应发——不能静默出一张 0 元单，要按名字报出来
    await send('POST', '/api/finance/employees', { name: '庚', hire_date: '2026-06-01' })
    const next = (await (await send('POST', '/api/finance/payslips/generate', { month: '2027-01' })).json()) as { created: number; skipped_no_salary: string[] }
    assert.equal(next.created, 2, '甲乙在册；丙 2026-02 已离职、丁入职日期在远期、庚没填参数')
    assert.deepEqual(next.skipped_no_salary, ['庚'])
    const jia2027 = (await (await get(`/api/finance/payslips?employee_id=${jia}&year=2027`)).json()) as { rows: Array<{ months_count: number; withheld_prev: number; gross_prev: number; tax: number }> }
    assert.equal(jia2027.rows.length, 1)
    assert.equal(jia2027.rows[0]!.months_count, 1)
    assert.equal(jia2027.rows[0]!.withheld_prev, 0, '跨年累计清零')
    assert.equal(jia2027.rows[0]!.gross_prev, 0)
    assert.equal(jia2027.rows[0]!.tax, 60, '按名册默认参数重新起算')
    const audit = (await (await get('/api/audit?limit=200')).json()) as { items: Array<{ action: string }> }
    const actions = new Set(audit.items.map((i) => i.action))
    for (const expected of ['payroll.employee.create', 'payroll.employee.update', 'payroll.employee.archive', 'payroll.roster.sync', 'payroll.payslip.generate', 'payroll.payslip.update', 'payroll.payslip.confirm', 'payroll.payslip.unconfirm', 'payroll.payslip.delete']) {
      assert.ok(actions.has(expected), `审计缺 ${expected}`)
    }
  })

  test('审查修复：乱序生成被挡并点名、入职日期空着照出但点名；改入职/离职日期守门；归档只读可恢复', async () => {
    const ren = (await (await send('POST', '/api/finance/employees', { name: '壬', hire_date: '2024-01-01', base_salary: 7000 })).json()) as { id: number }
    const gui = (await (await send('POST', '/api/finance/employees', { name: '癸', base_salary: 6000 })).json()) as { id: number }
    // 2028 年从 3 月先出（1/2 月还没出）——出得了，但入职日期空着的癸要被点名
    const mar = (await (await send('POST', '/api/finance/payslips/generate', { month: '2028-03' })).json()) as { created: number; no_hire_date: string[]; skipped_out_of_order: unknown[] }
    assert.ok(mar.created >= 2)
    assert.deepEqual(mar.no_hire_date, ['癸'], '入职日期空=按 1 月起算减除，必须点名')
    assert.deepEqual(mar.skipped_out_of_order, [])
    // 回头补 1 月：所有在 3 月已有单的人都被挡住并点名（P1-1：生成也守链）
    const jan = (await (await send('POST', '/api/finance/payslips/generate', { month: '2028-01' })).json()) as { created: number; skipped_out_of_order: Array<{ name: string; later_month: string }> }
    assert.equal(jan.created, 0)
    assert.ok(jan.skipped_out_of_order.some((x) => x.name === '壬' && x.later_month === '2028-03'))
    assert.ok(jan.skipped_out_of_order.some((x) => x.name === '癸'))
    // P1-2：改入职日期——受影响年份有单就拒；换到没单的年份放行
    assert.equal((await send('PATCH', `/api/finance/employees/${ren.id}`, { hire_date: '2028-02-01' })).status, 400, '2028 有单，入职改进 2028 拒')
    assert.equal((await send('PATCH', `/api/finance/employees/${ren.id}`, { hire_date: '2023-06-01' })).status, 200, '2023/2024 都没单，放行')
    assert.equal((await send('PATCH', `/api/finance/employees/${gui.id}`, { hire_date: '2028-01-15' })).status, 400, '原来空=所有已出单按 1 月起算，任何有单年份都受影响')
    // 离职日期不能早于已出单月份
    assert.equal((await send('PATCH', `/api/finance/employees/${ren.id}`, { leave_date: '2028-02-28' })).status, 400)
    assert.equal((await send('PATCH', `/api/finance/employees/${ren.id}`, { leave_date: '2028-03-31' })).status, 200)
    // P3-4：归档=只读；恢复后可改
    await send('DELETE', `/api/finance/employees/${gui.id}`)
    assert.equal((await send('PATCH', `/api/finance/employees/${gui.id}`, { note: 'x' })).status, 400, '归档行 API 也拒改')
    const back = (await (await send('POST', `/api/finance/employees/${gui.id}/unarchive`)).json()) as { archived_at: null | string }
    assert.equal(back.archived_at, null)
    assert.equal((await send('PATCH', `/api/finance/employees/${gui.id}`, { note: 'x' })).status, 200)
    const audit = (await (await get('/api/audit?limit=50')).json()) as { items: Array<{ action: string }> }
    assert.ok(audit.items.some((i) => i.action === 'payroll.employee.unarchive'))
  })

  test('审查修复：同步与手工同名行不建重复而是报出待绑定；根部门直属成员并入、平台拒绝时如实标注；成员级截断并入 truncated', async () => {
    await send('POST', '/api/finance/employees', { name: '辛', base_salary: 5000, hire_date: '2030-01-01' })
    fakeMembers = [{ name: '辛', open_id: 'ou-xin', department_ids: ['od-d1'] }]
    fakeRootMembers = [{ name: '老板', open_id: 'ou-boss', department_ids: ['0'] }]
    const r1 = (await (await send('POST', '/api/finance/employees/sync')).json()) as {
      created: number; pending_bind: Array<{ name: string; open_id: string }>; root_members: string
    }
    assert.deepEqual(r1.pending_bind, [{ name: '辛', open_id: 'ou-xin' }], '同名手工行：不建第二条，报出等人绑定')
    assert.equal(r1.root_members, 'synced')
    const roster = (await (await get('/api/finance/employees')).json()) as { employees: Array<{ id: number; name: string; open_id: string; department: string }> }
    assert.equal(roster.employees.filter((e) => e.name === '辛').length, 1, '没有重复的辛')
    const boss = roster.employees.find((e) => e.open_id === 'ou-boss')
    assert.ok(boss !== undefined && boss.name === '老板', '根部门直属成员也进名册')
    assert.equal(r1.created, 1, '只新建了老板')
    // 人工绑定后再同步：不再待绑定，部门按平台更新
    const xin = roster.employees.find((e) => e.name === '辛')!
    await send('PATCH', `/api/finance/employees/${xin.id}`, { open_id: 'ou-xin' })
    const r2 = (await (await send('POST', '/api/finance/employees/sync')).json()) as { created: number; updated: number; pending_bind: unknown[] }
    assert.deepEqual(r2.pending_bind, [])
    assert.equal(r2.created, 0)
    assert.equal(r2.updated, 1, '辛的部门从空更新为技术部')
    // 平台拒绝根查询：整次同步不失败，root_members 如实标 unavailable
    fakeRootMembers = 'error'
    const r3 = (await (await send('POST', '/api/finance/employees/sync')).json()) as { root_members: string; note: string }
    assert.equal(r3.root_members, 'unavailable')
    assert.match(r3.note, /手工登记/)
    // 成员级截断：单部门 501 人触 CONTACT_CAP → truncated 必须透出（P2-1）
    fakeRootMembers = []
    fakeMembers = Array.from({ length: 501 }, (_, i) => ({ name: `临${i}`, open_id: `ou-bulk-${i}`, department_ids: ['od-d1'] }))
    const r4 = (await (await send('POST', '/api/finance/employees/sync')).json()) as { truncated: boolean; note: string }
    assert.equal(r4.truncated, true)
    assert.match(r4.note, /分页护栏/)
  })

  test('期初累计（用户拍板：前面没有按 0、有数开账）：并入此前累计、覆盖月不再出单、改/删守门、校验/权限/审计', async () => {
    type Row = {
      id: number; employee_id: number; months_count: number; gross_prev: number; social_prev: number; extra_prev: number;
      withheld_prev: number; taxable_cum: number; tax: number; net: number
    }
    const mk = async (body: unknown) => ((await (await send('POST', '/api/finance/employees', body)).json()) as { id: number }).id
    const gen = async (month: string) =>
      (await (await send('POST', '/api/finance/payslips/generate', { month })).json()) as {
        rows: Row[]; skipped_in_opening: Array<{ name: string; through_month: string }>
      }
    const zi = await mk({ name: '子', hire_date: '2025-06-01', base_salary: 10000, social: 1000, extra_deduct: 1000 })
    const chou = await mk({ name: '丑', hire_date: '2029-08-15', base_salary: 8000 })
    const O = '/api/finance/payslips/opening'
    // 校验：年份非四位 / through_month 不在该年 / 负数 / 早于本年入职月 / 权限分离
    assert.equal((await send('PUT', O, { employee_id: zi, year: '29', through_month: '2029-10' })).status, 400)
    assert.equal((await send('PUT', O, { employee_id: zi, year: '2029', through_month: '2028-10' })).status, 400)
    assert.equal((await send('PUT', O, { employee_id: zi, year: '2029', through_month: '2029-10', gross: -1 })).status, 400)
    assert.equal((await send('PUT', O, { employee_id: chou, year: '2029', through_month: '2029-05' })).status, 400, '入职前不可能有累计')
    assert.equal((await send('PUT', O, { employee_id: zi, year: '2029', through_month: '2029-10' }, clerkToken)).status, 403, 'finance:read 不解锁工资写')
    assert.equal((await fetch(`${base}${O}?employee_id=${zi}&year=2029`)).status, 401)
    // 没有期初的人读到 null（前端据此显示"未开账"）
    const none = (await (await get(`${O}?employee_id=${chou}&year=2029`)).json()) as { opening: unknown }
    assert.equal(none.opening, null)
    // 开账：截至 10 月末累计应发 100000 / 个人社保 10000 / 专项附加 10000 / 已预扣 600（全 0 也合法=前面按 0 登记）
    const put = await send('PUT', O, { employee_id: zi, year: '2029', through_month: '2029-10', gross: 100000, social: 10000, extra_deduct: 10000, withheld: 600, note: '年中启用' })
    assert.equal(put.status, 200, await put.text())
    const got = (await (await get(`${O}?employee_id=${zi}&year=2029`)).json()) as { opening: { through_month: string; gross: number; withheld: number; note: string } }
    assert.equal(got.opening.through_month, '2029-10')
    assert.equal(got.opening.gross, 100000)
    assert.equal(got.opening.withheld, 600)
    assert.equal(got.opening.note, '年中启用')
    // 覆盖月及之前不再出单（否则双计）：10 月被点名跳过
    const g10 = await gen('2029-10')
    assert.ok(g10.skipped_in_opening.some((x) => x.name === '子' && x.through_month === '2029-10'), '期初已覆盖 10 月')
    assert.ok(!g10.rows.some((r) => r.employee_id === zi))
    // 11 月出单：此前累计 = 期初（没有更早的单）；计税月数 11（2025 年入职 → 本年 1 月起算）
    const z11 = (await gen('2029-11')).rows.find((r) => r.employee_id === zi)!
    assert.equal(z11.months_count, 11)
    assert.deepEqual([z11.gross_prev, z11.social_prev, z11.extra_prev, z11.withheld_prev], [100000, 10000, 10000, 600])
    // 110000 − 5000×11 − 11000 − 11000 = 33000 → 3% = 990，减已预扣 600 = 390；实发 10000 − 1000 − 390 = 8610
    assert.deepEqual([z11.taxable_cum, z11.tax, z11.net], [33000, 390, 8610])
    // 该年已有单：改/删期初被挡（已出的单是按旧期初算的快照）
    assert.equal((await send('PUT', O, { employee_id: zi, year: '2029', through_month: '2029-10', gross: 120000 })).status, 400)
    assert.equal((await send('DELETE', `${O}?employee_id=${zi}&year=2029`)).status, 400)
    // 删掉 11 月单 → 改期初 → 重出：130000 − 55000 − 22000 = 53000 → 10% − 2520 = 2780，减 600 = 2180；实发 6820
    assert.equal((await send('DELETE', `/api/finance/payslips/${z11.id}`)).status, 200)
    assert.equal((await send('PUT', O, { employee_id: zi, year: '2029', through_month: '2029-10', gross: 120000, social: 10000, extra_deduct: 10000, withheld: 600 })).status, 200)
    const z11b = (await gen('2029-11')).rows.find((r) => r.employee_id === zi)!
    assert.deepEqual([z11b.taxable_cum, z11b.tax, z11b.net], [53000, 2180, 6820])
    // 12 月：此前累计 = 期初 + 11 月单（链子接上，已预扣 600 + 2180）
    const z12 = (await gen('2029-12')).rows.find((r) => r.employee_id === zi)!
    assert.equal(z12.gross_prev, 130000)
    assert.equal(z12.withheld_prev, 2780)
    // 从最后一月起逐张删掉后才能删期初；审计两类动作在场、不落备注正文
    assert.equal((await send('DELETE', `/api/finance/payslips/${z12.id}`)).status, 200)
    assert.equal((await send('DELETE', `/api/finance/payslips/${z11b.id}`)).status, 200)
    assert.equal((await send('DELETE', `${O}?employee_id=${zi}&year=2029`)).status, 200)
    assert.equal((await send('DELETE', `${O}?employee_id=${zi}&year=2029`)).status, 404, '删过就没有了')
    const audit = (await (await get('/api/audit?limit=200')).json()) as { items: Array<{ action: string; targetId?: string; target_id?: string }> }
    const actions = new Set(audit.items.map((i) => i.action))
    assert.ok(actions.has('payroll.opening.set') && actions.has('payroll.opening.delete'))
  })
})

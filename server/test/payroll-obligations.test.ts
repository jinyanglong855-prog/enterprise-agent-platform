/** 工资域义务扫描（2026-11-02 财务线残余 A4/A5/A6）：
 *  名册 vs 飞书通讯录差异（平台查无此人/新面孔/同名待绑定；info 不推卡；平台出错整轮报错不闭合；源头消失自动闭合）/
 *  社保公积金增减员（离职→次月 15 日前减员、入职→30 日内增员；窗口外/归档/未来入职不进场；办没办系统无从得知
 *  → closeOnAbsence=false：归档不自动闭合，「已完成」无备注=unverifiable、force+备注=forced）/
 *  建档参数变化（四项与 app_meta 快照比对；首轮只记基线；改了出一条隔轮不消失；同键当日再改并进同行；四项之外不报）。
 *  平台读走假 fetch（真机契约形状），卡片走 mock 桥可断言，时钟注入。 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ADMIN_DATA_DIR = mkdtempSync(join(tmpdir(), 'admin-payroll-obligations-test-'))
delete process.env.ADMIN_JWT_SECRET
process.env.ADMIN_BRIDGE_ENABLED = '1'
process.env.ADMIN_BRIDGE_ADAPTER = 'mock'
// 通讯录比对扫描器有凭据守卫（没配就不撞网）；本用例全程假 fetch，凭据内容无所谓
process.env.ADMIN_FEISHU_APP_ID = 'cli_test'
process.env.ADMIN_FEISHU_APP_SECRET = 'sec_test'

const { buildServices, createRuntimeModule, registerAuthMiddleware } = await import('../src/app.module.js')
const { config } = await import('../src/config.js')
const { BridgeService } = await import('../src/bridge/bridge.service.js')
const { MockAdapter } = await import('../src/bridge/mock.adapter.js')
const { ObligationScannerService } = await import('../src/todos/obligation-scanner.service.js')
const { addDaysISO, localDate } = await import('../src/todos/todos.service.js')
import type { INestApplication } from '@nestjs/common'
import type { Services } from '../src/app.module.js'
import type { MockAdapter as MockAdapterType } from '../src/bridge/mock.adapter.js'
import type { BridgeService as BridgeServiceType } from '../src/bridge/bridge.service.js'
import type { ObligationScannerService as ScannerType } from '../src/todos/obligation-scanner.service.js'

function jsonRes(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

/** 平台假件（形状照真机探针契约）：技术部成员可在用例间改；platformDown=true 时通讯录接口整体报错。 */
let fakeMembers: Array<{ name: string; open_id: string; department_ids: string[] }> = []
let platformDown = false
let rootDown = false
const fakeFetch: typeof fetch = async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
  const url = String(input)
  const rawPath = url.slice(url.indexOf('/open-apis') + '/open-apis'.length)
  const path = rawPath.includes('?') ? rawPath.slice(0, rawPath.indexOf('?')) : rawPath
  const u = new URL(url)
  if (path === '/auth/v3/tenant_access_token/internal') return jsonRes({ code: 0, msg: 'ok', tenant_access_token: 't-1', expire: 7200 })
  if (platformDown) return jsonRes({ code: 99991663, msg: 'fake: platform down' })
  if (path === '/contact/v3/departments/0/children') {
    return jsonRes({
      code: 0,
      data: { items: [{ department_id: 'd1', open_department_id: 'od-d1', name: '技术部', member_count: fakeMembers.length, parent_department_id: '0' }], has_more: false },
    })
  }
  if (path === '/contact/v3/users/find_by_department') {
    if (u.searchParams.get('department_id') === '0') {
      if (rootDown) return jsonRes({ code: 99992357, msg: 'not a valid {open_department_id}' })
      return jsonRes({ code: 0, data: { items: [], has_more: false } })
    }
    return jsonRes({ code: 0, data: { items: fakeMembers, has_more: false } })
  }
  return jsonRes({ code: 99991663, msg: `fake: unknown path ${path}` })
}

describe('工资域义务扫描（名册差异 / 社保增减员 / 建档参数）', () => {
  let app: INestApplication
  let base: string
  let services: Services
  let mock: InstanceType<typeof MockAdapterType>
  let bridge: InstanceType<typeof BridgeServiceType>
  let scanner: InstanceType<typeof ScannerType>
  let db: Services['db']
  let token: string
  const ACTOR = { username: 'boss', source: 'ui' as const }

  type Row = { id: number; status: string; title: string; detail: string; severity: string; due_date: string; source_ref: string }
  const row = (key: string): Row | undefined =>
    db.prepare('SELECT id, status, title, detail, severity, due_date, source_ref FROM obligations WHERE dedupe_key = ?').get(key) as Row | undefined
  const result = (summary: Awaited<ReturnType<ScannerType['runAll']>>, key: string) => {
    const r = summary.scanners.find((s) => s.scanner === key)
    assert.ok(r !== undefined, `应有扫描器 ${key} 的结果`)
    return r
  }
  const insertEmployee = (e: { name: string; open_id?: string; hire?: string; leave?: string; archived?: boolean }): number => {
    const ts = new Date().toISOString()
    const r = db
      .prepare(
        `INSERT INTO finance_employees (name, open_id, department, hire_date, leave_date, base_salary_cents, created_at, created_by, updated_at, updated_by, archived_at)
         VALUES (?, ?, '', ?, ?, 800000, ?, 'boss', ?, 'boss', ?)`,
      )
      .run(e.name, e.open_id ?? '', e.hire ?? '', e.leave ?? '', ts, ts, e.archived === true ? ts : null)
    return Number(r.lastInsertRowid)
  }
  const hdr = () => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' })

  before(async () => {
    const real = buildServices()
    db = real.db
    real.platformData.setFetchFn(fakeFetch)
    mock = new MockAdapter()
    await mock.start()
    bridge = new BridgeService(real.db, real.audit, real.proposals, real.agent, real.rbac, real.todos)
    bridge.registerAdapter(mock)
    await bridge.start()
    scanner = new ObligationScannerService(real.db, real.rbac, real.finance, real.invoices, real.proposals, bridge, real.todos, real.supply, real.roster)
    services = { ...real, bridge, obligationScanner: scanner }
    const { dynamicModule } = createRuntimeModule(services)
    const { NestFactory } = await import('@nestjs/core')
    app = await NestFactory.create(dynamicModule, { logger: false })
    registerAuthMiddleware(app, services.auth)
    await app.listen(0, '127.0.0.1')
    const address = app.getHttpServer().address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    base = `http://127.0.0.1:${port}`
    db.prepare(`INSERT INTO bridge_identities (platform, platform_userid, username, allowed, created_at) VALUES ('mock', 'ou_boss', 'boss', 1, ?)`).run(
      new Date().toISOString(),
    )
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'boss', password: config.bossInitialPassword }),
    })
    token = ((await res.json()) as { token: string }).token
  })

  after(async () => {
    await bridge.shutdown()
    await app.close()
    rmSync(process.env.ADMIN_DATA_DIR!, { recursive: true, force: true })
  })

  test('名册 vs 通讯录：三类差异进场、info 不推卡；平台出错整轮报错不闭合；源头消失逐条自动闭合', async () => {
    insertEmployee({ name: '张三', open_id: 'ou_z', hire: '2025-01-05' })
    insertEmployee({ name: '李四', open_id: 'ou_l', hire: '2025-02-05' })
    insertEmployee({ name: '赵六', hire: '2025-03-05' }) // 手工行：没 open_id
    fakeMembers = [
      { name: '张三', open_id: 'ou_z', department_ids: ['od-d1'] },
      { name: '王五', open_id: 'ou_w', department_ids: ['od-d1'] },
      { name: '赵六', open_id: 'ou_zh', department_ids: ['od-d1'] },
    ]
    const cardsBefore = mock.userCards.length
    const r1 = await scanner.runAll('manual')
    const roster = result(r1, 'scan.payroll.roster')
    assert.equal(roster.error, undefined, `通讯录比对不该报错：${roster.error ?? ''}`)
    assert.equal(roster.created, 3, '平台查无此人一 / 新面孔一 / 同名待绑定一')
    const missing = row('scan.payroll.roster:missing:ou_l')
    assert.ok(missing !== undefined && missing.status === 'open')
    assert.match(missing.title, /李四 已不在飞书通讯录/)
    assert.equal(missing.severity, 'warn')
    assert.deepEqual(JSON.parse(missing.source_ref), { employeeId: 2, openId: 'ou_l' })
    const fresh = row('scan.payroll.roster:new:ou_w')
    assert.ok(fresh !== undefined)
    assert.match(fresh.title, /新面孔 王五（技术部） 未进工资名册/)
    assert.equal(fresh.severity, 'warn')
    const bind = row('scan.payroll.roster:bind:ou_zh')
    assert.ok(bind !== undefined)
    assert.equal(bind.severity, 'info', '同名待绑定只进待办中心')
    assert.match(bind.title, /赵六 疑似名册里的同名手工行/)
    const pushed = mock.userCards.slice(cardsBefore).filter((c) => c.card.kind === 'todo-item')
    assert.equal(pushed.filter((c) => c.card.todoId === missing.id).length, 1, '查无此人 warn 推卡')
    assert.equal(pushed.filter((c) => c.card.todoId === fresh.id).length, 1, '新面孔 warn 推卡')
    assert.equal(pushed.filter((c) => c.card.todoId === bind.id).length, 0, 'info 不推卡')

    // 平台出错：整轮落 error，三条一条不闭合（审查教训：出错当"没了"会假闭合）
    platformDown = true
    const r2 = await scanner.runAll('manual')
    const down = result(r2, 'scan.payroll.roster')
    assert.ok(typeof down.error === 'string' && down.error.includes('查部门树'), `平台出错应落在 error：${down.error ?? ''}`)
    assert.equal(down.autoResolved, 0)
    assert.equal(row('scan.payroll.roster:missing:ou_l')!.status, 'open')
    assert.equal(row('scan.payroll.roster:new:ou_w')!.status, 'open')
    platformDown = false
    // 根部门直属成员拉不到（应用缺权限是常见态）：视图不完整也整轮报错，不把这些人误判成离职（审查 P2-1）
    rootDown = true
    const r2b = await scanner.runAll('manual')
    const partial = result(r2b, 'scan.payroll.roster')
    assert.ok(typeof partial.error === 'string' && partial.error.includes('根部门'), `视图不完整应整轮报错：${partial.error ?? ''}`)
    assert.equal(partial.autoResolved, 0)
    assert.equal(row('scan.payroll.roster:missing:ou_l')!.status, 'open')
    rootDown = false

    // 源头消失逐条闭合：李四回到通讯录 / 赵六填上 open_id / 王五从飞书同步建档
    fakeMembers.push({ name: '李四', open_id: 'ou_l', department_ids: ['od-d1'] })
    db.prepare("UPDATE finance_employees SET open_id = 'ou_zh' WHERE name = '赵六'").run()
    await services.roster.syncFromPlatform(ACTOR)
    assert.ok(db.prepare("SELECT id FROM finance_employees WHERE open_id = 'ou_w'").get() !== undefined, '同步应把王五建进名册')
    const r3 = await scanner.runAll('manual')
    const after3 = result(r3, 'scan.payroll.roster')
    assert.equal(after3.error, undefined)
    assert.equal(after3.found, 0, '三类源头都没了')
    assert.equal(after3.autoResolved, 3)
    for (const key of ['scan.payroll.roster:missing:ou_l', 'scan.payroll.roster:new:ou_w', 'scan.payroll.roster:bind:ou_zh']) {
      assert.equal(row(key)!.status, 'resolved', `${key} 应自动闭合`)
    }
  })

  test('社保增减员：离职→次月 15 日前减员、入职→30 日内增员；窗口外/归档/未来入职不进场；归档不自动闭合；「已完成」要备注强制确认', async () => {
    const now = new Date()
    const today = localDate(now)
    const leave = addDaysISO(today, -10)
    const hire = addDaysISO(today, -5)
    const jia = insertEmployee({ name: '甲', open_id: 'ou_jia', hire: '2024-06-01', leave })
    const yi = insertEmployee({ name: '乙', open_id: 'ou_yi', hire })
    insertEmployee({ name: '丙', open_id: 'ou_bing', hire: '2023-01-01', leave: addDaysISO(today, -120) }) // 离职超 90 天：窗口外
    insertEmployee({ name: '丁', open_id: 'ou_ding', hire: addDaysISO(today, -3), archived: true }) // 已归档不进场
    insertEmployee({ name: '戊', open_id: 'ou_wu', hire: addDaysISO(today, 10) }) // 入职日在未来：还没到
    // 这几个人也放进通讯录，别让名册差异扫描器的候选混进本用例
    const ids = ['ou_jia', 'ou_yi', 'ou_bing', 'ou_ding', 'ou_wu']
    fakeMembers.push(...['甲', '乙', '丙', '丁', '戊'].map((n, i) => ({ name: n, open_id: ids[i]!, department_ids: ['od-d1'] })))
    const cardsBefore = mock.userCards.length
    const r1 = await scanner.runAll('manual', now)
    const social = result(r1, 'scan.payroll.social')
    assert.equal(social.error, undefined)
    assert.equal(social.created, 2, '只有甲（减员）乙（增员）进场')
    const [ly, lm] = leave.split('-').map(Number) as [number, number]
    const leaveDue = lm === 12 ? `${ly + 1}-01-15` : `${ly}-${String(lm + 1).padStart(2, '0')}-15`
    const reduce = row(`scan.payroll.social:leave:${jia}`)
    assert.ok(reduce !== undefined)
    assert.match(reduce.title, /甲 \d{4}-\d{2}-\d{2} 离职：办社保公积金减员 \+ 出最后一月工资单/)
    assert.equal(reduce.due_date, leaveDue, '减员截止=离职次月 15 日')
    assert.equal(reduce.severity, today > leaveDue ? 'critical' : 'warn')
    assert.deepEqual(JSON.parse(reduce.source_ref), { employeeId: jia })
    const add = row(`scan.payroll.social:hire:${yi}`)
    assert.ok(add !== undefined)
    assert.match(add.title, /乙 \d{4}-\d{2}-\d{2} 入职：办社保公积金增员（入职 30 日内）/)
    assert.equal(add.due_date, addDaysISO(hire, 30), '增员截止=入职+30 天')
    assert.equal(add.severity, 'warn')
    const pushed = mock.userCards.slice(cardsBefore).filter((c) => c.card.kind === 'todo-item')
    assert.equal(pushed.filter((c) => c.card.todoId === reduce.id || c.card.todoId === add.id).length, 2, '两条都推即时卡')

    // 归档甲（办完减员后的常规动作）：候选里消失，但 closeOnAbsence=false → 行不动
    db.prepare('UPDATE finance_employees SET archived_at = ? WHERE id = ?').run(new Date().toISOString(), jia)
    const r2 = await scanner.runAll('manual', now)
    const s2 = result(r2, 'scan.payroll.social')
    assert.equal(s2.found, 1, '只剩乙的增员')
    assert.equal(s2.autoResolved, 0, '外部动作类义务不因源头缺席闭合')
    assert.equal(row(`scan.payroll.social:leave:${jia}`)!.status, reduce.status, '减员行状态不变')

    // 「已完成」：无备注 → unverifiable（告诉人要备注）；force+备注 → forced（dismissed）
    const d1 = await fetch(`${base}/api/todos/${reduce.id}/done`, { method: 'POST', headers: hdr(), body: '{}' })
    assert.equal(d1.status, 201)
    const b1 = (await d1.json()) as { outcome: string; message?: string }
    assert.equal(b1.outcome, 'unverifiable')
    assert.match(b1.message ?? '', /社保增减员/)
    assert.equal(row(`scan.payroll.social:leave:${jia}`)!.status, reduce.status, '无备注不关')
    const d2 = await fetch(`${base}/api/todos/${reduce.id}/done`, {
      method: 'POST',
      headers: hdr(),
      body: JSON.stringify({ force: true, note: '已在社保网厅办减员' }),
    })
    assert.equal(d2.status, 201)
    assert.equal(((await d2.json()) as { outcome: string }).outcome, 'forced')
    assert.equal(row(`scan.payroll.social:leave:${jia}`)!.status, 'dismissed')
    // 关了之后再扫不重开（dismissed 是人给过的"别再报"）——哪怕把归档撤回让源头重现
    db.prepare('UPDATE finance_employees SET archived_at = NULL WHERE id = ?').run(jia)
    await scanner.runAll('manual', now)
    assert.equal(row(`scan.payroll.social:leave:${jia}`)!.status, 'dismissed')
  })

  test('建档参数：首轮只记基线；改了出一条且隔轮不消失；同键当日再改并进同行刷新口径；四项之外不报', async () => {
    const snap = (): Record<string, string> =>
      JSON.parse((db.prepare("SELECT value FROM app_meta WHERE key = 'finance.profile_snapshot'").get() as { value: string }).value) as Record<string, string>
    assert.deepEqual(Object.keys(snap()).sort(), ['主体类型', '征收方式', '纳税人身份', '纳税期限'].sort(), '前两个用例的扫描已记基线')
    assert.equal(snap()['纳税人身份'], services.finance.profileGet().profile['纳税人身份'] ?? '', '基线=当时的值')
    const count = () => (db.prepare("SELECT COUNT(*) AS n FROM obligations WHERE source_type = 'scan.finance.profile'").get() as { n: number }).n
    assert.equal(count(), 0, '记基线那轮不报')

    const now = new Date()
    const today = localDate(now)
    services.finance.profileSet(ACTOR, '纳税人身份', '一般纳税人')
    const cardsBefore = mock.userCards.length
    const r1 = await scanner.runAll('manual', now)
    const p1 = result(r1, 'scan.finance.profile')
    assert.equal(p1.error, undefined)
    assert.equal(p1.created, 1)
    const key = `scan.finance.profile:纳税人身份:${today}`
    const first = row(key)
    assert.ok(first !== undefined && first.status === 'open')
    assert.match(first.title, /建档参数「纳税人身份」改了：（空） → 一般纳税人/)
    assert.match(first.detail, /小规模与一般纳税人不同/)
    assert.equal(first.severity, 'warn')
    assert.deepEqual(JSON.parse(first.source_ref), { profileKey: '纳税人身份', from: '', to: '一般纳税人' })
    assert.ok(mock.userCards.slice(cardsBefore).some((c) => c.card.kind === 'todo-item' && c.card.todoId === first.id), 'warn 进场推卡')
    assert.equal(snap()['纳税人身份'], '一般纳税人', '比对完快照即更新')

    // 隔轮：没新改动 → 不重报、不闭合（closeOnAbsence=false）
    const r2 = await scanner.runAll('manual', now)
    assert.equal(result(r2, 'scan.finance.profile').found, 0)
    assert.equal(result(r2, 'scan.finance.profile').autoResolved, 0)
    assert.equal(row(key)!.status, 'open')

    // 同键当日再改：同 dedupe 键 → 并进同行，口径刷新成最新一跳
    services.finance.profileSet(ACTOR, '纳税人身份', '小规模纳税人')
    const r3 = await scanner.runAll('manual', now)
    assert.equal(result(r3, 'scan.finance.profile').created, 0)
    assert.equal(result(r3, 'scan.finance.profile').deduped, 1)
    assert.match(row(key)!.title, /一般纳税人 → 小规模纳税人/)
    assert.equal(count(), 1)
    assert.equal(snap()['纳税人身份'], '小规模纳税人')

    // 四项之外的参数改了不报
    services.finance.profileSet(ACTOR, '代账联系人', '王会计')
    const r4 = await scanner.runAll('manual', now)
    assert.equal(result(r4, 'scan.finance.profile').found, 0)
    assert.equal(count(), 1)
  })
})

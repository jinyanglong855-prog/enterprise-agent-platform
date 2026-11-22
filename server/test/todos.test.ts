/**
 * 义务域全链路测试（2026-10-31 待办预警方案）：真实 Nest 路由 + mock 桥 + 临时库 + 注入时钟。
 * 覆盖：人工待办 CRUD 与可见性谓词（mine/pool/企业、不可见=404 不泄露存在性）、
 * 推导型「已完成」核实流程（源头消失/仍在/无法核实 + 强制确认必填备注）、推导型可改到期/严重度/责任人且扫描不覆盖、
 * 路由配置 boss 兜底与改绑、手动扫描幂等、
 * 扫描器进出场（应收到期/应付到期/提案积压/零角色/缺票）、状态跃迁即时卡、
 * 晨报一天一轮与 ack 静音、升级阶梯（1 天升级 + 第 3 天重推）。
 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import bcrypt from 'bcryptjs'

process.env.ADMIN_DATA_DIR = mkdtempSync(join(tmpdir(), 'admin-todos-test-'))
delete process.env.ADMIN_JWT_SECRET
process.env.ADMIN_BRIDGE_ENABLED = '1'
process.env.ADMIN_BRIDGE_ADAPTER = 'mock'

const appModule = await import('../src/app.module.js')
const { buildServices, createRuntimeModule, registerAuthMiddleware } = appModule
const { config } = await import('../src/config.js')
const { BridgeService } = await import('../src/bridge/bridge.service.js')
const { MockAdapter } = await import('../src/bridge/mock.adapter.js')
const { ObligationScannerService, parseDailyScanAt } = await import('../src/todos/obligation-scanner.service.js')
const { addDaysISO, localDate } = await import('../src/todos/todos.service.js')
import type { INestApplication } from '@nestjs/common'
import type { Services } from '../src/app.module.js'
import type { MockAdapter as MockAdapterType } from '../src/bridge/mock.adapter.js'
import type { BridgeService as BridgeServiceType } from '../src/bridge/bridge.service.js'
import type { ObligationScannerService as ScannerType } from '../src/todos/obligation-scanner.service.js'
import type { ObligationRow } from '../src/todos/todos.types.js'

const ymd = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const shiftDays = (days: number): string => {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return ymd(d)
}

describe('义务域（待办/扫描/晨报）', () => {
  let app: INestApplication
  let base: string
  let services: Services
  let mock: InstanceType<typeof MockAdapterType>
  let bridge: InstanceType<typeof BridgeServiceType>
  let scanner: InstanceType<typeof ScannerType>
  let bossToken: string
  let tdToken: string // tduser：持 td-role（todo:read+todo:write）
  let strangerToken: string // stranger：也有 todo 权限但与测试数据无关联（可见性反例）
  let nopermToken: string // noperm：有账号无角色——403 分支的真实反例
  let db: Services['db']

  async function login(username: string, password: string): Promise<string> {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    assert.equal(res.status, 201, `登录 ${username} 应成功`)
    return ((await res.json()) as { token: string }).token
  }

  const hdr = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' })

  function insertEntry(input: {
    id: string
    type: 'income' | 'expense'
    dueDate: string
    status?: string
    paidCents?: number
    counterparty?: string
  }): void {
    db.prepare(
      `INSERT INTO finance_entries (id, date, type, amount_cents, status, counterparty, due_date, paid_amount_cents, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'boss', ?, 'boss')`,
    ).run(
      input.id,
      shiftDays(-10),
      input.type,
      1_000_00,
      input.status ?? 'unpaid',
      input.counterparty ?? '测试对方',
      input.dueDate,
      input.paidCents ?? 0,
      new Date().toISOString(),
      new Date().toISOString(),
    )
  }

  before(async () => {
    const real = buildServices()
    db = real.db
    // 出站可断言的 mock 桥 + 注入时钟的扫描器：替换装配产物里对应的服务再建动态模块
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

    // td-role：义务域独立权限点的正面账号；stranger 同权限但与数据无关联
    const seed = db.transaction(() => {
      db.prepare('INSERT OR IGNORE INTO roles (name) VALUES (?)').run('td-role')
      const role = db.prepare('SELECT id FROM roles WHERE name = ?').get('td-role') as { id: number }
      for (const code of ['todo:read', 'todo:write']) {
        const p = db.prepare('SELECT id FROM permissions WHERE code = ?').get(code) as { id: number }
        db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)').run(role.id, p.id)
      }
      for (const name of ['tduser', 'stranger', 'noperm']) {
        db.prepare(
          'INSERT INTO users (username, password_hash, display_name, is_service, created_at) VALUES (?, ?, ?, 0, ?)',
        ).run(name, bcrypt.hashSync('test12345', 10), name, new Date().toISOString())
        // noperm：有账号没角色——403 分支的真实反例
        if (name === 'noperm') continue
        db.prepare(
          'INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES ((SELECT id FROM users WHERE username = ?), (SELECT id FROM roles WHERE name = ?))',
        ).run(name, 'td-role')
      }
      // 平台身份：boss 与 tduser 都能收单聊卡
      for (const [ou, username] of [
        ['ou_boss', 'boss'],
        ['ou_td', 'tduser'],
      ] as const) {
        db.prepare(
          `INSERT INTO bridge_identities (platform, platform_userid, username, allowed, created_at) VALUES ('mock', ?, ?, 1, ?)`,
        ).run(ou, username, new Date().toISOString())
      }
    })
    seed()

    bossToken = await login('boss', config.bossInitialPassword)
    tdToken = await login('tduser', 'test12345')
    strangerToken = await login('stranger', 'test12345')
    nopermToken = await login('noperm', 'test12345')
  })

  after(async () => {
    await bridge.shutdown()
    await app.close()
    rmSync(process.env.ADMIN_DATA_DIR!, { recursive: true, force: true })
  })

  test('权限点独立：无 todo:read 的请求 403；有权限的可见空列表', async () => {
    const noPerm = await fetch(`${base}/api/todos?scope=mine`, { headers: hdr(nopermToken) })
    assert.equal(noPerm.status, 403, '没有 todo:read 的账号 403')
    const noPermSummary = await fetch(`${base}/api/todos/summary`, { headers: hdr(nopermToken) })
    assert.equal(noPermSummary.status, 403)
    const noPermCreate = await fetch(`${base}/api/todos`, { method: 'POST', headers: hdr(nopermToken), body: JSON.stringify({ title: 'x' }) })
    assert.equal(noPermCreate.status, 403, '没有 todo:write 的账号建不了')
    assert.equal((await fetch(`${base}/api/todos?scope=mine`, { headers: hdr(bossToken) })).status, 200, 'boss 全权')
    // stranger 有 todo:read（td-role）
    const list = await fetch(`${base}/api/todos?scope=mine`, { headers: hdr(tdToken) })
    assert.equal(list.status, 200)
    const body = (await list.json()) as { items: unknown[] }
    assert.deepEqual(body.items, [])
  })

  let manualId = 0
  test('建人工待办：默认归自己，列表可见；审计不落标题', async () => {
    const res = await fetch(`${base}/api/todos`, {
      method: 'POST',
      headers: hdr(tdToken),
      body: JSON.stringify({ title: '给猫窝补货', detail: '抖音渠道', dueDate: shiftDays(1), severity: 'warn' }),
    })
    assert.equal(res.status, 201)
    const { item } = (await res.json()) as { item: ObligationRow }
    manualId = item.id
    assert.equal(item.origin, 'manual')
    assert.equal(item.owner_type, 'user')
    assert.equal(item.owner_id, 'tduser')
    assert.equal(item.status, 'open')
    const audits = db.prepare("SELECT detail FROM audit_log WHERE action = 'todo.created' AND target_id = ?").get(String(manualId)) as { detail: string }
    assert.ok(!audits.detail.includes('猫窝'), '审计不得记标题')
  })

  test('可见性谓词：owner/创建人可见，无关联的同权限账号 404 不泄露存在性', async () => {
    // stranger 与这条待办无任何关联：单条动作全 404
    for (const [method, path] of [
      ['PATCH', `/api/todos/${manualId}`],
      ['POST', `/api/todos/${manualId}/done`],
      ['POST', `/api/todos/${manualId}/dismiss`],
    ] as const) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: hdr(strangerToken),
        body: method === 'PATCH' ? JSON.stringify({ title: '偷改' }) : undefined,
      })
      assert.equal(res.status, 404, `${method} 应 404`)
    }
    const list = (await (await fetch(`${base}/api/todos?scope=mine`, { headers: hdr(strangerToken) })).json()) as { items: { id: number }[] }
    assert.ok(!list.items.some((i) => i.id === manualId), '他人待办不得出现在列表')
    // 企业视图是权限面（admin:manage），不是单条记录：403 明说缺权限点，不涉及存在性泄露
    const ent = await fetch(`${base}/api/todos?scope=enterprise`, { headers: hdr(strangerToken) })
    assert.equal(ent.status, 403)
    const entBoss = await fetch(`${base}/api/todos?scope=enterprise`, { headers: hdr(bossToken) })
    assert.equal(entBoss.status, 200)
  })

  test('岗位池：role 待办持岗人可见；summary 按到期分桶', async () => {
    const res = await fetch(`${base}/api/todos`, {
      method: 'POST',
      headers: hdr(bossToken),
      body: JSON.stringify({ title: '岗位池巡检', ownerType: 'role', ownerId: 'td-role', dueDate: shiftDays(-1), severity: 'critical' }),
    })
    assert.equal(res.status, 201)
    const pool = (await (await fetch(`${base}/api/todos?scope=pool`, { headers: hdr(tdToken) })).json()) as { items: { title: string }[] }
    assert.ok(pool.items.some((i) => i.title === '岗位池巡检'), '持岗人应能在池里看到')

    // summary：逾期（岗位池那条 critical，昨天到期）+ 今日（manual 明天? 不对——manual 是 +1 明天）
    const summary = (await (await fetch(`${base}/api/todos/summary`, { headers: hdr(tdToken) })).json()) as {
      overdue: number
      today: number
      upcoming7: number
    }
    assert.equal(summary.overdue, 1, '岗位池昨日到期的那条计逾期')
    assert.equal(summary.upcoming7, 1, 'manual 明天到期计未来 7 天')
  })

  test('推导型「已完成」先核实：源头不存在→resolved 并记谁按的；备注必填规则；关闭后不能再操作', async () => {
    db.prepare(
      `INSERT INTO obligations (source_type, source_ref, dedupe_key, title, detail, owner_type, owner_id, due_date, severity, status, origin, first_seen_at, created_at)
       VALUES ('scan.receivable', '{}', 'scan.receivable:X1:2026-01-01', '应收到期：测试 1000 元', '', 'user', 'boss', '2026-01-01', 'critical', 'open', 'scan', ?, ?)`,
    ).run(new Date().toISOString(), new Date().toISOString())
    const row = db.prepare("SELECT id FROM obligations WHERE dedupe_key = 'scan.receivable:X1:2026-01-01'").get() as { id: number }

    const noReason = await fetch(`${base}/api/todos/${row.id}/dismiss`, { method: 'POST', headers: hdr(bossToken), body: '{}' })
    assert.equal(noReason.status, 400, '静默/强制确认必须带备注')
    const forcedNoNote = await fetch(`${base}/api/todos/${row.id}/done`, {
      method: 'POST',
      headers: hdr(bossToken),
      body: JSON.stringify({ force: true }),
    })
    // 源头（账目 X1）根本不存在：哪怕带 force，核实在前——真没了就是 resolved，不落 dismissed
    assert.equal(forcedNoNote.status, 201)
    const verdict = (await forcedNoNote.json()) as { outcome: string; message?: string; item: ObligationRow }
    assert.equal(verdict.outcome, 'resolved')
    assert.equal(verdict.item.status, 'resolved')
    assert.equal(verdict.item.done_by, 'boss', '核实闭合要记谁按的')
    assert.match(verdict.message ?? '', /已核实/)

    const again = await fetch(`${base}/api/todos/${row.id}/done`, { method: 'POST', headers: hdr(bossToken) })
    assert.equal(again.status, 400, '已关闭的不能再操作')
    const dismissClosed = await fetch(`${base}/api/todos/${row.id}/dismiss`, {
      method: 'POST',
      headers: hdr(bossToken),
      body: JSON.stringify({ reason: '已线下催回' }),
    })
    assert.equal(dismissClosed.status, 400)
  })

  test('人工待办 done 带备注走得通（审计不落备注正文）；ack 落静音标记', async () => {
    const done = await fetch(`${base}/api/todos/${manualId}/done`, {
      method: 'POST',
      headers: hdr(tdToken),
      body: JSON.stringify({ note: '已补货 20 套' }),
    })
    assert.equal(done.status, 201)
    const body = (await done.json()) as { outcome: string; item: ObligationRow }
    assert.equal(body.outcome, 'done')
    assert.equal(body.item.status, 'done')
    assert.equal(body.item.done_note, '已补货 20 套')
    const audit = db.prepare("SELECT detail FROM audit_log WHERE action = 'todo.done' AND target_id = ?").get(String(manualId)) as { detail: string }
    assert.ok(!audit.detail.includes('补货'), '审计只记有无备注，不记备注正文')
    assert.match(audit.detail, /"hasNote":true/)

    // 空 body（老客户端/卡片旁路形状）也能完成：备注落空串
    const mk2 = await fetch(`${base}/api/todos`, {
      method: 'POST',
      headers: hdr(tdToken),
      body: JSON.stringify({ title: '无备注完成' }),
    })
    const id2 = ((await mk2.json()) as { item: ObligationRow }).item.id
    const bare = await fetch(`${base}/api/todos/${id2}/done`, { method: 'POST', headers: hdr(tdToken) })
    assert.equal(bare.status, 201)
    assert.equal(((await bare.json()) as { item: ObligationRow }).item.done_note, '')

    // ack：建一条自己的待办再按「暂不处理」，标记落 ack:（不靠此时有没有升级行）
    const mk = await fetch(`${base}/api/todos`, {
      method: 'POST',
      headers: hdr(tdToken),
      body: JSON.stringify({ title: '催供应商发货', dueDate: shiftDays(3) }),
    })
    const ackId = ((await mk.json()) as { item: ObligationRow }).item.id
    const ack = await fetch(`${base}/api/todos/${ackId}/ack`, { method: 'POST', headers: hdr(tdToken) })
    assert.equal(ack.status, 201)
    const r = db.prepare('SELECT last_notified FROM obligations WHERE id = ?').get(ackId) as { last_notified: string }
    assert.match(r.last_notified, /^ack:/)
  })

  test('路由配置：九来源 boss 兜底；改绑岗位并留审计', async () => {
    const routes = (await (await fetch(`${base}/api/todos/routes`, { headers: hdr(bossToken) })).json()) as {
      routes: { source_type: string; owner_id: string; enabled: number }[]
    }
    assert.equal(routes.routes.length, 12, '十二个内置扫描器（2026-11-01 生产域 +2，S5 批次临期 +1；2026-11-02 财务线残余 +3）')
    for (const r of routes.routes) {
      assert.equal(r.owner_id, 'boss', '未配置兜底 boss')
      assert.equal(r.enabled, 1)
    }
    const denied = await fetch(`${base}/api/todos/routes`, { headers: hdr(tdToken) })
    assert.equal(denied.status, 403, '路由配置要 admin:manage')

    const put = await fetch(`${base}/api/todos/routes/scan.receivable`, {
      method: 'PUT',
      headers: hdr(bossToken),
      body: JSON.stringify({ ownerType: 'role', ownerId: 'td-role' }),
    })
    assert.equal(put.status, 200)
    assert.equal(((await put.json()) as { route: { owner_id: string } }).route.owner_id, 'td-role')
    const audit = db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'todo.route.set'").get() as { n: number }
    assert.ok(audit.n >= 1)
    // 改回 boss（后续扫描器测试按 boss 收卡断言）
    await fetch(`${base}/api/todos/routes/scan.receivable`, {
      method: 'PUT',
      headers: hdr(bossToken),
      body: JSON.stringify({ ownerType: 'user', ownerId: 'boss' }),
    })
  })

  test('手动扫描：幂等；社保月缴进场；scan_runs 留痕；manual 触发不推晨报', async () => {
    const r1 = (await (await fetch(`${base}/api/todos/scan`, { method: 'POST', headers: hdr(bossToken) })).json()) as {
      trigger: string
      digest: string
      scanners: { scanner: string; found: number; created: number }[]
    }
    assert.equal(r1.trigger, 'manual')
    assert.equal(r1.digest, 'skipped')
    assert.equal(r1.scanners.length, 12, '十二个内置扫描器（2026-11-01 生产域 +2，S5 批次临期 +1；2026-11-02 财务线残余 名册/社保增减员/建档参数 +3）')
    const social = r1.scanners.find((s) => s.scanner === 'scan.filing')!
    // 征期预告窗口=+7 天：本月 15 日征期只在每月 8 号及以后进窗口（2026-11-01 跨月实证）——月初断言让位给窗口口径
    const dayOfMonth = new Date().getDate()
    if (dayOfMonth >= 9) {
      assert.ok(social.created >= 1, '档案为空也应至少有社保月缴一条')
    } else {
      assert.equal(social.created, 0, '月初 1–8 号：本月 15 日还没进 +7 天预告窗口，不该硬造')
    }
    const cardsBefore = mock.userCards.length
    const r2 = await scanner.runAll('manual')
    assert.equal(r2.scanners.reduce((n, s) => n + s.created, 0), 0, '第二轮全去重')
    assert.equal(r2.escalated, 0)
    assert.equal(r2.repushed, 0)
    const runs = (await (await fetch(`${base}/api/todos/scan-runs`, { headers: hdr(bossToken) })).json()) as { runs: unknown[] }
    assert.ok(runs.runs.length >= 2)
    assert.equal(mock.userCards.length, cardsBefore, '去重轮不推任何卡（活跃行口径刷新不重发）')
  })

  test('扫描器进出场：应收/应付/提案进场即推卡；付掉自动闭合；重开再进场', async () => {
    insertEntry({ id: 'FIN-T-001', type: 'income', dueDate: shiftDays(2), counterparty: '客户甲' }) // warn 进场
    insertEntry({ id: 'FIN-T-002', type: 'expense', dueDate: shiftDays(-3), status: 'partial', paidCents: 40_00, counterparty: '供应商乙' })
    db.prepare(
      `INSERT INTO finance_proposals (id, kind, payload, summary, status, created_at, created_by) VALUES ('PRP-T-1', 'single', '{}', '测试提案摘要', 'pending', ?, 'agent')`,
    ).run(new Date(Date.now() - 25 * 3600 * 1000).toISOString())
    const cardsBefore = mock.userCards.length

    const r1 = await scanner.runAll('manual')
    const created = r1.scanners.reduce((n, s) => n + s.created, 0)
    assert.ok(created >= 3, `应收+应付+提案至少三条（实际 ${created}）`)
    assert.ok(mock.userCards.length >= cardsBefore + 3, 'warn/critical 进场都应有即时卡')
    // 应付逾期 → 升级
    const escalated = db.prepare("SELECT status FROM obligations WHERE dedupe_key LIKE 'scan.payable:FIN-T-002%'").get() as { status: string }
    assert.equal(escalated.status, 'escalated', '到期已过的应付进场即升级')
    // 推导型 detail 携带剩余金额口径
    const ar = db.prepare("SELECT detail FROM obligations WHERE dedupe_key LIKE 'scan.receivable:FIN-T-001%'").get() as { detail: string }
    assert.match(ar.detail, /1000/, '应收剩余金额应为 1000 元')
    // 推导型即时卡不带「完成」按钮（核实式完成在待办中心做）
    const arId = (db.prepare("SELECT id FROM obligations WHERE dedupe_key LIKE 'scan.receivable:FIN-T-001%'").get() as { id: number }).id
    const arCard = mock.userCards.find((c) => c.card.kind === 'todo-item' && c.card.todoId === arId)
    assert.ok(arCard !== undefined, '应收进场应推过即时卡')
    assert.equal(arCard!.card.canDone, false, '推导型卡 canDone=false')

    // 同参数再扫：全去重，不新增卡
    const cardsMid = mock.userCards.length
    await scanner.runAll('manual')
    assert.equal(mock.userCards.length, cardsMid, '去重轮不重推')

    // 付掉应收 → 自动闭合；再翻回未清 → 重开
    db.prepare("UPDATE finance_entries SET status = 'paid', paid_amount_cents = 1_000_00 WHERE id = 'FIN-T-001'").run()
    await scanner.runAll('manual')
    assert.equal((db.prepare("SELECT status FROM obligations WHERE dedupe_key LIKE 'scan.receivable:FIN-T-001%'").get() as { status: string }).status, 'resolved')
    db.prepare("UPDATE finance_entries SET status = 'unpaid', paid_amount_cents = 0 WHERE id = 'FIN-T-001'").run()
    await scanner.runAll('manual')
    assert.equal((db.prepare("SELECT status FROM obligations WHERE dedupe_key LIKE 'scan.receivable:FIN-T-001%'").get() as { status: string }).status, 'open', '源头重现应重开')
  })

  test('路由改绑移交活跃推导项：应收改到岗位 → 已在场的应收待办进岗位池；改回老板同样移交', async () => {
    const active = () =>
      db
        .prepare("SELECT owner_type, owner_id FROM obligations WHERE dedupe_key LIKE 'scan.receivable:FIN-T-001%' AND status IN ('open','escalated')")
        .get() as { owner_type: string; owner_id: string }
    assert.deepEqual(active(), { owner_type: 'user', owner_id: 'boss' }, '前置：应收待办当前归老板')
    const poolBefore = (await (await fetch(`${base}/api/todos?scope=pool`, { headers: hdr(tdToken) })).json()) as { items: { id: number; source_type: string }[] }
    assert.equal(poolBefore.items.filter((i) => i.source_type === 'scan.receivable').length, 0, '前置：岗位池里没有应收')

    const put = await fetch(`${base}/api/todos/routes/scan.receivable`, {
      method: 'PUT',
      headers: hdr(bossToken),
      body: JSON.stringify({ ownerType: 'role', ownerId: 'td-role' }),
    })
    assert.equal(put.status, 200)
    assert.deepEqual(active(), { owner_type: 'role', owner_id: 'td-role' }, '活跃应收待办随路由移交岗位')
    const poolAfter = (await (await fetch(`${base}/api/todos?scope=pool`, { headers: hdr(tdToken) })).json()) as { items: { id: number; source_type: string }[] }
    assert.ok(poolAfter.items.some((i) => i.source_type === 'scan.receivable'), '岗位成员在岗位池看到移交来的应收')
    const audit = db.prepare("SELECT detail FROM audit_log WHERE action = 'todo.route.set' ORDER BY id DESC LIMIT 1").get() as { detail: string }
    assert.equal((JSON.parse(audit.detail) as { migrated: number }).migrated, 1, '审计记移交条数')

    // 改回老板：同样移交（后续晨报/升级测试按 boss 收卡断言）
    await fetch(`${base}/api/todos/routes/scan.receivable`, {
      method: 'PUT',
      headers: hdr(bossToken),
      body: JSON.stringify({ ownerType: 'user', ownerId: 'boss' }),
    })
    assert.deepEqual(active(), { owner_type: 'user', owner_id: 'boss' })
  })

  test('晨报一天一轮：schedule 推卡（老板带企业总览）；同日再跑 already；升级第 3 天重推、ack 静音', async () => {
    const itemCards = () => mock.userCards.filter((c) => c.card.kind === 'todo-item').length
    const before = mock.userCards.length
    const d1 = await scanner.runAll('schedule')
    assert.equal(d1.digest, 'sent')
    assert.ok(mock.userCards.length > before, '有 warn 项应推晨报')
    const digestCards = mock.userCards.filter((c) => c.card.kind === 'todo-digest')
    assert.ok(digestCards.length >= 2, 'boss 与 tduser 各一张（各有可见 warn 项）')
    const bossCard = digestCards.find((c) => c.openId === 'ou_boss')!
    assert.ok(
      bossCard.card.lines.some((l) => l.includes('企业总览')),
      '老板晨报带企业总览',
    )

    const d2 = await scanner.runAll('schedule')
    assert.equal(d2.digest, 'already', '同日不重发')
    const itemsAfterD2 = itemCards()

    // 应收翻成昨天到期 → 下一轮升级 + 推即时卡（esc:1）
    db.prepare("UPDATE finance_entries SET due_date = ? WHERE id = 'FIN-T-001'").run(shiftDays(-1))
    const tomorrow = new Date(Date.now() + 36 * 3600 * 1000)
    const d3 = await scanner.runAll('schedule', tomorrow)
    assert.ok(d3.escalated >= 1, '过期应收应升级')
    assert.ok(itemCards() > itemsAfterD2, '升级即时卡应推送')

    // 第 3 天阶梯重推（dedupe 含到期日：改期后是新行，老行已 resolved——必须按 escalated 取活跃行）
    const escRow = db
      .prepare("SELECT id FROM obligations WHERE dedupe_key LIKE 'scan.receivable:FIN-T-001%' AND status = 'escalated'")
      .get() as { id: number }
    const cardsFor = (id: number) => mock.userCards.filter((c) => c.card.kind === 'todo-item' && c.card.todoId === id).length
    db.prepare("UPDATE obligations SET last_notified = '' WHERE id = ?").run(escRow.id)
    const day3 = new Date(tomorrow.getTime() + 3 * 24 * 3600 * 1000)
    const itemsBeforeDay3 = itemCards()
    const rowCardsBeforeDay3 = cardsFor(escRow.id)
    const d4 = await scanner.runAll('schedule', day3)
    assert.ok(d4.repushed >= 1, '第 3 天应重推')
    assert.ok(itemCards() > itemsBeforeDay3)
    assert.equal(cardsFor(escRow.id), rowCardsBeforeDay3 + 1, '该项第 3 天恰推一张')
    const marker = () => (db.prepare('SELECT last_notified FROM obligations WHERE id = ?').get(escRow.id) as { last_notified: string }).last_notified
    assert.match(marker(), /^esc:s3:/, '阶段标记落为 s3')

    // ack 后静音：第 7 天本该 s7 重推，ack 过的项一张不推；只数该项的卡（其他升级项照常走阶梯）
    await fetch(`${base}/api/todos/${escRow.id}/ack`, { method: 'POST', headers: hdr(bossToken) })
    assert.match(marker(), /^ack:/, 'ack 落标')
    const rowCardsBeforeAck = cardsFor(escRow.id)
    const day7 = new Date(tomorrow.getTime() + 7 * 24 * 3600 * 1000)
    await scanner.runAll('schedule', day7)
    assert.equal(cardsFor(escRow.id), rowCardsBeforeAck, 'ack 后第 7 天不再重推该项')
    assert.match(marker(), /^ack:/, 'ack 标记不被阶梯覆盖')
  })

  test('卡片回写闭环：待办卡按钮经桥 → 服务 → 终态；推导型按"完成"被拒但卡面不误改；审计 source=bridge', async () => {
    // 推导型（应收）：ack 可，done 拒
    const derived = db.prepare("SELECT id FROM obligations WHERE dedupe_key LIKE 'scan.receivable:FIN-T-001%'").get() as { id: number }
    db.prepare("UPDATE obligations SET status = 'open', last_notified = '' WHERE id = ?").run(derived.id)
    const ackOutcome = await mock.emitCardAction({
      platform: 'mock',
      platformUserid: 'ou_boss',
      conversationId: 'oc_x',
      kind: 'todo',
      todoId: derived.id,
      action: 'ack',
    })
    assert.equal(ackOutcome, 'acked')
    assert.match(mock.texts.at(-1)?.text ?? '', /收到/)
    const doneOutcome = await mock.emitCardAction({
      platform: 'mock',
      platformUserid: 'ou_boss',
      conversationId: 'oc_x',
      kind: 'todo',
      todoId: derived.id,
      action: 'done',
    })
    assert.equal(doneOutcome, undefined, '推导型完成被拒：无终态可改脸')
    assert.match(mock.texts.at(-1)?.text ?? '', /源头/)

    // 人工待办：done → 终态 done；再点一遍照样回终态（卡面不会"变回去"）
    const created = (await (
      await fetch(`${base}/api/todos`, {
        method: 'POST',
        headers: hdr(bossToken),
        body: JSON.stringify({ title: '卡片完成验证' }),
      })
    ).json()) as { item: { id: number } }
    const first = await mock.emitCardAction({
      platform: 'mock',
      platformUserid: 'ou_boss',
      conversationId: 'oc_x',
      kind: 'todo',
      todoId: created.item.id,
      action: 'done',
    })
    assert.equal(first, 'done')
    assert.match(mock.texts.at(-1)?.text ?? '', /已完成：卡片完成验证/)
    const again = await mock.emitCardAction({
      platform: 'mock',
      platformUserid: 'ou_boss',
      conversationId: 'oc_x',
      kind: 'todo',
      todoId: created.item.id,
      action: 'done',
    })
    assert.equal(again, 'done', '已闭环再点：返回终态让卡面改脸')

    // 白名单外的平台用户：无回音、审计 reject
    const outsider = await mock.emitCardAction({
      platform: 'mock',
      platformUserid: 'ou_nobody',
      conversationId: 'oc_x',
      kind: 'todo',
      todoId: created.item.id,
      action: 'ack',
    })
    assert.equal(outsider, undefined)
    const audits = db
      .prepare("SELECT action, source, detail FROM audit_log WHERE action LIKE 'bridge.card.%' AND detail LIKE '%\"kind\":\"todo\"%' ORDER BY id")
      .all() as { action: string; source: string; detail: string }[]
    assert.ok(audits.some((a) => a.action === 'bridge.card.action' && a.source === 'bridge'))
    assert.ok(audits.some((a) => a.action === 'bridge.card.reject'), '白名单外应有 reject 审计')
    for (const a of audits) assert.ok(!a.detail.includes('卡片完成验证'), '审计不记待办标题')
  })

  // ---------- 2026-10-31 对抗审查修复钉住 ----------

  test('窗口滑出不假闭合：逾期 40 天的应收照样进场；征期行候选缺席不自动 resolved（closeOnAbsence=false）', async () => {
    insertEntry({ id: 'FIN-T-OLD', type: 'income', dueDate: shiftDays(-40), counterparty: '拖了很久的客户' })
    await scanner.runAll('manual')
    const old = db.prepare("SELECT status, severity FROM obligations WHERE dedupe_key LIKE 'scan.receivable:FIN-T-OLD%'").get() as
      | { status: string; severity: string }
      | undefined
    assert.ok(old !== undefined, '逾期 40 天的应收不能因为"窗口"而不在场')
    assert.equal(old.status, 'escalated')
    assert.equal(old.severity, 'critical')

    // 征期：把时钟拨到 120 天后——本月社保键不再是候选，但行必须还在（系统不知道缴没缴）
    const social = db
      .prepare("SELECT id, status FROM obligations WHERE dedupe_key = ? ")
      .get(`scan.filing:social:${localDate().slice(0, 7)}`) as { id: number; status: string } | undefined
    assert.ok(social !== undefined && (social.status === 'open' || social.status === 'escalated'), '前置：本月社保行活跃')
    const far = new Date(Date.now() + 120 * 86_400_000)
    const r = await scanner.runAll('manual', far)
    const filingRun = r.scanners.find((s) => s.scanner === 'scan.filing')!
    assert.equal(filingRun.autoResolved, 0, '征期扫描器不按缺席闭合')
    const after = db.prepare('SELECT status FROM obligations WHERE id = ?').get(social.id) as { status: string }
    assert.ok(after.status === 'open' || after.status === 'escalated', `社保行不能被滑出闭合（实际 ${after.status}）`)
    // 应收在远期时钟下依然是候选（无下限）：不被闭合
    const oldAfter = db.prepare("SELECT status FROM obligations WHERE dedupe_key LIKE 'scan.receivable:FIN-T-OLD%'").get() as { status: string }
    assert.equal(oldAfter.status, 'escalated')
  })

  test('缺票数用真实总数（total），不是 limit 裁过的 count', async () => {
    const month = localDate().slice(0, 7)
    for (const id of ['FIN-T-NOINV-1', 'FIN-T-NOINV-2']) {
      db.prepare(
        `INSERT INTO finance_entries (id, date, type, amount_cents, status, counterparty, due_date, paid_amount_cents, created_at, created_by, updated_at, updated_by)
         VALUES (?, ?, 'expense', 50000, 'paid', '供应商A', '', 50000, ?, 'boss', ?, 'boss')`,
      ).run(id, `${month}-02`, new Date().toISOString(), new Date().toISOString())
    }
    const expected = services.invoices.listMissing({ month, limit: 1 }).total
    assert.ok(expected >= 2, `前置：本月缺票至少 2 笔（实际 ${expected}）`)
    await scanner.runAll('manual')
    const row = db.prepare('SELECT title FROM obligations WHERE dedupe_key = ?').get(`scan.missing_invoice:${month}`) as { title: string }
    assert.match(row.title, new RegExp(`有 ${expected} 笔`), `标题应带真实总数 ${expected}（实际："${row.title}"）`)
  })

  test('新指派即时卡：建给岗位推给持岗人（带完成按钮）；建给自己不打扰', async () => {
    const itemCardsTo = (openId: string) => mock.userCards.filter((c) => c.openId === openId && c.card.kind === 'todo-item')
    const tdBefore = itemCardsTo('ou_td').length
    const mk = await fetch(`${base}/api/todos`, {
      method: 'POST',
      headers: hdr(bossToken),
      body: JSON.stringify({ title: '岗位任务：核对本月发票', ownerType: 'role', ownerId: 'td-role', dueDate: shiftDays(2), severity: 'info' }),
    })
    assert.equal(mk.status, 201)
    const created = ((await mk.json()) as { item: ObligationRow }).item
    const tdCards = itemCardsTo('ou_td')
    assert.equal(tdCards.length, tdBefore + 1, 'info 级人工待办也要推新指派卡（派活不能静默）')
    assert.equal(tdCards.at(-1)!.card.todoId, created.id)
    assert.equal(tdCards.at(-1)!.card.canDone, true, '人工待办卡带「完成」')

    const selfBefore = itemCardsTo('ou_td').length
    const self = await fetch(`${base}/api/todos`, {
      method: 'POST',
      headers: hdr(tdToken),
      body: JSON.stringify({ title: '自己记一下', dueDate: shiftDays(1) }),
    })
    assert.equal(self.status, 201)
    assert.equal(itemCardsTo('ou_td').length, selfBefore, '自己给自己建不推卡')
  })

  test('升级抄送老板：岗位待办逾期升级时，持岗人与老板各收一张', async () => {
    const itemCardsTo = (openId: string) => mock.userCards.filter((c) => c.openId === openId && c.card.kind === 'todo-item')
    const mk = await fetch(`${base}/api/todos`, {
      method: 'POST',
      headers: hdr(bossToken),
      body: JSON.stringify({ title: '岗位任务：昨天就该交的报表', ownerType: 'role', ownerId: 'td-role', dueDate: shiftDays(-1), severity: 'warn' }),
    })
    const created = ((await mk.json()) as { item: ObligationRow }).item
    const bossBefore = itemCardsTo('ou_boss').filter((c) => c.card.todoId === created.id).length
    const tdBefore = itemCardsTo('ou_td').filter((c) => c.card.todoId === created.id).length
    const r = await scanner.runAll('manual')
    assert.ok(r.escalated >= 1)
    assert.equal((db.prepare('SELECT status FROM obligations WHERE id = ?').get(created.id) as { status: string }).status, 'escalated')
    assert.equal(itemCardsTo('ou_td').filter((c) => c.card.todoId === created.id).length, tdBefore + 1, '持岗人收升级卡')
    assert.equal(itemCardsTo('ou_boss').filter((c) => c.card.todoId === created.id).length, bossBefore + 1, '老板抄送一张')
  })

  test('晨报：老板盘子干净也收企业总览；昨日全员切片用真实审计键出人话；扫描告警入卡；个人卡有昨日回顾', async () => {
    // 让老板名下没有活跃 warn/critical 项（记下来事后恢复）
    const muted = db
      .prepare("SELECT id FROM obligations WHERE owner_type = 'user' AND owner_id = 'boss' AND status IN ('open','escalated')")
      .all() as { id: number }[]
    db.prepare("UPDATE obligations SET status = 'dismissed' WHERE owner_type = 'user' AND owner_id = 'boss' AND status IN ('open','escalated')").run()
    const day = new Date(Date.now() + 30 * 86_400_000)
    const today = localDate(day)
    const yesterday = addDaysISO(today, -1)
    const ts = new Date(`${yesterday}T10:00:00`).toISOString()
    db.prepare("INSERT INTO audit_log (ts, username, source, action, target_id, detail, ok) VALUES (?, 'tduser', 'ui', 'finance.create', 'FIN-Y', '{}', 1)").run(ts)
    db.prepare("INSERT INTO audit_log (ts, username, source, action, target_id, detail, ok) VALUES (?, 'tduser', 'ui', 'finance.create', 'FIN-Z', '{}', 1)").run(ts)
    db.prepare("INSERT INTO audit_log (ts, username, source, action, target_id, detail, ok) VALUES (?, 'tduser', 'ui', 'auth.login', '', '{}', 1)").run(ts)
    db.prepare(
      `INSERT INTO scan_runs (scanner, ran_at, found, created, deduped, auto_resolved, errors, duration_ms)
       VALUES ('scan.filing', ?, 0, 0, 0, 0, '档案读取失败：模拟', 1)`,
    ).run(day.toISOString())
    try {
      const before = mock.userCards.length
      const r = await scanner.runAll('schedule', day)
      assert.equal(r.digest, 'sent')
      const digests = mock.userCards.slice(before).filter((c) => c.card.kind === 'todo-digest')
      const bossCard = digests.find((c) => c.openId === 'ou_boss')
      assert.ok(bossCard !== undefined, '老板个人没项也要收企业总览')
      assert.equal(bossCard.card.lines.filter((l) => l.startsWith('- ')).length, 0, '老板没有个人项')
      assert.ok(bossCard.card.lines.some((l) => l.includes('【企业总览】')), '企业总览在')
      const allLine = bossCard.card.lines.find((l) => l.startsWith('【昨日全员】'))
      assert.ok(allLine !== undefined, '昨日全员切片在')
      assert.match(allLine, /记账 2/, `审计键 finance.create 应映射成"记账"（实际："${allLine}"）`)
      assert.ok(!allLine.includes('auth.login') && !allLine.includes('登录'), '登录这类系统动作不进切片')
      assert.ok(bossCard.card.lines[0]!.startsWith('【扫描告警】'), `扫描告警置顶（实际首行："${bossCard.card.lines[0]}"）`)
      assert.match(bossCard.card.lines[0]!, /合规日历 1 次/)
      const tdCard = digests.find((c) => c.openId === 'ou_td')
      assert.ok(tdCard !== undefined, 'tduser 有岗位项应收卡')
      assert.ok(tdCard.card.lines.some((l) => l.startsWith('【昨日回顾】') && l.includes('记账 2')), '个人卡带昨日回顾一行')
      assert.ok(!tdCard.card.lines.some((l) => l.includes('企业总览')), '普通人不带企业总览')
    } finally {
      const restore = db.prepare("UPDATE obligations SET status = 'open' WHERE id = ?")
      for (const m of muted) restore.run(m.id)
    }
  })

  // ---------- 2026-10-31 二批：核实式完成 / 推导型可改三项 ----------

  test('推导型「已完成」核实流程：源头仍在→pending 且解除静音；源头付掉→resolved 带备注；强制确认→必填备注落 dismissed 且不翻案', async () => {
    insertEntry({ id: 'FIN-T-VERIFY', type: 'income', dueDate: shiftDays(-2), counterparty: '核实客户' })
    await scanner.runAll('manual')
    const row = db.prepare("SELECT id, status FROM obligations WHERE dedupe_key LIKE 'scan.receivable:FIN-T-VERIFY%'").get() as { id: number; status: string }
    assert.ok(row !== undefined, '前置：应收进场')

    // 先「暂不处理」静音，再按「已完成」：源头（账目仍未清）还在 → 不关、静音解除、告知现状
    const ack = await fetch(`${base}/api/todos/${row.id}/ack`, { method: 'POST', headers: hdr(bossToken) })
    assert.equal(ack.status, 201)
    const pending = await fetch(`${base}/api/todos/${row.id}/done`, { method: 'POST', headers: hdr(bossToken), body: '{}' })
    assert.equal(pending.status, 201)
    const p = (await pending.json()) as { outcome: string; message?: string; item: ObligationRow }
    assert.equal(p.outcome, 'pending')
    assert.ok(p.item.status === 'open' || p.item.status === 'escalated', '源头还在不能关')
    assert.match(p.message ?? '', /源头还在/)
    assert.equal(p.item.last_notified, '', '核实发现没完成：解除「暂不处理」静音，提醒恢复')

    // 无备注强制确认：400；带备注强制确认：dismissed（永久），审计 forced=true 且不含备注正文
    const forceNoNote = await fetch(`${base}/api/todos/${row.id}/done`, {
      method: 'POST',
      headers: hdr(bossToken),
      body: JSON.stringify({ force: true }),
    })
    assert.equal(forceNoNote.status, 400)
    assert.match(((await forceNoNote.json()) as { message: string }).message, /备注/)
    const forced = await fetch(`${base}/api/todos/${row.id}/done`, {
      method: 'POST',
      headers: hdr(bossToken),
      body: JSON.stringify({ force: true, note: '客户现金付清，账还没记' }),
    })
    assert.equal(forced.status, 201)
    const f = (await forced.json()) as { outcome: string; item: ObligationRow }
    assert.equal(f.outcome, 'forced')
    assert.equal(f.item.status, 'dismissed')
    assert.equal(f.item.dismissed_reason, '客户现金付清，账还没记')
    const audit = db
      .prepare("SELECT detail FROM audit_log WHERE action = 'todo.dismissed' AND target_id = ? ORDER BY id DESC LIMIT 1")
      .get(String(row.id)) as { detail: string }
    assert.match(audit.detail, /"forced":true/)
    assert.ok(!audit.detail.includes('现金'), '审计不落备注正文')
    // 源头还在（账目仍未清）但人已强制确认：下一轮扫描不翻案
    await scanner.runAll('manual')
    assert.equal((db.prepare('SELECT status FROM obligations WHERE id = ?').get(row.id) as { status: string }).status, 'dismissed')

    // 另一条：源头付掉后按「已完成」→ 核实通过，resolved，记谁按的与备注
    insertEntry({ id: 'FIN-T-VERIFY2', type: 'expense', dueDate: shiftDays(-1), counterparty: '核实供应商' })
    await scanner.runAll('manual')
    const row2 = db.prepare("SELECT id FROM obligations WHERE dedupe_key LIKE 'scan.payable:FIN-T-VERIFY2%'").get() as { id: number }
    db.prepare("UPDATE finance_entries SET status = 'paid', paid_amount_cents = amount_cents WHERE id = 'FIN-T-VERIFY2'").run()
    const ok = await fetch(`${base}/api/todos/${row2.id}/done`, {
      method: 'POST',
      headers: hdr(bossToken),
      body: JSON.stringify({ note: '已转账' }),
    })
    assert.equal(ok.status, 201)
    const o = (await ok.json()) as { outcome: string; item: ObligationRow }
    assert.equal(o.outcome, 'resolved')
    assert.equal(o.item.status, 'resolved')
    assert.equal(o.item.done_by, 'boss')
    assert.equal(o.item.done_note, '已转账')
  })

  test('征期这类系统无法核实：「已完成」→ unverifiable 不改状态；带备注 force → dismissed', async () => {
    const social = db
      .prepare("SELECT id FROM obligations WHERE dedupe_key = ? AND status IN ('open', 'escalated')")
      .get(`scan.filing:social:${localDate().slice(0, 7)}`) as { id: number } | undefined
    assert.ok(social !== undefined, '前置：本月社保行活跃')
    const first = await fetch(`${base}/api/todos/${social.id}/done`, { method: 'POST', headers: hdr(bossToken), body: '{}' })
    assert.equal(first.status, 201)
    const u = (await first.json()) as { outcome: string; message?: string; item: ObligationRow }
    assert.equal(u.outcome, 'unverifiable')
    assert.match(u.message ?? '', /无从核实/)
    assert.ok(u.item.status === 'open' || u.item.status === 'escalated', '无法核实不动状态')
    const confirmed = await fetch(`${base}/api/todos/${social.id}/done`, {
      method: 'POST',
      headers: hdr(bossToken),
      body: JSON.stringify({ force: true, note: '已在电子税务局申报并扣款' }),
    })
    assert.equal(confirmed.status, 201)
    const c = (await confirmed.json()) as { outcome: string; item: ObligationRow }
    assert.equal(c.outcome, 'forced')
    assert.equal(c.item.status, 'dismissed')
    assert.equal(c.item.dismissed_reason, '已在电子税务局申报并扣款')
    // 恢复成活跃，别影响后面依赖本月社保行的用例
    db.prepare("UPDATE obligations SET status = 'open', dismissed_by = '', dismissed_reason = '', dismissed_at = NULL WHERE id = ?").run(social.id)
  })

  test('推导型可改到期/严重度/责任人：改标题被拒；改过的三项扫描刷新不覆盖；源头重现重开时回到扫描器口径', async () => {
    insertEntry({ id: 'FIN-T-EDIT', type: 'income', dueDate: shiftDays(1), counterparty: '可延期客户' })
    await scanner.runAll('manual')
    const row = db.prepare("SELECT id, severity, due_date FROM obligations WHERE dedupe_key LIKE 'scan.receivable:FIN-T-EDIT%'").get() as {
      id: number
      severity: string
      due_date: string
    }
    assert.equal(row.severity, 'warn')
    const badTitle = await fetch(`${base}/api/todos/${row.id}`, { method: 'PATCH', headers: hdr(bossToken), body: JSON.stringify({ title: '改标题' }) })
    assert.equal(badTitle.status, 400)
    assert.match(((await badTitle.json()) as { message: string }).message, /标题/)

    const later = shiftDays(9)
    const edited = await fetch(`${base}/api/todos/${row.id}`, {
      method: 'PATCH',
      headers: hdr(bossToken),
      body: JSON.stringify({ dueDate: later, severity: 'info', ownerType: 'role', ownerId: 'td-role' }),
    })
    assert.equal(edited.status, 200)
    const e = (await edited.json()) as { item: ObligationRow }
    assert.equal(e.item.due_date, later)
    assert.equal(e.item.severity, 'info')
    assert.equal(e.item.owner_id, 'td-role')
    assert.equal(e.item.user_edited, 1)

    await scanner.runAll('manual')
    const after = db.prepare('SELECT due_date, severity, owner_id, user_edited FROM obligations WHERE id = ?').get(row.id) as ObligationRow
    assert.equal(after.due_date, later, '扫描刷新不得把人延的到期日拨回去')
    assert.equal(after.severity, 'info')
    assert.equal(after.owner_id, 'td-role')

    // 源头付掉 → 自动闭合；又变回未清 → 重开，到期/严重度回到扫描器口径，user_edited 清零
    db.prepare("UPDATE finance_entries SET status = 'paid', paid_amount_cents = amount_cents WHERE id = 'FIN-T-EDIT'").run()
    await scanner.runAll('manual')
    assert.equal((db.prepare('SELECT status FROM obligations WHERE id = ?').get(row.id) as { status: string }).status, 'resolved')
    db.prepare("UPDATE finance_entries SET status = 'unpaid', paid_amount_cents = 0 WHERE id = 'FIN-T-EDIT'").run()
    await scanner.runAll('manual')
    const reopened = db.prepare('SELECT status, due_date, severity, user_edited, done_note FROM obligations WHERE id = ?').get(row.id) as ObligationRow
    assert.equal(reopened.status, 'open')
    assert.equal(reopened.due_date, row.due_date)
    assert.equal(reopened.severity, 'warn')
    assert.equal(reopened.user_edited, 0)
  })

  test('核实不假闭合：账目改期换键后仍判"源头还在"并把口径并进本条；改期出窗口则如实说明', async () => {
    // 改期到 2 天后（仍在 +3 天预告窗口内，新键在候选里）：同 entryId 身份匹配到 → pending + 并键
    insertEntry({ id: 'FIN-T-MOVE1', type: 'income', dueDate: shiftDays(-1), counterparty: '改期客户一' })
    await scanner.runAll('manual')
    const r1 = db.prepare("SELECT id, dedupe_key FROM obligations WHERE dedupe_key LIKE 'scan.receivable:FIN-T-MOVE1%'").get() as {
      dedupe_key: string
      id: number
    }
    db.prepare("UPDATE finance_entries SET due_date = ? WHERE id = 'FIN-T-MOVE1'").run(shiftDays(2))
    const res = await fetch(`${base}/api/todos/${r1.id}/done`, { method: 'POST', headers: hdr(bossToken), body: '{}' })
    assert.equal(res.status, 201)
    const body = (await res.json()) as { item: ObligationRow; message?: string; outcome: string }
    assert.equal(body.outcome, 'pending', '改期不是处理完，不能闭合')
    assert.match(body.message ?? '', /口径/)
    const after = db.prepare('SELECT dedupe_key, status FROM obligations WHERE id = ?').get(r1.id) as { dedupe_key: string; status: string }
    assert.notEqual(after.dedupe_key, r1.dedupe_key, '应并进新口径的键')
    assert.ok(after.status === 'open' || after.status === 'escalated')
    const run = await scanner.runAll('manual')
    const dup = db.prepare("SELECT COUNT(*) AS c FROM obligations WHERE dedupe_key LIKE 'scan.receivable:FIN-T-MOVE1%'").get() as { c: number }
    assert.equal(dup.c, 1, '并键后不另建新行')
    assert.equal(run.scanners.find((s) => s.scanner === 'scan.receivable')!.created, 0, '并键后扫描零新建')

    // 改期出预告窗口（+20 天）：候选里彻底没有 → resolved，但话必须如实（说明改期到以后会再提醒）
    insertEntry({ id: 'FIN-T-MOVE2', type: 'income', dueDate: shiftDays(-1), counterparty: '改期客户二' })
    await scanner.runAll('manual')
    const r2 = db.prepare("SELECT id FROM obligations WHERE dedupe_key LIKE 'scan.receivable:FIN-T-MOVE2%'").get() as { id: number }
    db.prepare("UPDATE finance_entries SET due_date = ? WHERE id = 'FIN-T-MOVE2'").run(shiftDays(20))
    const res2 = await fetch(`${base}/api/todos/${r2.id}/done`, { method: 'POST', headers: hdr(bossToken), body: '{}' })
    assert.equal(res2.status, 201)
    const body2 = (await res2.json()) as { message?: string; outcome: string }
    assert.equal(body2.outcome, 'resolved')
    assert.match(body2.message ?? '', /改期/, '闭合话术要说明"可能是改期"，不能谎报已处理完')
  })

  test('路由改绑不动被人手动改过责任人的行（user_edited 同样约束批量移交）', async () => {
    const row = db
      .prepare("SELECT id FROM obligations WHERE dedupe_key LIKE 'scan.receivable:FIN-T-001%' AND status IN ('open','escalated')")
      .get() as { id: number }
    const patch = await fetch(`${base}/api/todos/${row.id}`, {
      method: 'PATCH',
      headers: hdr(bossToken),
      body: JSON.stringify({ ownerType: 'role', ownerId: 'td-role' }),
    })
    assert.equal(patch.status, 200)
    const route = await fetch(`${base}/api/todos/routes/scan.receivable`, {
      method: 'PUT',
      headers: hdr(bossToken),
      body: JSON.stringify({ ownerType: 'user', ownerId: 'tduser' }),
    })
    assert.equal(route.status, 200)
    const after = db.prepare('SELECT owner_type, owner_id FROM obligations WHERE id = ?').get(row.id) as {
      owner_id: string
      owner_type: string
    }
    assert.deepEqual(after, { owner_id: 'td-role', owner_type: 'role' }, '手动改派不被路由移交洗掉')
    // 恢复路由到 boss，别影响其他用例
    await fetch(`${base}/api/todos/routes/scan.receivable`, {
      method: 'PUT',
      headers: hdr(bossToken),
      body: JSON.stringify({ ownerType: 'user', ownerId: 'boss' }),
    })
  })

  test('runAll 重入：并发两次共用同一轮（不撞 dedupe_key UNIQUE）', async () => {
    const [a, b] = await Promise.all([scanner.runAll('manual'), scanner.runAll('manual')])
    assert.equal(a, b, '同一轮进行中再触发返回同一结果对象')
    const c = await scanner.runAll('manual')
    assert.notEqual(c, a, '上一轮结束后再触发是新的一轮')
  })

  test('ADMIN_DAILY_SCAN_AT 解析：HH:MM 合法；非法回退 08:30 并标 invalid', () => {
    assert.deepEqual(parseDailyScanAt('08:30'), { hour: 8, minute: 30 })
    assert.deepEqual(parseDailyScanAt('7:05'), { hour: 7, minute: 5 })
    assert.deepEqual(parseDailyScanAt(undefined), { hour: 8, minute: 30 })
    assert.deepEqual(parseDailyScanAt('25:00'), { hour: 8, minute: 30, invalid: '25:00' })
    assert.deepEqual(parseDailyScanAt('abc'), { hour: 8, minute: 30, invalid: 'abc' })
    assert.deepEqual(parseDailyScanAt(''), { hour: 8, minute: 30, invalid: '' })
  })
  test('全月历投影：整月固定事项不受临期窗口限制；身份分支与扫描同源（按月/按季/企税/跨年季度标签）', async () => {
    const bossActor = { username: 'boss', source: 'ui' } as const
    services.finance.profileSet(bossActor, '纳税人身份', '小规模纳税人')
    services.finance.profileSet(bossActor, '纳税期限', '按月申报')
    services.finance.profileSet(bossActor, '主体类型', '有限公司')
    const now = new Date()
    const nm = now.getMonth() + 1 === 12 ? { y: now.getFullYear() + 1, m: 1 } : { y: now.getFullYear(), m: now.getMonth() + 2 }
    const nextYm = `${nm.y}-${String(nm.m).padStart(2, '0')}`
    const r = await fetch(`${base}/api/todos/recurring?month=${nextYm}`, { headers: hdr(bossToken) })
    assert.equal(r.status, 200)
    const body = (await r.json()) as { month: string; items: { key: string; title: string; due: string; channel: string; phase: string; severity: string }[] }
    assert.equal(body.month, nextYm)
    const keys = body.items.map((i) => i.key)
    assert.ok(keys.includes(`scan.filing:vat-m:${nextYm}-15`), '次月增值税按月预列——不在 7 天窗口也可见（用户定稿：提早是提示）')
    assert.ok(keys.includes(`scan.filing:social:${nextYm}`), '次月社保预列')
    assert.equal(keys.some((k) => k.startsWith('scan.filing:cit:')), [1, 4, 7, 10].includes(nm.m), '企税只在季度月')
    const vat = body.items.find((i) => i.key === `scan.filing:vat-m:${nextYm}-15`)!
    assert.match(vat.title, /小规模按月/)
    assert.equal(vat.phase, 'early', '次月 15 日必晚于今天=提示')
    assert.equal(vat.severity, 'warn')
    assert.match(vat.channel, /电子税务局/)
    // 按季口径：明年 1 月的季报挂"上一年第 4 季度"（跨年不倒挂）
    services.finance.profileSet(bossActor, '纳税期限', '按季申报')
    const q = scanner.recurringMonth('2027-01')
    const vatQ = q.items.find((i) => i.key === 'scan.filing:vat-q:2027-01-15')
    assert.ok(vatQ, '2027-01 是季度月：小规模按季预列')
    assert.match(vatQ!.title, /2026 年第 4 季度/)
    // 身份拨回"未登记"，别污染后续用例（profileSet 不收空串）
    services.finance.profileSet(bossActor, '纳税人身份', '未登记')
    services.finance.profileSet(bossActor, '纳税期限', '未登记')
    services.finance.profileSet(bossActor, '主体类型', '未登记')
  })

  test('全月历投影：当天=预警/过期=预警、同键义务行让位、个税代扣按上月工资记录列出；month 非法 400/无权限 403', async () => {
    const now = new Date()
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const prevYm = now.getMonth() === 0 ? `${now.getFullYear() - 1}-12` : `${now.getFullYear()}-${String(now.getMonth()).padStart(2, '0')}`
    const socialKey = `scan.filing:social:${ym}`
    db.prepare('DELETE FROM obligations WHERE dedupe_key = ?').run(socialKey)
    const due15 = `${ym}-15`
    const today = ymd(now)
    const b1 = (await (await fetch(`${base}/api/todos/recurring?month=${ym}`, { headers: hdr(bossToken) })).json()) as { items: { key: string; phase: string }[] }
    const social = b1.items.find((i) => i.key === socialKey)
    assert.ok(social, '当月社保在投影里（身份未登记也恒有社保）')
    assert.equal(social!.phase, due15 > today ? 'early' : due15 === today ? 'today' : 'overdue', '提早=提示，当天=预警，过期=预警')
    // 同键义务行已存在 → 投影让位（活跃的真待办日历上另有；闭合=人确认办过）
    await scanner.runAll('manual', new Date(`${ym}-09T10:00:00`)) // 注入 9 号：社保 15 日必进 7 天窗口
    const b2 = (await (await fetch(`${base}/api/todos/recurring?month=${ym}`, { headers: hdr(bossToken) })).json()) as { items: { key: string }[] }
    assert.ok(!b2.items.some((i) => i.key === socialKey), '已有同键义务行：投影让位')
    // 个税代扣代缴：上月有工资记录才预列
    db.prepare(
      `INSERT INTO finance_entries (id, date, type, amount_cents, status, counterparty, due_date, paid_amount_cents, created_at, created_by, updated_at, updated_by)
       VALUES ('payroll-recur-test', ?, 'payroll', 800000, 'paid', '员工', '', 0, ?, 'boss', ?, 'boss')`,
    ).run(`${prevYm}-10`, new Date().toISOString(), new Date().toISOString())
    const b3 = (await (await fetch(`${base}/api/todos/recurring?month=${ym}`, { headers: hdr(bossToken) })).json()) as { items: { key: string }[] }
    assert.ok(b3.items.some((i) => i.key === `scan.filing:withholding:${prevYm}`), '上月有工资→当月个税代扣预列')
    db.prepare('DELETE FROM finance_entries WHERE id = ?').run('payroll-recur-test')
    // month 非法 400；无权限 403
    assert.equal((await fetch(`${base}/api/todos/recurring?month=2026-13`, { headers: hdr(bossToken) })).status, 400)
    assert.equal((await fetch(`${base}/api/todos/recurring`, { headers: hdr(bossToken) })).status, 400)
    assert.equal((await fetch(`${base}/api/todos/recurring?month=${ym}`, { headers: hdr(nopermToken) })).status, 403)
  })
  test('全月历投影 phase 三档确定性钉死（注入 today，不依赖跑测日期）', () => {
    const ym = '2026-11';
    db.prepare('DELETE FROM obligations WHERE dedupe_key = ?').run(`scan.filing:social:${ym}`);
    assert.equal(scanner.recurringMonth(ym, '2026-11-14').items.find((i) => i.key === `scan.filing:social:${ym}`)!.phase, 'early', '提早=提示');
    assert.equal(scanner.recurringMonth(ym, '2026-11-15').items.find((i) => i.key === `scan.filing:social:${ym}`)!.phase, 'today', '当天=预警');
    assert.equal(scanner.recurringMonth(ym, '2026-11-16').items.find((i) => i.key === `scan.filing:social:${ym}`)!.phase, 'overdue', '过期=预警');
  });

  test('小规模按季档案下 runAll：季度月当月 vat-q 不重复枚举（同轮同键撞 UNIQUE 会崩整轮且 scan_runs 无痕）', async () => {
    const bossActor = { username: 'boss', source: 'ui' } as const;
    services.finance.profileSet(bossActor, '纳税人身份', '小规模纳税人');
    services.finance.profileSet(bossActor, '纳税期限', '按季申报');
    services.finance.profileSet(bossActor, '主体类型', '有限公司');
    // 从当前月起找最近的季度月注入（最多 12 个月必命中），9 号=必进 7 天窗口
    let y = new Date().getFullYear();
    let m = new Date().getMonth() + 1;
    for (let i = 0; i < 12; i++) {
      if ([1, 4, 7, 10].includes(m)) break;
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
    const qm = `${y}-${String(m).padStart(2, '0')}`;
    db.prepare("DELETE FROM obligations WHERE dedupe_key LIKE 'scan.filing:%'").run();
    const r = await scanner.runAll('manual', new Date(`${qm}-09T10:00:00`));
    const filing = r.scanners.find((s) => s.scanner === 'scan.filing')!;
    assert.ok(filing.error === undefined, `扫描器不该报错：${filing.error ?? ''}`);
    const vatQ = db.prepare("SELECT COUNT(*) AS c FROM obligations WHERE dedupe_key = ?").get(`scan.filing:vat-q:${qm}-15`) as { c: number };
    assert.equal(vatQ.c, 1, 'vat-q 恰一条——重构曾在此重复枚举撞 UNIQUE');
    assert.ok(filing.created >= 2, '社保+税类照常进场');
    services.finance.profileSet(bossActor, '纳税人身份', '未登记');
    services.finance.profileSet(bossActor, '纳税期限', '未登记');
    services.finance.profileSet(bossActor, '主体类型', '未登记');
  });
})

/** 供应链域 HTTP 全链路 + 扫描器进出场合账（2026-11-01 生产任务全图 v0）：
 *  权限门（401/403/只读/服务号最小集）/ 模板 / 物料与别名 / 库存导入幂等 / 采购单导入与状态 /
 *  scan.supply 两扫描器（进场-刷新-闭合-换键）/ 核实式完成 / 不碰钱结构守门。 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import bcrypt from 'bcryptjs'
import Database from 'better-sqlite3'

process.env.ADMIN_DATA_DIR = mkdtempSync(join(tmpdir(), 'admin-supply-api-test-'))
delete process.env.ADMIN_JWT_SECRET

const appModule = await import('../src/app.module.js')
const { buildServices, createRuntimeModule, registerAuthMiddleware } = appModule
const { config } = await import('../src/config.js')
const { AGENT_RUNTIME_PERMISSIONS } = await import('../src/rbac/rbac.service.js')
const jwt = (await import('jsonwebtoken')).default
const { openDatabase } = await import('../src/db/database.js')

const ymd = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const shiftDays = (days: number): string => {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return ymd(d)
}

describe('供应链域（物料/库存/采购单 + scan.supply 扫描器）', () => {
  let app: import('@nestjs/common').INestApplication
  let base: string
  let services: ReturnType<typeof buildServices>
  let db: ReturnType<typeof buildServices>['db']
  let bossToken: string
  let rwToken: string // supuser：supply:read + supply:write
  let roToken: string // supro：只读
  let nopermToken: string // 有账号无角色——403 反例
  let agentToken: string // 真·agent 服务号令牌（网关同款直签）：只读承诺要在 HTTP 上钉住，不止查数组

  const send = (method: string, path: string, body?: unknown, token = bossToken) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

  interface OblRow {
    id: number
    source_type: string
    dedupe_key: string
    title: string
    due_date: string
    severity: string
    status: string
  }

  before(async () => {
    services = buildServices()
    db = services.db
    const { dynamicModule } = createRuntimeModule(services)
    const { NestFactory } = await import('@nestjs/core')
    app = await NestFactory.create(dynamicModule, { logger: false })
    registerAuthMiddleware(app, services.auth)
    await app.listen(0, '127.0.0.1')
    const address = app.getHttpServer().address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    base = `http://127.0.0.1:${port}`

    const seed = db.transaction(() => {
      db.prepare('INSERT OR IGNORE INTO roles (name) VALUES (?)').run('sup-role')
      const role = db.prepare('SELECT id FROM roles WHERE name = ?').get('sup-role') as { id: number }
      for (const code of ['supply:read', 'supply:write']) {
        const p = db.prepare('SELECT id FROM permissions WHERE code = ?').get(code) as { id: number }
        db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)').run(role.id, p.id)
      }
      db.prepare('INSERT OR IGNORE INTO roles (name) VALUES (?)').run('sup-ro')
      const ro = db.prepare('SELECT id FROM roles WHERE name = ?').get('sup-ro') as { id: number }
      const rp = db.prepare('SELECT id FROM permissions WHERE code = ?').get('supply:read') as { id: number }
      db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)').run(ro.id, rp.id)
      for (const name of ['supuser', 'supro', 'noperm']) {
        db.prepare('INSERT INTO users (username, password_hash, display_name, is_service, created_at) VALUES (?, ?, ?, 0, ?)').run(
          name,
          bcrypt.hashSync('test12345', 10),
          name,
          new Date().toISOString(),
        )
      }
      for (const [u, r] of [
        ['supuser', 'sup-role'],
        ['supro', 'sup-ro'],
      ] as const) {
        db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES ((SELECT id FROM users WHERE username = ?), (SELECT id FROM roles WHERE name = ?))').run(u, r)
      }
    })
    seed()

    const login = async (username: string, password: string): Promise<string> => {
      const res = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      assert.equal(res.status, 201, `登录 ${username} 应成功`)
      return ((await res.json()) as { token: string }).token
    }
    bossToken = await login('boss', config.bossInitialPassword)
    rwToken = await login('supuser', 'test12345')
    roToken = await login('supro', 'test12345')
    nopermToken = await login('noperm', 'test12345')
    agentToken = jwt.sign({ sub: services.rbac.agentServiceUsername()! }, config.jwtSecret, { expiresIn: '1h' })
  })

  after(async () => {
    await app.close()
    rmSync(process.env.ADMIN_DATA_DIR!, { recursive: true, force: true })
  })

  const supplyObligations = (): OblRow[] =>
    db.prepare("SELECT id, source_type, dedupe_key, title, due_date, severity, status FROM obligations WHERE source_type LIKE 'scan.supply%' ORDER BY id").all() as OblRow[]

  test('agent 运行时最小集：恰含 supply:read、不含 supply:write（七点）', () => {
    assert.ok(AGENT_RUNTIME_PERMISSIONS.includes('supply:read'))
    assert.ok(!AGENT_RUNTIME_PERMISSIONS.includes('supply:write'))
    assert.equal(AGENT_RUNTIME_PERMISSIONS.length, 7)
  })

  test('权限门：未登录 401 / 无角色 403 / 只读可读不可写', async () => {
    assert.equal((await fetch(`${base}/api/supply/summary`)).status, 401)
    assert.equal((await send('GET', '/api/supply/summary', undefined, nopermToken)).status, 403)
    assert.equal((await send('GET', '/api/supply/items', undefined, roToken)).status, 200)
    assert.equal((await send('POST', '/api/supply/items', { code: 'X-1', name: 'x' }, roToken)).status, 403)
    assert.equal((await send('POST', '/api/supply/imports/commit', { kind: 'inventory', text: 'a,b' }, roToken)).status, 403)
    assert.equal((await send('PATCH', '/api/supply/pos/1', { status: 'received' }, roToken)).status, 403)
  })

  test('服务号只读（HTTP 钉子）：agent 令牌九个 GET 读端点+preview 201、十个写端点全 403', async () => {
    for (const path of [
      '/api/supply/summary',
      '/api/supply/items',
      '/api/supply/below-safety',
      '/api/supply/expiring',
      '/api/supply/report/monthly',
      '/api/supply/pos',
      '/api/supply/bitable',
      '/api/supply/settings',
      '/api/supply/imports/template?kind=items',
    ]) {
      assert.equal((await send('GET', path, undefined, agentToken)).status, 200, `agent 读 ${path}`)
    }
    assert.equal((await send('POST', '/api/supply/imports/preview', { kind: 'items', text: '物料编码,物料名称,单位,分类,安全库存,别名,备注\nA,,,,,,' }, agentToken)).status, 201, 'preview 是读')
    const writes: [string, string, unknown][] = [
      ['POST', '/api/supply/items', { code: 'AG-1', name: 'agent 不能建' }],
      ['PATCH', '/api/supply/items/1', { name: 'x' }],
      ['POST', '/api/supply/items/1/archive', undefined],
      ['POST', '/api/supply/items/1/unarchive', undefined],
      ['PUT', '/api/supply/items/1/aliases', { aliases: ['a'] }],
      ['PATCH', '/api/supply/pos/1', { status: 'received' }],
      ['POST', '/api/supply/imports/commit', { kind: 'items', text: '物料编码\nAG-1' }],
      ['PUT', '/api/supply/bitable', { appToken: 'AKAGENT01', tables: { items: 'TBLAGENT01' } }],
      ['POST', '/api/supply/bitable/sync', { kinds: ['inventory'] }],
      ['PUT', '/api/supply/settings', { expiryWarnDays: 45 }],
    ]
    for (const [method, path, body] of writes) {
      assert.equal((await send(method, path, body, agentToken)).status, 403, `agent 写 ${method} ${path} 必须 403`)
    }
    assert.equal(((await (await send('GET', '/api/supply/items?query=AG-1')).json()) as { items: unknown[] }).items.length, 0, '403 的写没落库')
  })

  test('模板端点：三种 kind 自洽；非法 kind 400', async () => {
    for (const kind of ['items', 'inventory', 'pos']) {
      const res = await send('GET', `/api/supply/imports/template?kind=${kind}`)
      assert.equal(res.status, 200)
      const t = (await res.json()) as { kind: string; header: string[]; example: string[][]; csv: string }
      assert.equal(t.kind, kind)
      assert.ok(t.header.length >= 5)
      assert.ok(t.csv.length > 0)
    }
    assert.equal((await send('GET', '/api/supply/imports/template?kind=entries')).status, 400)
  })

  let itemId = 0

  test('物料建档/改档/别名/归档', async () => {
    const created = await send('POST', '/api/supply/items', { code: 'WL-001', name: '猫砂盆 L 号', unit: '个', category: '成品', safetyStock: 20 })
    assert.equal(created.status, 201)
    const item = (await created.json()) as { item: { id: number; safetyStock: number | null; belowSafety: boolean; aliases: string[] } }
    itemId = item.item.id
    assert.equal(item.item.safetyStock, 20)
    assert.equal(item.item.belowSafety, false)

    assert.equal((await send('POST', '/api/supply/items', { code: 'WL-001', name: '重复' })).status, 400)
    assert.equal((await send('POST', '/api/supply/items', { code: '', name: '没编码' })).status, 400)

    const patched = await send('PATCH', `/api/supply/items/${itemId}`, { safetyStock: 25, note: '双十一前备货线' })
    assert.equal(patched.status, 200)
    assert.equal(((await patched.json()) as { item: { safetyStock: number } }).item.safetyStock, 25)

    const aliases = await send('PUT', `/api/supply/items/${itemId}/aliases`, { aliases: ['SB-001', 'litter-L'] })
    assert.equal(aliases.status, 200)
    assert.deepEqual(((await aliases.json()) as { aliases: string[] }).aliases.sort(), ['SB-001', 'litter-L'])

    // 别名撞已有物料编码 → 两义，拒绝
    await send('POST', '/api/supply/items', { code: 'WL-009', name: '九号' })
    assert.equal((await send('PUT', `/api/supply/items/${itemId}/aliases`, { aliases: ['WL-009'] })).status, 400)
    assert.equal((await send('PUT', `/api/supply/items/${itemId}/aliases`, { aliases: '不是数组' })).status, 400)

    const listed = await send('GET', '/api/supply/items?query=SB-001')
    assert.equal(listed.status, 200)
    assert.equal(((await listed.json()) as { items: { id: number }[] }).items.length, 1, '别名参与搜索')

    await send('POST', '/api/supply/items', { code: 'WL-GONE', name: '要归档的' })
    const goneId = (((await send('GET', '/api/supply/items?query=WL-GONE')).json()) as Promise<{ items: { id: number }[] }>).then((r) => r.items[0]!.id)
    const gid = await goneId
    assert.equal((await send('POST', `/api/supply/items/${gid}/archive`)).status, 201)
    assert.equal(((await (await send('GET', '/api/supply/items?query=WL-GONE')).json()) as { items: unknown[] }).items.length, 0, '默认不含归档')
    assert.equal(((await (await send('GET', '/api/supply/items?query=WL-GONE&archived=1')).json()) as { items: unknown[] }).items.length, 1)
    // 往已归档物料名下导快照：不报错（历史补录合法），但 archivedTargets 必须披露——静默才是问题
    const toArchived = await send('POST', '/api/supply/imports/commit', {
      kind: 'inventory',
      text: ['物料编码,物料名称,仓库,数量,快照日期', `WL-GONE,要归档的,主仓,7,${shiftDays(-30)}`].join('\n'),
    })
    assert.equal(toArchived.status, 201)
    assert.deepEqual(((await toArchived.json()) as { archivedTargets: string[] }).archivedTargets, ['WL-GONE'])
    assert.equal((await send('POST', `/api/supply/items/${gid}/unarchive`)).status, 201)
    assert.equal(((await (await send('GET', '/api/supply/items?query=WL-GONE')).json()) as { items: unknown[] }).items.length, 1)

    // 搜索里的下划线是字面量不是 LIKE 通配：WL_0 不能把 WL-0xx 全捞出来
    assert.equal(((await (await send('GET', '/api/supply/items?query=WL_0')).json()) as { items: unknown[] }).items.length, 0)
  })

  test('库存导入：金额列剥除披露 + 预览不落库 + 错误行行号', async () => {
    const text = [
      '物料编码,物料名称,仓库,数量,快照日期,金额,税额',
      `WL-101,新的物料,主仓,5,${shiftDays(0)},999,129`,
      'WL-101,新的物料,主仓,,2026-13-99,,',
    ].join('\n')
    const preview = await send('POST', '/api/supply/imports/preview', { kind: 'inventory', text })
    assert.equal(preview.status, 201)
    const p = (await preview.json()) as {
      strippedMoneyColumns: string[]
      total: number
      valid: number
      invalid: number
      rows: { line: number; error?: string }[]
    }
    assert.deepEqual(p.strippedMoneyColumns, ['金额', '税额'], '金额类列剥除并披露（不碰钱结构守门，税额也算）')
    assert.equal(p.total, 2)
    assert.equal(p.valid, 1)
    assert.equal(p.invalid, 1)
    assert.match(p.rows[1]!.error!, /数量为空/)
    // 预览不落库
    const items = (await (await send('GET', '/api/supply/items?query=WL-101')).json()) as { items: unknown[] }
    assert.equal(items.items.length, 0)
  })

  test('库存导入：commit 落库 + 陌生编码自动建档 + 重导幂等 + 改数覆盖', async () => {
    const mk = (qty: string, date: string): string =>
      ['物料编码,物料名称,仓库,数量,快照日期', `WL-101,新的物料,主仓,${qty},${date}`, `WL-102,原料乙,原料仓,1200.5,${date}`].join('\n')
    const commit = await send('POST', '/api/supply/imports/commit', { kind: 'inventory', text: mk('35', shiftDays(0)), note: '11月盘点' })
    assert.equal(commit.status, 201)
    const r = (await commit.json()) as { batch: string; created: number; itemsCreated: string[] }
    assert.match(r.batch, /^SUP-\d{8}-\d{6}-[a-z0-9]{4}$/)
    assert.equal(r.created, 2)
    assert.deepEqual(r.itemsCreated.sort(), ['WL-101', 'WL-102'])

    const listed = (await (await send('GET', '/api/supply/items?query=WL-')).json()) as {
      items: { code: string; totalQuantity: number; stock: { warehouse: string; quantity: number; snapshotDate: string }[] }[]
    }
    const wl101 = listed.items.find((i) => i.code === 'WL-101')!
    assert.equal(wl101.stock[0]!.quantity, 35)
    const wl102 = listed.items.find((i) => i.code === 'WL-102')!
    assert.equal(wl102.totalQuantity, 1200.5, '小数数量不漂')

    // 同文件重导：全跳过 → 400（没有新数据）
    assert.equal((await send('POST', '/api/supply/imports/commit', { kind: 'inventory', text: mk('35', shiftDays(0)) })).status, 400)

    // 同键改数量 → 覆盖更新
    const again = await send('POST', '/api/supply/imports/commit', { kind: 'inventory', text: mk('40', shiftDays(0)) })
    assert.equal(again.status, 201)
    assert.equal(((await again.json()) as { updated: number; created: number }).updated, 1)
    const after = (await (await send('GET', '/api/supply/items?query=WL-101')).json()) as { items: { totalQuantity: number }[] }
    assert.equal(after.items[0]!.totalQuantity, 40)

    // 别名解析：用 SB-001 报数落到 WL-001 名下
    const aliasRow = await send('POST', '/api/supply/imports/commit', {
      kind: 'inventory',
      text: ['物料编码,物料名称,仓库,数量,快照日期', `SB-001,猫砂盆 L 号,主仓,88,${shiftDays(0)}`].join('\n'),
    })
    assert.equal(aliasRow.status, 201)
    const wl1 = (await (await send('GET', `/api/supply/items/${itemId}`)).json()) as {
      item: { code: string; totalQuantity: number }
    }
    assert.equal(wl1.item.code, 'WL-001')
    assert.equal(wl1.item.totalQuantity, 88, '别名报数落到主编码物料')
  })

  test('采购单导入 + 状态流转 + overdue 过滤', async () => {
    const text = [
      '采购单号,物料编码,物料名称,供应商,数量,下单日期,承诺到货日,状态,到货日,备注',
      `PO-A,WL-201,螺母,宁波紧固件,5000,${shiftDays(-3)},${shiftDays(2)},未到货,,`,
      `PO-B,WL-201,螺母,宁波紧固件,2000,${shiftDays(-10)},${shiftDays(-1)},未到货,,加急`,
      `PO-C,WL-201,螺母,宁波紧固件,100,${shiftDays(-2)},${shiftDays(5)},已到货,,`,
    ].join('\n')
    const commit = await send('POST', '/api/supply/imports/commit', { kind: 'pos', text })
    assert.equal(commit.status, 201)
    const r = (await commit.json()) as { created: number; updated: number; itemsCreated: string[] }
    assert.equal(r.created, 3)
    assert.deepEqual(r.itemsCreated, ['WL-201'])

    const open = (await (await send('GET', '/api/supply/pos?status=open')).json()) as { pos: { po_no: string; status: string }[]; total: number; limit: number }
    assert.equal(open.pos.length, 2)
    assert.equal(open.total, 2, 'total 与同一筛选的行数一致')
    assert.equal(open.limit, 200, '页长如实透出（超出 total>pos.length 由前端/插件披露）')
    const overdue = (await (await send('GET', '/api/supply/pos?overdue=1')).json()) as { pos: { po_no: string }[]; total: number }
    assert.deepEqual(overdue.pos.map((p) => p.po_no), ['PO-B'], '只有承诺日已过的算逾期')
    assert.equal(overdue.total, 1)

    const pos = (await (await send('GET', '/api/supply/pos')).json()) as { pos: { id: number; po_no: string; promised_date: string }[]; total: number }
    assert.equal(pos.total, 3)
    const poB = pos.pos.find((p) => p.po_no === 'PO-B')!
    assert.equal(poB.promised_date, shiftDays(-1))

    // 收货：到货日自动填今天；重开：到货日清掉
    const got = await send('PATCH', `/api/supply/pos/${poB.id}`, { status: 'received' })
    assert.equal(got.status, 200)
    const gotRow = (await got.json()) as { po: { status: string; received_date: string } }
    assert.equal(gotRow.po.received_date, shiftDays(0))
    const reopened = await send('PATCH', `/api/supply/pos/${poB.id}`, { status: 'open' })
    assert.equal(((await reopened.json()) as { po: { received_date: string } }).po.received_date, '')
    assert.equal((await send('PATCH', `/api/supply/pos/${poB.id}`, { status: 'unknown' })).status, 400)

    // 重复导入同内容 → 跳过无新增 → 400
    assert.equal((await send('POST', '/api/supply/imports/commit', { kind: 'pos', text })).status, 400)

    // 守卫：界面点过收货的单，旧文件重贴（文件里仍是"未到货"）不能把它倒翻回 open
    await send('PATCH', `/api/supply/pos/${poB.id}`, { status: 'received' })
    const stale = await send('POST', '/api/supply/imports/commit', { kind: 'pos', text })
    assert.equal(stale.status, 400, '只有被挡的那行有差异 → 没有新数据可导')
    assert.match(((await stale.json()) as { message: string }).message, /PO-B.*已收货.*不会把它倒翻/)
    let poBNow = (await (await send('GET', '/api/supply/pos?status=received')).json()) as { pos: { po_no: string; received_date: string }[] }
    assert.ok(poBNow.pos.some((p) => p.po_no === 'PO-B'), 'PO-B 仍是已到货')
    // 同一份旧文件里别的行有真实改动（PO-A 加备注）→ 201，但 PO-B 的状态照样被护住并披露
    const withNote = text.replace(`${shiftDays(2)},未到货,,`, `${shiftDays(2)},未到货,,改了备注`)
    const mixed = await send('POST', '/api/supply/imports/commit', { kind: 'pos', text: withNote })
    assert.equal(mixed.status, 201)
    const mixedBody = (await mixed.json()) as { updated: number; protectedClosed: string[] }
    assert.equal(mixedBody.updated, 1, '只有 PO-A 的备注算更新')
    assert.deepEqual(mixedBody.protectedClosed, ['PO-B'])
    poBNow = (await (await send('GET', '/api/supply/pos?status=received')).json()) as { pos: { po_no: string; received_date: string }[] }
    assert.equal(poBNow.pos.find((p) => p.po_no === 'PO-B')!.received_date, shiftDays(0), '到货日也没被清掉')
    // 后面的扫描器用例要 PO-B 在场：走台账"重开"（唯一合法的重开路径）
    await send('PATCH', `/api/supply/pos/${poB.id}`, { status: 'open' })
  })

  test('scan.supply.below_safety：按物料合计比——分仓合计低于安线进场、补仓刷新不换键、合计过线闭合、零库存 critical', async () => {
    // WL-001 安全线 25，别名导入后最新读数 88 —— 先把主仓降到 5
    await send('POST', '/api/supply/imports/commit', {
      kind: 'inventory',
      text: ['物料编码,物料名称,仓库,数量,快照日期', `WL-001,猫砂盆 L 号,主仓,5,${shiftDays(0)}`].join('\n'),
    })
    // WL-102 未设安全线：多少都不报
    await services.obligationScanner.runAll('manual')
    let rows = supplyObligations().filter((o) => o.source_type === 'scan.supply.below_safety')
    assert.equal(rows.length, 1, '只有 WL-001 在场（WL-102 没安全线）')
    assert.equal(rows[0]!.severity, 'warn')
    assert.match(rows[0]!.title, /猫砂盆 L 号 低于安全线：合计 5个（主仓 5）/)
    const firstKey = rows[0]!.dedupe_key
    assert.equal(firstKey, `scan.supply.below_safety:${itemId}`, '键=物料，不含仓库（2026-11-01 用户拍板按物料合计比）')

    // 备用仓再报 10：合计 15 仍低于 25 → 还是这一条（不按仓拆行、不换键），标题刷成合计 15 带分仓明细
    await send('POST', '/api/supply/imports/commit', {
      kind: 'inventory',
      text: ['物料编码,物料名称,仓库,数量,快照日期', `WL-001,猫砂盆 L 号,备用仓,10,${shiftDays(0)}`].join('\n'),
    })
    await services.obligationScanner.runAll('manual')
    rows = supplyObligations().filter((o) => o.source_type === 'scan.supply.below_safety')
    assert.equal(rows.length, 1, '两仓一条，不按仓拆')
    assert.equal(rows[0]!.dedupe_key, firstKey, '数量/仓库变化不换键')
    assert.match(rows[0]!.title, /合计 15个（主仓 5、备用仓 10）/)

    // REST 安全线名单端点（前端预警条与插件 summary 都靠它）：人话数量不是毫单位，warehouses 分仓明细
    const below = (await (await send('GET', '/api/supply/below-safety')).json()) as {
      items: { code: string; quantity: number; safetyStock: number; warehouses: string }[]
    }
    const wl1Below = below.items.find((b) => b.code === 'WL-001')!
    assert.deepEqual({ q: wl1Below.quantity, s: wl1Below.safetyStock, w: wl1Below.warehouses }, { q: 15, s: 25, w: '主仓 5、备用仓 10' })

    // 备用仓补到 30：合计 35 ≥ 25 → 闭合——主仓单看仍是 5，分仓比会误报，合计比不会
    await send('POST', '/api/supply/imports/commit', {
      kind: 'inventory',
      text: ['物料编码,物料名称,仓库,数量,快照日期', `WL-001,猫砂盆 L 号,备用仓,30,${shiftDays(0)}`].join('\n'),
    })
    await services.obligationScanner.runAll('manual')
    assert.equal(supplyObligations().find((o) => o.dedupe_key === firstKey)!.status, 'resolved', '合计过线即闭合')
    assert.equal(((await (await send('GET', `/api/supply/items/${itemId}`)).json()) as { item: { belowSafety: boolean } }).item.belowSafety, false)

    // 零库存 critical：WL-101 先补安全线再清零
    await send('POST', '/api/supply/imports/commit', {
      kind: 'inventory',
      text: ['物料编码,物料名称,仓库,数量,快照日期', `WL-101,新的物料,主仓,0,${shiftDays(0)}`].join('\n'),
    })
    const wl101 = (await (await send('GET', '/api/supply/items?query=WL-101')).json()) as { items: { id: number }[] }
    await send('PATCH', `/api/supply/items/${wl101.items[0]!.id}`, { safetyStock: 10 })
    await services.obligationScanner.runAll('manual')
    const zero = supplyObligations().find((o) => o.source_type === 'scan.supply.below_safety' && o.severity === 'critical' && o.status === 'open')
    assert.ok(zero !== undefined, '零库存行 critical')
    assert.match(zero!.title, /新的物料/)

    // 主仓也补到 60（后面用例要 WL-001 不在安线名单）
    await send('POST', '/api/supply/imports/commit', {
      kind: 'inventory',
      text: ['物料编码,物料名称,仓库,数量,快照日期', `WL-001,猫砂盆 L 号,主仓,60,${shiftDays(0)}`].join('\n'),
    })
    await services.obligationScanner.runAll('manual')
    assert.equal(supplyObligations().find((o) => o.dedupe_key === firstKey)!.status, 'resolved')
  })

  test('scan.supply.po_overdue：逾期 critical 带到期日、收货闭合、改期换键', async () => {
    const poOverdueRows = () => supplyObligations().filter((o) => o.source_type === 'scan.supply.po_overdue')
    await services.obligationScanner.runAll('manual')
    let rows = poOverdueRows()
    // PO-A（承诺 2 天后 warn）与 PO-B（昨天 critical）在场；PO-C 已到货不进
    assert.equal(rows.length, 2)
    const overdueRow = rows.find((r) => r.title.includes('PO-B'))!
    assert.equal(overdueRow.severity, 'critical')
    assert.equal(overdueRow.due_date, shiftDays(-1))
    const warnRow = rows.find((r) => r.title.includes('PO-A'))!
    assert.equal(warnRow.severity, 'warn')

    // 收货 PO-B → 候选消失 → 自动闭合
    const pos = (await (await send('GET', '/api/supply/pos')).json()) as { pos: { id: number; po_no: string }[] }
    const poB = pos.pos.find((p) => p.po_no === 'PO-B')!
    await send('PATCH', `/api/supply/pos/${poB.id}`, { status: 'received' })
    await services.obligationScanner.runAll('manual')
    rows = poOverdueRows()
    assert.equal(rows.filter((r) => r.title.includes('PO-B') && r.status === 'resolved').length, 1, '收货后闭合')

    // 改期：PO-A 重导成 30 天后 → 旧键闭合、新键进场（同源换口径）
    await send('POST', '/api/supply/imports/commit', {
      kind: 'pos',
      text: [
        '采购单号,物料编码,物料名称,供应商,数量,下单日期,承诺到货日,状态,到货日,备注',
        `PO-A,WL-201,螺母,宁波紧固件,5000,${shiftDays(-3)},${shiftDays(1)},未到货,,`,
      ].join('\n'),
    })
    await services.obligationScanner.runAll('manual')
    rows = poOverdueRows()
    const poA = rows.filter((r) => r.title.includes('PO-A'))
    assert.equal(poA.filter((r) => r.status === 'resolved').length, 1, '旧口径闭合')
    assert.equal(poA.filter((r) => r.status === 'open').length, 1, '新口径进场')
    assert.equal(poA.find((r) => r.status === 'open')!.due_date, shiftDays(1))
  })

  test('核实式完成：源头仍在 → pending；补货后 → resolved', async () => {
    // 造一条在场的安全线义务
    await send('POST', '/api/supply/imports/commit', {
      kind: 'inventory',
      text: ['物料编码,物料名称,仓库,数量,快照日期', `WL-301,测试物料,主仓,1,${shiftDays(0)}`].join('\n'),
    })
    const wl3 = (await (await send('GET', '/api/supply/items?query=WL-301')).json()) as { items: { id: number }[] }
    await send('PATCH', `/api/supply/items/${wl3.items[0]!.id}`, { safetyStock: 10 })
    await services.obligationScanner.runAll('manual')
    const row = supplyObligations().find((o) => o.source_type === 'scan.supply.below_safety' && o.title.includes('测试物料') && o.status === 'open')
    assert.ok(row !== undefined)

    // 源头仍在 → 不关，恢复提醒（pending）
    const pending = await send('POST', `/api/todos/${row!.id}/done`, {})
    assert.equal(pending.status, 201)
    const pendingBody = (await pending.json()) as { outcome: string; message: string }
    assert.equal(pendingBody.outcome, 'pending')
    assert.match(pendingBody.message, /源头还在/)

    // 补货 → 再点已完成 → resolved（闭合）
    await send('POST', '/api/supply/imports/commit', {
      kind: 'inventory',
      text: ['物料编码,物料名称,仓库,数量,快照日期', `WL-301,测试物料,主仓,99,${shiftDays(0)}`].join('\n'),
    })
    const done = await send('POST', `/api/todos/${row!.id}/done`, {})
    const doneBody = (await done.json()) as { outcome: string }
    assert.equal(doneBody.outcome, 'resolved')
  })

  test('summary 口径：计数与逾期数', async () => {
    const s = (await (await send('GET', '/api/supply/summary')).json()) as {
      items: number
      belowSafety: number
      openPos: number
      overduePos: number
    }
    assert.ok(s.items >= 4, '建档与自动建档的物料都在')
    assert.equal(s.openPos, 1, '只剩 PO-A（PO-B/PO-C 已收货）')
    assert.equal(s.overduePos, 0, 'PO-B 已收货，PO-A 改期 30 天后')
    assert.ok(s.belowSafety >= 1, 'WL-301 已补货但 WL-101 零库存行还在（若安全线为 10、读数 0）')
  })

  test('核实同源判定：采购单只认 poId——A 单改期不被同物料 B 单冒认', async () => {
    const poRows = () => supplyObligations().filter((o) => o.source_type === 'scan.supply.po_overdue')
    // 同物料再来一张 PO-D（+2 天，窗内），让候选里有"同 itemId 不同 poId"的干扰项，且排序在 A 前面
    await send('POST', '/api/supply/imports/commit', {
      kind: 'pos',
      text: [
        '采购单号,物料编码,物料名称,供应商,数量,下单日期,承诺到货日,状态,到货日,备注',
        `PO-D,WL-201,螺母,宁波紧固件,300,${shiftDays(-1)},${shiftDays(2)},未到货,,`,
      ].join('\n'),
    })
    await services.obligationScanner.runAll('manual')
    const rowA = poRows().find((r) => r.status === 'open' && r.title.includes('PO-A'))!
    const rowD = poRows().find((r) => r.status === 'open' && r.title.includes('PO-D'))!
    assert.ok(rowA !== undefined && rowD !== undefined)
    assert.ok(rowA.dedupe_key.endsWith(`:${shiftDays(1)}`))

    // A 改期到 +3 天（不跑扫描器，让 A 的旧键在行上、新键只在候选里）
    await send('POST', '/api/supply/imports/commit', {
      kind: 'pos',
      text: [
        '采购单号,物料编码,物料名称,供应商,数量,下单日期,承诺到货日,状态,到货日,备注',
        `PO-A,WL-201,螺母,宁波紧固件,5000,${shiftDays(-3)},${shiftDays(3)},未到货,,改了备注`,
      ].join('\n'),
    })
    // 点"已完成"核实：应并进 A 自己的新口径（pending、提 PO-A），而不是被排在前面的 PO-D 冒认成"已有行在跟→闭合并入"
    const done = await send('POST', `/api/todos/${rowA.id}/done`, {})
    const body = (await done.json()) as { outcome: string; message: string }
    assert.equal(body.outcome, 'pending', '源头还在（只是改期），不能闭合')
    assert.match(body.message, /PO-A/)
    assert.doesNotMatch(body.message, /PO-D/)
    const rowANow = supplyObligations().find((o) => o.id === rowA.id)!
    assert.ok(rowANow.dedupe_key.endsWith(`:${shiftDays(3)}`), '并进 A 的新键')
    assert.equal(rowANow.status, 'open')
    const rowDNow = supplyObligations().find((o) => o.id === rowD.id)!
    assert.equal(rowDNow.status, 'open', 'D 的行不受影响')
  })

  test('S5 批次/效期：可选列导入、效期必须有批次、同仓同日混报整批拒、批次行优先、临期端点+summary', async () => {
    const hdr = '物料编码,物料名称,仓库,数量,快照日期,批次,效期'
    const d0 = shiftDays(0)
    const text = [
      hdr,
      `WL-401,冻干鸡肉,冷库,40,${d0},B-OLD,${shiftDays(-2)}`, // 已过期
      `WL-401,冻干鸡肉,冷库,25,${d0},B-NEW,${shiftDays(10)}`, // 临期 10 天
      `WL-401,冻干鸡肉,冷库,15,${d0},B-FAR,${shiftDays(200)}`, // 远期：不进临期名单
    ].join('\n')
    const res = await send('POST', '/api/supply/imports/commit', { kind: 'inventory', text })
    assert.equal(res.status, 201)
    assert.equal(((await res.json()) as { created: number }).created, 3)

    // 效期挂在批次上：没批次号的行报效期 → 400
    const bad = await send('POST', '/api/supply/imports/commit', {
      kind: 'inventory',
      text: [hdr, `WL-401,冻干鸡肉,冷库,1,${d0},,${shiftDays(5)}`].join('\n'),
    })
    assert.equal(bad.status, 400)
    assert.match(((await bad.json()) as { message: string }).message, /效期.*批次/)

    // 同仓同日既有总量行又有批次行：预览标错、提交整批拒（事务原子——好行也不落）
    const mixed = [hdr, `WL-401,冻干鸡肉,冷库,80,${d0},,`, `WL-401,冻干鸡肉,冷库,40,${d0},B-OLD,${shiftDays(-2)}`].join('\n')
    const pv = (await (await send('POST', '/api/supply/imports/preview', { kind: 'inventory', text: mixed })).json()) as {
      invalid: number
      rows: { error?: string }[]
    }
    assert.equal(pv.invalid, 1)
    assert.match(pv.rows[1]!.error!, /既有总量行又有批次行/)
    assert.equal((await send('POST', '/api/supply/imports/commit', { kind: 'inventory', text: mixed })).status, 400)

    // 物料视图：三行批次读数，合计 80
    const listed = (await (await send('GET', '/api/supply/items?query=WL-401')).json()) as {
      items: { totalQuantity: number; stock: { batchNo: string; expiryDate: string; quantity: number }[] }[]
    }
    const wl4 = listed.items[0]!
    assert.equal(wl4.totalQuantity, 80)
    assert.equal(wl4.stock.length, 3)
    assert.ok(wl4.stock.some((s) => s.batchNo === 'B-NEW' && s.expiryDate === shiftDays(10) && s.quantity === 25))

    // 老口径混用：隔天只报总量（批次留空）→ 最新读数取最新日期的总量行，旧批次行退场。
    // 不拦（货可能真合并了），但预览与提交都带非阻断提示：批次与效期会从临期名单消失
    const totalOnly = ['物料编码,物料名称,仓库,数量,快照日期', `WL-401,冻干鸡肉,冷库,70,${shiftDays(1)}`].join('\n')
    const pvTotal = (await (await send('POST', '/api/supply/imports/preview', { kind: 'inventory', text: totalOnly })).json()) as { hints: string[] }
    assert.equal(pvTotal.hints.length, 1, '预览提示：总量行顶掉批次行')
    assert.match(pvTotal.hints[0]!, /WL-401 冷库：此前按批次报数.*从临期名单消失/)
    const cmTotal = (await (await send('POST', '/api/supply/imports/commit', { kind: 'inventory', text: totalOnly })).json()) as { hints: string[] }
    assert.deepEqual(cmTotal.hints, pvTotal.hints, '提交结果带同一条提示')
    const after = (await (await send('GET', '/api/supply/items?query=WL-401')).json()) as {
      items: { totalQuantity: number; stock: { batchNo: string; snapshotDate: string }[] }[]
    }
    assert.equal(after.items[0]!.totalQuantity, 70)
    assert.deepEqual(after.items[0]!.stock.map((s) => s.snapshotDate), [shiftDays(1)], '最新读数=每仓最新一天')

    // 临期端点：按最新读数算——WL-401 的批次行已被总量行顶掉，不进名单
    const exp = (await (await send('GET', '/api/supply/expiring')).json()) as { today: string; warnDays: number; items: { batchNo: string }[] }
    assert.equal(exp.warnDays, 90)
    assert.equal(exp.items.filter((i) => i.batchNo.startsWith('B-')).length, 0, '总量行顶掉批次行后无批次可临期')

    // 再隔天报回批次行（新日期）：临期名单恢复
    await send('POST', '/api/supply/imports/commit', {
      kind: 'inventory',
      text: [
        hdr,
        `WL-401,冻干鸡肉,冷库,20,${shiftDays(2)},B-OLD,${shiftDays(-2)}`,
        `WL-401,冻干鸡肉,冷库,30,${shiftDays(2)},B-NEW,${shiftDays(10)}`,
        `WL-401,冻干鸡肉,冷库,20,${shiftDays(2)},B-FAR,${shiftDays(200)}`,
      ].join('\n'),
    })
    const exp2 = (await (await send('GET', '/api/supply/expiring')).json()) as { items: { batchNo: string; daysLeft: number }[] }
    assert.deepEqual(exp2.items.map((i) => i.batchNo).sort(), ['B-NEW', 'B-OLD'], '过期+临期在场，远期不在')
    assert.ok(exp2.items.find((i) => i.batchNo === 'B-OLD')!.daysLeft < 0, 'daysLeft<0=已过期')

    // summary：临期/过期计数
    const s = (await (await send('GET', '/api/supply/summary')).json()) as { expiringBatches: number; expiredBatches: number }
    assert.equal(s.expiringBatches, 2)
    assert.equal(s.expiredBatches, 1)

    // 混报守门按解析后的物料算：主编码报批次 + 别名报总量（同仓同日）也要整批拒——不能靠编码原文绕过
    const wl4id = ((await (await send('GET', '/api/supply/items?query=WL-401')).json()) as { items: { id: number }[] }).items[0]!.id
    const notAlias = await send('POST', '/api/supply/imports/commit', {
      kind: 'inventory',
      text: [hdr, `WL-401,冻干鸡肉,冷库,25,${d0},B-NEW2,${shiftDays(15)}`, `NEW-XX,别的物料,冷库,10,${d0},,`].join('\n'),
    })
    assert.equal(notAlias.status, 201, '两个不同物料同仓同日一批一总，不是混报')
    assert.equal((await send('PUT', `/api/supply/items/${wl4id}/aliases`, { aliases: ['FD-500'] })).status, 200)
    const aliasMix = await send('POST', '/api/supply/imports/commit', {
      kind: 'inventory',
      text: [hdr, `WL-401,冻干鸡肉,冷库,26,${d0},B-NEW2,${shiftDays(15)}`, `FD-500,冻干鸡肉,冷库,10,${d0},,`].join('\n'),
    })
    assert.equal(aliasMix.status, 400, '别名挂上后同物料同仓同日混报要拒')
    assert.match(((await aliasMix.json()) as { message: string }).message, /既有总量行又有批次行/)

    // 批次/仓/单号里的控制字符剥掉（FP_SEP 是 \u001F，透进来会撞 dedupe 键打断整轮扫描）
    const ctrl = await send('POST', '/api/supply/imports/commit', {
      kind: 'inventory',
      text: [hdr, `WL-401,冻干鸡肉,冷库,5,${d0},"B\u001FX",${shiftDays(15)}`].join('\n'),
    })
    assert.equal(ctrl.status, 201)
    const stockCtrl = ((await (await send('GET', '/api/supply/items?query=WL-401')).json()) as { items: { stock: { batchNo: string }[] }[] }).items[0]!
    assert.ok(stockCtrl.stock.every((r) => !r.batchNo.includes('\u001F')), '控制字符不进批次号')
  })

  test('scan.supply.expiry_near：过期 critical 带到期日、批次身份核实不被同物料其他批次冒认、清零闭合', async () => {
    const hdr = '物料编码,物料名称,仓库,数量,快照日期,批次,效期'
    const expRows = () => supplyObligations().filter((o) => o.source_type === 'scan.supply.expiry_near')
    await services.obligationScanner.runAll('manual')
    let rows = expRows()
    assert.equal(rows.length, 2, 'B-OLD（过期）与 B-NEW（临期）在场，B-FAR 不在')
    const oldRow = rows.find((r) => r.title.includes('B-OLD'))!
    assert.equal(oldRow.severity, 'critical')
    assert.equal(oldRow.due_date, shiftDays(-2))
    assert.match(oldRow.title, /已过期/)
    const newRow = rows.find((r) => r.title.includes('B-NEW'))!
    assert.equal(newRow.severity, 'warn')
    assert.equal(newRow.due_date, shiftDays(10))

    // 核实式完成：B-OLD 的条点"已完成"——源头还在 → pending 且只认 B-OLD（批次三元组身份，不被 B-NEW 冒认）
    const pend = (await (await send('POST', `/api/todos/${oldRow.id}/done`, {})).json()) as { outcome: string; message: string }
    assert.equal(pend.outcome, 'pending')
    assert.match(pend.message, /B-OLD/)
    assert.doesNotMatch(pend.message, /B-NEW/)

    // B-OLD 处置清零（同键数量改 0）+ B-NEW 补录改效期（同源换口径刷标题不换键）→ 重扫
    await send('POST', '/api/supply/imports/commit', {
      kind: 'inventory',
      text: [
        hdr,
        `WL-401,冻干鸡肉,冷库,0,${shiftDays(2)},B-OLD,${shiftDays(-2)}`,
        `WL-401,冻干鸡肉,冷库,30,${shiftDays(2)},B-NEW,${shiftDays(20)}`,
      ].join('\n'),
    })
    await services.obligationScanner.runAll('manual')
    rows = expRows()
    assert.equal(rows.find((r) => r.id === oldRow.id)!.status, 'resolved', '批次清零 → 自动闭合')
    const nwNow = rows.find((r) => r.id === newRow.id)!
    assert.equal(nwNow.status, 'open', 'B-NEW 还在（同键）')
    assert.ok(nwNow.title.includes(shiftDays(20)), '效期改判刷到最新')
    assert.equal(nwNow.due_date, shiftDays(20))
    assert.equal(rows.filter((r) => r.status === 'open').length, 1, 'qty=0 的批次不进名单')
  })

  test('R1 月报：当月 partial 口径、四块结构齐、未来月 400、格式 400、缺省当月、历史月可出', async () => {
    const today = shiftDays(0)
    const month = today.slice(0, 7)
    const y = Number(month.slice(0, 4))
    const mo = Number(month.slice(5, 7))
    const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate()
    const res = await send('GET', `/api/supply/report/monthly?month=${month}`)
    assert.equal(res.status, 200)
    const r = (await res.json()) as {
      month: string
      asOf: string
      partial: boolean
      stock: { activeItems: number; reportedItems: number; belowSafety: number; movers: { code: string; change: number }[]; moversTotal: number }
      purchase: { orderedPos: number; orderedLines: number; orderedQty: number; receivedLines: number; openNow: number; overdueAsOf: number }
      batches: { expiring: number; expired: number; rows: unknown[] }
      alerts: { raised: number; closed: number; openNow: number }
      notes: string[]
    }
    assert.equal(r.month, month)
    assert.equal(r.asOf, today)
    assert.equal(r.partial, Number(today.slice(8, 10)) < lastDay, '当月没过完=partial（月末最后一天跑则 false）')
    assert.ok(r.stock.activeItems >= 5, 'WL-001/101/102/201/401 都在')
    assert.ok(r.stock.reportedItems >= 4)
    assert.ok(r.stock.belowSafety >= 1, 'WL-101 零库存低于安线')
    assert.ok(r.stock.moversTotal >= 1)
    assert.ok(r.stock.movers.some((m) => m.code === 'WL-401'), 'movers 含批次测试物料')
    assert.ok(r.purchase.openNow >= 1, 'PO-A/PO-D 在途')
    assert.ok(r.purchase.orderedQty >= 0)
    assert.ok(r.batches.expiring >= 1, 'B-NEW 临期在场')
    assert.ok(r.alerts.openNow >= 1, '有未闭合的 supply 预警')
    assert.ok(r.alerts.raised >= 1, '本月新进场过预警')
    assert.ok(Array.isArray(r.notes) && r.notes.length >= 1, '口径说明不空（在途按当前状态等）')

    assert.equal((await send('GET', '/api/supply/report/monthly?month=2026-13')).status, 400)
    assert.equal((await send('GET', '/api/supply/report/monthly?month=abc')).status, 400)
    const nextMonth = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`
    assert.equal((await send('GET', `/api/supply/report/monthly?month=${nextMonth}`)).status, 400, '未来月 400')
    assert.equal(((await (await send('GET', '/api/supply/report/monthly')).json()) as { month: string }).month, month, '缺省当月')
    const prevMonth = mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`
    const prev = await send('GET', `/api/supply/report/monthly?month=${prevMonth}`)
    assert.equal(prev.status, 200, '历史月（快照回看）不 500')
    assert.equal(((await prev.json()) as { partial: boolean }).partial, false, '历史月=整月口径')

    // 批次块与库存块同一读数宇宙：未来日期才导的批次行不进当月月报（expiringRows(asOf) 隔离）
    await send('POST', '/api/supply/imports/commit', {
      kind: 'inventory',
      text: [
        '物料编码,物料名称,仓库,数量,快照日期,批次,效期',
        `WL-402,未来批次,主仓,10,${shiftDays(5)},B-FUT,${shiftDays(20)}`,
      ].join('\n'),
    })
    const now2 = (await (await send('GET', `/api/supply/report/monthly?month=${month}`)).json()) as { batches: { rows: { batchNo: string }[]; rowsTotal: number } }
    assert.ok(!now2.batches.rows.some((r) => r.batchNo === 'B-FUT'), 'asOf=today 的月报看不到 5 天后才存在的批次读数')
    const live = (await (await send('GET', '/api/supply/expiring')).json()) as { items: { batchNo: string }[] }
    assert.ok(live.items.some((i) => i.batchNo === 'B-FUT'), '实时临期名单（无界）能看到它')
  })

  test('域设置：临期窗口缺省 90、范围校验、admin:manage 门、改后名单/扫描器/月报同口径、审计留前后值', async () => {
    const got = (await (await send('GET', '/api/supply/settings')).json()) as {
      settings: { expiryWarnDays: number; updatedAt: string | null }
      range: { expiryWarnDays: number[] }
    }
    assert.equal(got.settings.expiryWarnDays, 90)
    assert.equal(got.settings.updatedAt, null, '没设过=缺省')
    assert.deepEqual(got.range.expiryWarnDays, [1, 365])
    for (const bad of [0, 366, 1.5, 'abc', '', null]) {
      assert.equal((await send('PUT', '/api/supply/settings', { expiryWarnDays: bad })).status, 400, `expiryWarnDays=${String(bad)} 要 400`)
    }
    assert.equal((await send('PUT', '/api/supply/settings', { expiryWarnDays: 45 }, rwToken)).status, 403, '有 supply:write 没 admin:manage 不能改')
    // +60 天的批次：90 天窗内、45 天窗外
    const hdr = '物料编码,物料名称,仓库,数量,快照日期,批次,效期'
    assert.equal(
      (await send('POST', '/api/supply/imports/commit', { kind: 'inventory', text: [hdr, `WL-SET,设置物料,主仓,9,${shiftDays(3)},B-60,${shiftDays(60)}`].join('\n') })).status,
      201,
    )
    const before = (await (await send('GET', '/api/supply/expiring')).json()) as { warnDays: number; items: { batchNo: string }[] }
    assert.equal(before.warnDays, 90)
    assert.ok(before.items.some((i) => i.batchNo === 'B-60'), '90 天窗：+60 在场')
    const set = (await (await send('PUT', '/api/supply/settings', { expiryWarnDays: '45' })).json()) as {
      settings: { expiryWarnDays: number; updatedBy: string; updatedAt: string | null }
    }
    assert.equal(set.settings.expiryWarnDays, 45, '字符串数字也收')
    assert.equal(set.settings.updatedBy, 'boss')
    assert.ok(set.settings.updatedAt !== null)
    const after = (await (await send('GET', '/api/supply/expiring')).json()) as { warnDays: number; items: { batchNo: string }[] }
    assert.equal(after.warnDays, 45)
    assert.ok(!after.items.some((i) => i.batchNo === 'B-60'), '45 天窗：+60 不在')
    await services.obligationScanner.runAll('manual')
    assert.ok(!supplyObligations().some((o) => o.source_type === 'scan.supply.expiry_near' && o.title.includes('B-60')), '扫描器同口径')
    const rep = (await (await send('GET', '/api/supply/report/monthly')).json()) as { notes: string[] }
    assert.ok(rep.notes.some((n) => n.includes('临期窗口 45 天')), '月报备注跟设置走')
    const au = db.prepare("SELECT detail FROM audit_log WHERE action = 'supply.settings.set' ORDER BY id DESC LIMIT 1").get() as { detail: string }
    assert.deepEqual(JSON.parse(au.detail), { before: { expiryWarnDays: 90 }, after: { expiryWarnDays: 45 } })
    assert.equal((await send('PUT', '/api/supply/settings', { expiryWarnDays: 90 })).status, 200, '恢复缺省')
  })

  test('仓库名归一 + 首次出现仓库名提示：全角空格/首尾空白抹平，新拼法只提示不拦、已有仓名不提示', async () => {
    const hdr = '物料编码,物料名称,仓库,数量,快照日期'
    const r1 = (await (await send('POST', '/api/supply/imports/commit', { kind: 'inventory', text: [hdr, `WL-WH,仓名物料,主仓\u3000,7,${shiftDays(3)}`].join('\n') })).json()) as {
      created: number
      hints: string[]
    }
    assert.equal(r1.created, 1)
    const whs = db
      .prepare("SELECT DISTINCT warehouse AS w FROM supply_inventory_snapshots WHERE item_id = (SELECT id FROM supply_items WHERE code = 'WL-WH')")
      .all() as { w: string }[]
    assert.deepEqual(whs.map((w) => w.w), ['主仓'], '全角空格抹平后仍是"主仓"')
    const pv = (await (await send('POST', '/api/supply/imports/preview', { kind: 'inventory', text: [hdr, `WL-WH,仓名物料,主仓库,7,${shiftDays(3)}`].join('\n') })).json()) as {
      invalid: number
      hints: string[]
    }
    assert.equal(pv.invalid, 0, '新拼法不是错')
    assert.equal(pv.hints.length, 1)
    assert.match(pv.hints[0]!, /首次出现的仓库名：主仓库（库里已有：.*主仓.*）/)
    const pv2 = (await (await send('POST', '/api/supply/imports/preview', { kind: 'inventory', text: [hdr, `WL-WH,仓名物料,主仓,8,${shiftDays(3)}`].join('\n') })).json()) as { hints: string[] }
    assert.deepEqual(pv2.hints, [], '已有仓名不提示')
  })

  test('不碰钱结构守门：四张表没有任何金额/价格列', () => {
    for (const table of ['supply_items', 'supply_item_aliases', 'supply_inventory_snapshots', 'supply_purchase_orders']) {
      const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)
      const money = cols.filter((c) => /amount|price|cost|cents|money|金额|单价|价格/i.test(c))
      assert.deepEqual(money, [], `${table} 不应有金额列`)
    }
  })
})

// --------------------------------------------------------------- 老库迁移（S5 批次列 + 唯一索引变形）

test('迁移：v0 快照表（无批次列、四列唯一索引）打开后补两列、索引重建成五列、数据保留、幂等', () => {
  const dir = mkdtempSync(join(tmpdir(), 'admin-supply-migrate-'))
  const path = join(dir, 'old.db')
  const raw = new Database(path)
  raw.exec(`CREATE TABLE supply_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '', unit TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '', safety_milli INTEGER, note TEXT NOT NULL DEFAULT '', archived_at TEXT,
    created_at TEXT NOT NULL, created_by TEXT NOT NULL, updated_at TEXT, updated_by TEXT)`)
  raw.exec(`CREATE TABLE supply_inventory_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL REFERENCES supply_items(id),
    warehouse TEXT NOT NULL DEFAULT '主仓', qty_milli INTEGER NOT NULL, snapshot_date TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'import', fp TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, created_by TEXT NOT NULL)`)
  raw.exec('CREATE UNIQUE INDEX uq_supply_snap_key ON supply_inventory_snapshots(item_id, warehouse, snapshot_date, source)')
  raw.prepare("INSERT INTO supply_items (id, code, name, created_at, created_by) VALUES (1, 'WL-OLD', '老物料', '2026-10-01T00:00:00Z', 'boss')").run()
  raw.prepare(
    "INSERT INTO supply_inventory_snapshots (item_id, warehouse, qty_milli, snapshot_date, source, fp, created_at, created_by) VALUES (1, '主仓', 5000, '2026-10-30', 'import', 'x', '2026-10-30T00:00:00Z', 'boss')",
  ).run()
  raw.close()

  const upgraded = openDatabase(path)
  const cols = new Set((upgraded.prepare('PRAGMA table_info(supply_inventory_snapshots)').all() as { name: string }[]).map((c) => c.name))
  assert.ok(cols.has('batch_no') && cols.has('expiry_date'), '补齐批次/效期两列')
  const idx = (upgraded.prepare('PRAGMA index_info(uq_supply_snap_key)').all() as { name: string }[]).map((c) => c.name)
  assert.deepEqual(idx, ['item_id', 'warehouse', 'batch_no', 'snapshot_date', 'source'], '唯一索引重建成五列')
  const row = upgraded.prepare('SELECT qty_milli, batch_no, expiry_date FROM supply_inventory_snapshots WHERE item_id = 1').get() as {
    qty_milli: number
    batch_no: string
    expiry_date: string
  }
  assert.deepEqual(row, { qty_milli: 5000, batch_no: '', expiry_date: '' }, '老行保留且默认总量行')
  // 新形状下同仓同日两批次能并存（老索引会撞）
  upgraded
    .prepare(
      "INSERT INTO supply_inventory_snapshots (item_id, warehouse, batch_no, expiry_date, qty_milli, snapshot_date, source, fp, created_at, created_by) VALUES (1, '主仓', 'B1', '2026-12-01', 1000, '2026-10-31', 'import', 'a', '2026-10-31T00:00:00Z', 'boss')",
    )
    .run()
  assert.doesNotThrow(() =>
    upgraded
      .prepare(
        "INSERT INTO supply_inventory_snapshots (item_id, warehouse, batch_no, expiry_date, qty_milli, snapshot_date, source, fp, created_at, created_by) VALUES (1, '主仓', 'B2', '2027-01-01', 2000, '2026-10-31', 'import', 'b', '2026-10-31T00:00:00Z', 'boss')",
      )
      .run(),
  )
  upgraded.close()
  assert.doesNotThrow(() => openDatabase(path).close(), '幂等：再开一次不炸、不重建')
  rmSync(dir, { recursive: true, force: true })
})

/** 通道 B：飞书多维表格只读同步（2026-11-01 v0.5）服务级测试，假 fetch 钉四件事：
 *  1) 运行时对飞书零写——除拿 token 的 POST，业务调用必须全是 GET（方向纪律）；
 *  2) 拉表→归一→复用导入层落库：source='bitable'、批次号前缀 SUPB-、日期毫秒转 YYYY-MM-DD、缺可选列='';
 *  3) 登记册校验与留痕；未登记/未配表/无权限各自的人话错误，各类隔离互不拖累；
 *  4) 幂等（表没变=unchanged 不报错）与 dryRun 试跑不落库。 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ADMIN_DATA_DIR = mkdtempSync(join(tmpdir(), 'admin-supply-bitable-test-'))
delete process.env.ADMIN_JWT_SECRET

const appModule = await import('../src/app.module.js')
const { buildServices } = appModule

const ymd = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const today = ymd(new Date())
const shiftDays = (days: number): string => {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return ymd(d)
}
/** 本机零点的毫秒时间戳（bitable 日期字段形状）。 */
const msOf = (date: string): number => new Date(`${date}T00:00:00`).getTime()

const ACTOR = { username: 'boss', source: 'test' }

describe('通道 B：多维表格只读同步（supply-bitable）', () => {
  let services: ReturnType<typeof buildServices>
  let bitable: InstanceType<(typeof import('../src/supply/supply-bitable.service.js'))['SupplyBitableService']>
  let calls: { method: string; url: string }[] = []
  /** 各表当前返回的记录（测试里改这里=改"表里的数"；null=无权限）。 */
  let tables: Record<string, Record<string, unknown>[] | null>

  before(async () => {
    services = buildServices()
    tables = {}
    const fetchFn: typeof fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push({ method, url })
      const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
      if (method === 'POST' && url.includes('/auth/v3/tenant_access_token')) {
        return json({ code: 0, tenant_access_token: 't-test-1', expire: 7200 })
      }
      if (method !== 'GET') {
        // 方向纪律钉子：业务里出现任何写调用都返回错误（断言在测试尾部统一查 calls）
        return json({ code: 91466, msg: `fake 只接受 GET，收到 ${method}` })
      }
      const m = /\/bitable\/v1\/apps\/([^/]+)\/tables\/([^/]+)\/records/.exec(url)
      if (m !== null) {
        const items = tables[m[2]!]
        if (items === undefined) return json({ code: 1254004, msg: 'TableIdNotExist' })
        if (items === null) return json({ code: 1254302, msg: 'PermissionError' })
        return json({ code: 0, data: { items: items.map((fields, i) => ({ record_id: `rec${i}`, fields })), has_more: false } })
      }
      return json({ code: -1, msg: `fake 未实现的路径 ${url}` })
    }) as typeof fetch
    bitable = new (await import('../src/supply/supply-bitable.service.js')).SupplyBitableService(services.db, services.audit, services.supplyImports, { fetchFn })
  })

  after(() => {
    rmSync(process.env.ADMIN_DATA_DIR!, { recursive: true, force: true })
  })

  test('登记册：未登记同步 400；校验拒绝烂输入；正常设置后回读', async () => {
    await assert.rejects(() => bitable.sync(ACTOR, {}), /还没登记多维表格/)
    assert.throws(() => bitable.setRegistry(ACTOR, { appToken: '', tables: {} }), /appToken 必填/)
    assert.throws(() => bitable.setRegistry(ACTOR, { appToken: 'AKOK00001', tables: {} }), /至少登记一张/)
    assert.throws(() => bitable.setRegistry(ACTOR, { appToken: '含!字符', tables: { inventory: 'TBLINVENT1' } }), /appToken 形状/)
    assert.throws(() => bitable.setRegistry(ACTOR, { appToken: 'AKOK00001', tables: { inventory: '短' } }), /table_id 形状|形状不对/)
    const { registry } = bitable.setRegistry(ACTOR, {
      appToken: 'AKOK00001',
      tables: { items: 'TBLITEMS01', inventory: 'TBLINVENT1', pos: 'TBLPOS0001' },
    })
    assert.equal(registry.appToken, 'AKOK00001')
    const back = bitable.getRegistry()
    assert.ok(back !== null && back.tables.inventory === 'TBLINVENT1')
  })

  test('真同步三类：归一落库（SUPB 批次前缀、毫秒日期、缺可选列）+ 审计留痕 + 登记册记 lastSync', async () => {
    tables = {
      TBLITEMS01: [{ 物料编码: 'WL-B2', 物料名称: '表格先建的', 单位: '个', 分类: '成品', 安全库存: 8 }],
      TBLINVENT1: [
        { 物料编码: 'WL-B1', 物料名称: '通道B物料', 仓库: '主仓', 数量: 12.5, 快照日期: msOf(today), 批次: 'BB-1', 效期: msOf(shiftDays(10)) },
        { 物料编码: 'WL-B1', 物料名称: '通道B物料', 仓库: '备仓', 数量: 5, 快照日期: msOf(today) },
      ],
      TBLPOS0001: [
        { 采购单号: 'PO-B1', 物料编码: 'WL-B1', 物料名称: '通道B物料', 供应商: '宁波X', 数量: 100, 下单日期: msOf(shiftDays(-1)), 承诺到货日: msOf(shiftDays(2)), 状态: '未到货' },
      ],
    }
    calls = []
    const { results } = await bitable.sync(ACTOR, {})
    assert.deepEqual(results.map((r) => r.error === undefined ? r.kind : `ERR:${r.kind}`), ['items', 'inventory', 'pos'], '三类都成')
    const inv = results.find((r) => r.kind === 'inventory')!
    assert.equal(inv.created, 2)
    assert.match(inv.batch!, /^SUPB-\d{8}-\d{6}-[a-z0-9]{4}$/, '通道 B 批次号 SUPB 前缀')
    // 落库形状：source='bitable'、批次/效期归一（毫秒→YYYY-MM-DD）、缺批次=总量行
    const rows = services.db.prepare("SELECT warehouse, batch_no, expiry_date, qty_milli, snapshot_date FROM supply_inventory_snapshots WHERE source = 'bitable' ORDER BY warehouse").all() as {
      warehouse: string; batch_no: string; expiry_date: string; qty_milli: number; snapshot_date: string
    }[]
    assert.equal(rows.length, 2)
    assert.deepEqual(rows.find((r) => r.warehouse === '主仓'), { warehouse: '主仓', batch_no: 'BB-1', expiry_date: shiftDays(10), qty_milli: 12500, snapshot_date: today })
    assert.deepEqual(rows.find((r) => r.warehouse === '备仓'), { warehouse: '备仓', batch_no: '', expiry_date: '', qty_milli: 5000, snapshot_date: today })
    // 物料与安全线、采购单也进来了；合计=主仓+备仓
    const item = services.db.prepare("SELECT id, safety_milli FROM supply_items WHERE code = 'WL-B1'").get() as { id: number; safety_milli: number | null }
    assert.equal(item.safety_milli, null, '表格没设安全线的物料不硬造')
    assert.equal(services.supply.listItems({ query: 'WL-B1' })[0]!.totalQuantity, 17.5)
    const po = services.db.prepare("SELECT po_no, promised_date FROM supply_purchase_orders WHERE po_no = 'PO-B1'").get() as { po_no: string; promised_date: string }
    assert.equal(po.promised_date, shiftDays(2))
    // 审计：同步一条 + 导入层三条（channel=bitable）
    const syncAudit = services.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'supply.bitable.sync'").get() as { n: number }
    assert.equal(syncAudit.n, 1)
    const importAudits = services.db.prepare("SELECT detail FROM audit_log WHERE action = 'supply.import' AND target_id LIKE 'SUPB-%'").all() as { detail: string }[]
    assert.equal(importAudits.length, 3)
    assert.ok(importAudits.every((a) => (JSON.parse(a.detail) as { channel: string }).channel === 'bitable'))
    // 登记册 lastSync 留痕
    const reg = bitable.getRegistry()
    assert.ok(reg !== null && reg.lastSync.inventory !== undefined && reg.lastSync.inventory!.batch === inv.batch)
    // 方向纪律：业务调用全是 GET（只有拿 token 的一次 POST）
    const writes = calls.filter((c) => c.method !== 'GET')
    assert.equal(writes.length, 1, '除拿 token 外零写调用')
    assert.ok(writes[0]!.url.includes('/auth/v3/tenant_access_token'))
  })

  test('幂等：表没变再同步=unchanged 不报错；changed 才更新', async () => {
    const again = await bitable.sync(ACTOR, {})
    assert.ok(again.results.every((r) => r.unchanged === true), '三类全部无变化')
    tables.TBLINVENT1 = [
      { 物料编码: 'WL-B1', 物料名称: '通道B物料', 仓库: '主仓', 数量: 20, 快照日期: msOf(today), 批次: 'BB-1', 效期: msOf(shiftDays(10)) },
      { 物料编码: 'WL-B1', 物料名称: '通道B物料', 仓库: '备仓', 数量: 5, 快照日期: msOf(today) },
    ]
    const after = await bitable.sync(ACTOR, { kinds: ['inventory'] })
    assert.equal(after.results[0]!.updated, 1, '同键改数=覆盖更新')
    assert.equal(services.supply.listItems({ query: 'WL-B1' })[0]!.totalQuantity, 25)
  })

  test('dryRun 试跑：预览 valid/invalid、不落库不换库存', async () => {
    tables.TBLINVENT1 = [
      { 物料编码: 'WL-B1', 物料名称: '通道B物料', 仓库: '主仓', 数量: 30, 快照日期: msOf(today), 批次: 'BB-1', 效期: msOf(shiftDays(10)) },
      { 物料编码: 'WL-B1', 物料名称: '通道B物料', 仓库: '主仓', 数量: 3.14159, 快照日期: msOf(today), 批次: 'BB-2', 效期: msOf(shiftDays(20)) },
      { 物料编码: 'WL-B1', 物料名称: '通道B物料', 仓库: '主仓', 数量: 1, 快照日期: msOf(today), 批次: '', 效期: '' },
    ]
    const before = services.supply.listItems({ query: 'WL-B1' })[0]!.totalQuantity
    const { results } = await bitable.sync(ACTOR, { kinds: ['inventory'], dryRun: true })
    const r = results[0]!
    assert.equal(r.dryRun, true)
    assert.equal(r.valid, 1, '数量超 3 位小数那行被守门标错')
    assert.equal(r.invalid, 2, '精度错一行 + 与批次行同仓同日混报的总量行')
    assert.ok(r.errors!.length >= 2)
    assert.equal(services.supply.listItems({ query: 'WL-B1' })[0]!.totalQuantity, before, '试跑不落库')
    const syncAudit = services.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'supply.bitable.sync'").get() as { n: number }
    assert.ok(syncAudit.n >= 2, '试跑也留痕（拉表=花平台配额，审计要能看见谁拉的）')
  })

  test('类隔离：无权限的表只坏自己；没配的表人话报错', async () => {
    // 还原成有效数据（dryRun 用例里改坏了）
    tables.TBLINVENT1 = [
      { 物料编码: 'WL-B1', 物料名称: '通道B物料', 仓库: '主仓', 数量: 30, 快照日期: msOf(today), 批次: 'BB-1', 效期: msOf(shiftDays(10)) },
      { 物料编码: 'WL-B1', 物料名称: '通道B物料', 仓库: '备仓', 数量: 5, 快照日期: msOf(today) },
    ]
    tables.TBLPOS0001 = null // 假飞书返回 PermissionError
    const bad = await bitable.sync(ACTOR, {})
    const posRes = bad.results.find((r) => r.kind === 'pos')!
    assert.match(posRes.error!, /失败 code=1254302/)
    assert.match(posRes.error!, /共享给本应用/)
    assert.ok(bad.results.find((r) => r.kind === 'inventory')!.error === undefined, '其他类不受影响')
    // 未配表：新登记册只配 inventory（同 base，旧留痕沿用）
    bitable.setRegistry(ACTOR, { appToken: 'AKOK00001', tables: { inventory: 'TBLINVENT1' } })
    const partial = await bitable.sync(ACTOR, {})
    const itemsRes = partial.results.find((r) => r.kind === 'items')!
    assert.match(itemsRes.error!, /没登记 table_id/)
    // 权限类错误不算同步失败但审计 ok=0：pos 那次已记；登记册 lastSync 不留失败类
    // 失败的类不留新痕：pos 的 lastSync 还是上次成功那条（SUPB 批次），items 也在（2 号用例成功过）
    const reg = bitable.getRegistry()
    assert.ok(reg !== null && reg.lastSync.pos !== undefined && reg.lastSync.pos.batch.startsWith('SUPB-'), '失败不覆盖上次成功留痕')
    assert.ok(reg.lastSync.items !== undefined)
  })

  test('扫描前自动同步（2026-11-02）：没接通道 B 不跑、只拉已登记的类、系统身份留痕、扫描基于新读数；失败写 scan_runs 不打断扫描；晨报切片标截止日', async () => {
    const { ObligationScannerService } = await import('../src/todos/obligation-scanner.service.js')
    const s = services
    const bare = new ObligationScannerService(s.db, s.rbac, s.finance, s.invoices, s.proposals, s.bridge, s.todos, s.supply, s.roster)
    const r0 = await bare.runAll('manual')
    assert.equal(r0.presync, undefined, '没接通道 B 的扫描器不预同步')
    assert.equal((s.db.prepare("SELECT COUNT(*) AS n FROM scan_runs WHERE scanner = 'supply.bitable.presync'").get() as { n: number }).n, 0)
    // 登记册此时只接了库存表：预同步只拉这一类（items/pos 没登记不算失败）；表里改数 → 扫描前拉到，扫描基于新读数
    assert.deepEqual(bitable.configuredKinds(), ['inventory'])
    tables.TBLINVENT1 = [
      { 物料编码: 'WL-B1', 物料名称: '通道B物料', 仓库: '主仓', 数量: 1, 快照日期: msOf(today), 批次: 'BB-1', 效期: msOf(shiftDays(10)) },
      { 物料编码: 'WL-B1', 物料名称: '通道B物料', 仓库: '备仓', 数量: 0, 快照日期: msOf(today) },
    ]
    const wired = new ObligationScannerService(s.db, s.rbac, s.finance, s.invoices, s.proposals, s.bridge, s.todos, s.supply, s.roster, bitable)
    const r1 = await wired.runAll('manual')
    assert.ok(r1.presync !== undefined && r1.presync.error === undefined, `预同步成功：${JSON.stringify(r1.presync)}`)
    assert.equal(r1.presync!.fetched, 2)
    assert.equal(r1.presync!.changed, 2, '两行改数都更新')
    assert.equal(s.supply.listItems({ query: 'WL-B1' })[0]!.totalQuantity, 1, '扫描用的是刚拉到的读数')
    const run = s.db.prepare("SELECT found, created, errors FROM scan_runs WHERE scanner = 'supply.bitable.presync' ORDER BY id DESC LIMIT 1").get() as {
      found: number
      created: number
      errors: string
    }
    assert.deepEqual(run, { found: 2, created: 2, errors: '' })
    const au = s.db.prepare("SELECT username, source FROM audit_log WHERE action = 'supply.bitable.sync' ORDER BY id DESC LIMIT 1").get() as { username: string; source: string }
    assert.deepEqual(au, { username: '-', source: 'scan' }, '系统身份：不进「昨日全员」人工动作统计')
    // 表没变再扫：unchanged 不是失败
    const r1b = await wired.runAll('manual')
    assert.equal(r1b.presync!.error, undefined)
    assert.equal(r1b.presync!.changed, 0)
    // 失败：表无权限 → presync.error + scan_runs errors 非空；九个扫描器照常跑完
    tables.TBLINVENT1 = null
    const r2 = await wired.runAll('manual')
    assert.match(r2.presync!.error!, /库存快照.*1254302/)
    // 名册 vs 通讯录扫描器（2026-11-02）在没配飞书凭据的测试环境按设计整轮报错，与预同步无关：比较前后两轮出错集合一致即"没打断"
    const erroring = (r: typeof r2) => r.scanners.filter((x) => x.error !== undefined).map((x) => x.scanner).sort()
    assert.ok(r2.scanners.length >= 12, '十二个扫描器照常跑完')
    assert.deepEqual(erroring(r2), erroring(r1b), '预同步失败不打断扫描（出错集合与上一轮一致）')
    const bad = s.db.prepare("SELECT errors FROM scan_runs WHERE scanner = 'supply.bitable.presync' ORDER BY id DESC LIMIT 1").get() as { errors: string }
    assert.match(bad.errors, /1254302/)
    // 晨报【生产切片】：读数日期早于"今天"时尾注截止日；读数就是当天的不加
    assert.doesNotMatch(s.supply.briefingSlice(today), /库存数据截至/)
    assert.match(s.supply.briefingSlice(shiftDays(1)), new RegExp(`（库存数据截至 ${today}）$`), '切片非空时尾注截止日')
  })

  test('同步结果带导入层提示：试跑与真同步都能看到"总量行顶掉批次行"', async () => {
    tables.TBLINVENT1 = [{ 物料编码: 'WL-B1', 物料名称: '通道B物料', 仓库: '主仓', 数量: 1, 快照日期: msOf(shiftDays(1)) }]
    const dry = await bitable.sync(ACTOR, { kinds: ['inventory'], dryRun: true })
    assert.equal(dry.results[0]!.hints!.length, 1)
    assert.match(dry.results[0]!.hints![0]!, /WL-B1 主仓：此前按批次报数.*从临期名单消失/)
    const real = await bitable.sync(ACTOR, { kinds: ['inventory'] })
    assert.deepEqual(real.results[0]!.hints, dry.results[0]!.hints)
  })
})

/** 生产供应链域服务（2026-11-01 生产任务全图 v0）：物料主数据（含别名）/ 库存快照 / 采购单行。
 *  写入口（界面 REST 与导入提交都走这里）+ 读口径（最新库存、安全线名单、采购单列表，供扫描器共用）。
 *  守门：无金额字段（结构级，schema 与类型层都没有）；数量一律过 qtyToMilli（毫单位）；
 *  日期复用 finance.util 的 parseDate 校验。物料删除=归档不物理删（快照/采购单引用它）。 */
import type { DB } from '../db/database.js'
import { nowIso } from '../db/database.js'
import type { AuditService } from '../audit/audit.service.js'
import { BadRequestError, NotFoundError } from '../errors.js'
import { localDate, parseDate } from '../finance/finance.util.js'
import {
  DEFAULT_EXPIRY_WARN_DAYS,
  EXPIRY_WARN_DAYS_MAX,
  EXPIRY_WARN_DAYS_MIN,
  SUPPLY_SETTINGS_KEY,
  PO_STATUS_VALUES,
  QTY_SCALE,
  qtyToMilli,
  milliToQty,
  fmtQty,
  type ItemView,
  type PoStatus,
  type SupplyItemRow,
  type SupplyPoRow,
} from './supply.types.js'

/** REST/导入写动作的操作者（谁/从哪来），审计三要素之二。 */
export interface SupplyActor {
  username: string
  source: string
}

/** 域设置（企业建档参数，app_meta `supply.settings`）：现在只有临期窗口一项。 */
export interface SupplySettings {
  /** 临期窗口（天）：效期 ≤ 今天+N 的批次进临期名单/扫描器/晨报切片/月报。 */
  expiryWarnDays: number
  /** 最近一次改设置的时间（ISO）；没设过=null（用的是缺省）。 */
  updatedAt: string | null
  updatedBy: string
}

function isWarnDays(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= EXPIRY_WARN_DAYS_MIN && v <= EXPIRY_WARN_DAYS_MAX
}

export interface ItemCreateInput {
  code?: unknown
  name?: unknown
  unit?: unknown
  category?: unknown
  safetyStock?: unknown
  note?: unknown
}

export interface ItemUpdateInput {
  name?: unknown
  unit?: unknown
  category?: unknown
  safetyStock?: unknown
  note?: unknown
}

export interface PoUpdateInput {
  status?: unknown
  receivedDate?: unknown
  note?: unknown
}

export interface StockReading {
  warehouse: string
  /** 批次号；''=总量行。 */
  batchNo: string
  /** 效期 YYYY-MM-DD；''=无效期。 */
  expiryDate: string
  quantity: number
  snapshotDate: string
}

/** 每键（物料+仓库+批次）的最新读数行（供列表视图与扫描器共用）。 */
export interface LatestStockRow {
  item_id: number
  warehouse: string
  batch_no: string
  expiry_date: string
  qty_milli: number
  snapshot_date: string
}

/** 安全线预警名单行（扫描器 scan.supply.below_safety 的口径）——按物料一行，全仓合计比。
 *  warehouses 是"主仓 3、备用仓 10"式的人话明细（预警里让人看见各仓都剩多少）。 */
export interface BelowSafetyRow {
  item_id: number
  code: string
  name: string
  unit: string
  safety_milli: number
  total_milli: number
  snapshot_date: string
  warehouses: string
}

/** 批次临期/过期名单行（扫描器 scan.supply.expiry_near 的口径）。 */
export interface ExpiryRow {
  item_id: number
  code: string
  name: string
  unit: string
  warehouse: string
  batch_no: string
  expiry_date: string
  qty_milli: number
  /** 距过期天数：负=已过期。 */
  days_left: number
}

export interface PoListOpts {
  status?: string
  itemId?: number
  overdueBefore?: string
  promisedBy?: string
  limit?: number
}

export type PoListRow = SupplyPoRow & { code: string; name: string; unit: string }

/** 生产/供应链月报（R1，数量口径）。所有数量都是人话数量（非毫单位）。 */
export interface MonthlyReport {
  month: string
  /** 库存/逾期/临期的截止日：月末与今天取早者。 */
  asOf: string
  /** 当月未结束（asOf<月末）。 */
  partial: boolean
  stock: {
    activeItems: number
    /** 截止日有读数的物料数（没报过数的不按 0）。 */
    reportedItems: number
    belowSafety: number
    movers: { code: string; name: string; unit: string; startQuantity: number | null; endQuantity: number | null; change: number }[]
    moversTotal: number
  }
  purchase: {
    orderedPos: number
    orderedLines: number
    orderedQty: number
    receivedLines: number
    receivedQty: number
    cancelledLines: number
    openNow: number
    overdueAsOf: number
  }
  batches: {
    expiring: number
    expired: number
    /** rows 只列前 20：超出时前端/插件按 rowsTotal 如实说"共 N 条"。 */
    rowsTotal: number
    rows: { code: string; name: string; unit: string; warehouse: string; batchNo: string; expiryDate: string; quantity: number; daysLeft: number }[]
  }
  alerts: { raised: number; raisedBySource: Record<string, number>; closed: number; openNow: number }
  notes: string[]
}

/** 采购单列表缺省页长（REST 不透出 limit；超出部分靠 total 如实披露）。 */
export const PO_LIST_LIMIT = 200

/** 指纹/行键的字段分隔符：控制字符，正常文本里不会出现——用 '|' 会让含竖线的供应商名或备注撞指纹假跳过。 */
export const FP_SEP = '\u001F'

export class SupplyService {
  constructor(
    private readonly db: DB,
    private readonly audit: AuditService,
  ) {}

  // ---------- 物料主数据 ----------

  createItem(actor: SupplyActor, body: ItemCreateInput): ItemView {
    const code = this.parseCode(body.code)
    const name = this.parseName(body.name, code)
    const safety = this.parseSafety(body.safetyStock)
    const ts = nowIso()
    const exists = this.db.prepare('SELECT id FROM supply_items WHERE code = ?').get(code) as { id: number } | undefined
    if (exists !== undefined) throw new BadRequestError(`物料编码 "${code}" 已存在（编号 ${exists.id}），别重复建档。`)
    const r = this.db
      .prepare(
        `INSERT INTO supply_items (code, name, unit, category, safety_milli, note, created_at, created_by, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(code, name, this.parseShort(body.unit), this.parseShort(body.category, 32), safety, this.parseNote(body.note), ts, actor.username, ts, actor.username)
    this.audit.log({
      username: actor.username,
      source: actor.source,
      action: 'supply.item.created',
      targetId: String(r.lastInsertRowid),
      detail: { code, hasSafety: safety !== null },
    })
    return this.getItem(Number(r.lastInsertRowid))
  }

  updateItem(actor: SupplyActor, rawId: unknown, body: ItemUpdateInput): ItemView {
    const row = this.requireItem(rawId)
    const name = body.name !== undefined ? this.parseName(body.name, row.code) : row.name
    const unit = body.unit !== undefined ? this.parseShort(body.unit) : row.unit
    const category = body.category !== undefined ? this.parseShort(body.category, 32) : row.category
    const safety = body.safetyStock !== undefined ? this.parseSafety(body.safetyStock) : row.safety_milli
    const note = body.note !== undefined ? this.parseNote(body.note) : row.note
    this.db
      .prepare('UPDATE supply_items SET name = ?, unit = ?, category = ?, safety_milli = ?, note = ?, updated_at = ?, updated_by = ? WHERE id = ?')
      .run(name, unit, category, safety, note, nowIso(), actor.username, row.id)
    this.audit.log({
      username: actor.username,
      source: actor.source,
      action: 'supply.item.updated',
      targetId: String(row.id),
      detail: { code: row.code, safetyChanged: safety !== row.safety_milli },
    })
    return this.getItem(row.id)
  }

  archiveItem(actor: SupplyActor, rawId: unknown): { archived: boolean } {
    return this.setArchived(actor, rawId, true)
  }

  unarchiveItem(actor: SupplyActor, rawId: unknown): { archived: boolean } {
    return this.setArchived(actor, rawId, false)
  }

  private setArchived(actor: SupplyActor, rawId: unknown, archived: boolean): { archived: boolean } {
    const row = this.requireItem(rawId)
    if (archived && row.archived_at === null) {
      this.db.prepare('UPDATE supply_items SET archived_at = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(nowIso(), nowIso(), actor.username, row.id)
      this.audit.log({ username: actor.username, source: actor.source, action: 'supply.item.archived', targetId: String(row.id), detail: { code: row.code } })
    }
    if (!archived && row.archived_at !== null) {
      this.db.prepare('UPDATE supply_items SET archived_at = NULL, updated_at = ?, updated_by = ? WHERE id = ?').run(nowIso(), actor.username, row.id)
      this.audit.log({ username: actor.username, source: actor.source, action: 'supply.item.unarchived', targetId: String(row.id), detail: { code: row.code } })
    }
    return { archived }
  }

  /** 覆盖式设置别名集（编码映射地基）：别名=外部系统里对同一物料的别的叫法。
   *  别名不得与任何物料编码相同（否则导入解析"先编码后别名"会有两义）。 */
  setAliases(actor: SupplyActor, rawId: unknown, aliases: unknown): { aliases: string[] } {
    const row = this.requireItem(rawId)
    if (!Array.isArray(aliases)) throw new BadRequestError('aliases 需要字符串数组。')
    const cleaned: string[] = []
    for (const a of aliases) {
      if (typeof a !== 'string') throw new BadRequestError('别名需要字符串。')
      const v = a.trim()
      if (v === '') continue
      if (v.length > 64) throw new BadRequestError(`别名 "${v.slice(0, 20)}…" 超过 64 个字符。`)
      if (cleaned.includes(v)) continue
      const clash = this.db.prepare('SELECT id, code FROM supply_items WHERE code = ?').get(v) as { id: number; code: string } | undefined
      if (clash !== undefined) throw new BadRequestError(`别名 "${v}" 与物料编码撞名（"${clash.code}"，编号 ${clash.id}）：换个写法，别让解析有两义。`)
      cleaned.push(v)
    }
    const run = this.db.transaction(() => {
      this.db.prepare('DELETE FROM supply_item_aliases WHERE item_id = ?').run(row.id)
      const ts = nowIso()
      for (const v of cleaned) {
        const taken = this.db.prepare('SELECT item_id FROM supply_item_aliases WHERE alias = ?').get(v) as { item_id: number } | undefined
        if (taken !== undefined && taken.item_id !== row.id) {
          throw new BadRequestError(`别名 "${v}" 已挂在别的物料（编号 ${taken.item_id}）名下：先去那边摘掉再挂这里。`)
        }
        this.db
          .prepare('INSERT OR IGNORE INTO supply_item_aliases (alias, item_id, created_at, created_by) VALUES (?, ?, ?, ?)')
          .run(v, row.id, ts, actor.username)
      }
    })
    run()
    this.audit.log({
      username: actor.username,
      source: actor.source,
      action: 'supply.aliases.set',
      targetId: String(row.id),
      detail: { code: row.code, count: cleaned.length },
    })
    return { aliases: cleaned }
  }

  /** 编码→别名 两级解析（导入落 identity 的唯一入口）。 */
  resolveItemRef(codeOrAlias: string): SupplyItemRow | undefined {
    const byCode = this.db.prepare('SELECT * FROM supply_items WHERE code = ?').get(codeOrAlias) as SupplyItemRow | undefined
    if (byCode !== undefined) return byCode
    const alias = this.db
      .prepare('SELECT i.* FROM supply_item_aliases a JOIN supply_items i ON i.id = a.item_id WHERE a.alias = ?')
      .get(codeOrAlias) as SupplyItemRow | undefined
    return alias
  }

  /** 解析或建档（导入时遇到陌生编码）：名称取行内"物料名称"，没给就用编码本身——
   *  先建档再由人在库存页补全称/安全线，导入不因陌生编码整批失败。 */
  ensureItem(actor: SupplyActor, code: string, name?: string): SupplyItemRow {
    const found = this.resolveItemRef(code)
    if (found !== undefined) return found
    const ts = nowIso()
    const r = this.db
      .prepare(
        `INSERT INTO supply_items (code, name, created_at, created_by, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(code, name !== undefined && name !== '' ? name : code, ts, actor.username, ts, actor.username)
    const item = this.db.prepare('SELECT * FROM supply_items WHERE id = ?').get(r.lastInsertRowid) as SupplyItemRow
    this.audit.log({
      username: actor.username,
      source: actor.source,
      action: 'supply.item.created',
      targetId: String(item.id),
      detail: { code: item.code, via: 'import' },
    })
    return item
  }

  // ---------- 读口径 ----------

  listItems(opts: { query?: string; includeArchived?: boolean } = {}): ItemView[] {
    const where: string[] = []
    const params: (string | number)[] = []
    if (opts.includeArchived !== true) where.push('archived_at IS NULL')
    const q = (opts.query ?? '').trim()
    if (q !== '') {
      // 转义 LIKE 通配符：编码/别名里常见下划线（WL_001），不转义会把 _ 当任意单字符匹配
      where.push(
        "(code LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\' OR id IN (SELECT item_id FROM supply_item_aliases WHERE alias LIKE ? ESCAPE '\\'))",
      )
      const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`
      params.push(like, like, like, like)
    }
    const rows = this.db
      .prepare(`SELECT * FROM supply_items ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY code`)
      .all(...params) as SupplyItemRow[]
    const aliases = this.aliasesByItem()
    const stock = this.latestStockByItem(new Map(rows.map((r) => [r.id, r])))
    return rows.map((row) => this.toView(row, aliases.get(row.id) ?? [], stock.get(row.id) ?? []))
  }

  getItem(rawId: unknown): ItemView {
    const row = this.requireItem(rawId)
    const aliases = this.db.prepare('SELECT alias FROM supply_item_aliases WHERE item_id = ? ORDER BY alias').all(row.id) as {
      alias: string
    }[]
    const stock = this.latestStockRows().filter((s) => s.item_id === row.id)
    return this.toView(row, aliases.map((a) => a.alias), stock.map(toReading))
  }

  /** 每键（物料+仓库+批次）最新读数：先取各仓最新报数日（同仓同日=一次报数，批次行成组），
   *  该日各批次取 id 最大（同日重报后写赢）；**同仓同日既有批次行又有总量行时以批次行为准**
   *  （总量行忽略——批次更具体，混报是数据毛病，不猜、不删行，列表里看得见）。 */
  latestStockRows(): LatestStockRow[] {
    return this.latestStockRowsAsOf('')
  }

  /** 截止某日的"当时最新读数"（月报用：asOf=月末看月末库存、asOf=上月末看月初库存）；''=不限日期。 */
  latestStockRowsAsOf(asOf: string): LatestStockRow[] {
    const limit = asOf === '' ? '' : 'WHERE snapshot_date <= ?'
    const params = asOf === '' ? [] : [asOf, asOf]
    const rows = this.db
      .prepare(
        `SELECT s.item_id AS item_id, s.warehouse AS warehouse, s.batch_no AS batch_no, s.expiry_date AS expiry_date,
                s.qty_milli AS qty_milli, s.snapshot_date AS snapshot_date
         FROM supply_inventory_snapshots s
         JOIN (SELECT item_id, warehouse, MAX(snapshot_date) AS d
               FROM supply_inventory_snapshots ${limit} GROUP BY item_id, warehouse) latest
           ON latest.item_id = s.item_id AND latest.warehouse = s.warehouse AND latest.d = s.snapshot_date
         JOIN (SELECT item_id, warehouse, snapshot_date, batch_no, MAX(id) AS id
               FROM supply_inventory_snapshots ${limit} GROUP BY item_id, warehouse, snapshot_date, batch_no) b
           ON b.id = s.id
         ORDER BY s.item_id, s.warehouse, s.batch_no`,
      )
      .all(...params) as LatestStockRow[]
    const byKey = new Map<string, LatestStockRow[]>()
    for (const r of rows) {
      const k = `${r.item_id}${FP_SEP}${r.warehouse}`
      const list = byKey.get(k) ?? []
      list.push(r)
      byKey.set(k, list)
    }
    const out: LatestStockRow[] = []
    for (const list of byKey.values()) {
      const batches = list.filter((r) => r.batch_no !== '')
      out.push(...(batches.length > 0 ? batches : list))
    }
    return out
  }

  /** 安全线名单（扫描器口径，2026-11-01 用户拍板改**按物料合计比**）：启用物料、设了安全线、
   *  全仓合计（最新读数之和）低于安全线——退货仓这类小副仓不再把"合计 45 不缺"的物料拖进预警。 */
  belowSafetyRows(): BelowSafetyRow[] {
    const items = this.db
      .prepare('SELECT id, code, name, unit, safety_milli FROM supply_items WHERE archived_at IS NULL AND safety_milli IS NOT NULL')
      .all() as { id: number; code: string; name: string; unit: string; safety_milli: number }[]
    const byItem = new Map<number, LatestStockRow[]>()
    for (const r of this.latestStockRows()) {
      const list = byItem.get(r.item_id) ?? []
      list.push(r)
      byItem.set(r.item_id, list)
    }
    const out: BelowSafetyRow[] = []
    for (const it of items) {
      const rows = byItem.get(it.id)
      if (rows === undefined || rows.length === 0) continue
      const total = rows.reduce((n, r) => n + r.qty_milli, 0)
      if (total >= it.safety_milli) continue
      out.push({
        item_id: it.id,
        code: it.code,
        name: it.name,
        unit: it.unit,
        safety_milli: it.safety_milli,
        total_milli: total,
        snapshot_date: rows.reduce((d, r) => (r.snapshot_date > d ? r.snapshot_date : d), ''),
        warehouses: rows.map((r) => `${r.warehouse} ${fmtQty(r.qty_milli)}`).join('、'),
      })
    }
    out.sort((a, b) => a.total_milli - b.total_milli)
    return out
  }

  // ---------- 域设置（企业建档参数，app_meta `supply.settings`） ----------

  /** 读设置：没设过/存坏了都回缺省——设置坏了不该让临期扫描整轮失明。 */
  getSettings(): SupplySettings {
    const row = this.db.prepare('SELECT value, updated_at FROM app_meta WHERE key = ?').get(SUPPLY_SETTINGS_KEY) as
      | { value: string; updated_at: string }
      | undefined
    const out: SupplySettings = { expiryWarnDays: DEFAULT_EXPIRY_WARN_DAYS, updatedAt: null, updatedBy: '' }
    if (row === undefined) return out
    try {
      const parsed = JSON.parse(row.value) as Record<string, unknown>
      if (isWarnDays(parsed.expiryWarnDays)) out.expiryWarnDays = parsed.expiryWarnDays
      out.updatedAt = row.updated_at
      if (typeof parsed.updatedBy === 'string') out.updatedBy = parsed.updatedBy
    } catch {
      /* 坏 JSON 当没设过 */
    }
    return out
  }

  /** 改设置（admin:manage）：临期窗口只认 1..365 的整数天（字符串数字也收）；审计留前后值。 */
  setSettings(actor: SupplyActor, input: unknown): SupplySettings {
    const body = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}
    const before = this.getSettings()
    const raw = body.expiryWarnDays
    const days = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw
    if (!isWarnDays(days)) {
      throw new BadRequestError(`临期窗口要填 ${EXPIRY_WARN_DAYS_MIN}–${EXPIRY_WARN_DAYS_MAX} 的整数天（现在是 ${before.expiryWarnDays} 天）。`)
    }
    this.db
      .prepare(
        `INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(SUPPLY_SETTINGS_KEY, JSON.stringify({ expiryWarnDays: days, updatedBy: actor.username }), nowIso())
    this.audit.log({
      username: actor.username,
      source: actor.source,
      action: 'supply.settings.set',
      targetId: SUPPLY_SETTINGS_KEY,
      detail: { before: { expiryWarnDays: before.expiryWarnDays }, after: { expiryWarnDays: days } },
    })
    return this.getSettings()
  }

  /** 当前临期窗口（天）：扫描器/名单/月报/晨报都从这里取，不各自抄常量。 */
  expiryWarnDays(): number {
    return this.getSettings().expiryWarnDays
  }

  /** 临期/过期批次（S5）：有批次号、数量>0、效期 ≤ today+warnDays 的最新读数；已过期（days_left<0）
   *  与临期都返回，调用方按 days_left 分级。warnDays 缺省取设置里的窗口（DEFAULT_EXPIRY_WARN_DAYS 只是没设过时的底）。
   *  asOf 非空=读数宇宙限定到该日（月报回看用：10 月月报不能混进 11 月才导的批次行）；''=当前最新读数。 */
  expiringRows(today: string, warnDays = this.expiryWarnDays(), asOf = ''): ExpiryRow[] {
    const items = new Map(
      (this.db.prepare('SELECT id, code, name, unit FROM supply_items WHERE archived_at IS NULL').all() as {
        id: number
        code: string
        name: string
        unit: string
      }[]).map((i) => [i.id, i]),
    )
    const horizon = addDaysISO(today, warnDays)
    const out: ExpiryRow[] = []
    for (const r of asOf === '' ? this.latestStockRows() : this.latestStockRowsAsOf(asOf)) {
      if (r.batch_no === '' || r.expiry_date === '' || r.qty_milli <= 0) continue
      if (r.expiry_date > horizon) continue
      const it = items.get(r.item_id)
      if (it === undefined) continue
      out.push({
        item_id: r.item_id,
        code: it.code,
        name: it.name,
        unit: it.unit,
        warehouse: r.warehouse,
        batch_no: r.batch_no,
        expiry_date: r.expiry_date,
        qty_milli: r.qty_milli,
        days_left: diffDaysISO(today, r.expiry_date),
      })
    }
    out.sort((a, b) => a.expiry_date.localeCompare(b.expiry_date) || a.item_id - b.item_id || a.batch_no.localeCompare(b.batch_no))
    return out
  }

  /** 采购单列表（有 LIMIT；总数走 countPos，调用方据此说"共 N 张、只列前 M 张"）。 */
  listPos(opts: PoListOpts = {}): PoListRow[] {
    const { where, params } = this.posFilter(opts)
    const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? PO_LIST_LIMIT)), 500)
    return this.db
      .prepare(
        `SELECT p.*, i.code AS code, i.name AS name, i.unit AS unit
         FROM supply_purchase_orders p JOIN supply_items i ON i.id = p.item_id
         ${where}
         ORDER BY (p.status = 'open') DESC, p.promised_date ASC, p.po_no ASC, p.id ASC
         LIMIT ?`,
      )
      .all(...params, limit) as PoListRow[]
  }

  /** 满足同一筛选的总行数（与 listPos 同一 where，列表被 LIMIT 截断时前端/插件靠它如实报数）。 */
  countPos(opts: PoListOpts = {}): number {
    const { where, params } = this.posFilter(opts)
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM supply_purchase_orders p ${where}`).get(...params) as { n: number }).n
  }

  private posFilter(opts: PoListOpts): { where: string; params: (string | number)[] } {
    const where: string[] = []
    const params: (string | number)[] = []
    if (opts.status !== undefined) {
      if (!(PO_STATUS_VALUES as readonly string[]).includes(opts.status)) throw new BadRequestError(`status 只认 ${PO_STATUS_VALUES.join('|')}。`)
      where.push('p.status = ?')
      params.push(opts.status)
    }
    if (opts.itemId !== undefined) {
      where.push('p.item_id = ?')
      params.push(opts.itemId)
    }
    if (opts.overdueBefore !== undefined) {
      // 严格小于：逾期 = 承诺日已过（今天到的货还不算逾期）
      where.push("p.status = 'open' AND p.promised_date != '' AND p.promised_date < ?")
      params.push(opts.overdueBefore)
    }
    if (opts.promisedBy !== undefined) {
      // 含端：到货预警窗口用（承诺日=今天也算"即将/今天到货"）
      where.push("p.status = 'open' AND p.promised_date != '' AND p.promised_date <= ?")
      params.push(opts.promisedBy)
    }
    return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', params }
  }

  getPo(rawId: unknown): SupplyPoRow & { code: string; name: string; unit: string } {
    const row = this.db
      .prepare(
        `SELECT p.*, i.code AS code, i.name AS name, i.unit AS unit
         FROM supply_purchase_orders p JOIN supply_items i ON i.id = p.item_id WHERE p.id = ?`,
      )
      .get(this.parseId(rawId)) as (SupplyPoRow & { code: string; name: string; unit: string }) | undefined
    if (row === undefined) throw new NotFoundError('采购单行不存在。')
    return row
  }

  /** 采购单行改状态（收货/取消/重开）：不删行；received 状态落到货日（没给=今天），
   *  非 received 状态清掉到货日（重开/取消后不留陈旧到货日）。 */
  updatePo(actor: SupplyActor, rawId: unknown, body: PoUpdateInput, now = new Date()): SupplyPoRow & { code: string; name: string; unit: string } {
    const row = this.getPo(rawId)
    let status = row.status
    if (body.status !== undefined) {
      if (typeof body.status !== 'string' || !(PO_STATUS_VALUES as readonly string[]).includes(body.status)) {
        throw new BadRequestError(`status 只认 ${PO_STATUS_VALUES.join('|')}。`)
      }
      status = body.status as PoStatus
    }
    let receivedDate = row.received_date
    if (body.receivedDate !== undefined) {
      if (body.receivedDate === null || body.receivedDate === '') {
        receivedDate = ''
      } else {
        if (typeof body.receivedDate !== 'string') throw new BadRequestError('receivedDate 需要 YYYY-MM-DD。')
        receivedDate = parseDate(body.receivedDate.trim(), '到货日') ?? ''
      }
    }
    if (status === 'received' && receivedDate === '') receivedDate = localDate(now)
    if (status !== 'received') receivedDate = ''
    const note = body.note !== undefined ? this.parseNote(body.note) : row.note
    this.db
      .prepare('UPDATE supply_purchase_orders SET status = ?, received_date = ?, note = ?, fp = ?, updated_at = ? WHERE id = ?')
      .run(status, receivedDate, note, poFp(row.po_no, row.item_id, row.supplier, row.qty_milli, row.ordered_date, row.promised_date, status, receivedDate, note), nowIso(), row.id)
    this.audit.log({
      username: actor.username,
      source: actor.source,
      action: 'supply.po.updated',
      targetId: String(row.id),
      detail: { poNo: row.po_no, from: row.status, to: status },
    })
    return this.getPo(row.id)
  }

  summary(today = ''): {
    items: number
    archived: number
    belowSafety: number
    openPos: number
    overduePos: number
    /** 临期批次数（含已过期；today='' 时为 0）。 */
    expiringBatches: number
    /** 其中已过期批次数。 */
    expiredBatches: number
    lastSnapshotDate: string
  } {
    const items = (this.db.prepare('SELECT COUNT(*) AS n FROM supply_items WHERE archived_at IS NULL').get() as { n: number }).n
    const archived = (this.db.prepare('SELECT COUNT(*) AS n FROM supply_items WHERE archived_at IS NOT NULL').get() as { n: number }).n
    const openPos = (this.db.prepare("SELECT COUNT(*) AS n FROM supply_purchase_orders WHERE status = 'open'").get() as { n: number }).n
    const overduePos =
      today === ''
        ? 0
        : (
            this.db
              .prepare("SELECT COUNT(*) AS n FROM supply_purchase_orders WHERE status = 'open' AND promised_date != '' AND promised_date < ?")
              .get(today) as { n: number }
          ).n
    const last =
      (this.db.prepare('SELECT MAX(snapshot_date) AS d FROM supply_inventory_snapshots').get() as { d: string | null }).d ?? ''
    const expiring = today === '' ? [] : this.expiringRows(today)
    return {
      items,
      archived,
      belowSafety: this.belowSafetyRows().length,
      openPos,
      overduePos,
      expiringBatches: expiring.length,
      expiredBatches: expiring.filter((e) => e.days_left < 0).length,
      lastSnapshotDate: last,
    }
  }

  /** 晨报老板卡的【生产切片】一行（2026-11-01 R1）：没建物料=本域没用起来返回 ''（不占老板卡）；
   *  用起来了但四项全零也返回 ''（"少发不打扰"与待办晨报同口径——有事才说）。 */
  briefingSlice(today: string): string {
    const s = this.summary(today)
    if (s.items === 0) return ''
    const arrivals = (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM supply_purchase_orders WHERE status = 'open' AND promised_date = ?")
        .get(today) as { n: number }
    ).n
    if (s.belowSafety + s.overduePos + s.expiringBatches + arrivals === 0) return ''
    const parts = [`低于安线 ${s.belowSafety}`, `到货逾期 ${s.overduePos}`]
    parts.push(s.expiredBatches > 0 ? `临期批次 ${s.expiringBatches}（含过期 ${s.expiredBatches}）` : `临期批次 ${s.expiringBatches}`)
    parts.push(`今日应到 ${arrivals}`)
    // 读数不是今天的=老板看的是旧账（全图 §0.5「拉」的失败模式：拉到旧数不能冒充今日）：切片尾上写明截止日。
    // 四项全零时整条不发（少发不打扰），此时也不单发截止日——陈旧与否由扫描前自动同步在源头管。
    const stale = s.lastSnapshotDate !== '' && s.lastSnapshotDate < today ? `（库存数据截至 ${s.lastSnapshotDate}）` : ''
    return parts.join(' · ') + stale
  }

  /** 生产/供应链月报（R1，数量口径，金额切片归财务域）。asOf=月末与今天取早者：当月看"到今天为止"，
   *  历史月看月末。库存按"截止日当时最新读数"回溯（快照是流水，能回看）；采购单状态没有历史——
   *  在途/逾期按**当前**状态算并在 notes 里如实说明；预警计数取义务表 scan.supply.* 行的首现/闭合时间。 */
  monthlyReport(month: string, today: string): MonthlyReport {
    const m = /^(\d{4})-(\d{2})$/.exec(month)
    if (m === null || Number(m[2]) < 1 || Number(m[2]) > 12) throw new BadRequestError('month 格式应为 YYYY-MM。')
    const y = Number(m[1])
    const mo = Number(m[2])
    const start = `${month}-01`
    const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate()
    const end = `${month}-${String(lastDay).padStart(2, '0')}`
    if (start > today) throw new BadRequestError(`${month} 还没到，月报无从出。`)
    const asOf = end < today ? end : today
    const prevEnd = addDaysISO(start, -1)

    const items = this.db
      .prepare('SELECT id, code, name, unit, safety_milli FROM supply_items WHERE archived_at IS NULL ORDER BY code')
      .all() as { id: number; code: string; name: string; unit: string; safety_milli: number | null }[]
    const totals = (rows: LatestStockRow[]): Map<number, number> => {
      const t = new Map<number, number>()
      for (const r of rows) t.set(r.item_id, (t.get(r.item_id) ?? 0) + r.qty_milli)
      return t
    }
    const endRows = this.latestStockRowsAsOf(asOf)
    const endTotals = totals(endRows)
    const startTotals = totals(this.latestStockRowsAsOf(prevEnd))
    const belowSafety = items.filter((i) => i.safety_milli !== null && endTotals.has(i.id) && endTotals.get(i.id)! < i.safety_milli).length
    const movers = items
      .filter((i) => endTotals.has(i.id) || startTotals.has(i.id))
      .map((i) => ({
        code: i.code,
        name: i.name,
        unit: i.unit,
        startQuantity: startTotals.has(i.id) ? milliToQty(startTotals.get(i.id)!) : null,
        endQuantity: endTotals.has(i.id) ? milliToQty(endTotals.get(i.id)!) : null,
        change: milliToQty((endTotals.get(i.id) ?? 0) - (startTotals.get(i.id) ?? 0)),
      }))
      .sort((a, b) => Math.abs(b.change) - Math.abs(a.change) || a.code.localeCompare(b.code))
    const reported = new Set(endRows.map((r) => r.item_id)).size

    const one = (sql: string, ...p: (string | number)[]): number => (this.db.prepare(sql).get(...p) as { n: number }).n
    const sumQty = (sql: string, ...p: (string | number)[]): number =>
      milliToQty((this.db.prepare(sql).get(...p) as { q: number | null }).q ?? 0)
    const ordered = one('SELECT COUNT(DISTINCT po_no) AS n FROM supply_purchase_orders WHERE ordered_date >= ? AND ordered_date <= ?', start, asOf)
    const orderedLines = one('SELECT COUNT(*) AS n FROM supply_purchase_orders WHERE ordered_date >= ? AND ordered_date <= ?', start, asOf)
    const orderedQty = sumQty('SELECT SUM(qty_milli) AS q FROM supply_purchase_orders WHERE ordered_date >= ? AND ordered_date <= ?', start, asOf)
    const received = one("SELECT COUNT(*) AS n FROM supply_purchase_orders WHERE status = 'received' AND received_date >= ? AND received_date <= ?", start, asOf)
    const receivedQty = sumQty("SELECT SUM(qty_milli) AS q FROM supply_purchase_orders WHERE status = 'received' AND received_date >= ? AND received_date <= ?", start, asOf)
    const openNow = one("SELECT COUNT(*) AS n FROM supply_purchase_orders WHERE status = 'open'")
    const overdueAsOf = one("SELECT COUNT(*) AS n FROM supply_purchase_orders WHERE status = 'open' AND promised_date != '' AND promised_date < ?", asOf)
    // updated_at / first_seen_at / resolved_at 都是 UTC ISO：边界要按本机零点换成同一口径再比，裸串比在 UTC+8 会把月初 0–8 点的事划到上月
    const fromIso = new Date(`${start}T00:00:00`).toISOString()
    const toIso = new Date(`${addDaysISO(asOf, 1)}T00:00:00`).toISOString()
    const cancelled = one("SELECT COUNT(*) AS n FROM supply_purchase_orders WHERE status = 'cancelled' AND updated_at >= ? AND updated_at < ?", fromIso, toIso)

    // 批次块与库存块同一读数宇宙（截止 asOf），days_left 也按 asOf 起算
    const warnDays = this.expiryWarnDays()
    const expiry = this.expiringRows(asOf, warnDays, asOf)
    const alertsRaised = this.db
      .prepare(
        `SELECT source_type, COUNT(*) AS n FROM obligations
         WHERE source_type LIKE 'scan.supply.%' AND first_seen_at >= ? AND first_seen_at < ? GROUP BY source_type`,
      )
      .all(fromIso, toIso) as { source_type: string; n: number }[]
    const alertsClosed = one(
      "SELECT COUNT(*) AS n FROM obligations WHERE source_type LIKE 'scan.supply.%' AND resolved_at IS NOT NULL AND resolved_at >= ? AND resolved_at < ?",
      fromIso,
      toIso,
    )
    const alertsOpen = one("SELECT COUNT(*) AS n FROM obligations WHERE source_type LIKE 'scan.supply.%' AND status IN ('open', 'escalated')")

    return {
      month,
      asOf,
      partial: asOf < end,
      stock: {
        activeItems: items.length,
        reportedItems: reported,
        belowSafety,
        movers: movers.slice(0, 20),
        moversTotal: movers.length,
      },
      purchase: { orderedPos: ordered, orderedLines, orderedQty, receivedLines: received, receivedQty, cancelledLines: cancelled, openNow, overdueAsOf },
      batches: {
        expiring: expiry.filter((e) => e.days_left >= 0).length,
        expired: expiry.filter((e) => e.days_left < 0).length,
        rowsTotal: expiry.length,
        rows: expiry.slice(0, 20).map((e) => ({
          code: e.code,
          name: e.name,
          unit: e.unit,
          warehouse: e.warehouse,
          batchNo: e.batch_no,
          expiryDate: e.expiry_date,
          quantity: milliToQty(e.qty_milli),
          daysLeft: e.days_left,
        })),
      },
      alerts: {
        raised: alertsRaised.reduce((n, a) => n + a.n, 0),
        raisedBySource: Object.fromEntries(alertsRaised.map((a) => [a.source_type, a.n])),
        closed: alertsClosed,
        openNow: alertsOpen,
      },
      notes: [
        '数量口径月报：不含任何金额（金额切片在财务域）。',
        `库存=截止 ${asOf} 各仓最新报数之和；月初=截止 ${prevEnd} 的最新报数（没报过数的物料按"无读数"不按 0）。`,
        '采购单状态没有历史：在途/逾期按当前状态算；已取消按改状态时间归月。',
        `临期窗口 ${warnDays} 天（设置里可改，全域一个数）。`,
        ...(asOf < end ? [`${month} 尚未结束：数据截止今天（${asOf}）。`] : []),
      ],
    }
  }

  // ---------- 内部 ----------

  private toView(row: SupplyItemRow, aliases: string[], stock: StockReading[]): ItemView {
    const safety = row.safety_milli
    // 合计在毫单位里加（展示数量是浮点，直接相加会漂 0.1+0.2 那种）
    const totalMilli = stock.reduce((n, s) => n + Math.round(s.quantity * QTY_SCALE), 0)
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      unit: row.unit,
      category: row.category,
      safetyStock: safety === null ? null : milliToQty(safety),
      note: row.note,
      archived: row.archived_at !== null,
      aliases,
      stock,
      totalQuantity: milliToQty(totalMilli),
      // 没有任何读数=「还没盘过」不是「低于安线」（与 belowSafetyRows 同口径：要有一条读数才谈合计）
      belowSafety: safety !== null && stock.length > 0 && totalMilli < safety,
    }
  }

  private aliasesByItem(): Map<number, string[]> {
    const map = new Map<number, string[]>()
    for (const r of this.db.prepare('SELECT item_id, alias FROM supply_item_aliases ORDER BY alias').all() as {
      item_id: number
      alias: string
    }[]) {
      const list = map.get(r.item_id) ?? []
      list.push(r.alias)
      map.set(r.item_id, list)
    }
    return map
  }

  private latestStockByItem(items: Map<number, SupplyItemRow>): Map<number, StockReading[]> {
    const map = new Map<number, StockReading[]>()
    if (items.size === 0) return map
    for (const r of this.latestStockRows()) {
      if (!items.has(r.item_id)) continue
      const list = map.get(r.item_id) ?? []
      list.push(toReading(r))
      map.set(r.item_id, list)
    }
    return map
  }

  private requireItem(rawId: unknown): SupplyItemRow {
    const row = this.db.prepare('SELECT * FROM supply_items WHERE id = ?').get(this.parseId(rawId)) as SupplyItemRow | undefined
    if (row === undefined) throw new NotFoundError('物料不存在。')
    return row
  }

  private parseId(rawId: unknown): number {
    const id = Number(rawId)
    if (!Number.isInteger(id) || id <= 0) throw new BadRequestError('编号需要正整数。')
    return id
  }

  private parseCode(raw: unknown): string {
    if (typeof raw !== 'string' || raw.trim() === '') throw new BadRequestError('物料编码必填。')
    const code = raw.trim()
    if (code.length > 64) throw new BadRequestError('物料编码最长 64 个字符。')
    return code
  }

  private parseName(raw: unknown, fallbackCode: string): string {
    if (raw === undefined || raw === null || raw === '') return fallbackCode
    if (typeof raw !== 'string') throw new BadRequestError('物料名称需要字符串。')
    const name = raw.trim()
    if (name.length > 128) throw new BadRequestError('物料名称最长 128 个字符。')
    return name
  }

  private parseShort(raw: unknown, max = 32): string {
    if (raw === undefined || raw === null) return ''
    if (typeof raw !== 'string') throw new BadRequestError('需要字符串。')
    const v = raw.trim()
    if (v.length > max) throw new BadRequestError(`最长 ${max} 个字符。`)
    return v
  }

  private parseNote(raw: unknown): string {
    return this.parseShort(raw, 500)
  }

  /** 安全线：数字 ≥0（毫单位落库）；null/空=未设。布尔/对象这类不是数字的类型直接拒（Number(true)=1 会被静默当成 1）。 */
  private parseSafety(raw: unknown): number | null {
    if (raw === undefined || raw === null || raw === '') return null
    if (typeof raw !== 'number' && typeof raw !== 'string') throw new BadRequestError('安全库存应为 ≥0 的数字。')
    const n = Number(raw)
    if (!Number.isFinite(n) || n < 0) throw new BadRequestError(`安全库存 "${String(raw)}" 应为 ≥0 的数字。`)
    return qtyToMilli(n)
  }
}

function toReading(r: LatestStockRow): StockReading {
  return { warehouse: r.warehouse, batchNo: r.batch_no, expiryDate: r.expiry_date, quantity: milliToQty(r.qty_milli), snapshotDate: r.snapshot_date }
}

/** YYYY-MM-DD 加/减天数（本地日历日，不碰时区）。 */
export function addDaysISO(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number]
  const t = new Date(Date.UTC(y, m - 1, d) + days * 86_400_000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`
}

/** 两个 YYYY-MM-DD 相差天数（to - from）。 */
export function diffDaysISO(fromYmd: string, toYmd: string): number {
  const [fy, fm, fd] = fromYmd.split('-').map(Number) as [number, number, number]
  const [ty, tm, td] = toYmd.split('-').map(Number) as [number, number, number]
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000)
}

/** 采购单行指纹（同键内容是否变过；状态改动也进指纹，重开/收货后键同内容不同=覆盖更新）。 */
export function poFp(
  poNo: string,
  itemId: number,
  supplier: string,
  qtyMilli: number,
  orderedDate: string,
  promisedDate: string,
  status: string,
  receivedDate: string,
  note: string,
): string {
  return [poNo, itemId, supplier, qtyMilli, orderedDate, promisedDate, status, receivedDate, note].join(FP_SEP)
}

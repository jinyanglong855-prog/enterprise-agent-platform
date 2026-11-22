/** 供应链导入域（2026-11-01 生产任务全图 v0，通道A=文件导入）：CSV/TSV 文本 + 固定中文模板
 *  → 确定性解析 → 预览（不写库）→ 事务原子落库。三种导入：items（物料主数据，含别名）/
 *  inventory（库存快照）/ pos（采购单行）。解析器复用账本导入的 RFC4180 实现；
 *  落库走 SupplyService 的同一套守门（毫单位数量、日期校验）。
 *  幂等口径：快照同键（物料+仓库+日期+来源）fp 同→跳过、fp 变→最新读数覆盖；
 *  采购单同键（单号+物料）同 fp→跳过、变→最新口径覆盖，但**库里已收货/已取消的单不被文件倒翻**
 *  （旧文件重贴一遍不会把界面上点过收货的单改回未到货、不会重开逾期预警；要重开去台账点「重开」），
 *  被挡的单号在结果 protectedClosed 里披露；物料编码已存在→只补空缺字段不覆盖已有值。
 *  批内同键多行：inventory/pos 后行覆盖前行（最新报数赢）；items 先行建档、后行只补空缺（与"已存在只补空"同一规则）。
 *  预览里标 duplicate_in_batch 让人看见。导入落到已归档物料名下不报错（历史单据合法），但在 archivedTargets 里披露。
 *  结构级守门：金额/单价/价格列一律剥除并在预览里披露——本域只收数量与日期，"值多少钱"归财务域。 */
import type { DB } from '../db/database.js'
import { nowIso } from '../db/database.js'
import type { AuditService } from '../audit/audit.service.js'
import { BadRequestError } from '../errors.js'
import { localDate, parseDate } from '../finance/finance.util.js'
import { IMPORT_MAX_BYTES, IMPORT_MAX_ROWS, normalizeDateCell, parseDelimited, resolveDelimiter } from '../finance/finance-imports.service.js'
import { FP_SEP, poFp, SupplyService, type SupplyActor } from './supply.service.js'
import { MONEY_COLUMN_RE, PO_STATUS_VALUES, qtyToMilli, type PoStatus, type SupplyItemRow } from './supply.types.js'

export const SUPPLY_IMPORT_KINDS = ['items', 'inventory', 'pos'] as const
export type SupplyImportKind = (typeof SUPPLY_IMPORT_KINDS)[number]

export const KIND_LABELS: Record<SupplyImportKind, string> = {
  items: '物料主数据',
  inventory: '库存快照',
  pos: '采购单',
}

const ITEMS_HEADER = ['物料编码', '物料名称', '单位', '分类', '安全库存', '别名', '备注'] as const
const INVENTORY_HEADER = ['物料编码', '物料名称', '仓库', '数量', '快照日期'] as const
/** 库存快照可选列（S5 批次/效期，2026-11-01）：老模板不带这两列照常可导（批次=''=总量行）。 */
const INVENTORY_OPTIONAL = ['批次', '效期'] as const
const POS_HEADER = ['采购单号', '物料编码', '物料名称', '供应商', '数量', '下单日期', '承诺到货日', '状态', '到货日', '备注'] as const

/** 快照来源：import=文件导入（通道 A）；bitable=飞书多维表格只读同步（通道 B）。进 UNIQUE 键与指纹。 */
export type SnapshotSource = 'import' | 'bitable'

const STATUS_ALIASES: Record<string, PoStatus> = {
  open: 'open',
  received: 'received',
  cancelled: 'cancelled',
  未到货: 'open',
  待到货: 'open',
  在途: 'open',
  已到货: 'received',
  已收货: 'received',
  已取消: 'cancelled',
  取消: 'cancelled',
}

/** 归一后的行记录（按 kind 三选一；数量字段全是毫单位）。 */
interface ItemRecord {
  code: string
  name: string
  unit: string
  category: string
  safetyMilli: number | null
  aliases: string[]
  note: string
}
interface SnapshotRecord {
  code: string
  name: string
  warehouse: string
  /** ''=总量行；非空=该仓该批次的读数。 */
  batchNo: string
  /** ''=无效期；有效期必有批次（buildRecord 守门）。 */
  expiryDate: string
  qtyMilli: number
  date: string
}
interface PoRecord {
  poNo: string
  code: string
  name: string
  supplier: string
  qtyMilli: number
  orderedDate: string
  promisedDate: string
  status: PoStatus
  receivedDate: string
  note: string
}
type AnyRecord = ItemRecord | SnapshotRecord | PoRecord

export interface SupplyImportRowResult {
  line: number
  raw: string[]
  /** 归一后的行数据（通过守门时才有）。 */
  record?: AnyRecord
  error?: string
  /** 本批次内与更早一行同键（落库时后行覆盖前行）。 */
  duplicate_in_batch?: boolean
}

export interface SupplyImportPreview {
  kind: SupplyImportKind
  kindLabel: string
  delimiter: string
  header: string[]
  /** 剥除的金额类列（结构级守门的可见证据）。 */
  strippedMoneyColumns: string[]
  /** 非阻断提示（库存类）：首次出现的仓库名 / 总量行顶掉批次行——不拦，只把后果说在前面。 */
  hints: string[]
  total: number
  valid: number
  invalid: number
  rows: SupplyImportRowResult[]
}

export interface SupplyImportCommitResult {
  batch: string
  kind: SupplyImportKind
  created: number
  updated: number
  skipped: number
  /** 导入顺带新建的物料编码（陌生编码自动建档，老板回头补全）。 */
  itemsCreated: string[]
  /** 落到已归档物料名下的编码（默认列表/安全线名单里看不见它，勾"含归档"才见）。 */
  archivedTargets: string[]
  /** 库里已收货/已取消、文件里却写成别的状态而被挡下的采购单号（状态与到货日没动，其余字段照常更新）。 */
  protectedClosed: string[]
  strippedMoneyColumns: string[]
  /** 同 SupplyImportPreview.hints（按落库前的库里现状算）。 */
  hints: string[]
}

interface Counts {
  created: number
  updated: number
  skipped: number
}

/** 一次 commit 的披露收集器（三张披露清单都按首现去重）。 */
interface CommitCtx {
  itemsCreated: string[]
  archivedTargets: string[]
  protectedClosed: string[]
}

function pushUnique(list: string[], v: string): void {
  if (!list.includes(v)) list.push(v)
}

export class SupplyImportsService {
  constructor(
    private readonly db: DB,
    private readonly audit: AuditService,
    private readonly supply: SupplyService,
  ) {}

  /** 预览：解析 + 逐行守门，不写库。 */
  preview(kind: SupplyImportKind, text: string): SupplyImportPreview {
    const { delimiter, header, stripped, lines } = this.parseTable(kind, text)
    const seenKeys = new Set<string>()
    const dayMode = new Map<string, 'total' | 'batch'>()
    const rows = lines.map(({ line, cells }) => {
      const result: SupplyImportRowResult = { line, raw: cells }
      try {
        const record = this.buildRecord(kind, header, cells)
        result.record = record
        if (kind === 'inventory') checkDayMode(dayMode, record as SnapshotRecord, this.itemKeyOf((record as SnapshotRecord).code))
        const key = rowKey(kind, record)
        if (seenKeys.has(key)) result.duplicate_in_batch = true
        else seenKeys.add(key)
      } catch (err) {
        result.error = err instanceof Error ? err.message : String(err)
      }
      return result
    })
    const invalid = rows.filter((r) => r.error !== undefined).length
    const hints = kind === 'inventory' ? this.inventoryHints(rows.filter((r) => r.error === undefined).map((r) => r.record as SnapshotRecord)) : []
    return {
      kind,
      kindLabel: KIND_LABELS[kind],
      delimiter,
      header,
      strippedMoneyColumns: stripped,
      hints,
      total: rows.length,
      valid: rows.length - invalid,
      invalid,
      rows,
    }
  }

  /** 提交：事务原子——任一行过不了守门整批回滚（预览与落库同一解析器，口径一致）。
   *  source：通道 A 文件导入='import'（缺省）；通道 B 多维表格同步='bitable'（批次号前缀 SUPB，快照 UNIQUE 键含来源）。 */
  commit(actor: SupplyActor, kind: SupplyImportKind, text: string, note = '', now = new Date(), source: SnapshotSource = 'import'): SupplyImportCommitResult {
    const { header, stripped, lines } = this.parseTable(kind, text)
    const batch = allocateBatchId(now, source)
    const ctx: CommitCtx = { itemsCreated: [], archivedTargets: [], protectedClosed: [] }
    const counts: Counts = { created: 0, updated: 0, skipped: 0 }
    // 先整批解析再落库：混报守门（同仓同日既总量又批次）要看见兄弟行，逐行边解析边写做不到
    const records: AnyRecord[] = []
    const dayMode = new Map<string, 'total' | 'batch'>()
    for (const { line, cells } of lines) {
      try {
        const record = this.buildRecord(kind, header, cells)
        if (kind === 'inventory') checkDayMode(dayMode, record as SnapshotRecord, this.itemKeyOf((record as SnapshotRecord).code))
        records.push(record)
      } catch (err) {
        throw new BadRequestError(`第 ${line} 行：${err instanceof Error ? err.message : String(err)}`)
      }
    }
    // 提示在落库前算（要比"库里现状 vs 本批"）；落库后原样返回，让导入/同步结果把后果带给人
    const hints = kind === 'inventory' ? this.inventoryHints(records as SnapshotRecord[]) : []
    const run = this.db.transaction(() => {
      for (const record of records) {
        const n =
          kind === 'items'
            ? this.upsertItem(actor, record as ItemRecord)
            : kind === 'inventory'
              ? this.upsertSnapshot(actor, record as SnapshotRecord, ctx, source)
              : this.upsertPo(actor, record as PoRecord, ctx, now)
        counts.created += n.created
        counts.updated += n.updated
        counts.skipped += n.skipped
      }
      if (counts.created + counts.updated === 0) {
        const guard =
          ctx.protectedClosed.length > 0
            ? `其中 ${ctx.protectedClosed.join('、')} 在库里已收货/已取消，文件里的状态不会把它倒翻（要重开请到采购台账点「重开」）。`
            : '要覆盖更新请改动内容后再导。'
        throw new BadRequestError(`没有新数据可导：全部行都与库里已有数据相同。${guard}`)
      }
    })
    run()
    this.audit.log({
      username: actor.username,
      source: actor.source,
      action: 'supply.import',
      targetId: batch,
      detail: { kind, channel: source, ...counts, ...ctx, strippedMoneyColumns: stripped, hints, note: note.trim() },
    })
    return { batch, kind, ...counts, ...ctx, strippedMoneyColumns: stripped, hints }
  }

  template(kind: SupplyImportKind): { kind: SupplyImportKind; kindLabel: string; header: string[]; example: string[][]; csv: string } {
    const header = [...this.templateHeaderOf(kind)] as string[]
    const example =
      kind === 'items'
        ? [
            ['WL-001', '猫砂盆 L 号', '个', '成品', '20', 'SB-001；litter-L', ''],
            ['WL-002', 'PP 塑料粒', '千克', '原料', '500', '', '注塑用'],
          ]
        : kind === 'inventory'
          ? [
              ['WL-001', '猫砂盆 L 号', '主仓', '35', '2026-11-01', '', ''],
              ['WL-002', 'PP 塑料粒', '原料仓', '1200.5', '2026-11-01', '', ''],
              ['WL-003', '冻干鸡肉 500g', '主仓', '40', '2026-11-01', 'B20250901', '2026-12-15'],
              ['WL-003', '冻干鸡肉 500g', '主仓', '25', '2026-11-01', 'B20251015', '2027-02-01'],
            ]
          : [
              ['PO-2026-001', 'WL-002', 'PP 塑料粒', '甬兴塑化', '2000', '2026-10-28', '2026-11-05', '未到货', '', ''],
              ['PO-2026-002', 'WL-001', '猫砂盆 L 号', '恒益五金', '100', '2026-10-30', '2026-11-02', '未到货', '', '加急'],
            ]
    const csv = [header, ...example].map((r) => r.map(csvCell).join(',')).join('\n')
    return { kind, kindLabel: KIND_LABELS[kind], header, example, csv }
  }

  // ------------------------------------------------------------ 非阻断提示

  /** 库存预览/提交的提示（不拦，只把后果说在前面；按 物料+仓库 去重，最多 10 条）：
   *  ① 首次出现的仓库名——库里已有仓时，新拼法多半是同一仓写法不统一（安线按各仓合计比，会把同一批货算两遍）；
   *  ② 总量行顶掉批次行——此前按批次报、本次按总量报（或同日两种都有而批次优先），落库后批次与效期从临期名单消失。
   *  两条都是系统替不了人判断的事：仓是不是同一个、货是不是真合并了，只有报数的人知道。 */
  private inventoryHints(records: SnapshotRecord[]): string[] {
    const hints: string[] = []
    const existing = (this.db.prepare('SELECT DISTINCT warehouse AS w FROM supply_inventory_snapshots ORDER BY warehouse').all() as { w: string }[]).map((r) => r.w)
    if (existing.length > 0) {
      const fresh = [...new Set(records.map((r) => r.warehouse))].filter((w) => !existing.includes(w))
      if (fresh.length > 0) {
        hints.push(`首次出现的仓库名：${fresh.join('、')}（库里已有：${existing.join('、')}）。若是同一个仓请统一写法——安线按各仓合计比，拼法不同会把同一批货算两遍。`)
      }
    }
    // 本批里各 物料+仓库 最晚的批次行日期（同一文件先批次后总量也算顶）
    const fileBatchDate = new Map<string, string>()
    for (const r of records) {
      if (r.batchNo === '') continue
      const k = `${this.itemKeyOf(r.code)}${FP_SEP}${r.warehouse}`
      const prev = fileBatchDate.get(k)
      if (prev === undefined || r.date > prev) fileBatchDate.set(k, r.date)
    }
    // 库里该物料该仓"最新一天"是不是批次行（是则返回那天，否则 null）
    const latestBatchStmt = this.db.prepare(
      `SELECT MAX(snapshot_date) AS d FROM supply_inventory_snapshots
        WHERE item_id = ? AND warehouse = ? AND batch_no <> ''
          AND snapshot_date = (SELECT MAX(snapshot_date) FROM supply_inventory_snapshots WHERE item_id = ? AND warehouse = ?)`,
    )
    const seen = new Set<string>()
    let overflow = 0
    for (const r of records) {
      if (r.batchNo !== '') continue
      const itemKey = this.itemKeyOf(r.code)
      const k = `${itemKey}${FP_SEP}${r.warehouse}`
      if (seen.has(k)) continue
      let batchDate = fileBatchDate.get(k) ?? ''
      if (itemKey.startsWith('id:')) {
        const id = Number(itemKey.slice(3))
        const row = latestBatchStmt.get(id, r.warehouse, id, r.warehouse) as { d: string | null }
        if (row.d !== null && row.d > batchDate) batchDate = row.d
      }
      if (batchDate === '' || r.date < batchDate) continue
      seen.add(k)
      if (hints.length >= 10) {
        overflow++
        continue
      }
      hints.push(
        r.date === batchDate
          ? `${r.code} ${r.warehouse}：${batchDate} 已有批次行，本次同日总量行落库后不参与读数（同仓同日批次行优先）。`
          : `${r.code} ${r.warehouse}：此前按批次报数（最近 ${batchDate}），本次 ${r.date} 改按总量报——落库后该仓批次与效期将从临期名单消失；货仍分批请按批次报。`,
      )
    }
    if (overflow > 0) hints.push(`另有 ${overflow} 处总量行顶掉批次行，略。`)
    return hints
  }

  // ------------------------------------------------------------ 解析

  /** 混报守门的物料键：编码/别名能解析到已有物料就用其 id（别名与主编码混写也算同一物料），否则用编码原文（新物料）。 */
  private itemKeyOf(code: string): string {
    const hit = this.supply.resolveItemRef(code)
    return hit === undefined ? `code:${code}` : `id:${hit.id}`
  }

  /** 必需列（缺任一 400）。 */
  private headerOf(kind: SupplyImportKind): readonly string[] {
    return kind === 'items' ? ITEMS_HEADER : kind === 'inventory' ? INVENTORY_HEADER : POS_HEADER
  }

  /** 模板列=必需列+可选列（库存快照多"批次/效期"两列；不填就是总量行）。 */
  private templateHeaderOf(kind: SupplyImportKind): readonly string[] {
    return kind === 'inventory' ? [...INVENTORY_HEADER, ...INVENTORY_OPTIONAL] : this.headerOf(kind)
  }

  /** 解析与列头校验（preview/commit 共用）：定界符自适应、BOM 剥除、空行过滤、行数上限、
   *  必需列存在性、金额列剥除披露。 */
  private parseTable(kind: SupplyImportKind, text: string): {
    delimiter: string
    header: string[]
    stripped: string[]
    lines: { line: number; cells: string[] }[]
  } {
    if (typeof text !== 'string' || text.trim() === '') throw new BadRequestError('导入内容为空。')
    if (Buffer.byteLength(text, 'utf8') > IMPORT_MAX_BYTES) {
      throw new BadRequestError(`导入内容超过 ${IMPORT_MAX_BYTES / 1024 / 1024} MB 上限，请拆分后分批导入。`)
    }
    const delimiter = resolveDelimiter(text)
    const table = parseDelimited(text.replace(/^\uFEFF/, ''), delimiter)
    const lines = table
      .map((cells, i) => ({ line: i + 1, cells }))
      .filter((r) => r.cells.some((c) => c.trim() !== ''))
    if (lines.length === 0) throw new BadRequestError('导入内容没有有效数据行。')
    const rawHeader = lines[0]!.cells.map((c) => c.trim())
    const expected = this.headerOf(kind)
    const missing = expected.filter((h) => !rawHeader.includes(h))
    if (missing.length > 0) {
      throw new BadRequestError(`列头缺必需列：${missing.join('、')}（${KIND_LABELS[kind]}必需列见模板${kind === 'inventory' ? '，批次/效期可留空' : ''}）。可先下载模板照着填。`)
    }
    const stripped = rawHeader.filter((h) => h !== '' && !expected.includes(h) && MONEY_COLUMN_RE.test(h))
    const dataLines = lines.slice(1)
    if (dataLines.length === 0) throw new BadRequestError('只有列头没有数据行。')
    if (dataLines.length > IMPORT_MAX_ROWS) {
      throw new BadRequestError(`单批最多 ${IMPORT_MAX_ROWS} 行，本次 ${dataLines.length} 行，请拆分后分批导入。`)
    }
    return { delimiter, header: rawHeader, stripped, lines: dataLines }
  }

  private cell(header: string[], cells: string[], name: string): string {
    const idx = header.indexOf(name)
    return idx < 0 ? '' : (cells[idx] ?? '').trim()
  }

  /** 行 → 归一记录（抛错=该行无效）。同名列取首现位置。 */
  private buildRecord(kind: SupplyImportKind, header: string[], cells: string[]): AnyRecord {
    const pick = (name: string): string => this.cell(header, cells, name)
    if (kind === 'items') {
      const code = requireCell(pick('物料编码'), '物料编码')
      return {
        code,
        name: pick('物料名称'),
        unit: pick('单位'),
        category: pick('分类'),
        safetyMilli: parseQtyCell(pick('安全库存'), '安全库存', true),
        aliases: splitAliases(pick('别名')),
        note: pick('备注'),
      }
    }
    if (kind === 'inventory') {
      const batchNo = stripControl(pick('批次'))
      if (batchNo.length > 64) throw new BadRequestError(`批次 "${batchNo.slice(0, 20)}…" 超过 64 字。`)
      const expiryDate = parseDateCell(pick('效期'), '效期')
      // 效期挂在批次上：没批次号的"总量行"报效期没有归属（同仓多批次效期各异），拒绝而不是猜
      if (expiryDate !== '' && batchNo === '') throw new BadRequestError('填了效期就要填批次（效期跟着批次走；按总量报数请把效期留空）。')
      return {
        code: requireCell(pick('物料编码'), '物料编码'),
        name: pick('物料名称'),
        warehouse: normalizeWarehouse(pick('仓库')) || '主仓',
        batchNo,
        expiryDate,
        qtyMilli: parseQtyCell(pick('数量'), '数量', false)!,
        date: parseDateCell(requireCell(pick('快照日期'), '快照日期'), '快照日期'),
      }
    }
    const statusRaw = pick('状态')
    let status: PoStatus = 'open'
    if (statusRaw !== '') {
      const mapped = STATUS_ALIASES[statusRaw]
      if (mapped === undefined) {
        throw new BadRequestError(`状态 "${statusRaw}" 认不出（可用：${PO_STATUS_VALUES.join('|')} 或 未到货/已到货/已取消）。`)
      }
      status = mapped
    }
    return {
      poNo: stripControl(requireCell(pick('采购单号'), '采购单号')),
      code: requireCell(pick('物料编码'), '物料编码'),
      name: pick('物料名称'),
      supplier: pick('供应商'),
      qtyMilli: parseQtyCell(pick('数量'), '数量', false)!,
      orderedDate: parseDateCell(pick('下单日期'), '下单日期'),
      promisedDate: parseDateCell(pick('承诺到货日'), '承诺到货日'),
      status,
      receivedDate: parseDateCell(pick('到货日'), '到货日'),
      note: pick('备注'),
    }
  }

  // ------------------------------------------------------------ 落库

  /** 陌生编码自动建档（新建进 itemsCreated 披露）；命中已归档物料照常落库但进 archivedTargets 披露——
   *  历史单据补录是合法场景，静默才是问题。 */
  private resolveOrCreate(actor: SupplyActor, code: string, name: string, ctx: CommitCtx): SupplyItemRow {
    const before = this.supply.resolveItemRef(code)
    if (before !== undefined) {
      if (before.archived_at !== null) pushUnique(ctx.archivedTargets, before.code)
      return before
    }
    const item = this.supply.ensureItem(actor, code, name)
    pushUnique(ctx.itemsCreated, item.code)
    return item
  }

  private upsertItem(actor: SupplyActor, r: ItemRecord): Counts {
    const existing = this.supply.resolveItemRef(r.code)
    const ts = nowIso()
    if (existing === undefined) {
      this.db
        .prepare(
          `INSERT INTO supply_items (code, name, unit, category, safety_milli, note, created_at, created_by, updated_at, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(r.code, r.name !== '' ? r.name : r.code, r.unit, r.category, r.safetyMilli, r.note, ts, actor.username, ts, actor.username)
      const item = this.supply.resolveItemRef(r.code)!
      this.applyAliases(actor, item.id, r.aliases, item.code)
      return { created: 1, updated: 0, skipped: 0 }
    }
    // 已存在：只补空缺（文件里非空且库里为空/未设才写）——重导同一份文件不改已有档案
    const sets: string[] = []
    const params: (string | number | null)[] = []
    if (r.name !== '' && existing.name === existing.code && r.name !== existing.name) {
      sets.push('name = ?')
      params.push(r.name)
    }
    if (r.unit !== '' && existing.unit === '') {
      sets.push('unit = ?')
      params.push(r.unit)
    }
    if (r.category !== '' && existing.category === '') {
      sets.push('category = ?')
      params.push(r.category)
    }
    if (r.safetyMilli !== null && existing.safety_milli === null) {
      sets.push('safety_milli = ?')
      params.push(r.safetyMilli)
    }
    if (r.note !== '' && existing.note === '') {
      sets.push('note = ?')
      params.push(r.note)
    }
    const aliasAdded = this.applyAliases(actor, existing.id, r.aliases, existing.code)
    if (sets.length === 0) return { created: 0, updated: aliasAdded > 0 ? 1 : 0, skipped: aliasAdded > 0 ? 0 : 1 }
    this.db.prepare(`UPDATE supply_items SET ${sets.join(', ')}, updated_at = ?, updated_by = ? WHERE id = ?`).run(...params, ts, actor.username, existing.id)
    return { created: 0, updated: 1, skipped: 0 }
  }

  /** 别名挂载（与 SupplyService.setAliases 同一套撞名规则；导入里不逐条审计，批次审计一条）。返回新增条数。 */
  private applyAliases(actor: SupplyActor, itemId: number, aliases: string[], code: string): number {
    let added = 0
    for (const alias of aliases) {
      if (alias === code) continue
      const clashItem = this.db.prepare('SELECT id FROM supply_items WHERE code = ?').get(alias) as { id: number } | undefined
      if (clashItem !== undefined) {
        throw new BadRequestError(`别名 "${alias}" 与物料编码撞名（编号 ${clashItem.id}）：换个写法，别让解析有两义。`)
      }
      const held = this.db.prepare('SELECT item_id FROM supply_item_aliases WHERE alias = ?').get(alias) as { item_id: number } | undefined
      if (held !== undefined) {
        if (held.item_id !== itemId) throw new BadRequestError(`别名 "${alias}" 已挂在别的物料（编号 ${held.item_id}）名下：先摘再挂。`)
        continue
      }
      this.db
        .prepare('INSERT INTO supply_item_aliases (alias, item_id, created_at, created_by) VALUES (?, ?, ?, ?)')
        .run(alias, itemId, nowIso(), actor.username)
      added++
    }
    return added
  }

  private upsertSnapshot(actor: SupplyActor, r: SnapshotRecord, ctx: CommitCtx, source: SnapshotSource): Counts {
    const item = this.resolveOrCreate(actor, r.code, r.name, ctx)
    const fp = [item.id, r.warehouse, r.batchNo, r.date, r.qtyMilli, source, r.expiryDate].join(FP_SEP)
    const existing = this.db
      .prepare(
        'SELECT id, fp FROM supply_inventory_snapshots WHERE item_id = ? AND warehouse = ? AND batch_no = ? AND snapshot_date = ? AND source = ?',
      )
      .get(item.id, r.warehouse, r.batchNo, r.date, source) as { id: number; fp: string } | undefined
    if (existing === undefined) {
      this.db
        .prepare(
          `INSERT INTO supply_inventory_snapshots (item_id, warehouse, batch_no, expiry_date, qty_milli, snapshot_date, source, fp, created_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(item.id, r.warehouse, r.batchNo, r.expiryDate, r.qtyMilli, r.date, source, fp, nowIso(), actor.username)
      return { created: 1, updated: 0, skipped: 0 }
    }
    if (existing.fp === fp) return { created: 0, updated: 0, skipped: 1 }
    this.db
      .prepare('UPDATE supply_inventory_snapshots SET qty_milli = ?, expiry_date = ?, fp = ? WHERE id = ?')
      .run(r.qtyMilli, r.expiryDate, fp, existing.id)
    return { created: 0, updated: 1, skipped: 0 }
  }

  private upsertPo(actor: SupplyActor, r: PoRecord, ctx: CommitCtx, now: Date): Counts {
    const item = this.resolveOrCreate(actor, r.code, r.name, ctx)
    let status = r.status
    let receivedDate = r.receivedDate
    const existing = this.db
      .prepare('SELECT id, fp, status, received_date FROM supply_purchase_orders WHERE po_no = ? AND item_id = ?')
      .get(r.poNo, item.id) as { id: number; fp: string; status: PoStatus; received_date: string } | undefined
    if (existing !== undefined && existing.status !== 'open' && status !== existing.status) {
      // 库里已收货/已取消、文件里却是别的状态：状态与到货日按库里的算，其余字段照常——
      // 旧文件重贴不能把人点过的收货倒翻回未到货（会重开逾期预警）；要重开走台账按钮
      status = existing.status
      receivedDate = existing.received_date
      pushUnique(ctx.protectedClosed, r.poNo)
    }
    if (status === 'received' && receivedDate === '') receivedDate = localDate(now)
    if (status !== 'received') receivedDate = ''
    const fp = poFp(r.poNo, item.id, r.supplier, r.qtyMilli, r.orderedDate, r.promisedDate, status, receivedDate, r.note)
    if (existing === undefined) {
      this.db
        .prepare(
          `INSERT INTO supply_purchase_orders
             (po_no, item_id, supplier, qty_milli, ordered_date, promised_date, status, received_date, note, fp, created_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(r.poNo, item.id, r.supplier, r.qtyMilli, r.orderedDate, r.promisedDate, status, receivedDate, r.note, fp, nowIso(), actor.username)
      return { created: 1, updated: 0, skipped: 0 }
    }
    if (existing.fp === fp) return { created: 0, updated: 0, skipped: 1 }
    this.db
      .prepare(
        `UPDATE supply_purchase_orders
           SET supplier = ?, qty_milli = ?, ordered_date = ?, promised_date = ?, status = ?, received_date = ?, note = ?, fp = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(r.supplier, r.qtyMilli, r.orderedDate, r.promisedDate, status, receivedDate, r.note, fp, nowIso(), existing.id)
    return { created: 0, updated: 1, skipped: 0 }
  }
}

// ------------------------------------------------------------------ 纯函数

function requireCell(v: string, label: string): string {
  if (v === '') throw new BadRequestError(`${label}为空。`)
  return v
}

/** 日期列：空→''；否则常见写法归一（2026/11/1、2026.11.01、20261101…）后严格校验。 */
function parseDateCell(raw: string, label: string): string {
  if (raw === '') return ''
  return parseDate(normalizeDateCell(raw), label)!
}

/** 数量列（毫单位）：≥0、≤3 位小数；空+allowEmpty → null。负数拒绝（清点/下单量不为负）。 */
function parseQtyCell(raw: string, label: string, allowEmpty: boolean): number | null {
  if (raw === '') {
    if (allowEmpty) return null
    throw new BadRequestError(`${label}为空。`)
  }
  const n = Number(raw.replace(/[,，\s]/g, ''))
  if (!Number.isFinite(n)) throw new BadRequestError(`${label} "${raw}" 不是数字。`)
  if (n < 0) throw new BadRequestError(`${label} "${raw}" 不能为负数。`)
  return qtyToMilli(n)
}

/** 进 dedupe_key / 指纹的文本剥掉控制字符：FP_SEP 是 \u001F，让它从 CSV 透进来能撞键把整轮扫描打断。 */
function stripControl(v: string): string {
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001f\u007f]/g, '').trim()
}

/** 仓库名归一：只抹"看不见的差异"（控制字符、全角空格、连续/首尾空白），不做同义词字典——
 *  "主仓"与"主仓库"仍是两个仓，靠预览提示（首次出现的仓库名）让人统一写法。 */
function normalizeWarehouse(v: string): string {
  return stripControl(v).replace(/\u3000/g, ' ').replace(/\s+/g, ' ').trim()
}

function splitAliases(raw: string): string[] {
  const out: string[] = []
  for (const s of raw.split(/[;；、,，|]/)) {
    const v = s.trim()
    if (v !== '' && !out.includes(v)) out.push(v)
  }
  return out
}

function rowKey(kind: SupplyImportKind, record: AnyRecord): string {
  if (kind === 'items') return (record as ItemRecord).code
  if (kind === 'inventory') {
    const r = record as SnapshotRecord
    return [r.code, r.warehouse, r.batchNo, r.date].join(FP_SEP)
  }
  const r = record as PoRecord
  return [r.poNo, r.code].join(FP_SEP)
}

/** 同物料同仓同日要么全按总量报（批次留空）、要么全按批次报——混着来，"最新读数"算不清哪行算数，整批拒。
 *  itemKey 由调用方按解析后的物料给（别名与主编码是同一物料，不能靠编码原文绕过）。 */
function checkDayMode(seen: Map<string, 'total' | 'batch'>, r: SnapshotRecord, itemKey: string): void {
  const key = [itemKey, r.warehouse, r.date].join(FP_SEP)
  const mode = r.batchNo === '' ? 'total' : 'batch'
  const prev = seen.get(key)
  if (prev === undefined) seen.set(key, mode)
  else if (prev !== mode) {
    throw new BadRequestError(`${r.code} 在 ${r.warehouse} ${r.date} 既有总量行又有批次行：同仓同日二选一（按批次报就全按批次，不另报总量）。`)
  }
}

function allocateBatchId(d: Date, source: SnapshotSource): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const rand = Math.random().toString(36).slice(2, 6)
  const prefix = source === 'bitable' ? 'SUPB' : 'SUP'
  return `${prefix}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${rand}`
}

function csvCell(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v
}

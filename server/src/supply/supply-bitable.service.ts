/**
 * 通道 B：飞书多维表格（bitable）只读同步（2026-11-01 生产任务全图 §4-2 v0.5）。
 *
 * 方向纪律（与 platform-data 同款）：运行时对飞书**零写**——拿 tenant_access_token 的 POST 除外，
 * 业务只 GET 记录列表。拉回来的记录归一成"导入行文本"，复用 supply-imports 的解析器与守门
 * （commit(..., source='bitable')）：两条通道同一口径、同一事务原子；快照 UNIQUE 键含来源、
 * 批次号前缀 SUPB-，与文件导入（通道 A）互不踩。
 *
 * 本地持久化=登记册（app_meta 单键 JSON）：app_token + 三张表 table_id + 上次同步留痕。
 * 人的路径：在飞书建多维表格（列名照导入模板）→ 管理员登记 app_token/table_id → 界面点"同步"
 * （先"试跑"看预览，再真同步）。表里改数 → 再同步 → 库存读数/台账更新 → 扫描器自会重新过。
 *
 * 字段归一：bitable 记录 fields 是 {列名: 值}；文本取字符串、数字直接用、日期列（毫秒时间戳）转
 * YYYY-MM-DD（本机时区）、多选/人员等复合值取其文字拼接；缺列=''（可选列语义，由解析器守门）。
 * 不认识的列（表里多出来的）直接忽略——模板之外的列不进系统，金额类列更不会（解析层另有剥除披露）。
 */
import type { DB } from '../db/database.js'
import type { AuditService } from '../audit/audit.service.js'
import { BadRequestError } from '../errors.js'
import { FeishuApiError, FeishuClient } from '../bridge/feishu-client.js'
import type { SupplyActor } from './supply.service.js'
import { SUPPLY_IMPORT_KINDS, type SupplyImportKind, type SupplyImportsService } from './supply-imports.service.js'

const REGISTRY_KEY = 'supply.bitable.registry'

/** 单表最多翻页数（page_size 500 → 1 万行）；导入层单批上限另有 IMPORT_MAX_ROWS 守门。 */
const MAX_PAGES = 20
const PAGE_SIZE = 500

export interface BitableRegistry {
  appToken: string
  /** 三类数据各一张表；''=该类未接（同步时报人话错，不碰其他类）。 */
  tables: Record<SupplyImportKind, string>
  updatedAt: string
  updatedBy: string
  /** 最近一次真同步（非试跑）留痕，按类。 */
  lastSync: Partial<Record<SupplyImportKind, { at: string; by: string; batch: string; created: number; updated: number; skipped: number }>>
}

export interface BitableSyncResult {
  kind: SupplyImportKind
  kindLabel: string
  dryRun: boolean
  /** 从表里拉到的记录数（含被守门拒的）。 */
  fetched: number
  /** 真同步：落库批次号（全部无变化时没有批次，unchanged=true）。 */
  batch?: string
  created?: number
  updated?: number
  skipped?: number
  itemsCreated?: string[]
  archivedTargets?: string[]
  protectedClosed?: string[]
  /** 表里一行没变（全部跳过）：不是错，照常返回。 */
  unchanged?: boolean
  /** 试跑：预览计数 + 前几条错误（行号=表里第几条记录+1，与 CSV 行号同）。 */
  valid?: number
  invalid?: number
  errors?: { line: number; error: string }[]
  /** 导入层的非阻断提示（首次出现的仓库名 / 总量行顶掉批次行），试跑与真同步都带。 */
  hints?: string[]
  /** 该类失败（权限/登记/守门）：人话原因；别的类照常。 */
  error?: string
}

interface BitableRecord {
  record_id?: unknown
  fields?: unknown
}

export class SupplyBitableService {
  private client: FeishuClient

  constructor(
    private readonly db: DB,
    private readonly audit: AuditService,
    private readonly imports: SupplyImportsService,
    opts: { fetchFn?: typeof fetch } = {},
  ) {
    this.client = new FeishuClient(opts.fetchFn ?? fetch.bind(globalThis))
  }

  /** 测试接缝：HTTP 级测试在起服务后整体替换 fetch（重建 client；token 缓存随之清零）。 */
  setFetchFn(fn: typeof fetch): void {
    this.client = new FeishuClient(fn)
  }

  // ---------- 登记册 ----------

  /** 已登记 table_id 的类（扫描前自动同步只拉这些：没接的类不是失败，是没用起来；一张都没接=通道 B 没启用）。 */
  configuredKinds(): SupplyImportKind[] {
    const r = this.getRegistry()
    if (r === null) return []
    return SUPPLY_IMPORT_KINDS.filter((k) => r.tables[k] !== '')
  }

  getRegistry(): BitableRegistry | null {
    const row = this.db.prepare('SELECT value FROM app_meta WHERE key = ?').get(REGISTRY_KEY) as { value: string } | undefined
    if (row === undefined) return null
    try {
      const parsed = JSON.parse(row.value) as Partial<BitableRegistry>
      if (typeof parsed !== 'object' || parsed === null || typeof parsed.appToken !== 'string') return null
      const tables = (typeof parsed.tables === 'object' && parsed.tables !== null ? parsed.tables : {}) as Partial<Record<SupplyImportKind, unknown>>
      return {
        appToken: parsed.appToken,
        tables: {
          items: typeof tables.items === 'string' ? tables.items : '',
          inventory: typeof tables.inventory === 'string' ? tables.inventory : '',
          pos: typeof tables.pos === 'string' ? tables.pos : '',
        },
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
        updatedBy: typeof parsed.updatedBy === 'string' ? parsed.updatedBy : '',
        lastSync: typeof parsed.lastSync === 'object' && parsed.lastSync !== null ? parsed.lastSync : {},
      }
    } catch {
      return null
    }
  }

  setRegistry(actor: SupplyActor, input: unknown): { registry: BitableRegistry } {
    if (typeof input !== 'object' || input === null) throw new BadRequestError('需要 {appToken, tables:{items,inventory,pos}}。')
    const body = input as { appToken?: unknown; tables?: unknown }
    if (typeof body.appToken !== 'string' || body.appToken.trim() === '') throw new BadRequestError('appToken 必填（多维表格地址 /base/ 后面那段）。')
    const appToken = body.appToken.trim()
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(appToken)) throw new BadRequestError('appToken 形状不对：只含字母数字下划线横线，8–64 位。')
    const tablesIn = (typeof body.tables === 'object' && body.tables !== null ? body.tables : {}) as Partial<Record<SupplyImportKind, unknown>>
    const tables = {} as Record<SupplyImportKind, string>
    for (const kind of SUPPLY_IMPORT_KINDS) {
      const v = tablesIn[kind]
      if (v !== undefined && typeof v !== 'string') throw new BadRequestError(`tables.${kind} 需要字符串（table_id，tbl 开头）。`)
      const id = (v ?? '').trim()
      if (id !== '' && !/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw new BadRequestError(`tables.${kind} 形状不对：table_id 只含字母数字下划线横线。`)
      tables[kind] = id
    }
    if (Object.values(tables).every((t) => t === '')) throw new BadRequestError('三张表至少登记一张 table_id。')
    const prev = this.getRegistry()
    const registry: BitableRegistry = {
      appToken,
      tables,
      updatedAt: new Date().toISOString(),
      updatedBy: actor.username,
      // 换了 base 就不该沿用旧留痕
      lastSync: prev !== null && prev.appToken === appToken ? prev.lastSync : {},
    }
    this.saveRegistry(registry)
    this.audit.log({
      username: actor.username,
      source: actor.source,
      action: 'supply.bitable.registry.set',
      targetId: REGISTRY_KEY,
      detail: { appToken, tables },
    })
    return { registry }
  }

  private saveRegistry(registry: BitableRegistry): void {
    this.db
      .prepare(
        `INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(REGISTRY_KEY, JSON.stringify(registry), new Date().toISOString())
  }

  // ---------- 同步 ----------

  /** 按类同步（缺省三类全跑）。各类彼此隔离：一类失败（权限/登记/守门）记在它自己的 error 里，
   *  不影响别的类；类内仍是导入层的事务原子（一行过不了整类回滚）。dryRun=只拉只预览不落库。 */
  async sync(actor: SupplyActor, opts: { kinds?: unknown; dryRun?: unknown } = {}, now = new Date()): Promise<{ results: BitableSyncResult[] }> {
    const registry = this.getRegistry()
    if (registry === null) throw new BadRequestError('还没登记多维表格：请管理员先在"多维表格设置"里填 appToken 与 table_id。')
    const kinds = parseKinds(opts.kinds)
    const dryRun = opts.dryRun === true
    const results: BitableSyncResult[] = []
    for (const kind of kinds) {
      results.push(await this.syncKind(actor, registry, kind, dryRun, now))
    }
    if (!dryRun) {
      // 留痕按类写回登记册（失败的类不覆盖上次成功记录）
      for (const r of results) {
        if (r.error !== undefined || r.unchanged === true) continue
        registry.lastSync[r.kind] = {
          at: now.toISOString(),
          by: actor.username,
          batch: r.batch ?? '',
          created: r.created ?? 0,
          updated: r.updated ?? 0,
          skipped: r.skipped ?? 0,
        }
      }
      this.saveRegistry(registry)
    }
    this.audit.log({
      username: actor.username,
      source: actor.source,
      action: 'supply.bitable.sync',
      targetId: registry.appToken,
      detail: {
        dryRun,
        kinds,
        results: results.map((r) => ({
          kind: r.kind,
          fetched: r.fetched,
          ...(r.batch !== undefined ? { batch: r.batch } : {}),
          ...(r.created !== undefined ? { created: r.created, updated: r.updated, skipped: r.skipped } : {}),
          ...(r.invalid !== undefined ? { valid: r.valid, invalid: r.invalid } : {}),
          ...(r.unchanged === true ? { unchanged: true } : {}),
          ...(r.error !== undefined ? { error: r.error } : {}),
        })),
      },
      ok: results.every((r) => r.error === undefined),
    })
    return { results }
  }

  private async syncKind(actor: SupplyActor, registry: BitableRegistry, kind: SupplyImportKind, dryRun: boolean, now: Date): Promise<BitableSyncResult> {
    const template = this.imports.template(kind)
    const base: BitableSyncResult = { kind, kindLabel: template.kindLabel, dryRun, fetched: 0 }
    const tableId = registry.tables[kind]
    if (tableId === '') return { ...base, error: `${template.kindLabel}没登记 table_id（多维表格设置里补上）。` }
    let records: Record<string, unknown>[]
    try {
      records = await this.fetchAll(registry.appToken, tableId)
    } catch (e) {
      return { ...base, error: this.humanize(e, `读${template.kindLabel}表`) }
    }
    base.fetched = records.length
    if (records.length === 0) return { ...base, error: `${template.kindLabel}表是空的（或本应用看不到任何记录）。` }
    const text = toCsv(template.header, records)
    try {
      if (dryRun) {
        const p = this.imports.preview(kind, text)
        return {
          ...base,
          valid: p.valid,
          invalid: p.invalid,
          errors: p.rows.filter((r) => r.error !== undefined).slice(0, 10).map((r) => ({ line: r.line, error: r.error! })),
          hints: p.hints,
        }
      }
      const r = this.imports.commit(actor, kind, text, `多维表格同步（${registry.appToken}/${tableId}）`, now, 'bitable')
      return {
        ...base,
        batch: r.batch,
        created: r.created,
        updated: r.updated,
        skipped: r.skipped,
        itemsCreated: r.itemsCreated,
        archivedTargets: r.archivedTargets,
        protectedClosed: r.protectedClosed,
        hints: r.hints,
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // 表一行没变是常态（人没改数就点了同步）：当成"无变化"而不是失败
      if (!dryRun && msg.startsWith('没有新数据可导')) return { ...base, unchanged: true, created: 0, updated: 0, skipped: records.length }
      // 单批上限是文件通道的口径，"拆分后分批导入"对一张表没意义——换成表格场景的人话
      if (msg.startsWith('单批最多')) {
        return { ...base, error: `${template.kindLabel}表有 ${records.length} 行，超过单次同步上限（${msg.replace(/，本次.*$/, '')}）：请把历史行移到别的表或归档，只留当前有效读数。` }
      }
      return { ...base, error: msg }
    }
  }

  /** 翻页拉全表（只 GET）。fields 不是对象的记录丢掉（bitable 不会这样返回，防御）。 */
  private async fetchAll(appToken: string, tableId: string): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = []
    let pageToken = ''
    for (let page = 0; page < MAX_PAGES; page++) {
      const j = await this.client.call<{ data?: { items?: unknown; has_more?: unknown; page_token?: unknown } }>(
        'GET',
        `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records` +
          `?page_size=${PAGE_SIZE}${pageToken === '' ? '' : `&page_token=${encodeURIComponent(pageToken)}`}`,
      )
      const items = Array.isArray(j.data?.items) ? (j.data?.items as BitableRecord[]) : []
      for (const it of items) {
        if (typeof it.fields === 'object' && it.fields !== null) out.push(it.fields as Record<string, unknown>)
      }
      if (j.data?.has_more !== true || typeof j.data?.page_token !== 'string' || j.data.page_token === '') break
      pageToken = j.data.page_token
    }
    return out
  }

  private humanize(error: unknown, doing: string): string {
    if (error instanceof FeishuApiError) {
      // 1254302 PermissionDenied / 91403 Forbidden / 1254004 TableIdNotExist / 1254003 AppTokenNotExist（真机对照后再精修）
      const hint =
        error.code === 1254302 || error.code === 91403
          ? '——多半是没把这个多维表格共享给本应用（在表格「…」→ 添加协作者 → 选本应用，可阅读即可）'
          : error.code === 1254003 || error.code === 1254004
            ? '——appToken 或 table_id 填错了（对照表格地址栏 /base/<appToken>?table=<table_id>）'
            : ''
      return `${doing}失败 code=${error.code}：${error.msg}${hint}`
    }
    return `${doing}失败：${error instanceof Error ? error.message : String(error)}`
  }
}

function parseKinds(raw: unknown): SupplyImportKind[] {
  if (raw === undefined) return [...SUPPLY_IMPORT_KINDS]
  if (!Array.isArray(raw) || raw.length === 0) throw new BadRequestError(`kinds 需要非空数组（${SUPPLY_IMPORT_KINDS.join(' | ')}）。`)
  const out: SupplyImportKind[] = []
  for (const k of raw) {
    if (typeof k !== 'string' || !(SUPPLY_IMPORT_KINDS as readonly string[]).includes(k)) {
      throw new BadRequestError(`kinds 只认 ${SUPPLY_IMPORT_KINDS.join(' | ')}。`)
    }
    if (!out.includes(k as SupplyImportKind)) out.push(k as SupplyImportKind)
  }
  // 固定顺序：先物料再快照再采购单（陌生编码会自动建档，但先导物料能带上单位/安全线）
  return SUPPLY_IMPORT_KINDS.filter((k) => out.includes(k))
}

/** 模板里的日期列：只有这些列才把数字当时间戳转日期——批次号/编码等文本列里的长数字必须原样保留。 */
const DATE_COLUMNS = new Set(['快照日期', '效期', '下单日期', '承诺到货日', '到货日'])

/** 记录 → CSV 文本（列=导入模板列；表里没有的列=''）。 */
function toCsv(header: string[], records: Record<string, unknown>[]): string {
  const lines = [header.map(csvCell).join(',')]
  for (const rec of records) lines.push(header.map((h) => csvCell(DATE_COLUMNS.has(h) ? dateText(rec[h]) : cellText(rec[h]))).join(','))
  return lines.join('\n')
}

/** 日期列：bitable 日期字段是毫秒时间戳（13 位）→ 本机时区 YYYY-MM-DD；10 位当秒；字符串原样交给解析器。 */
export function dateText(v: unknown): string {
  if (typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v)) {
    if (v >= 1e11 && v <= 4e12) return localYmd(new Date(v))
    if (v >= 1e9 && v < 1e11) return localYmd(new Date(v * 1000))
  }
  return cellText(v)
}

/** bitable 字段值 → 文本（不做日期猜测：数字就是数字）。 */
export function cellText(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : ''
  if (typeof v === 'boolean') return v ? '是' : '否'
  if (Array.isArray(v)) return v.map(cellText).filter((s) => s !== '').join('；')
  if (typeof v === 'object') {
    const o = v as { text?: unknown; name?: unknown; value?: unknown; link?: unknown }
    if (typeof o.text === 'string') return o.text.trim()
    if (typeof o.name === 'string') return o.name.trim()
    if (o.value !== undefined) return cellText(o.value)
    if (typeof o.link === 'string') return o.link.trim()
  }
  return ''
}

function localYmd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function csvCell(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v
}

/** 批量导入域（任务全图 §0.6 输入通道）：CSV/TSV 文本 + 映射规则 → 确定性解析 → 逐行过 create 守门 →
 *  预览（合法/错误/疑似重复三类）→ 事务原子落库。
 *  台账页（固定模板）与对话入口（agent 看完结构出映射规则）共用同一解析器：agent 出理解和规则，代码干执行。
 *  账本只走"确认后落库"：预览不写库；commit 由老板本人在界面触发，或经批量提案卡片确认（source=confirm）。 */
import type { DB } from '../db/database.js'
import type { AuditService } from '../audit/audit.service.js'
import { BadRequestError } from '../errors.js'
import { STATUS_VALUES, TYPE_VALUES, type Actor, type EntryInput, type EntryStatus, type EntryType } from './finance.types.js'
import type { EntryRecord, FinanceService } from './finance.service.js'
import { parseAmount, parseDate, yuanToCents } from './finance.util.js'

/** 单批上限：真实量级一个月几十到几百笔；超过让用户分批（也压住一次事务的体量）。 */
export const IMPORT_MAX_ROWS = 500
export const IMPORT_MAX_BYTES = 1024 * 1024

/** 可映射的账目字段（与 EntryInput 同名；followup_note 不进导入）。 */
export const IMPORT_FIELDS = [
  'date', 'type', 'amount', 'status', 'counterparty', 'category', 'account', 'invoice_no', 'due_date', 'paid_amount', 'note',
] as const
export type ImportField = (typeof IMPORT_FIELDS)[number]

/** 映射规则："这张表怎么解读"。列用索引（0 起）或列头名；date 与 amount 必须映射，type 可由 default_type 或正负号推出。 */
export interface ImportMapping {
  /** 分隔符：',' '\t' ';' '|'；缺省 auto（按首个非空行计数取最多，平局优先 tab）。 */
  delimiter?: string
  /** 首行是否列头；缺省 true。 */
  has_header?: boolean
  columns: Partial<Record<ImportField, number | string>>
  /** 表里没有类型列（或类型列为空）时的统一类型。 */
  default_type?: string
  /** 类型列取值 → 枚举，补内置中文别名之外的叫法（如 "转入"→income）。 */
  type_map?: Record<string, string>
  status_map?: Record<string, string>
  /** 金额正负决定收支（银行流水常见：正=收入 负=支出），入账取绝对值；有类型值时类型优先、只取绝对值。 */
  sign_decides_type?: boolean
  /** 表里没有账户列（或为空）时统一挂的已建档账户。 */
  default_account?: string
  /** 表里没有状态列（或为空）时的统一状态（如银行流水全部 paid）；缺省按类型默认。 */
  default_status?: string
}

export interface ImportRowResult {
  /** 源文件行号（1 起，含列头行），用户按它回去改表。 */
  line: number
  raw: string[]
  /** 映射出的入参（通过守门时才有）。 */
  input?: EntryInput
  error?: string
  /** 库里已有同指纹（日期+类型+金额+对方）的条目编号。 */
  duplicate_of?: string
  /** 本批次内与更早一行同指纹。 */
  duplicate_in_batch?: boolean
}

export interface ImportPreview {
  delimiter: string
  has_header: boolean
  header: string[]
  total: number
  valid: number
  invalid: number
  duplicates: number
  rows: ImportRowResult[]
}

export interface ImportCommitResult {
  batch: string
  created: EntryRecord[]
  skipped: number
}

/** 台账页固定模板：列头中文，老板照着填；类型/状态列中文或英文枚举都认。 */
export const TEMPLATE_HEADER = ['日期', '类型', '金额', '对方', '分类', '账户', '状态', '已收付', '到期日', '发票号', '备注'] as const
export const TEMPLATE_MAPPING: ImportMapping = {
  delimiter: 'auto',
  has_header: true,
  columns: {
    date: '日期',
    type: '类型',
    amount: '金额',
    counterparty: '对方',
    category: '分类',
    account: '账户',
    status: '状态',
    paid_amount: '已收付',
    due_date: '到期日',
    invoice_no: '发票号',
    note: '备注',
  },
}
export const TEMPLATE_EXAMPLE: string[][] = [
  ['2026-10-08', '收入', '12000', '甬城科技', '货款', '', '未收付', '', '2026-11-08', '', '10 月项目尾款'],
  ['2026-10-09', '支出', '368.5', '顺丰', '快递', '微信', '已收付', '', '', '', ''],
]

const TYPE_ALIASES: Record<string, EntryType> = {
  收入: 'income', 应收: 'income', 收款: 'income',
  支出: 'expense', 应付: 'expense', 付款: 'expense',
  报销: 'reimburse',
  发票: 'invoice', 开票: 'invoice',
  工资: 'payroll', 社保: 'payroll', 工资社保: 'payroll', 薪资: 'payroll',
  税费: 'tax', 税: 'tax', 税款: 'tax',
}
const STATUS_ALIASES: Record<string, EntryStatus> = {
  未收付: 'unpaid', 未收: 'unpaid', 未付: 'unpaid', 未结: 'unpaid',
  已收付: 'paid', 已收: 'paid', 已付: 'paid', 已结: 'paid',
  部分收付: 'partial', 部分: 'partial',
  待定: 'pending',
  已开票: 'issued',
  已收票: 'received',
  已作废: 'cancelled', 作废: 'cancelled',
}
const DELIMITERS = [',', '\t', ';', '|'] as const

export class FinanceImportsService {
  constructor(
    private readonly db: DB,
    private readonly audit: AuditService,
    private readonly finance: FinanceService,
  ) {}

  /** 预览：解析 + 逐行守门 + 查重，不写库。mapping 缺省=台账页固定模板。 */
  preview(text: string, mapping: ImportMapping = TEMPLATE_MAPPING): ImportPreview {
    if (typeof text !== 'string' || text.trim() === '') throw new BadRequestError('导入内容为空。')
    if (Buffer.byteLength(text, 'utf8') > IMPORT_MAX_BYTES) {
      throw new BadRequestError(`导入内容超过 ${IMPORT_MAX_BYTES / 1024 / 1024} MB 上限，请拆分后分批导入。`)
    }
    const delimiter = resolveDelimiter(text, mapping.delimiter)
    const hasHeader = mapping.has_header ?? true
    const table = parseDelimited(text.replace(/^\uFEFF/, ''), delimiter)
    const lines = table
      .map((cells, i) => ({ line: i + 1, cells }))
      .filter((r) => r.cells.some((c) => c.trim() !== ''))
    if (lines.length === 0) throw new BadRequestError('导入内容没有有效数据行。')
    const header = hasHeader ? (lines[0]!.cells.map((c) => c.trim())) : lines[0]!.cells.map((_, i) => `列${i + 1}`)
    const dataLines = hasHeader ? lines.slice(1) : lines
    if (dataLines.length === 0) throw new BadRequestError('只有列头没有数据行。')
    if (dataLines.length > IMPORT_MAX_ROWS) {
      throw new BadRequestError(`单批最多 ${IMPORT_MAX_ROWS} 行，本次 ${dataLines.length} 行，请拆分后分批导入。`)
    }
    const cols = resolveColumns(mapping, header, hasHeader)
    const defaults = resolveDefaults(mapping)

    const seen = new Map<string, number>()
    const rows: ImportRowResult[] = dataLines.map(({ line, cells }) => {
      const result: ImportRowResult = { line, raw: cells }
      try {
        const input = this.buildInput(cells, cols, mapping, defaults)
        this.finance.normalizeCreateInput(input)
        result.input = input
        const fp = fingerprint(input)
        const dup = this.findDuplicate(input)
        if (dup !== undefined) result.duplicate_of = dup
        if (seen.has(fp)) result.duplicate_in_batch = true
        else seen.set(fp, line)
      } catch (err) {
        result.error = err instanceof Error ? (err as { message: string }).message : String(err)
      }
      return result
    })
    const invalid = rows.filter((r) => r.error !== undefined).length
    const duplicates = rows.filter((r) => r.error === undefined && (r.duplicate_of !== undefined || r.duplicate_in_batch === true)).length
    return { delimiter, has_header: hasHeader, header, total: rows.length, valid: rows.length - invalid, invalid, duplicates, rows }
  }

  /** 提交：事务原子——任一行过不了守门整批回滚（预览与落库口径一致，不留"导了一半"）。
   *  skip_duplicates=true 时库里已有同指纹的行跳过不入（批内重复不在此列：两行一样就是两笔）。 */
  commit(actor: Actor, rows: EntryInput[], opts: { skip_duplicates?: boolean; note?: string } = {}): ImportCommitResult {
    if (!Array.isArray(rows) || rows.length === 0) throw new BadRequestError('没有可导入的行。')
    if (rows.length > IMPORT_MAX_ROWS) throw new BadRequestError(`单批最多 ${IMPORT_MAX_ROWS} 行，本次 ${rows.length} 行。`)
    const batch = allocateBatchId()
    const run = this.db.transaction((items: EntryInput[]) => {
      const created: EntryRecord[] = []
      let skipped = 0
      // 本批已入账的指纹：批内重复不算"库里已有"（事务里查库会看见刚插入的行，不用它判重）——
      // 两行一样就是两笔，skip_duplicates 只跳过真正来自库里的重复（对抗审查 P1-1）
      const batchSeen = new Set<string>()
      items.forEach((row, i) => {
        if (row === null || typeof row !== 'object') throw new BadRequestError(`第 ${i + 1} 行不是对象。`)
        try {
          this.finance.normalizeCreateInput(row)
        } catch (err) {
          throw new BadRequestError(`第 ${i + 1} 行：${err instanceof Error ? err.message : String(err)}`)
        }
        const fp = fingerprint(row)
        if (opts.skip_duplicates === true && !batchSeen.has(fp) && this.findDuplicate(row) !== undefined) {
          skipped += 1
          return
        }
        created.push(this.finance.create(actor, row, { followupNote: `导入登记（批次 ${batch}）。` }))
        batchSeen.add(fp)
      })
      if (created.length === 0) throw new BadRequestError('所有行都与库里已有账目重复，没有新账可入；要照常入账请关掉"跳过重复"。')
      return { created, skipped }
    })
    const { created, skipped } = run(rows)
    this.audit.log({
      username: actor.username,
      source: actor.source,
      action: 'finance.import',
      targetId: batch,
      detail: { count: created.length, skipped, ids: created.map((r) => r.id), note: (opts.note ?? '').trim() },
    })
    return { batch, created, skipped }
  }

  template(): { header: string[]; example: string[][]; csv: string; mapping: ImportMapping } {
    const csv = [TEMPLATE_HEADER as readonly string[], ...TEMPLATE_EXAMPLE].map((r) => r.map(csvCell).join(',')).join('\n')
    return { header: [...TEMPLATE_HEADER], example: TEMPLATE_EXAMPLE, csv, mapping: TEMPLATE_MAPPING }
  }

  /** 提案卡知情用（对抗审查 P2-2）：数这些行里有多少与账本已有账同指纹（批内互重不计）。
   *  只数不拦：重复的账确认后照常入（老板看着卡面数字决定）。 */
  countDbDuplicates(rows: EntryInput[]): number {
    let n = 0
    for (const row of rows) {
      if (row !== null && typeof row === 'object' && this.findDuplicate(row) !== undefined) n += 1
    }
    return n
  }

  // --------------------------------------------------------------- 内部

  private buildInput(cells: string[], cols: ResolvedColumns, mapping: ImportMapping, defaults: ResolvedDefaults): EntryInput {
    const pick = (field: ImportField): string => {
      const idx = cols[field]
      return idx === undefined ? '' : (cells[idx] ?? '').trim()
    }
    const input: EntryInput = {}

    const dateRaw = pick('date')
    if (dateRaw === '') throw new BadRequestError('日期为空。')
    input.date = normalizeDateCell(dateRaw)
    parseDate(input.date, '日期')

    const amountRaw = pick('amount')
    if (amountRaw === '') throw new BadRequestError('金额为空。')
    const { value, negative } = normalizeAmountCell(amountRaw)
    const amount = parseAmount(value, '金额')

    const typeRaw = pick('type')
    let type: EntryType | undefined
    if (typeRaw !== '') {
      type = resolveType(typeRaw, mapping.type_map)
      if (type === undefined) throw new BadRequestError(`类型"${typeRaw}"认不出（可用：${TYPE_VALUES.join('|')} 或 收入/支出/报销/发票/工资/税费；别的叫法用 type_map 指定）。`)
    } else if (mapping.sign_decides_type === true) {
      type = negative ? 'expense' : 'income'
    } else if (defaults.type !== undefined) {
      type = defaults.type
    } else {
      throw new BadRequestError('类型为空，且没有 default_type、也没开 sign_decides_type。')
    }
    if (negative && mapping.sign_decides_type !== true) {
      throw new BadRequestError(`金额"${amountRaw}"是负数：账本金额只记正数；银行流水请开 sign_decides_type 让正负决定收支。`)
    }
    input.type = type
    input.amount = amount

    const statusRaw = pick('status')
    if (statusRaw !== '') {
      const status = resolveStatus(statusRaw, mapping.status_map)
      if (status === undefined) throw new BadRequestError(`状态"${statusRaw}"认不出（可用：${STATUS_VALUES.join('|')} 或 未收付/已收付/部分收付/待定/已开票/已收票/已作废）。`)
      input.status = status
    } else if (defaults.status !== undefined) {
      input.status = defaults.status
    }

    for (const field of ['counterparty', 'category', 'invoice_no', 'note'] as const) {
      const v = pick(field)
      if (v !== '') input[field] = v
    }
    const account = pick('account') || defaults.account
    if (account !== undefined && account !== '') input.account = account
    const due = pick('due_date')
    if (due !== '') {
      input.due_date = normalizeDateCell(due)
      parseDate(input.due_date, '到期日')
    }
    const paidRaw = pick('paid_amount')
    if (paidRaw !== '') {
      const paid = normalizeAmountCell(paidRaw)
      if (paid.negative) throw new BadRequestError(`已收付"${paidRaw}"不能为负数。`)
      input.paid_amount = parseAmount(paid.value, '已收付', true)
    } else if (input.status === 'paid') {
      input.paid_amount = amount // 已收付=全额到账，补齐让台账"状态"与"已收付"两列自洽
    }
    return input
  }

  private findDuplicate(input: EntryInput): string | undefined {
    // 冲销对两边都不参与查重：原账被冲销=经济上已相抵；作废账同样不挡——统计里已剔除，
    // 让它挡新账就是幽灵挡道（对抗审查 P2-1）。调用方守门已保证 date 是 YYYY-MM-DD。
    const row = this.db
      .prepare(
        `SELECT id FROM finance_entries
         WHERE deleted_at IS NULL AND reverses = '' AND reversed_by = '' AND status != 'cancelled'
           AND date = ? AND type = ? AND amount_cents = ? AND counterparty = ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(String(input.date), String(input.type), yuanToCents(Number(input.amount)), (input.counterparty ?? '').trim()) as
      | { id: string }
      | undefined
    return row?.id
  }
}

// ------------------------------------------------------------------- 解析与归一（纯函数，便于单测）

type ResolvedColumns = Partial<Record<ImportField, number>>
interface ResolvedDefaults {
  type?: EntryType
  status?: EntryStatus
  account?: string
}

export function resolveDelimiter(text: string, spec?: string): string {
  if (spec !== undefined && spec !== '' && spec !== 'auto') {
    if (!(DELIMITERS as readonly string[]).includes(spec)) {
      throw new BadRequestError(`delimiter 只认 ,  \\t  ;  |  或 auto，收到："${spec}"。`)
    }
    return spec
  }
  const firstLine = text.split(/\r?\n/).find((l) => l.trim() !== '') ?? ''
  let best: string = ','
  let bestCount = -1
  for (const d of ['\t', ',', ';', '|']) {
    const count = firstLine.split(d).length - 1
    if (count > bestCount) {
      best = d
      bestCount = count
    }
  }
  return best
}

/** RFC 4180 风格：引号包裹、"" 转义、引号内可含分隔符与换行；\r\n 与 \n 都认。 */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else {
          quoted = false
        }
      } else if (ch === '\r' && text[i + 1] === '\n') {
        cell += '\n' // 引号内跨平台换行归一成 \n
        i++
      } else {
        cell += ch
      }
      continue
    }
    if (ch === '"') {
      quoted = true
    } else if (ch === delimiter) {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else {
      cell += ch
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

function resolveColumns(mapping: ImportMapping, header: string[], hasHeader: boolean): ResolvedColumns {
  if (mapping === null || typeof mapping !== 'object' || mapping.columns === null || typeof mapping.columns !== 'object') {
    throw new BadRequestError('mapping.columns 缺失：至少要指明 date 与 amount 两列。')
  }
  const resolved: ResolvedColumns = {}
  for (const [field, spec] of Object.entries(mapping.columns) as [string, number | string][]) {
    if (!(IMPORT_FIELDS as readonly string[]).includes(field)) {
      throw new BadRequestError(`mapping.columns 里的"${field}"不是可导入字段（可用：${IMPORT_FIELDS.join('|')}）。`)
    }
    if (spec === undefined || spec === null || spec === '') continue
    let idx: number
    if (typeof spec === 'number') {
      if (!Number.isInteger(spec) || spec < 0) throw new BadRequestError(`字段 ${field} 的列索引应为 ≥0 的整数，收到：${spec}。`)
      idx = spec
    } else {
      const name = String(spec).trim()
      idx = header.findIndex((h) => h === name)
      if (idx < 0) {
        if (!hasHeader) throw new BadRequestError(`没有列头时字段 ${field} 只能用列索引，收到列名"${name}"。`)
        throw new BadRequestError(`字段 ${field} 指向的列"${name}"在列头里找不到（列头：${header.join(' / ')}）。`)
      }
    }
    if (idx >= header.length) throw new BadRequestError(`字段 ${field} 的列索引 ${idx} 超出列数（共 ${header.length} 列）。`)
    resolved[field as ImportField] = idx
  }
  if (resolved.date === undefined) throw new BadRequestError('mapping.columns 必须映射 date（日期列）。')
  if (resolved.amount === undefined) throw new BadRequestError('mapping.columns 必须映射 amount（金额列）。')
  return resolved
}

function resolveDefaults(mapping: ImportMapping): ResolvedDefaults {
  const out: ResolvedDefaults = {}
  if (mapping.default_type !== undefined && mapping.default_type !== '') {
    const t = resolveType(mapping.default_type, mapping.type_map)
    if (t === undefined) throw new BadRequestError(`default_type "${mapping.default_type}" 认不出。`)
    out.type = t
  }
  if (mapping.default_status !== undefined && mapping.default_status !== '') {
    const s = resolveStatus(mapping.default_status, mapping.status_map)
    if (s === undefined) throw new BadRequestError(`default_status "${mapping.default_status}" 认不出。`)
    out.status = s
  }
  if (mapping.default_account !== undefined && mapping.default_account.trim() !== '') out.account = mapping.default_account.trim()
  return out
}

function resolveType(raw: string, map?: Record<string, string>): EntryType | undefined {
  const v = raw.trim()
  const mapped = map?.[v]
  const candidate = mapped !== undefined ? mapped.trim() : v
  if ((TYPE_VALUES as readonly string[]).includes(candidate)) return candidate as EntryType
  return TYPE_ALIASES[candidate]
}

function resolveStatus(raw: string, map?: Record<string, string>): EntryStatus | undefined {
  const v = raw.trim()
  const mapped = map?.[v]
  const candidate = mapped !== undefined ? mapped.trim() : v
  if ((STATUS_VALUES as readonly string[]).includes(candidate)) return candidate as EntryStatus
  return STATUS_ALIASES[candidate]
}

/** 常见写法归一到 YYYY-MM-DD：2026/10/1、2026.10.01、2026年10月1日、20261001、带时间的 2026-10-01 12:30。认不出原样返回交 parseDate 报错。 */
export function normalizeDateCell(raw: string): string {
  const s = raw.trim()
  let m = s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:[ T].*)?$/)
  if (m) return `${m[1]}-${pad2(m[2]!)}-${pad2(m[3]!)}`
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  return s
}

/** 金额清洗：去千分位/货币符号/"元"/空格，统一各种负号与括号负数；返回正数字串与是否为负。 */
export function normalizeAmountCell(raw: string): { value: string; negative: boolean } {
  let s = raw.trim().replace(/[,，¥￥\s元]/g, '').replace(/[−–—]/g, '-')
  let negative = false
  if ((s.startsWith('(') && s.endsWith(')')) || (s.startsWith('（') && s.endsWith('）'))) {
    negative = true
    s = s.slice(1, -1)
  }
  if (s.startsWith('-')) {
    negative = true
    s = s.slice(1)
  } else if (s.startsWith('+')) {
    s = s.slice(1)
  }
  return { value: s, negative }
}

function fingerprint(input: EntryInput): string {
  return [input.date, input.type, yuanToCents(Number(input.amount)), (input.counterparty ?? '').trim()].join('|')
}

function allocateBatchId(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const rand = Math.random().toString(36).slice(2, 6)
  return `IMP-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${rand}`
}

function csvCell(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v
}

function pad2(v: string): string {
  return v.padStart(2, '0')
}

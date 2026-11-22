/** 账户域服务（口袋维，任务全图 §0.4-2 账户实体化）：
 *  账户=实体（名称+类型+期初余额）；余额=期初+Σ该账户已收−Σ已付（流量口径在 finance-flow.ts 共享）。
 *  记账侧的账户强校验在 finance.service.requireAccount（account 非空必须命中本表且未停用）。 */
import type { DB } from '../db/database.js'
import { nowIso } from '../db/database.js'
import type { AuditService } from '../audit/audit.service.js'
import { BadRequestError, NotFoundError } from '../errors.js'
import { type Actor, type AccountKind } from './finance.types.js'
import { flowByAccountCents } from './finance-flow.js'
import { centsToYuan, parseSignedAmount, r2, yuanToCents } from './finance.util.js'

export interface AccountRecord {
  id: number
  name: string
  kind: AccountKind
  opening_balance: number
  balance: number
  note: string
  archived: boolean
  created_at: string
  created_by: string
}

export interface AccountInput {
  name?: string
  kind?: string
  opening_balance?: number | string
  note?: string
  archived?: boolean
}

export class FinanceAccountsService {
  constructor(
    private readonly db: DB,
    private readonly audit: AuditService,
  ) {}

  list(): { count: number; accounts: AccountRecord[] } {
    const rows = this.db
      .prepare('SELECT * FROM finance_accounts ORDER BY archived_at IS NOT NULL, id ASC')
      .all() as AccountRow[]
    const flows = flowByAccountCents(this.db)
    return {
      count: rows.length,
      accounts: rows.map((r) => this.toRecord(r, flows.get(r.name) ?? 0)),
    }
  }

  create(actor: Actor, input: AccountInput): AccountRecord {
    const name = (input.name ?? '').trim()
    if (name === '' || name.length > 30) {
      throw new BadRequestError('账户名需要 1–30 个字（如：微信、对公银行、支付宝、现金），收到："' + (input.name ?? '') + '"。')
    }
    if (input.archived !== undefined) throw new BadRequestError('新建账户不支持 archived 参数；建了不用可再停用。')
    const kind = this.requireKind(input.kind ?? 'other')
    const opening = input.opening_balance !== undefined ? parseSignedAmount(input.opening_balance, 'opening_balance') : 0
    const dup = this.db.prepare('SELECT id FROM finance_accounts WHERE name = ?').get(name)
    if (dup !== undefined) throw new BadRequestError(`账户"${name}"已存在，不用重复建。`)
    this.db
      .prepare(
        'INSERT INTO finance_accounts (name, kind, opening_balance_cents, note, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(name, kind, yuanToCents(opening), (input.note ?? '').trim(), nowIso(), actor.username)
    this.audit.log({
      username: actor.username,
      source: actor.source,
      action: 'account.create',
      targetId: name,
      detail: { kind, opening_balance: opening },
    })
    return this.byName(name)
  }

  update(actor: Actor, rawId: number, input: AccountInput): AccountRecord {
    const row = this.requireRow(rawId)
    const sets: string[] = []
    const values: unknown[] = []
    if (input.name !== undefined) {
      const name = input.name.trim()
      if (name !== row.name) {
        // 账目按账户名关联，改名会让已有账目挂错账户；要换名字=新建+停用旧的
        throw new BadRequestError(`账户不能改名（已有账目按"${row.name}"关联）。要换名字请新建账户再停用本账户。`)
      }
    }
    if (input.kind !== undefined) {
      sets.push('kind = ?')
      values.push(this.requireKind(input.kind))
    }
    if (input.opening_balance !== undefined) {
      sets.push('opening_balance_cents = ?')
      values.push(yuanToCents(parseSignedAmount(input.opening_balance, 'opening_balance')))
    }
    if (input.note !== undefined) {
      sets.push('note = ?')
      values.push(input.note.trim())
    }
    if (input.archived !== undefined) {
      sets.push('archived_at = ?')
      values.push(input.archived ? nowIso() : null)
    }
    if (sets.length > 0) {
      this.db.prepare(`UPDATE finance_accounts SET ${sets.join(', ')} WHERE id = ?`).run(...values, row.id)
      this.audit.log({
        username: actor.username,
        source: actor.source,
        action: 'account.update',
        targetId: String(row.id),
        detail: { fields: Object.keys(input) },
      })
    }
    return this.byRow(this.requireRow(rawId))
  }

  // --------------------------------------------------------------- 内部

  private byName(name: string): AccountRecord {
    const row = this.db.prepare('SELECT * FROM finance_accounts WHERE name = ?').get(name) as AccountRow | undefined
    if (row === undefined) throw new NotFoundError(`找不到账户 ${name}。`)
    return this.byRow(row)
  }

  private byRow(row: AccountRow): AccountRecord {
    const flow = flowByAccountCents(this.db).get(row.name) ?? 0
    return this.toRecord(row, flow)
  }

  private requireRow(rawId: number): AccountRow {
    const row = this.db.prepare('SELECT * FROM finance_accounts WHERE id = ?').get(rawId) as AccountRow | undefined
    if (row === undefined) throw new NotFoundError(`找不到账户 id=${rawId}。`)
    return row
  }

  private toRecord(row: AccountRow, flowCents: number): AccountRecord {
    return {
      id: row.id,
      name: row.name,
      kind: row.kind as AccountKind,
      opening_balance: centsToYuan(row.opening_balance_cents),
      balance: r2(centsToYuan(row.opening_balance_cents + flowCents)),
      note: row.note,
      archived: row.archived_at !== null,
      created_at: row.created_at,
      created_by: row.created_by,
    }
  }

  private requireKind(value: string): AccountKind {
    if (!(ACCOUNT_KINDS as readonly string[]).includes(value)) {
      throw new BadRequestError(`kind 应为 ${ACCOUNT_KINDS.join('|')}，收到："${value}"。`)
    }
    return value as AccountKind
  }
}

const ACCOUNT_KINDS = ['bank', 'wechat', 'alipay', 'cash', 'other'] as const

interface AccountRow {
  id: number
  name: string
  kind: string
  opening_balance_cents: number
  note: string
  archived_at: string | null
  created_at: string
  created_by: string
}

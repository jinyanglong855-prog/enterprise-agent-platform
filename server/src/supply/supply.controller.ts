/** 供应链域 REST 面（2026-11-01 生产任务全图 v0）：物料/库存/采购单查询 + 物料写路径 + 导入。
 *  权限点：读=supply:read，写=supply:write。agent 服务号只持 read——导入落库是界面写路径，
 *  服务号天然 403，不需要财务域那种"批量提案"旁路（供应链导入不是钱，无确认卡片诉求）。
 *  值导入（不是 import type）：Nest 靠 design:paramtypes 元数据解析控制器构造依赖，
 *  type-only 导入会让 DI 起来就是 UnknownDependenciesException（todos.controller 同款踩坑）。 */
import { Body, Controller, Get, Param, Patch, Post, Put, Query, Req } from '@nestjs/common'
import type { Request } from 'express'
import { requirePermission } from '../auth/guard.js'
import { BadRequestError } from '../errors.js'
import { localDate } from '../finance/finance.util.js'
import { EXPIRY_WARN_DAYS_MAX, EXPIRY_WARN_DAYS_MIN, milliToQty } from './supply.types.js'
import { PO_LIST_LIMIT, SupplyService } from './supply.service.js'
import { SUPPLY_IMPORT_KINDS, SupplyImportsService, type SupplyImportKind } from './supply-imports.service.js'
import { SupplyBitableService } from './supply-bitable.service.js'

@Controller('api/supply')
export class SupplyController {
  constructor(
    private readonly supply: SupplyService,
    private readonly imports: SupplyImportsService,
    private readonly bitable: SupplyBitableService,
  ) {}

  @Get('summary')
  summary(@Req() req: Request): unknown {
    requirePermission(req, 'supply:read')
    return this.supply.summary(localDate())
  }

  @Get('items')
  listItems(@Req() req: Request, @Query('query') query?: string, @Query('archived') archived?: string): unknown {
    requirePermission(req, 'supply:read')
    return { items: this.supply.listItems({ query, includeArchived: archived === '1' }) }
  }

  @Get('items/:id')
  getItem(@Req() req: Request, @Param('id') id: string): unknown {
    requirePermission(req, 'supply:read')
    return { item: this.supply.getItem(id) }
  }

  @Post('items')
  createItem(@Req() req: Request, @Body() body: Record<string, unknown>): unknown {
    const auth = requirePermission(req, 'supply:write')
    return { item: this.supply.createItem(actorOf(auth, req), body) }
  }

  @Patch('items/:id')
  updateItem(@Req() req: Request, @Param('id') id: string, @Body() body: Record<string, unknown>): unknown {
    const auth = requirePermission(req, 'supply:write')
    return { item: this.supply.updateItem(actorOf(auth, req), id, body) }
  }

  @Post('items/:id/archive')
  archiveItem(@Req() req: Request, @Param('id') id: string): unknown {
    const auth = requirePermission(req, 'supply:write')
    return this.supply.archiveItem(actorOf(auth, req), id)
  }

  @Post('items/:id/unarchive')
  unarchiveItem(@Req() req: Request, @Param('id') id: string): unknown {
    const auth = requirePermission(req, 'supply:write')
    return this.supply.unarchiveItem(actorOf(auth, req), id)
  }

  @Put('items/:id/aliases')
  setAliases(@Req() req: Request, @Param('id') id: string, @Body() body: { aliases?: unknown }): unknown {
    const auth = requirePermission(req, 'supply:write')
    return this.supply.setAliases(actorOf(auth, req), id, body?.aliases)
  }

  /** 安线名单按物料合计比（2026-11-01 用户拍板）：quantity=各仓最新读数合计，warehouses=分仓明细人话。 */
  @Get('below-safety')
  belowSafety(@Req() req: Request): unknown {
    requirePermission(req, 'supply:read')
    return {
      items: this.supply.belowSafetyRows().map((r) => ({
        itemId: r.item_id,
        code: r.code,
        name: r.name,
        unit: r.unit,
        warehouses: r.warehouses,
        quantity: milliToQty(r.total_milli),
        safetyStock: milliToQty(r.safety_milli),
        snapshotDate: r.snapshot_date,
      })),
    }
  }

  /** 临期/过期批次名单（S5）：效期 ≤ 今天+临期窗口（域设置，缺省 90 天）的有批次读数，daysLeft<0=已过期。 */
  @Get('expiring')
  expiring(@Req() req: Request): unknown {
    requirePermission(req, 'supply:read')
    const today = localDate()
    return {
      today,
      warnDays: this.supply.expiryWarnDays(),
      items: this.supply.expiringRows(today).map((r) => ({
        itemId: r.item_id,
        code: r.code,
        name: r.name,
        unit: r.unit,
        warehouse: r.warehouse,
        batchNo: r.batch_no,
        expiryDate: r.expiry_date,
        quantity: milliToQty(r.qty_milli),
        daysLeft: r.days_left,
      })),
    }
  }

  /** 月报（R1）：month=YYYY-MM，缺省当月；当月未过完 partial=true 按"截至今天"算。 */
  @Get('report/monthly')
  monthlyReport(@Req() req: Request, @Query('month') month?: string): unknown {
    requirePermission(req, 'supply:read')
    const today = localDate()
    const m = month === undefined || month === '' ? today.slice(0, 7) : month
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw new BadRequestError('month 格式应为 YYYY-MM。')
    return this.supply.monthlyReport(m, today)
  }

  /** 列表有 LIMIT（PO_LIST_LIMIT）：响应带 total/limit，超出时前端与插件如实说"共 N 张、只列前 M 张"而不是静默截断。 */
  @Get('pos')
  listPos(@Req() req: Request, @Query('status') status?: string, @Query('itemId') itemId?: string, @Query('overdue') overdue?: string): unknown {
    requirePermission(req, 'supply:read')
    const idNum = itemId !== undefined && itemId !== '' ? Number(itemId) : undefined
    if (idNum !== undefined && (!Number.isInteger(idNum) || idNum <= 0)) throw new BadRequestError('itemId 应为正整数。')
    const opts = { status, itemId: idNum, overdueBefore: overdue === '1' ? localDate() : undefined }
    return { pos: this.supply.listPos(opts), total: this.supply.countPos(opts), limit: PO_LIST_LIMIT }
  }

  @Patch('pos/:id')
  updatePo(@Req() req: Request, @Param('id') id: string, @Body() body: Record<string, unknown>): unknown {
    const auth = requirePermission(req, 'supply:write')
    return { po: this.supply.updatePo(actorOf(auth, req), id, body) }
  }

  @Get('imports/template')
  template(@Req() req: Request, @Query('kind') kind?: string): unknown {
    requirePermission(req, 'supply:read')
    return this.imports.template(parseKind(kind))
  }

  @Post('imports/preview')
  preview(@Req() req: Request, @Body() body: { kind?: unknown; text?: unknown }): unknown {
    requirePermission(req, 'supply:read')
    if (typeof body?.text !== 'string') throw new BadRequestError('需要 text（CSV/TSV 文本）字段。')
    return this.imports.preview(parseKind(body.kind), body.text)
  }

  @Post('imports/commit')
  commit(@Req() req: Request, @Body() body: { kind?: unknown; text?: unknown; note?: unknown }): unknown {
    const auth = requirePermission(req, 'supply:write')
    if (typeof body?.text !== 'string') throw new BadRequestError('需要 text（CSV/TSV 文本）字段。')
    return this.imports.commit(actorOf(auth, req), parseKind(body.kind), body.text, typeof body.note === 'string' ? body.note : '')
  }

  // ---------- 域设置（企业建档参数：临期窗口，2026-11-02） ----------

  /** 读给有 supply:read 的人（名单页要显示"按 N 天算"）；改要 admin:manage（阈值是企业参数，和路由/登记册同级）。 */
  @Get('settings')
  settings(@Req() req: Request): unknown {
    requirePermission(req, 'supply:read')
    return { settings: this.supply.getSettings(), range: { expiryWarnDays: [EXPIRY_WARN_DAYS_MIN, EXPIRY_WARN_DAYS_MAX] } }
  }

  @Put('settings')
  setSettings(@Req() req: Request, @Body() body: unknown): unknown {
    const auth = requirePermission(req, 'admin:manage')
    return { settings: this.supply.setSettings(actorOf(auth, req), body) }
  }

  // ---------- 通道 B：多维表格只读同步（2026-11-01 v0.5） ----------

  /** 登记册可读给有 supply:read 的人（同步按钮要知道配没配、上次同步何时）；改登记册要 admin:manage。 */
  @Get('bitable')
  bitableRegistry(@Req() req: Request): unknown {
    requirePermission(req, 'supply:read')
    return { registry: this.bitable.getRegistry() }
  }

  @Put('bitable')
  setBitableRegistry(@Req() req: Request, @Body() body: unknown): unknown {
    const auth = requirePermission(req, 'admin:manage')
    return this.bitable.setRegistry(actorOf(auth, req), body)
  }

  /** 同步是写路径（落库走导入层）：supply:write；dryRun=true 只预览也按写权限收口（拉表=消耗平台配额）。 */
  @Post('bitable/sync')
  bitableSync(@Req() req: Request, @Body() body: { kinds?: unknown; dryRun?: unknown }): Promise<unknown> {
    const auth = requirePermission(req, 'supply:write')
    return this.bitable.sync(actorOf(auth, req), { kinds: body?.kinds, dryRun: body?.dryRun })
  }
}

function parseKind(raw: unknown): SupplyImportKind {
  if (typeof raw !== 'string' || !(SUPPLY_IMPORT_KINDS as readonly string[]).includes(raw)) {
    throw new BadRequestError(`kind 只认 ${SUPPLY_IMPORT_KINDS.join(' | ')}。`)
  }
  return raw as SupplyImportKind
}

function actorOf(auth: { username: string }, req: Request): { username: string; source: string } {
  const header = String(req.headers['x-actor-source'] ?? 'ui')
  return { username: auth.username, source: header === 'agent' ? 'agent' : 'ui' }
}

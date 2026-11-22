import type { RouteLocationRaw } from 'vue-router';

/**
 * 跨页跳转的单一事实源（2026-11-02 前端分区 2b）：所有"点信息条跳到对应记录"的链接都从这里构建，
 * 各列表页读同一个 query 契约做预定位。新增深链 = 这里加构建器 + 目标页 applyDeepLink 各加一条。
 */

function clean(
  query: Record<string, string | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(query).filter((e) => e[1] !== undefined && e[1] !== ''),
  ) as Record<string, string>;
}

// ----------------------------------------------------------- 财务

/** 流水台账预定位：id=开详情抽屉；month/type/status/account=预填筛选；outstanding=1 只看未结清。 */
export function ledgerLink(q: {
  account?: string;
  id?: string;
  month?: string;
  outstanding?: string;
  status?: string;
  type?: string;
}): RouteLocationRaw {
  return { path: '/finance/ledger', query: clean(q) };
}

/** 待确认记账：id=定位并高亮那张入账单。 */
export function proposalLink(id: string): RouteLocationRaw {
  return { path: '/finance/proposals', query: { id } };
}

/** 票夹：no=按票号精确过滤并定位；tab=wallet|missing|evidence|output；month=预填月份（缺票清单从待办跳入用）。 */
export function invoiceLink(q: {
  month?: string;
  no?: string;
  tab?: string;
}): RouteLocationRaw {
  return { path: '/finance/invoices', query: clean(q) };
}

/** 工资表：month=YYYY-MM 直接落到那个月。 */
export function payrollLink(month?: string): RouteLocationRaw {
  return { path: '/hr/payroll', query: month ? { month } : {} };
}

// ----------------------------------------------------------- 供应链

/** 库存物料：id=高亮物料行；filter=below 只看低于安全线，filter=expiring 只看有临期批次的物料。 */
export function inventoryLink(q: {
  filter?: 'below' | 'expiring';
  id?: string;
}): RouteLocationRaw {
  return { path: '/supply', query: clean(q) };
}

/** 采购台账：id=开详情；overdue=1 只看逾期未到货。 */
export function purchaseLink(q: {
  id?: string;
  overdue?: string;
}): RouteLocationRaw {
  return { path: '/supply/purchase', query: clean(q) };
}

// ----------------------------------------------------------- 待办 source_ref → 实体链接

export interface TodoEntityLink {
  /** 链接文案（按钮/链接上显示的字）。 */
  text: string;
  to: RouteLocationRaw;
}

/** 待办行的 source_ref（JSON 字符串）按 source_type 翻译成"去源头处理"的直达链接。
 *  没有对应实体（征期日历、零角色账号等）返回 undefined——那些靠处理流程指引的文字步骤。 */
export function todoEntityLink(
  sourceType: string,
  sourceRefJson: string,
): TodoEntityLink | undefined {
  let ref: Record<string, unknown> = {};
  try {
    ref = JSON.parse(sourceRefJson) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const s = (k: string): string =>
    typeof ref[k] === 'string' || typeof ref[k] === 'number'
      ? String(ref[k])
      : '';
  switch (sourceType) {
    case 'scan.receivable':
    case 'scan.payable': {
      const id = s('entryId');
      return id === ''
        ? undefined
        : { text: '看这笔账', to: ledgerLink({ id }) };
    }
    case 'scan.proposal_pending': {
      const id = s('proposalId');
      return id === '' ? undefined : { text: '去确认', to: proposalLink(id) };
    }
    case 'scan.missing_invoice': {
      const month = s('month');
      return {
        text: '看缺票清单',
        to: invoiceLink(
          month === '' ? { tab: 'missing' } : { month, tab: 'missing' },
        ),
      };
    }
    case 'scan.supply.below_safety': {
      const id = s('itemId');
      return id === ''
        ? undefined
        : { text: '看这个物料', to: inventoryLink({ filter: 'below', id }) };
    }
    case 'scan.supply.po_overdue': {
      const id = s('poId');
      return id === ''
        ? undefined
        : { text: '看这张采购单', to: purchaseLink({ id, overdue: '1' }) };
    }
    case 'scan.supply.expiry_near': {
      const id = s('itemId');
      return id === ''
        ? undefined
        : { text: '看这个物料', to: inventoryLink({ filter: 'expiring', id }) };
    }
    case 'scan.payroll.roster': {
      const id = s('employeeId');
      return id === ''
        ? undefined
        : { text: '看这名员工', to: { path: '/hr', query: { id } } };
    }
    case 'scan.payroll.social': {
      const id = s('employeeId');
      return id === ''
        ? undefined
        : { text: '看这名员工', to: { path: '/hr', query: { id } } };
    }
    case 'scan.finance.profile': {
      return { text: '看财务档案', to: { path: '/finance/settings' } };
    }
    default: {
      return undefined;
    }
  }
}

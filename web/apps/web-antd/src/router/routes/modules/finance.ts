import type { RouteRecordRaw } from 'vue-router';

const routes: RouteRecordRaw[] = [
  {
    meta: {
      authority: ['finance:read'],
      icon: 'lucide:wallet',
      order: 2,
      title: '财务',
    },
    name: 'Finance',
    path: '/finance',
    children: [
      {
        component: () => import('#/views/finance/summary.vue'),
        meta: {
          icon: 'lucide:bar-chart-3',
          title: '月度看板',
        },
        name: 'FinanceSummary',
        path: '',
      },
      {
        component: () => import('#/views/finance/ledger/index.vue'),
        meta: {
          icon: 'lucide:rows-3',
          title: '流水台账',
        },
        name: 'FinanceLedger',
        path: 'ledger',
      },
      {
        component: () => import('#/views/finance/proposals/index.vue'),
        meta: {
          icon: 'lucide:stamp',
          title: '待确认记账',
        },
        name: 'FinanceProposals',
        path: 'proposals',
      },
      {
        component: () => import('#/views/finance/accounts/index.vue'),
        meta: {
          icon: 'lucide:wallet-cards',
          title: '账户',
        },
        name: 'FinanceAccounts',
        path: 'accounts',
      },
      {
        component: () => import('#/views/finance/invoices/index.vue'),
        meta: {
          icon: 'lucide:receipt',
          title: '票夹',
        },
        name: 'FinanceInvoices',
        path: 'invoices',
      },
      {
        component: () => import('#/views/finance/posting-rules/index.vue'),
        meta: {
          // 规则是"飞书审批 → 账本提案"的接线配置：管理面权限（与平台登记册同一口径），财务读写不解锁
          authority: ['admin:manage'],
          icon: 'lucide:git-merge',
          title: '审批自动入账规则',
        },
        name: 'FinancePostingRules',
        path: 'posting-rules',
      },
      {
        component: () => import('#/views/finance/settings/index.vue'),
        meta: {
          icon: 'lucide:settings',
          title: '财务设置',
        },
        name: 'FinanceSettings',
        path: 'settings',
      },
    ],
  },
];

export default routes;

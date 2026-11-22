import type { RouteRecordRaw } from 'vue-router';

/** 供应链域（2026-11-01 生产任务全图 v0；2026-11-02 前端分区定名「供应链」）：库存物料 / 采购台账 /
 *  生产月报 / 供应链设置。权限点 supply:read 管菜单可见；
 *  页内写按钮按 supply:write 显隐（没写权限的人看不到新建/导入/收货这些入口，而不是点了才 403）。 */
const routes: RouteRecordRaw[] = [
  {
    meta: {
      authority: ['supply:read'],
      icon: 'lucide:package',
      order: 4,
      title: '供应链',
    },
    name: 'Supply',
    path: '/supply',
    children: [
      {
        component: () => import('#/views/supply/inventory/index.vue'),
        meta: {
          icon: 'lucide:boxes',
          title: '库存物料',
        },
        name: 'SupplyInventory',
        path: '',
      },
      {
        component: () => import('#/views/supply/purchase/index.vue'),
        meta: {
          icon: 'lucide:clipboard-list',
          title: '采购台账',
        },
        name: 'SupplyPurchase',
        path: 'purchase',
      },
      {
        component: () => import('#/views/supply/report/index.vue'),
        meta: {
          icon: 'lucide:file-bar-chart',
          title: '生产月报',
        },
        name: 'SupplyReport',
        path: 'report',
      },
      {
        component: () => import('#/views/supply/settings/index.vue'),
        meta: {
          icon: 'lucide:settings',
          title: '供应链设置',
        },
        name: 'SupplySettings',
        path: 'settings',
      },
    ],
  },
];

export default routes;

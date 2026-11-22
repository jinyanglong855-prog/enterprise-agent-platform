import type { RouteRecordRaw } from 'vue-router';

/** 工作台（2026-11-02 企业大看板 R2）：登录后的首页。今日待办、待确认记账、本月收支、
 *  供应链提醒、系统检查告警一屏汇齐，每一块都可点进对应功能页。 */
const routes: RouteRecordRaw[] = [
  {
    component: () => import('#/views/workbench/index.vue'),
    meta: {
      affixTab: true,
      icon: 'lucide:layout-dashboard',
      order: 0,
      title: '工作台',
    },
    name: 'Workbench',
    path: '/workbench',
  },
];

export default routes;

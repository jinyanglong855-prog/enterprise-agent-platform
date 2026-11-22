import type { RouteRecordRaw } from 'vue-router';

/** 待办中心（2026-10-31 待办预警方案 §七）：预警/待办/晨报同一实体的界面投影。
 *  四视图：今日 / 日历 / 岗位池 / 企业（企业视图页内按 admin:manage 显隐）。权限点 todo:read。 */
const routes: RouteRecordRaw[] = [
  {
    meta: {
      authority: ['todo:read'],
      icon: 'lucide:list-checks',
      order: 1,
      title: '待办中心',
    },
    name: 'Todos',
    path: '/todos',
    children: [
      {
        component: () => import('#/views/todos/index.vue'),
        meta: {
          icon: 'lucide:list-checks',
          title: '待办与预警',
        },
        name: 'TodosIndex',
        path: '',
      },
    ],
  },
];

export default routes;

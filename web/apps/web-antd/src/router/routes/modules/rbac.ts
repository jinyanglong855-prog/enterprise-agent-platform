import type { RouteRecordRaw } from 'vue-router';

/** 系统（2026-10-30 执行计划 P1 拼装台面；2026-11-02 前端分区定名「系统」）：
 *  企业把固定权限点拼装成岗位角色并绑人，admin:manage 专属。 */
const routes: RouteRecordRaw[] = [
  {
    meta: {
      authority: ['admin:manage'],
      icon: 'lucide:shield-check',
      order: 7,
      title: '系统',
    },
    name: 'System',
    path: '/system',
    children: [
      {
        component: () => import('#/views/rbac/roles.vue'),
        meta: {
          icon: 'lucide:shield-check',
          title: '角色权限',
        },
        name: 'SystemRoles',
        path: '',
      },
    ],
  },
];

export default routes;

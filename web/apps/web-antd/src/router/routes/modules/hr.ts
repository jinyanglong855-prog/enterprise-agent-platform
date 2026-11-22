import type { RouteRecordRaw } from 'vue-router';

/** 人事（2026-11-02 前端分区）：员工名册 + 工资表从「财务 › 工资」单页两页签拆出。
 *  人事台本体已随融合定位转向归档（HR=平台强项），这里是财务域最小增量的名册/工资面。
 *  工资是敏感面：独立权限点 payroll:read，财务读写不解锁。 */
const routes: RouteRecordRaw[] = [
  {
    meta: {
      authority: ['payroll:read'],
      icon: 'lucide:users',
      order: 3,
      title: '人事',
    },
    name: 'Hr',
    path: '/hr',
    children: [
      {
        component: () => import('#/views/hr/employees/index.vue'),
        meta: {
          icon: 'lucide:contact',
          title: '员工名册',
        },
        name: 'HrEmployees',
        path: '',
      },
      {
        component: () => import('#/views/hr/payroll/index.vue'),
        meta: {
          icon: 'lucide:banknote',
          title: '工资表',
        },
        name: 'HrPayroll',
        path: 'payroll',
      },
    ],
  },
];

export default routes;

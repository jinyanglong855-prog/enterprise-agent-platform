import type { RouteRecordRaw } from 'vue-router';

/** 知识库（2026-11-02 阶段 3 融合）：公司政策/流程/经验的搜索与问答界面。
 *  权限点 knowledge:read（老板角色缺省持有；要给员工开放在系统权限页勾）。 */
const routes: RouteRecordRaw[] = [
  {
    meta: {
      authority: ['knowledge:read'],
      icon: 'lucide:book-open',
      order: 6,
      title: '知识库',
    },
    name: 'Knowledge',
    path: '/knowledge',
    children: [
      {
        component: () => import('#/views/knowledge/index.vue'),
        meta: {
          icon: 'lucide:book-open',
          title: '政策与经验',
        },
        name: 'KnowledgeIndex',
        path: '',
      },
    ],
  },
];

export default routes;

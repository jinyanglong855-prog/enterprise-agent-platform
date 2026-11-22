import type { RouteRecordRaw } from 'vue-router';

/** 智能助手（2026-11-02 前端分区）：和公司智能体对话（记账/问数/查档案/政策问答）。
 *  权限点 agent:read / agent:write。 */
const routes: RouteRecordRaw[] = [
  {
    meta: {
      authority: ['agent:read'],
      icon: 'lucide:bot',
      order: 5,
      title: '智能助手',
    },
    name: 'Assistant',
    path: '/assistant',
    children: [
      {
        component: () => import('#/views/agent/chat.vue'),
        meta: {
          icon: 'lucide:message-circle',
          title: '智能对话',
        },
        name: 'AssistantChat',
        path: '',
      },
    ],
  },
];

export default routes;

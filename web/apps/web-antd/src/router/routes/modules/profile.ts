import type { RouteRecordRaw } from 'vue-router';

import { $t } from '#/locales';

/** 个人中心（从上游 vben.ts 拆出保留：头像下拉「个人中心」指向 /profile，非演示功能）。 */
const routes: RouteRecordRaw[] = [
  {
    name: 'Profile',
    path: '/profile',
    component: () => import('#/views/_core/profile/index.vue'),
    meta: {
      icon: 'lucide:user',
      hideInMenu: true,
      title: $t('page.auth.profile'),
    },
  },
];

export default routes;

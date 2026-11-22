<script lang="ts" setup>
// 顶栏布局（2026-11-02 残留清理）：右上角铃铛接真实待办（原为 Vben 演示假数据），
// 删 Vben 文档/GitHub/问答外链；本地已读状态只影响角标，不动后端待办。
import type { NotificationItem } from '@vben/layouts';

import type { Obligation } from '#/api/todos';

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';

import { AuthenticationLoginExpiredModal } from '@vben/common-ui';
import { useWatermark } from '@vben/hooks';
import {
  BasicLayout,
  LockScreen,
  Notification,
  UserDropdown,
} from '@vben/layouts';
import { preferences, usePreferences } from '@vben/preferences';
import { useAccessStore, useUserStore } from '@vben/stores';

import dayjs from 'dayjs';

import { listTodosApi } from '#/api/todos';
import { TODO_SOURCE_LABELS } from '#/constants/labels';
import { $t } from '#/locales';
import { useAuthStore } from '#/store';
import LoginForm from '#/views/_core/authentication/login.vue';

const router = useRouter();
const userStore = useUserStore();
const authStore = useAuthStore();
const accessStore = useAccessStore();
const { destroyWatermark, updateWatermark } = useWatermark();
const { isDark } = usePreferences();

const notifications = ref<NotificationItem[]>([]);
const readIds = ref<Set<number | string>>(new Set());
let timer: ReturnType<typeof setInterval> | undefined;

const showDot = computed(() =>
  notifications.value.some((item) => !item.isRead),
);

function dueText(item: Obligation): string {
  if (!item.due_date) return '无固定到期日';
  const days = dayjs(item.due_date).diff(dayjs().startOf('day'), 'day');
  if (days < 0) return `已逾期 ${-days} 天`;
  if (days === 0) return '今天到期';
  return `${days} 天后到期`;
}

async function loadTodos() {
  // 没有待办读权限的角色不轮询（否则每分钟一次 403）；铃铛留空即可
  if (!accessStore.accessCodes.includes('todo:read')) return;
  try {
    const body = await listTodosApi({
      scope: 'mine',
      status: 'active',
      limit: 20,
    });
    notifications.value = body.items.map((item) => ({
      id: item.id,
      avatar: '',
      date: dueText(item),
      isRead: readIds.value.has(item.id),
      message: TODO_SOURCE_LABELS[item.source_type] ?? item.source_type,
      title: item.title,
      link: '/todos',
      query: { id: String(item.id) },
    }));
  } catch {
    // 拉不到（掉线/权限变化）就保持现状，别把角标闪没
  }
}

const menus = computed(() => [
  {
    handler: () => {
      router.push({ name: 'Profile' });
    },
    icon: 'lucide:user',
    text: $t('page.auth.profile'),
  },
]);

const avatar = computed(() => {
  return userStore.userInfo?.avatar ?? preferences.app.defaultAvatar;
});

async function handleLogout() {
  await authStore.logout(false);
}

function handleNoticeClear() {
  notifications.value = [];
}

function markRead(id: number | string) {
  readIds.value.add(id);
  const item = notifications.value.find((item) => item.id === id);
  if (item) {
    item.isRead = true;
  }
}

function remove(id: number | string) {
  notifications.value = notifications.value.filter((item) => item.id !== id);
}

function handleMakeAll() {
  notifications.value.forEach((item) => {
    item.isRead = true;
    readIds.value.add(item.id);
  });
}

const viewAll = () => {
  router.push('/todos');
};

const handleClick = (item: NotificationItem) => {
  if (item.link) {
    router.push({ path: item.link, query: item.query ?? {} });
    markRead(item.id);
  }
};

onMounted(() => {
  loadTodos();
  timer = setInterval(loadTodos, 60_000);
});

onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});

watch(
  () => ({
    enable: preferences.app.watermark,
    content: preferences.app.watermarkContent,
    isDark: isDark.value,
  }),
  async ({ enable, content, isDark: isDarkValue }) => {
    if (enable) {
      const watermarkColor = isDarkValue
        ? 'rgba(255, 255, 255, 0.12)'
        : 'rgba(0, 0, 0, 0.12)';

      await updateWatermark({
        advancedStyle: {
          colorStops: [
            {
              color: watermarkColor,
              offset: 0,
            },
            {
              color: watermarkColor,
              offset: 1,
            },
          ],
          type: 'linear',
        },
        content:
          content ||
          `${userStore.userInfo?.username} - ${userStore.userInfo?.realName}`,
      });
    } else {
      destroyWatermark();
    }
  },
  {
    immediate: true,
  },
);
</script>

<template>
  <BasicLayout
    :avatar
    :text="userStore.userInfo?.realName"
    @clear-preferences-and-logout="handleLogout"
    @logout="handleLogout"
  >
    <template #user-dropdown>
      <UserDropdown
        :avatar
        :menus
        :text="userStore.userInfo?.realName"
        :description="userStore.userInfo?.username"
        @clear-preferences-and-logout="handleLogout"
        @logout="handleLogout"
      />
    </template>
    <template #notification>
      <Notification
        :dot="showDot"
        :notifications="notifications"
        @clear="handleNoticeClear"
        @read="(item) => item.id && markRead(item.id)"
        @remove="(item) => item.id && remove(item.id)"
        @make-all="handleMakeAll"
        @on-click="handleClick"
        @view-all="viewAll"
      />
    </template>
    <template #extra>
      <AuthenticationLoginExpiredModal
        v-model:open="accessStore.loginExpired"
        :avatar
      >
        <LoginForm />
      </AuthenticationLoginExpiredModal>
    </template>
    <template #lock-screen>
      <LockScreen :avatar @to-login="handleLogout" />
    </template>
  </BasicLayout>
</template>

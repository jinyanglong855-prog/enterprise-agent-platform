<script lang="ts" setup>
/**
 * 飞书授权回调页：飞书带 ?code=&state= 回跳到这里。
 * 校验 state（防 CSRF）→ 用 code 换系统会话（与密码登录同一落场）→ 进系统；
 * 任何一步失败都回登录页并提示，不留死屏。
 */
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { LOGIN_PATH } from '@vben/constants';

import { message } from 'ant-design-vue';

import { FEISHU_REDIRECT_URI } from '#/api';
import { useAuthStore } from '#/store';

defineOptions({ name: 'FeishuCallback' });

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();

const errorText = ref('');

onMounted(async () => {
  const code = String(route.query.code ?? '');
  const state = String(route.query.state ?? '');
  const expected = sessionStorage.getItem('feishu-sso-state') ?? '';
  sessionStorage.removeItem('feishu-sso-state');

  const backToLogin = async (text: string) => {
    errorText.value = text;
    message.error(text);
    await router.replace(LOGIN_PATH);
  };

  if (code === '') {
    await backToLogin('飞书授权没有返回授权码，请重新登录。');
    return;
  }
  if (expected === '' || state !== expected) {
    await backToLogin('登录状态校验失败（state 不匹配），请重新点击飞书登录。');
    return;
  }

  try {
    await authStore.feishuLogin(code, FEISHU_REDIRECT_URI);
  } catch (error) {
    const text =
      error instanceof Error && error.message !== ''
        ? error.message
        : '飞书登录失败，请重试。';
    await backToLogin(text);
  }
});
</script>

<template>
  <div
    class="flex flex-col items-center justify-center gap-3"
    style="min-height: 60vh"
  >
    <template v-if="errorText === ''">
      <span class="animate-pulse text-lg">正在通过飞书登录…</span>
      <span class="text-muted-foreground text-sm">确认后自动进入系统</span>
    </template>
    <template v-else>
      <span class="text-destructive">{{ errorText }}</span>
      <span class="text-muted-foreground text-xs">正在返回登录页…</span>
    </template>
  </div>
</template>

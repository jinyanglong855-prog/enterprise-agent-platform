<script lang="ts" setup>
import type { VbenFormSchema } from '@vben/common-ui';

import { computed } from 'vue';

import { AuthenticationLogin, z } from '@vben/common-ui';
import { $t } from '@vben/locales';

import { buildFeishuAuthorizeUrl } from '#/api';
import { useAuthStore } from '#/store';

defineOptions({ name: 'Login' });

const authStore = useAuthStore();

/** 飞书自建应用 App ID（公开值非机密；换 token 的机密在服务端） */
const FEISHU_APP_ID = 'cli_your_app_id_here'; // 替换为你的飞书自建应用 App ID（公开值非机密；换 token 的机密在服务端环境变量）

function feishuLogin() {
  // 回跳地址固定 127.0.0.1，而防伪 state 存在 sessionStorage——浏览器按 origin 隔离存储：
  // 从 localhost 等其它本机别名进入时，回跳落在另一个 origin 上读不到 state，必然「校验不匹配」。
  // 先归一到回跳同源再走授权。
  if (window.location.origin !== 'http://127.0.0.1:5666') {
    window.location.href = 'http://127.0.0.1:5666/auth/login';
    return;
  }
  window.location.href = buildFeishuAuthorizeUrl(FEISHU_APP_ID);
}

const formSchema = computed((): VbenFormSchema[] => {
  return [
    {
      component: 'VbenInput',
      componentProps: {
        placeholder: $t('authentication.usernameTip'),
      },
      fieldName: 'username',
      label: $t('authentication.username'),
      rules: z.string().min(1, { message: $t('authentication.usernameTip') }),
    },
    {
      component: 'VbenInputPassword',
      componentProps: {
        placeholder: $t('authentication.password'),
      },
      fieldName: 'password',
      label: $t('authentication.password'),
      rules: z.string().min(1, { message: $t('authentication.passwordTip') }),
    },
  ];
});
</script>

<template>
  <AuthenticationLogin
    :form-schema="formSchema"
    :loading="authStore.loginLoading"
    :show-code-login="false"
    :show-forget-password="false"
    :show-qrcode-login="false"
    :show-register="false"
    :show-third-party-login="true"
    @submit="authStore.authLogin"
  >
    <template #third-party-login>
      <div class="w-full">
        <div class="mb-2 flex items-center gap-2">
          <div class="h-px flex-1 bg-border"></div>
          <span class="text-muted-foreground text-xs">或</span>
          <div class="h-px flex-1 bg-border"></div>
        </div>
        <button
          class="border-border hover:bg-accent hover:text-accent-foreground flex h-9 w-full items-center justify-center gap-2 rounded-md border bg-transparent text-sm font-medium transition-colors"
          type="button"
          @click="feishuLogin"
        >
          <svg viewBox="0 0 24 24" class="h-4 w-4" fill="currentColor">
            <path
              d="M3.6 4.2h7.05L8.4 9.6H1.35L3.6 4.2zm6.6 5.4h7.05L15 15H7.95l2.25-5.4zm4.05 5.4h7.05l-2.25 5.4h-7.05l2.25-5.4z"
            />
          </svg>
          飞书登录
        </button>
      </div>
    </template>
  </AuthenticationLogin>
</template>

<script setup lang="ts">
import type { ProfilePasswordSetting as ProfilePasswordSettingComp } from '@vben/common-ui';

import type { VbenFormSchema } from '#/adapter/form';

import { computed, ref } from 'vue';

import { ProfilePasswordSetting, z } from '@vben/common-ui';

import { message } from 'ant-design-vue';

import { requestClient } from '#/api/request';

const formSchema = computed((): VbenFormSchema[] => {
  return [
    {
      fieldName: 'oldPassword',
      label: '旧密码',
      component: 'VbenInputPassword',
      componentProps: {
        placeholder: '请输入旧密码',
      },
    },
    {
      fieldName: 'newPassword',
      label: '新密码',
      component: 'VbenInputPassword',
      componentProps: {
        passwordStrength: true,
        placeholder: '请输入新密码',
      },
    },
    {
      fieldName: 'confirmPassword',
      label: '确认密码',
      component: 'VbenInputPassword',
      componentProps: {
        passwordStrength: true,
        placeholder: '请再次输入新密码',
      },
      dependencies: {
        rules(values) {
          const { newPassword } = values;
          return z
            .string({ error: '请再次输入新密码' })
            .min(1, { message: '请再次输入新密码' })
            .refine((value) => value === newPassword, {
              message: '两次输入的密码不一致',
            });
        },
        triggerFields: ['newPassword'],
      },
    },
  ];
});

// 之前是假改密（只弹提示不调接口，2026-10-27 框架定版修正）：接真 PUT /api/auth/password，
// 旧密码错误/新密码不足 8 位由后端拒绝，错误信息由 request 拦截器统一弹出
const formRef = ref<InstanceType<typeof ProfilePasswordSettingComp>>();

async function handleSubmit(values: Record<string, unknown>) {
  try {
    await requestClient.put('/auth/password', {
      newPassword: String(values.newPassword ?? ''),
      oldPassword: String(values.oldPassword ?? ''),
    });
    message.success('密码修改成功');
    formRef.value
      ?.getFormApi()
      ?.setValues({ confirmPassword: '', newPassword: '', oldPassword: '' });
  } catch {
    // 错误已在拦截器弹过（旧密码不对/新密码太短等），这里不再重复提示
  }
}
</script>
<template>
  <ProfilePasswordSetting
    ref="formRef"
    class="w-1/3"
    :form-schema="formSchema"
    @submit="handleSubmit"
  />
</template>

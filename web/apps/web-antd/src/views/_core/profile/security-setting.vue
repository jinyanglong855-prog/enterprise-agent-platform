<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import { ProfileSecuritySetting } from '@vben/common-ui';

import { getMeApi } from '#/api';

const binding =
  ref<Awaited<ReturnType<typeof getMeApi>>['feishuBinding']>(null);

onMounted(async () => {
  try {
    binding.value = (await getMeApi()).feishuBinding;
  } catch {
    binding.value = null;
  }
});

const formSchema = computed(() => {
  const items = [
    {
      value: true,
      fieldName: 'accountPassword',
      label: '账户密码',
      description: '账号密码登录与飞书登录进入的是同一个账号，权限完全一致',
    },
  ];
  if (binding.value) {
    const short =
      binding.value.openId.length > 16
        ? `${binding.value.openId.slice(0, 16)}…`
        : binding.value.openId;
    const date = binding.value.boundAt.slice(0, 10);
    items.push({
      value: true,
      fieldName: 'feishu',
      label: '飞书账号',
      description: `已绑定：${binding.value.name}（${short}），绑定于 ${date}。可在登录页点「飞书登录」免密进入`,
    });
  } else {
    items.push({
      value: false,
      fieldName: 'feishu',
      label: '飞书账号',
      description:
        '未绑定飞书。绑定入口：管理员在管理后台「融合层」添加，或在飞书里给机器人发消息走审批',
    });
  }
  return items;
});
</script>
<template>
  <ProfileSecuritySetting :form-schema="formSchema" />
</template>

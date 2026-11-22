<script lang="ts" setup>
import { ref, watch } from 'vue';

import { Button, Input, message, Modal } from 'ant-design-vue';

import { inspectionPackApi } from '#/api/finance';

const props = defineProps<{ open: boolean }>();

const emit = defineEmits<{ 'update:open': [boolean] }>();

const from = ref('');
const to = ref('');
const loading = ref(false);
const markdown = ref('');
const meta = ref('');

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    from.value = `${new Date().getFullYear()}-01-01`;
    to.value = '';
    markdown.value = '';
    meta.value = '';
  },
  { immediate: true },
);

async function run() {
  loading.value = true;
  try {
    const r = await inspectionPackApi({
      from: from.value.trim() || undefined,
      to: to.value.trim() || undefined,
    });
    markdown.value = r.markdown;
    meta.value = `${r.from} 至 ${r.to}：${r.entry_count} 笔账、${r.invoice_count} 张票${r.truncated ? '（明细超 500 笔只展示前 500，需要完整请分段导出）' : ''}`;
  } catch (error) {
    markdown.value = '';
    console.error('应答包生成失败', error); // 拦截器已弹后端文案，这里只记日志
  } finally {
    loading.value = false;
  }
}

/** 复制全文：专管员/代账要数时整包发过去。 */
async function copyAll() {
  try {
    await navigator.clipboard.writeText(markdown.value);
    message.success('已复制全文，可直接粘贴给专管员/代账');
  } catch {
    message.warning('浏览器没给剪贴板权限，请手动全选复制');
  }
}

function download() {
  const blob = new Blob([markdown.value], {
    type: 'text/markdown;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `财务检查应答包_${from.value.trim() || '年初'}_${to.value.trim() || '今天'}.md`;
  a.click();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <Modal
    :footer="null"
    :open="open"
    title="检查应答包"
    width="820"
    @cancel="emit('update:open', false)"
  >
    <div class="mb-3 text-sm text-gray-500">
      专管员/代账要数时，一份包给全：期间合计、建档参数、逐笔明细、票据对照，全是账面口径（声明写在包里）。
    </div>
    <div class="mb-4 flex flex-wrap items-end gap-3">
      <div>
        <div class="mb-1 text-sm text-gray-500">起始日（空=今年元旦）</div>
        <Input
          v-model:value="from"
          class="w-40"
          placeholder="YYYY-MM-DD"
          @press-enter="run"
        />
      </div>
      <div>
        <div class="mb-1 text-sm text-gray-500">截止日（空=今天）</div>
        <Input
          v-model:value="to"
          class="w-40"
          placeholder="YYYY-MM-DD"
          @press-enter="run"
        />
      </div>
      <Button :loading="loading" type="primary" @click="run"> 生成 </Button>
      <template v-if="markdown">
        <Button @click="copyAll">复制全文</Button>
        <Button @click="download">下载 .md</Button>
      </template>
    </div>
    <div v-if="meta" class="mb-2 text-xs text-gray-400">
      {{ meta }}
    </div>
    <pre
      v-if="markdown"
      class="max-h-[60vh] overflow-auto rounded border border-gray-200 bg-gray-50 p-3 text-xs leading-5"
      >{{ markdown }}</pre>
  </Modal>
</template>

<script lang="ts" setup>
import type { AnnualArchive } from '#/api/finance';

import { ref, watch } from 'vue';

import { Button, Input, message, Modal, Table } from 'ant-design-vue';

import { annualArchiveApi } from '#/api/finance';

const props = defineProps<{ open: boolean }>();

const emit = defineEmits<{ 'update:open': [boolean] }>();

const year = ref(String(new Date().getFullYear()));
const loading = ref(false);
const archive = ref<AnnualArchive | undefined>(undefined);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    archive.value = undefined;
  },
  { immediate: true },
);

async function run() {
  if (!/^\d{4}$/.test(year.value.trim()))
    return message.warning('年份填 4 位（如 2026）');
  loading.value = true;
  try {
    archive.value = await annualArchiveApi(year.value.trim());
  } catch (error) {
    archive.value = undefined;
    console.error('归档导出失败', error); // 拦截器已弹后端文案，这里只记日志
  } finally {
    loading.value = false;
  }
}

function download() {
  if (!archive.value) return;
  const blob = new Blob([JSON.stringify(archive.value, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `财务年度归档_${archive.value.year}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

const columns = [
  { dataIndex: 'key', key: 'section', title: '数据节' },
  {
    dataIndex: 'count',
    key: 'count',
    title: '条数',
    align: 'right' as const,
    width: 100,
  },
  { dataIndex: 'sha256', key: 'sha256', title: 'sha256', ellipsis: true },
];
</script>

<template>
  <Modal
    :footer="null"
    :open="open"
    title="年度归档导出"
    width="760"
    @cancel="emit('update:open', false)"
  >
    <div class="mb-3 text-sm text-gray-500">
      全年数据一个 JSON 包 + 逐节 sha256
      清单："不可变"靠哈希清单保证——来年复核时重新导出同年度，
      比对清单哈希一致即数据未被改动。附件不进包（包里只有文件名与哈希索引），文件随服务器
      attachments 目录另行备份。
    </div>
    <div class="mb-4 flex items-end gap-3">
      <div>
        <div class="mb-1 text-sm text-gray-500">年份</div>
        <Input
          v-model:value="year"
          class="w-32"
          placeholder="YYYY"
          @press-enter="run"
        />
      </div>
      <Button :loading="loading" type="primary" @click="run">
        生成归档包
      </Button>
      <Button v-if="archive" type="primary" ghost @click="download">
        下载 JSON
      </Button>
    </div>

    <template v-if="archive">
      <div class="mb-3 rounded border border-gray-200 p-3 text-xs leading-5">
        <div>
          包序列号（整体哈希）：<code class="break-all">{{
            archive.manifest.bundle_sha256
          }}</code>
        </div>
        <div class="mt-1 text-gray-500">
          生成于 {{ archive.generated_at }}；{{ archive.notes[0] }}
        </div>
      </div>
      <Table
        :columns="columns"
        :data-source="
          Object.entries(archive.manifest.sections).map(([key, v]) => ({
            count: v.count,
            key,
            sha256: v.sha256,
          }))
        "
        :pagination="false"
        row-key="key"
        size="small"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'sha256'">
            <code class="text-xs">{{
              (record as { sha256: string }).sha256
            }}</code>
          </template>
        </template>
      </Table>
    </template>
  </Modal>
</template>

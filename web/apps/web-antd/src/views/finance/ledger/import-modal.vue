<script lang="ts" setup>
import type { EntryInput, ImportPreview } from '#/api/finance';

import { computed, ref } from 'vue';

import {
  Alert,
  Button,
  Checkbox,
  message,
  Modal,
  Table,
  Tabs,
  Tag,
  Textarea,
  Tooltip,
} from 'ant-design-vue';

import {
  importCommitApi,
  importPreviewApi,
  importTemplateApi,
  STATUS_LABELS,
  TYPE_LABELS,
} from '#/api/finance';
import { readFileText } from '#/utils/file-text';

const emit = defineEmits<{ imported: [] }>();
const open = defineModel<boolean>('open', { default: false });

const tab = ref<'file' | 'paste'>('paste');
const text = ref('');
const fileName = ref('');
const preview = ref<ImportPreview>();
const parsing = ref(false);
const importing = ref(false);
const skipDuplicates = ref(true);
const selectedLines = ref<number[]>([]);

const dataSource = computed(() => preview.value?.rows ?? []);
const selectedInputs = computed<EntryInput[]>(() =>
  (preview.value?.rows ?? [])
    .filter(
      (r) => selectedLines.value.includes(r.line) && r.input !== undefined,
    )
    .map((r) => r.input!),
);

const columns = [
  { dataIndex: 'line', key: 'line', title: '行', width: 55 },
  { key: 'date', title: '日期', width: 100 },
  { key: 'type', title: '类型', width: 60 },
  { key: 'amount', title: '金额', align: 'right' as const, width: 90 },
  {
    dataIndex: 'counterparty',
    key: 'counterparty',
    title: '对方',
    ellipsis: true,
  },
  {
    dataIndex: 'category',
    key: 'category',
    title: '分类',
    width: 80,
    ellipsis: true,
  },
  { dataIndex: 'account', key: 'account', title: '账户', width: 80 },
  { key: 'status', title: '状态', width: 80 },
  { key: 'result', title: '解析结果', width: 190 },
];

function reset() {
  text.value = '';
  fileName.value = '';
  preview.value = undefined;
  selectedLines.value = [];
  skipDuplicates.value = true;
}

async function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  if (file.size > 1024 * 1024) {
    message.error('文件超过 1 MB 上限，请拆分');
    input.value = '';
    return;
  }
  text.value = await readFileText(file);
  fileName.value = file.name;
  input.value = '';
  await parse();
}

async function parse() {
  if (!text.value.trim()) {
    message.warning('先上传文件或粘贴表格内容');
    return;
  }
  parsing.value = true;
  try {
    preview.value = await importPreviewApi(text.value);
    // 可入账的行默认全选；错误行不可选，疑似重复默认不选（勾了才入）
    selectedLines.value = (preview.value?.rows ?? [])
      .filter((r) => r.input !== undefined && r.duplicate_of === undefined)
      .map((r) => r.line);
  } catch (error) {
    preview.value = undefined;
    message.error(`解析失败：${(error as Error)?.message ?? error}`);
  } finally {
    parsing.value = false;
  }
}

async function doImport() {
  if (selectedInputs.value.length === 0) {
    message.warning('没有勾选任何可入账的行');
    return;
  }
  importing.value = true;
  try {
    const r = await importCommitApi(selectedInputs.value, {
      note: fileName.value || '台账页粘贴导入',
      skip_duplicates: skipDuplicates.value,
    });
    const parts = [`批次 ${r.batch}，入账 ${r.created.length} 笔`];
    if (r.skipped > 0) parts.push(`跳过重复 ${r.skipped} 笔`);
    message.success(`导入完成：${parts.join('，')}`);
    reset();
    open.value = false;
    emit('imported');
  } catch (error) {
    message.error(`导入失败：${(error as Error)?.message ?? error}`);
  } finally {
    importing.value = false;
  }
}

async function downloadTemplate() {
  const t = await importTemplateApi();
  const blob = new Blob([`\uFEFF${t.csv}`], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '流水导入模板.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}
</script>

<template>
  <Modal
    :footer="null"
    :open="open"
    title="批量导入流水"
    width="920px"
    @cancel="open = false"
  >
    <p class="mb-3 text-sm text-gray-500">
      标准表格走这里：下载模板按列填好（Excel 里「另存为
      CSV」即可），上传或直接粘贴解析。 手搓的、格式不定的表请丢进
      <b>财务台对话框</b>，让 agent 出解读规则。单批最多 500
      行，已锁定结账的月份会被拦下。
    </p>

    <Tabs v-model:active-key="tab">
      <Tabs.TabPane key="paste" tab="粘贴表格">
        <Textarea
          v-model:value="text"
          :rows="7"
          class="font-mono text-xs"
          placeholder="从 Excel 直接复制几行粘进来（Tab 分隔也能认），或粘贴 CSV 文本"
        />
      </Tabs.TabPane>
      <Tabs.TabPane key="file" tab="上传文件">
        <input accept=".csv,.tsv,.txt" type="file" @change="onFileChange" />
        <span v-if="fileName" class="ml-2 text-sm text-gray-500">{{
          fileName
        }}</span>
      </Tabs.TabPane>
    </Tabs>

    <div class="mb-3 flex items-center gap-2">
      <Button :loading="parsing" type="primary" @click="parse">解析预览</Button>
      <Button size="small" @click="downloadTemplate">下载模板</Button>
      <div class="flex-1"></div>
      <span v-if="preview" class="text-sm">
        <Tag color="green">可入账 {{ preview.valid }}</Tag>
        <Tag v-if="preview.duplicates > 0" color="orange">疑似重复 {{ preview.duplicates }}</Tag>
        <Tag v-if="preview.invalid > 0" color="red">错误 {{ preview.invalid }}</Tag>
      </span>
    </div>

    <Alert
      v-if="preview && preview.total > 0"
      class="mb-2"
      show-icon
      type="info"
    >
      <template #message>
        勾选要入的账（{{ selectedInputs.length }}/{{ preview.valid }} 笔已选）；
        <Checkbox v-model:checked="skipDuplicates" class="ml-1">
          库里已有的同笔账跳过不入
        </Checkbox>
      </template>
    </Alert>

    <Table
      v-if="preview"
      :columns="columns"
      :data-source="dataSource"
      :pagination="{ pageSize: 10, showSizeChanger: false }"
      :row-selection="{
        selectedRowKeys: selectedLines,
        getCheckboxProps: (r: { input?: unknown }) => ({
          disabled: r.input === undefined,
        }),
        onChange: (keys: any[]) => (selectedLines = keys.map(Number)),
      }"
      :scroll="{ y: 360 }"
      row-key="line"
      size="small"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'date'">
          {{ record.input?.date ?? '—' }}
        </template>
        <template v-else-if="column.key === 'type'">
          {{
            record.input
              ? (TYPE_LABELS[record.input.type as keyof typeof TYPE_LABELS] ??
                record.input.type)
              : '—'
          }}
        </template>
        <template v-else-if="column.key === 'amount'">
          {{ record.input?.amount ?? '—' }}
        </template>
        <template v-else-if="column.key === 'status'">
          {{
            record.input?.status
              ? (STATUS_LABELS[
                  record.input.status as keyof typeof STATUS_LABELS
                ] ?? record.input.status)
              : '—'
          }}
        </template>
        <template v-else-if="column.key === 'result'">
          <template v-if="record.error">
            <Tag color="red">错误</Tag>
            <Tooltip :title="record.error">
              <span class="cursor-help text-xs text-red-500">{{ record.error.slice(0, 14) }}…</span>
            </Tooltip>
          </template>
          <template v-else-if="record.duplicate_of">
            <Tag color="orange">疑似重复</Tag>
            <span class="text-xs text-gray-400">= {{ record.duplicate_of }}</span>
          </template>
          <template v-else-if="record.duplicate_in_batch">
            <Tag color="orange">批内重复</Tag>
          </template>
          <template v-else>
            <Tag color="green">可入账</Tag>
          </template>
        </template>
      </template>
    </Table>

    <div class="mt-3 flex items-center justify-end gap-2">
      <Button @click="open = false">取消</Button>
      <Button
        :disabled="selectedInputs.length === 0"
        :loading="importing"
        type="primary"
        @click="doImport"
      >
        确认导入（{{ selectedInputs.length }} 笔）
      </Button>
    </div>
  </Modal>
</template>

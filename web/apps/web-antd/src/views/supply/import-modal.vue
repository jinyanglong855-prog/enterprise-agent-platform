<script lang="ts" setup>
import type { ImportPreviewInfo, SupplyImportKind } from '#/api/supply';

import { computed, ref, watch } from 'vue';

import {
  Alert,
  Button,
  message,
  Modal,
  Table,
  Tag,
  Textarea,
} from 'ant-design-vue';

import {
  importCommitApi,
  importPreviewApi,
  importTemplateApi,
} from '#/api/supply';
import { readFileText } from '#/utils/file-text';

const props = defineProps<{ kind: SupplyImportKind }>();
const emit = defineEmits<{ imported: [] }>();
const open = defineModel<boolean>('open', { default: false });

const KIND_TABS = [
  { label: '物料主数据', value: 'items' },
  { label: '库存快照', value: 'inventory' },
  { label: '采购单', value: 'pos' },
] as const;

const text = ref('');
const fileName = ref('');
const preview = ref<ImportPreviewInfo>();
const parsing = ref(false);
const importing = ref(false);

const kindLabel = computed(
  () => KIND_TABS.find((t) => t.value === props.kind)?.label ?? props.kind,
);
/** 批内同键语义按 kind 不同：items 已存在只补空缺（先行赢），inventory/pos 最新报数赢（后行赢）——文案得跟后端规则一致。 */
const dupHint = computed(() =>
  props.kind === 'items'
    ? '批内重复：先行建档，后行只补空缺'
    : '批内重复：后行覆盖前行',
);
/** 任一行非法后端整批回滚：有错误行时导入按钮就该灰掉，而不是让人点一条必 400 的死路。 */
const canImport = computed(
  () =>
    preview.value !== undefined &&
    preview.value.valid > 0 &&
    preview.value.invalid === 0,
);
const columns = [
  { dataIndex: 'line', key: 'line', title: '行', width: 55 },
  { dataIndex: 'raw', key: 'raw', title: '原始内容', ellipsis: true },
  { key: 'result', title: '解析结果', width: 300 },
];

watch(open, (v) => {
  if (!v) reset();
});

function reset() {
  text.value = '';
  fileName.value = '';
  preview.value = undefined;
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
    preview.value = await importPreviewApi(props.kind, text.value);
  } catch (error) {
    preview.value = undefined;
    message.error(`解析失败：${(error as Error)?.message ?? error}`);
  } finally {
    parsing.value = false;
  }
}

async function doImport() {
  if (!canImport.value) {
    message.warning(
      preview.value && preview.value.invalid > 0
        ? '有错误行：改掉红色标记的行再导（任一行非法整批不落）'
        : '没有可导入的行：先解析预览',
    );
    return;
  }
  importing.value = true;
  try {
    const r = await importCommitApi(props.kind, text.value);
    const extras: string[] = [];
    if (r.itemsCreated.length > 0)
      extras.push(
        `顺带建档物料 ${r.itemsCreated.join('、')}（记得补全名称/安全线）`,
      );
    if (r.archivedTargets.length > 0)
      extras.push(
        `注意：${r.archivedTargets.join('、')} 是已归档物料，数据落在它名下（勾「含归档」才看得见）`,
      );
    if (r.protectedClosed.length > 0) {
      extras.push(
        `${r.protectedClosed.join('、')} 在库里已收货/已取消，文件里的状态没有把它倒翻（要重开请在台账点「重开」）`,
      );
    }
    extras.push(...r.hints);
    message.success(
      `已导入：新建 ${r.created}、更新 ${r.updated}、跳过 ${r.skipped}${extras.length > 0 ? `；${extras.join('；')}` : ''}`,
      extras.length > 0 ? 10 : 3,
    );
    open.value = false;
    emit('imported');
  } catch (error) {
    message.error(`导入失败：${(error as Error)?.message ?? error}`);
  } finally {
    importing.value = false;
  }
}

async function downloadTemplate() {
  try {
    const t = await importTemplateApi(props.kind);
    const blob = new Blob([`\uFEFF${t.csv}`], {
      type: 'text/csv;charset=utf-8',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `supply-${props.kind}-template.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (error) {
    message.error(`模板下载失败：${(error as Error)?.message ?? error}`);
  }
}
</script>

<template>
  <Modal
    cancel-text="关闭"
    :confirm-loading="importing"
    ok-text="导入"
    :ok-button-props="{ disabled: !canImport }"
    :open="open"
    :title="`导入${kindLabel}`"
    :width="860"
    @cancel="open = false"
    @ok="doImport"
  >
    <div class="mb-3 flex items-center gap-2">
      <Button size="small" @click="downloadTemplate">
        下载{{ kindLabel }}模板
      </Button>
      <label class="cursor-pointer text-sm text-blue-600">
        <input
          type="file"
          accept=".csv,.tsv,.txt"
          class="hidden"
          @change="onFileChange"
        />
        {{ fileName ? `已选：${fileName}` : '选文件（CSV/TSV，≤1MB）' }}
      </label>
      <div class="flex-1"></div>
      <span class="text-xs text-gray-400">或直接粘贴到下面</span>
    </div>
    <Textarea
      v-model:value="text"
      :auto-size="{ minRows: 4, maxRows: 10 }"
      :placeholder="`粘贴带列头的表格文本（${kindLabel}模板列头），粘贴后点「解析预览」`"
    />
    <div class="mt-2">
      <Button
        :loading="parsing"
        size="small"
        type="primary"
        ghost
        @click="parse"
      >
        解析预览
      </Button>
    </div>

    <template v-if="preview">
      <Alert
        v-if="preview.strippedMoneyColumns.length > 0"
        class="mt-3"
        show-icon
        type="warning"
        :message="`已剥除金额类列：${preview.strippedMoneyColumns.join('、')}——本域不收金额，「值多少钱」在财务域。`"
      />
      <Alert
        v-if="preview.hints.length > 0"
        class="mt-3"
        message="提示（不拦导入，但请先确认）"
        show-icon
        type="info"
      >
        <template #description>
          <ul class="mb-0 pl-4">
            <li v-for="hint in preview.hints" :key="hint">{{ hint }}</li>
          </ul>
        </template>
      </Alert>
      <div class="mt-3 text-sm">
        共 {{ preview.total }} 行：可导入 {{ preview.valid }}、错误
        {{ preview.invalid }}
        <span v-if="preview.invalid > 0" class="ml-2 text-red-600">有错误行时整批不落，改掉再导</span>
      </div>
      <Table
        class="mt-2"
        :columns="columns"
        :data-source="preview.rows"
        :pagination="{ pageSize: 8 }"
        :scroll="{ y: 320 }"
        row-key="line"
        size="small"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'raw'">
            {{ (record as { raw: string[] }).raw.join(' | ') }}
          </template>
          <template v-else-if="column.key === 'result'">
            <Tag v-if="(record as { error?: string }).error" color="red">
              {{ (record as { error?: string }).error }}
            </Tag>
            <Tag
              v-else-if="
                (record as { duplicate_in_batch?: boolean }).duplicate_in_batch
              "
              color="orange"
            >
              {{ dupHint }}
            </Tag>
            <Tag v-else color="green">可导入</Tag>
          </template>
        </template>
      </Table>
      <div class="mt-2 text-xs text-gray-400">
        幂等口径：同键同内容跳过、同键内容变了覆盖更新；任一行非法整批不落。采购单里库里已收货/已取消的单不会被文件倒翻。
      </div>
    </template>
  </Modal>
</template>

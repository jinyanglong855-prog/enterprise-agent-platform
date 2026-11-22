<script lang="ts" setup>
import type { CashCountRecord } from '#/api/finance';

import { ref, watch } from 'vue';

import {
  Button,
  Input,
  InputNumber,
  message,
  Modal,
  Table,
  Tag,
} from 'ant-design-vue';

import { createCashCountApi, listCashCountsApi } from '#/api/finance';

const props = defineProps<{
  account?: string;
  open: boolean;
}>();

const emit = defineEmits<{ 'update:open': [boolean] }>();

const counted = ref<number | undefined>(undefined);
const asOf = ref('');
const note = ref('');
const saving = ref(false);
/** 刚记的这次盘点（含服务端算的账面数与差额），单独亮出来给人数钱对账。 */
const last = ref<CashCountRecord | undefined>(undefined);
const history = ref<CashCountRecord[]>([]);
const loading = ref(false);

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function loadHistory() {
  if (!props.account) return;
  loading.value = true;
  try {
    const body = await listCashCountsApi({ account: props.account, limit: 20 });
    history.value = body.records;
  } catch (error) {
    console.error('盘点历史加载失败', error); // 拦截器已弹后端文案，这里只记日志
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    counted.value = undefined;
    asOf.value = localToday();
    note.value = '';
    last.value = undefined;
    void loadHistory();
  },
  { immediate: true },
);

function fmt(n: number): string {
  return n.toLocaleString('zh-CN', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  });
}

async function save() {
  if (!props.account) return;
  if (counted.value == null || Number.isNaN(counted.value)) {
    return message.warning('先数一遍，把实际数出来的金额填进来');
  }
  if (asOf.value.trim() && !/^\d{4}-\d{2}-\d{2}$/.test(asOf.value.trim())) {
    return message.warning('盘点日格式应为 YYYY-MM-DD（留空=今天）');
  }
  saving.value = true;
  try {
    last.value = await createCashCountApi({
      account: props.account,
      as_of: asOf.value.trim() || undefined,
      counted: counted.value,
      note: note.value.trim() || undefined,
    });
    message.success('已记录本次盘点');
    await loadHistory();
  } catch (error) {
    console.error('盘点保存失败', error); // 拦截器已弹后端文案，这里只记日志
  } finally {
    saving.value = false;
  }
}

const columns = [
  { dataIndex: 'as_of', key: 'as_of', title: '盘点日', width: 105 },
  {
    dataIndex: 'counted',
    key: 'counted',
    title: '实点(元)',
    align: 'right' as const,
    width: 95,
  },
  {
    dataIndex: 'book',
    key: 'book',
    title: '账面(元)',
    align: 'right' as const,
    width: 95,
  },
  {
    dataIndex: 'diff',
    key: 'diff',
    title: '差额(元)',
    align: 'right' as const,
    width: 95,
  },
  { dataIndex: 'note', key: 'note', title: '备注', ellipsis: true },
];
</script>

<template>
  <Modal
    :footer="null"
    :open="open"
    :title="`现金盘点 · ${account ?? ''}`"
    width="680"
    @cancel="emit('update:open', false)"
  >
    <div class="mb-3 text-sm text-gray-500">
      现金/账户实际点一遍，把数出来的金额填进来；系统按同一时点算账面余额，给出差额。
      盘点只记录差异不调平——差额怎么处理（记漏的账、冲销记错的）走正常记账路径。
    </div>
    <div class="mb-4 flex flex-wrap items-end gap-3">
      <div>
        <div class="mb-1 text-sm text-gray-500">
          实点金额（元，数出来多少填多少）
        </div>
        <InputNumber
          v-model:value="counted"
          :precision="2"
          class="w-44"
          placeholder="数出来的金额"
          @press-enter="save"
        />
      </div>
      <div>
        <div class="mb-1 text-sm text-gray-500">盘点日（空=今天）</div>
        <Input
          v-model:value="asOf"
          class="w-40"
          placeholder="YYYY-MM-DD"
          @press-enter="save"
        />
      </div>
      <div class="min-w-40 flex-1">
        <div class="mb-1 text-sm text-gray-500">备注</div>
        <Input
          v-model:value="note"
          placeholder="如：保险柜零头、未入账收据"
          @press-enter="save"
        />
      </div>
      <Button :loading="saving" type="primary" @click="save">记一笔盘点</Button>
    </div>

    <div v-if="last" class="mb-4 grid grid-cols-3 gap-3">
      <div class="rounded border border-gray-200 p-3">
        <div class="text-xs text-gray-500">实点</div>
        <div class="text-lg font-semibold">{{ fmt(last.counted) }}</div>
      </div>
      <div class="rounded border border-gray-200 p-3">
        <div class="text-xs text-gray-500">账面（{{ last.as_of }}）</div>
        <div class="text-lg font-semibold">{{ fmt(last.book) }}</div>
      </div>
      <div class="rounded border border-gray-200 p-3">
        <div class="text-xs text-gray-500">差额（实点 − 账面）</div>
        <div
          class="text-lg font-semibold"
          :class="last.diff === 0 ? 'text-green-600' : 'text-red-600'"
        >
          {{ last.diff > 0 ? '+' : '' }}{{ fmt(last.diff) }}
          <span class="ml-1 text-xs font-normal">{{
            last.diff === 0 ? '对上了' : '有差异，先查原因再调账'
          }}</span>
        </div>
      </div>
    </div>

    <div class="mb-2 text-sm font-medium text-gray-500">
      历史盘点（最近 {{ history.length }} 次）
    </div>
    <Table
      :columns="columns"
      :data-source="history"
      :loading="loading"
      :pagination="false"
      row-key="id"
      size="small"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'diff'">
          <span
            :class="
              (record as CashCountRecord).diff === 0
                ? 'text-green-600'
                : 'text-red-600'
            "
          >
            {{ (record as CashCountRecord).diff > 0 ? '+' : ''
            }}{{ fmt((record as CashCountRecord).diff) }}
          </span>
        </template>
        <template v-else-if="column.key === 'as_of'">
          {{ (record as CashCountRecord).as_of }}
          <Tag
            v-if="last && (record as CashCountRecord).id === last.id"
            class="ml-1"
            color="blue"
          >
            刚记
          </Tag>
        </template>
      </template>
    </Table>
  </Modal>
</template>

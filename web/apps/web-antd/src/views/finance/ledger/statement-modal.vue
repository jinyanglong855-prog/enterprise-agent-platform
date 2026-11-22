<script lang="ts" setup>
import type { CounterpartyStatement, EntryStatus } from '#/api/finance';

import { ref, watch } from 'vue';

import { Button, Input, message, Modal, Table, Tag } from 'ant-design-vue';

import {
  counterpartyStatementApi,
  STATUS_LABELS,
  TYPE_LABELS,
} from '#/api/finance';

const props = defineProps<{ open: boolean }>();

const emit = defineEmits<{ 'update:open': [boolean] }>();

const counterparty = ref('');
const from = ref('');
const to = ref('');
const loading = ref(false);
const statement = ref<CounterpartyStatement | undefined>(undefined);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    counterparty.value = '';
    from.value = `${new Date().getFullYear()}-01-01`;
    to.value = '';
    statement.value = undefined;
  },
  { immediate: true },
);

function fmt(n: number): string {
  return n.toLocaleString('zh-CN', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  });
}

async function run() {
  if (counterparty.value.trim() === '')
    return message.warning('填对方名称（支持部分匹配，如"甬城"）');
  loading.value = true;
  try {
    statement.value = await counterpartyStatementApi({
      counterparty: counterparty.value.trim(),
      from: from.value.trim() || undefined,
      to: to.value.trim() || undefined,
    });
  } catch (error) {
    statement.value = undefined;
    console.error('对账单生成失败', error); // 拦截器已弹后端文案，这里只记日志
  } finally {
    loading.value = false;
  }
}

const columns = [
  { dataIndex: 'date', key: 'date', title: '日期', width: 100 },
  { dataIndex: 'id', key: 'id', title: '编号', width: 155 },
  { key: 'type', title: '类型', width: 70 },
  {
    dataIndex: 'category',
    key: 'category',
    title: '分类',
    width: 90,
    ellipsis: true,
  },
  {
    dataIndex: 'amount',
    key: 'amount',
    title: '金额(元)',
    align: 'right' as const,
    width: 95,
  },
  {
    dataIndex: 'paid',
    key: 'paid',
    title: '已收付(元)',
    align: 'right' as const,
    width: 95,
  },
  { key: 'status', title: '状态', width: 85 },
  { dataIndex: 'note', key: 'note', title: '备注', ellipsis: true },
];

function statusText(s: string): string {
  return STATUS_LABELS[s as EntryStatus] ?? s;
}
</script>

<template>
  <Modal
    :footer="null"
    :open="open"
    title="往来对账单"
    width="860"
    @cancel="emit('update:open', false)"
  >
    <div class="mb-3 text-sm text-gray-500">
      按对方出一份"期初未结 → 期间明细 →
      期末未结"的对账单，和客户/供应商对往来用。
      口径：余额=截至该日累计未收付（未付全额/部分付算差额）；作废账与冲销对不进对账单。
    </div>
    <div class="mb-4 flex flex-wrap items-end gap-3">
      <div>
        <div class="mb-1 text-sm text-gray-500">对方 *</div>
        <Input
          v-model:value="counterparty"
          class="w-48"
          placeholder="部分匹配即可"
          @press-enter="run"
        />
      </div>
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
      <Button :loading="loading" type="primary" @click="run">
        生成对账单
      </Button>
    </div>

    <template v-if="statement">
      <div class="mb-3 grid grid-cols-4 gap-3">
        <div class="rounded border border-gray-200 p-3">
          <div class="text-xs text-gray-500">
            期初应收未收（{{ statement.from }} 前）
          </div>
          <div class="text-lg font-semibold">
            {{ fmt(statement.opening.receivable) }}
          </div>
        </div>
        <div class="rounded border border-gray-200 p-3">
          <div class="text-xs text-gray-500">期初应付未付</div>
          <div class="text-lg font-semibold">
            {{ fmt(statement.opening.payable) }}
          </div>
        </div>
        <div class="rounded border border-gray-200 p-3">
          <div class="text-xs text-gray-500">
            期末应收未收（至 {{ statement.to }}）
          </div>
          <div class="text-lg font-semibold text-blue-600">
            {{ fmt(statement.closing.receivable) }}
          </div>
        </div>
        <div class="rounded border border-gray-200 p-3">
          <div class="text-xs text-gray-500">期末应付未付</div>
          <div class="text-lg font-semibold text-blue-600">
            {{ fmt(statement.closing.payable) }}
          </div>
        </div>
      </div>
      <div class="mb-2 text-sm text-gray-500">
        期间：收入开票合计 {{ fmt(statement.totals.income) }} 元（已收
        {{ fmt(statement.totals.received) }}）； 支出合计
        {{ fmt(statement.totals.outflow) }} 元（已付
        {{ fmt(statement.totals.paid_out) }}）
      </div>
      <div
        class="mb-3 whitespace-pre-wrap rounded border border-gray-200 p-3 text-xs leading-5 text-gray-500"
      >
        {{ statement.hint }}
      </div>
      <Table
        :columns="columns"
        :data-source="statement.lines"
        :pagination="
          statement.lines.length > 15
            ? { pageSize: 15, showSizeChanger: false }
            : false
        "
        row-key="id"
        size="small"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'type'">
            {{
              TYPE_LABELS[
                (record as { type: string }).type as keyof typeof TYPE_LABELS
              ] ?? (record as { type: string }).type
            }}
          </template>
          <template v-else-if="column.key === 'status'">
            <Tag
              :color="
                (record as { status: string }).status === 'paid'
                  ? 'green'
                  : 'orange'
              "
            >
              {{ statusText((record as { status: string }).status) }}
            </Tag>
          </template>
        </template>
      </Table>
    </template>
  </Modal>
</template>

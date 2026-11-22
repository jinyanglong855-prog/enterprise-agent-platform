<script lang="ts" setup>
import type { InvoiceRecord } from '#/api/finance';

import { reactive, ref, watch } from 'vue';

import { Input, InputNumber, message, Modal, Select } from 'ant-design-vue';

import {
  createInvoiceApi,
  INVOICE_KIND_LABELS,
  INVOICE_STATUS_LABELS,
  updateInvoiceApi,
} from '#/api/finance';

const props = defineProps<{
  open: boolean;
  record?: InvoiceRecord;
}>();
const emit = defineEmits<{ saved: []; 'update:open': [boolean] }>();
const KIND_OPTIONS = Object.entries(INVOICE_KIND_LABELS).map(
  ([value, label]) => ({
    label,
    value,
  }),
);
const STATUS_OPTIONS = Object.entries(INVOICE_STATUS_LABELS).map(
  ([value, label]) => ({
    label,
    value,
  }),
);

const saving = ref(false);
const form = reactive<{
  amount?: number;
  counterparty: string;
  date: string;
  kind?: string;
  note: string;
  number: string;
  status?: string;
}>({ counterparty: '', date: '', note: '', number: '' });

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    if (props.record) {
      // 编辑只放开票号/日期/对方/状态/备注；方向与票面金额是票面事实，冻结展示
      Object.assign(form, {
        amount: props.record.amount,
        counterparty: props.record.counterparty,
        date: props.record.date,
        kind: props.record.kind,
        note: props.record.note,
        number: props.record.number,
        status: props.record.status,
      });
    } else {
      Object.assign(form, {
        amount: undefined,
        counterparty: '',
        date: localToday(),
        kind: 'purchase',
        note: '',
        number: '',
        status: 'held',
      });
    }
  },
  { immediate: true },
);

async function onOk() {
  if (props.record) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date)) {
      return message.warning('开票日期格式应为 YYYY-MM-DD');
    }
    saving.value = true;
    try {
      const rec = await updateInvoiceApi(props.record.id, {
        counterparty: form.counterparty.trim(),
        date: form.date,
        note: form.note.trim(),
        number: form.number.trim(),
        status: form.status,
      });
      message.success(`已更新 ${rec.id}`);
      emit('saved');
      emit('update:open', false);
    } catch (error) {
      console.error('保存失败', error); // 拦截器已弹后端文案，这里只记日志
    } finally {
      saving.value = false;
    }
  } else {
    if (!form.kind)
      return message.warning('请选票的方向（销项/进项/内部凭证）');
    if (!form.amount || form.amount <= 0)
      return message.warning('请填票面金额');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date)) {
      return message.warning('开票日期格式应为 YYYY-MM-DD');
    }
    saving.value = true;
    try {
      const rec = await createInvoiceApi({
        amount: form.amount,
        counterparty: form.counterparty.trim(),
        date: form.date,
        kind: form.kind,
        note: form.note.trim(),
        number: form.number.trim(),
      });
      message.success(`已登记票 ${rec.id}`);
      emit('saved');
      emit('update:open', false);
    } catch (error) {
      console.error('保存失败', error); // 拦截器已弹后端文案，这里只记日志
    } finally {
      saving.value = false;
    }
  }
}
</script>

<template>
  <Modal
    :confirm-loading="saving"
    :open="open"
    :title="record ? `编辑票 ${record.id}` : '登记票'"
    @cancel="emit('update:open', false)"
    @ok="onOk"
  >
    <div class="grid grid-cols-2 gap-x-4 gap-y-3">
      <template v-if="!record">
        <div>
          <div class="mb-1 text-sm text-gray-500">方向 *</div>
          <Select
            v-model:value="form.kind"
            :options="KIND_OPTIONS"
            class="w-full"
          />
        </div>
        <div>
          <div class="mb-1 text-sm text-gray-500">票面金额（元）*</div>
          <InputNumber
            v-model:value="form.amount"
            :min="0.01"
            :precision="2"
            class="w-full"
            placeholder="0.00"
          />
        </div>
      </template>
      <template v-else>
        <div>
          <div class="mb-1 text-sm text-gray-500">方向</div>
          <Input
            :value="INVOICE_KIND_LABELS[form.kind ?? ''] ?? form.kind"
            disabled
          />
        </div>
        <div>
          <div class="mb-1 text-sm text-gray-500">票面金额（元）</div>
          <Input :value="form.amount" disabled />
        </div>
        <div class="col-span-2 text-xs text-gray-400">
          方向与票面金额是票面事实，不可改；记错了把状态改成"已作废"再重录一张。
        </div>
      </template>
      <div>
        <div class="mb-1 text-sm text-gray-500">开票日期（YYYY-MM-DD）*</div>
        <Input v-model:value="form.date" placeholder="如：2026-10-21" />
      </div>
      <div>
        <div class="mb-1 text-sm text-gray-500">票号</div>
        <Input v-model:value="form.number" placeholder="发票右上角号码，可空" />
      </div>
      <div class="col-span-2">
        <div class="mb-1 text-sm text-gray-500">对方单位</div>
        <Input v-model:value="form.counterparty" placeholder="如：XX 公司" />
      </div>
      <div v-if="record">
        <div class="mb-1 text-sm text-gray-500">状态</div>
        <Select
          v-model:value="form.status"
          :options="STATUS_OPTIONS"
          class="w-full"
        />
      </div>
      <div :class="record ? '' : 'col-span-2'">
        <div class="mb-1 text-sm text-gray-500">备注</div>
        <Input v-model:value="form.note" placeholder="可空" />
      </div>
    </div>
  </Modal>
</template>

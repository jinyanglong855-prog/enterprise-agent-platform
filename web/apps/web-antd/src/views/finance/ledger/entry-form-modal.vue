<script lang="ts" setup>
import type {
  AccountRecord,
  EntryInput,
  EntryRecord,
  EntryStatus,
  EntryType,
} from '#/api/finance';

import { computed, reactive, ref, watch } from 'vue';

import {
  DatePicker,
  Input,
  InputNumber,
  message,
  Modal,
  Select,
  Textarea,
} from 'ant-design-vue';

import {
  createEntryApi,
  listAccountsApi,
  STATUS_LABELS,
  STATUS_VALUES,
  TYPE_LABELS,
  TYPE_VALUES,
  updateEntryApi,
} from '#/api/finance';

const props = defineProps<{
  open: boolean;
  record?: EntryRecord; // edit 模式传入；不传=新建
}>();

const emit = defineEmits<{ saved: []; 'update:open': [boolean] }>();

const isEdit = computed(() => props.record !== undefined);
const saving = ref(false);
const accountOptions = ref<{ label: string; value: string }[]>([]);

/** 后端 DEFAULT_STATUS：create 时选完类型自动带出建议状态。 */
const DEFAULT_STATUS: Record<EntryType, EntryStatus> = {
  expense: 'unpaid',
  income: 'unpaid',
  invoice: 'issued',
  payroll: 'unpaid',
  reimburse: 'pending',
  tax: 'unpaid',
};

async function loadAccounts() {
  try {
    const body = await listAccountsApi();
    accountOptions.value = body.accounts
      .filter((a: AccountRecord) => !a.archived)
      .map((a: AccountRecord) => ({ label: a.name, value: a.name }));
  } catch {
    accountOptions.value = []; // 下拉空不影响手填以外的字段
  }
}

const form = reactive<EntryInput & { status?: EntryStatus }>({});

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    const r = props.record;
    Object.assign(form, {
      account: r?.account ?? '',
      amount: r?.amount,
      category: r?.category ?? '',
      counterparty: r?.counterparty ?? '',
      date: r?.date ?? today(),
      due_date: r?.due_date ?? '',
      followup_note: '',
      invoice_no: r?.invoice_no ?? '',
      note: r?.note ?? '',
      paid_amount: r?.paid_amount ?? 0,
      status: r?.status,
      type: r?.type,
    });
    loadAccounts();
  },
);

function today(): string {
  return new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD（本机时区）
}

function onTypeChange(value: unknown) {
  // antd Select 的 @change 参数是宽类型；非空且合法时才联动默认状态
  if (!isEdit.value && typeof value === 'string' && value in DEFAULT_STATUS) {
    form.status = DEFAULT_STATUS[value as EntryType];
  }
}

async function onOk() {
  if (!form.type) return message.warning('请选类型');
  if (
    form.amount === undefined ||
    Number.isNaN(form.amount) ||
    form.amount <= 0
  ) {
    return message.warning('金额应为正数（元）');
  }
  if (!form.date) return message.warning('请选日期');
  saving.value = true;
  try {
    // 清空的 DatePicker 会给 null：归一成空串（编辑=清空该列；后端对空串不校验格式）
    const payload = { ...form, due_date: form.due_date ?? '' };
    if (isEdit.value && props.record) {
      // 编辑：全字段提交（后端按字段覆盖；followup_note 空串会被后端跳过）
      await updateEntryApi(props.record.id, payload);
      message.success(`已更新 ${props.record.id}`);
    } else {
      const created = await createEntryApi(payload);
      message.success(`已记账 ${created.id}`);
    }
    emit('update:open', false);
    emit('saved');
  } catch (error) {
    message.error(`保存失败：${(error as Error)?.message ?? error}`);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <Modal
    :confirm-loading="saving"
    :open="open"
    :title="isEdit ? `编辑 ${record?.id}` : '记一笔'"
    width="560px"
    @cancel="emit('update:open', false)"
    @ok="onOk"
  >
    <div class="grid grid-cols-2 gap-x-4 gap-y-3">
      <div>
        <div class="mb-1 text-sm text-gray-500">类型 *</div>
        <Select
          v-model:value="form.type"
          :options="
            TYPE_VALUES.map((v) => ({ label: TYPE_LABELS[v], value: v }))
          "
          class="w-full"
          placeholder="选类型"
          @change="onTypeChange"
        />
      </div>
      <div>
        <div class="mb-1 text-sm text-gray-500">金额（元）*</div>
        <InputNumber
          v-model:value="form.amount"
          :min="0.01"
          :precision="2"
          class="w-full"
          placeholder="0.00"
        />
      </div>
      <div>
        <div class="mb-1 text-sm text-gray-500">日期 *</div>
        <DatePicker
          v-model:value="form.date"
          class="w-full"
          value-format="YYYY-MM-DD"
        />
      </div>
      <div>
        <div class="mb-1 text-sm text-gray-500">状态</div>
        <Select
          v-model:value="form.status"
          :options="
            STATUS_VALUES.map((v) => ({ label: STATUS_LABELS[v], value: v }))
          "
          class="w-full"
          placeholder="默认按类型"
        />
      </div>
      <div>
        <div class="mb-1 text-sm text-gray-500">对方</div>
        <Input v-model:value="form.counterparty" placeholder="收/付款对象" />
      </div>
      <div>
        <div class="mb-1 text-sm text-gray-500">分类</div>
        <Input v-model:value="form.category" placeholder="如：办公/推广" />
      </div>
      <div>
        <div class="mb-1 text-sm text-gray-500">已收付（元，累计）</div>
        <InputNumber
          v-model:value="form.paid_amount"
          :min="0"
          :precision="2"
          class="w-full"
        />
      </div>
      <div>
        <div class="mb-1 text-sm text-gray-500">到期日</div>
        <DatePicker
          v-model:value="form.due_date"
          class="w-full"
          value-format="YYYY-MM-DD"
        />
      </div>
      <div>
        <div class="mb-1 text-sm text-gray-500">
          账户{{
            accountOptions.length === 0 ? '（还没建账户，去「账户」页建）' : ''
          }}
        </div>
        <Select
          v-model:value="form.account"
          :options="accountOptions"
          allow-clear
          show-search
          class="w-full"
          placeholder="选收付账户（可不选）"
        />
      </div>
      <div>
        <div class="mb-1 text-sm text-gray-500">发票号</div>
        <Input v-model:value="form.invoice_no" placeholder="选填" />
      </div>
      <div class="col-span-2">
        <div class="mb-1 text-sm text-gray-500">备注</div>
        <Input v-model:value="form.note" placeholder="一句话说明" />
      </div>
      <div v-if="isEdit" class="col-span-2">
        <div class="mb-1 text-sm text-gray-500">追加一条跟踪记录</div>
        <Textarea
          v-model:value="form.followup_note"
          :rows="2"
          placeholder="如：微信催收，答应本周付款（留空则不追加）"
        />
      </div>
    </div>
  </Modal>
</template>

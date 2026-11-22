<script lang="ts" setup>
import type { AccountRecord } from '#/api/finance';

import { onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';

import { useAccess } from '@vben/access';

import {
  Button,
  Input,
  InputNumber,
  message,
  Modal,
  Popconfirm,
  Select,
  Table,
  Tag,
} from 'ant-design-vue';

import {
  ACCOUNT_KIND_LABELS,
  createAccountApi,
  listAccountsApi,
  updateAccountApi,
} from '#/api/finance';
import { ledgerLink } from '#/utils/entity-links';

import CashcountModal from './cashcount-modal.vue';
import ReconcileModal from './reconcile-modal.vue';

const router = useRouter();
const { hasAccessByCodes } = useAccess();
const canWrite = hasAccessByCodes(['finance:write']);

const KIND_OPTIONS = Object.entries(ACCOUNT_KIND_LABELS).map(
  ([value, label]) => ({
    label,
    value,
  }),
);

const loading = ref(false);
const accounts = ref<AccountRecord[]>([]);
const formOpen = ref(false);
const editing = reactive<{ record?: AccountRecord }>({});
const saving = ref(false);
const reconcileOpen = ref(false);
const reconcileAccount = ref<string | undefined>(undefined);
const countOpen = ref(false);
const countAccount = ref<string | undefined>(undefined);

function openReconcile(record: AccountRecord) {
  reconcileAccount.value = record.name;
  reconcileOpen.value = true;
}

function openCount(record: AccountRecord) {
  countAccount.value = record.name;
  countOpen.value = true;
}

const form = reactive<{
  kind?: string;
  name: string;
  note?: string;
  opening_balance?: number;
}>({ name: '' });

async function load() {
  loading.value = true;
  try {
    const body = await listAccountsApi();
    accounts.value = body.accounts;
  } catch (error) {
    message.error(`加载失败：${(error as Error)?.message ?? error}`);
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  editing.record = undefined;
  Object.assign(form, {
    kind: 'other',
    name: '',
    note: '',
    opening_balance: 0,
  });
  formOpen.value = true;
}

function openEdit(record: AccountRecord) {
  editing.record = record;
  Object.assign(form, {
    kind: record.kind,
    // 编辑态不改名字段（后端禁止改名：账目按名字关联）——name 只读展示
    name: record.name,
    note: record.note,
    opening_balance: record.opening_balance,
  });
  formOpen.value = true;
}

async function onOk() {
  if (!editing.record && !form.name.trim())
    return message.warning('请填账户名');
  saving.value = true;
  try {
    if (editing.record) {
      await updateAccountApi(editing.record.id, {
        kind: form.kind,
        note: form.note,
        opening_balance: form.opening_balance,
      });
      message.success(`已更新 ${form.name}`);
    } else {
      await createAccountApi({
        kind: form.kind,
        name: form.name.trim(),
        note: form.note,
        opening_balance: form.opening_balance,
      });
      message.success(`已建账户 ${form.name.trim()}`);
    }
    formOpen.value = false;
    await load();
  } catch (error) {
    message.error(`保存失败：${(error as Error)?.message ?? error}`);
  } finally {
    saving.value = false;
  }
}

async function toggleArchive(record: AccountRecord) {
  try {
    await updateAccountApi(record.id, { archived: !record.archived });
    message.success(
      record.archived ? `已启用 ${record.name}` : `已停用 ${record.name}`,
    );
    await load();
  } catch (error) {
    message.error(`操作失败：${(error as Error)?.message ?? error}`);
  }
}

const columns = [
  { dataIndex: 'name', key: 'name', title: '账户' },
  { key: 'kind', title: '类型', width: 100 },
  {
    dataIndex: 'opening_balance',
    key: 'opening',
    title: '期初(元)',
    align: 'right' as const,
    width: 110,
  },
  {
    dataIndex: 'balance',
    key: 'balance',
    title: '当前余额(元)',
    align: 'right' as const,
    width: 120,
  },
  { dataIndex: 'note', key: 'note', title: '备注', ellipsis: true },
  { key: 'status', title: '状态', width: 90 },
  ...(canWrite ? [{ key: 'actions', title: '操作', width: 230 }] : []),
];

onMounted(load);
</script>

<template>
  <div class="p-4">
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <div class="text-sm text-gray-500">
        账户是钱的现实载体（微信/银行/支付宝/现金），余额 = 期初 + 累计已收 −
        累计已付；未收付的应收应付不进余额。
        记账时账户下拉只能选这里建过的账户。
      </div>
      <div class="flex-1"></div>
      <Button v-if="canWrite" type="primary" @click="openCreate">
        新建账户
      </Button>
    </div>

    <Table
      :columns="columns"
      :data-source="accounts"
      :loading="loading"
      :pagination="false"
      row-key="id"
      size="small"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'name'">
          <!-- 点账户名看这个账户的全部流水（台账按账户过滤） -->
          <Button
            size="small"
            type="link"
            @click="
              router.push(
                ledgerLink({ account: (record as AccountRecord).name }),
              )
            "
          >
            {{ (record as AccountRecord).name }}
          </Button>
        </template>
        <template v-else-if="column.key === 'kind'">
          {{
            ACCOUNT_KIND_LABELS[(record as AccountRecord).kind] ??
            (record as AccountRecord).kind
          }}
        </template>
        <template v-else-if="column.key === 'status'">
          <Tag
            :color="(record as AccountRecord).archived ? 'default' : 'green'"
          >
            {{ (record as AccountRecord).archived ? '已停用' : '在用' }}
          </Tag>
        </template>
        <template v-else-if="column.key === 'actions'">
          <Button
            size="small"
            type="link"
            @click="openReconcile(record as AccountRecord)"
          >
            对账
          </Button>
          <Button
            size="small"
            type="link"
            @click="openCount(record as AccountRecord)"
          >
            盘点
          </Button>
          <Button
            size="small"
            type="link"
            @click="openEdit(record as AccountRecord)"
          >
            编辑
          </Button>
          <Popconfirm
            :title="`确认${(record as AccountRecord).archived ? '启用' : '停用'} ${(record as AccountRecord).name}？`"
            @confirm="toggleArchive(record as AccountRecord)"
          >
            <Button
              danger
              size="small"
              type="link"
              v-if="!(record as AccountRecord).archived"
            >
              停用
            </Button>
            <Button size="small" type="link" v-else>启用</Button>
          </Popconfirm>
        </template>
      </template>
    </Table>

    <Modal
      :confirm-loading="saving"
      :open="formOpen"
      :title="editing.record ? `编辑 ${editing.record.name}` : '新建账户'"
      @cancel="formOpen = false"
      @ok="onOk"
    >
      <div class="grid grid-cols-2 gap-x-4 gap-y-3">
        <div>
          <div class="mb-1 text-sm text-gray-500">账户名 *</div>
          <Input
            v-model:value="form.name"
            :disabled="!!editing.record"
            placeholder="如：微信、对公银行"
          />
        </div>
        <div>
          <div class="mb-1 text-sm text-gray-500">类型</div>
          <Select
            v-model:value="form.kind"
            :options="KIND_OPTIONS"
            class="w-full"
          />
        </div>
        <div>
          <div class="mb-1 text-sm text-gray-500">期初余额（元，可为负）</div>
          <InputNumber
            v-model:value="form.opening_balance"
            class="w-full"
            :precision="2"
            placeholder="0.00"
          />
        </div>
        <div>
          <div class="mb-1 text-sm text-gray-500">备注</div>
          <Input v-model:value="form.note" placeholder="如：尾号 1234" />
        </div>
        <div v-if="editing.record" class="col-span-2 text-xs text-gray-400">
          账户名不可改：已有账目按名字关联。要换名字请新建账户再停用本账户。
        </div>
      </div>
    </Modal>

    <ReconcileModal v-model:open="reconcileOpen" :account="reconcileAccount" />
    <CashcountModal v-model:open="countOpen" :account="countAccount" />
  </div>
</template>

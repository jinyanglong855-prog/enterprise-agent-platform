<script lang="ts" setup>
// 审批落账规则（2026-11-01 融合方案 §5 P2 → 2026-11-02 前端页）：把"飞书审批通过 → 账本提案"的接线配置搬到网页。
// 规则在页面上攒改动、整表保存（后端 PUT 覆盖并订阅各定义的审批事件）；「预览解析」贴实例码核对金额/事由怎么被认出来。
// 落账本身仍走提案确认（老板飞书卡片 / 「提案」页），这里不直接写账；护栏（类型合法/账户已建档/code 唯一）在服务层，前端如实提示。
import type { AccountRecord, PostingPreview, PostingRule } from '#/api/finance';

import { computed, onMounted, reactive, ref } from 'vue';

import {
  Alert,
  Button,
  Descriptions,
  Input,
  message,
  Modal,
  Popconfirm,
  Select,
  Switch,
  Table,
  Tag,
} from 'ant-design-vue';

import {
  listAccountsApi,
  listPostingRulesApi,
  previewPostingApi,
  savePostingRulesApi,
  TYPE_LABELS,
  TYPE_VALUES,
} from '#/api/finance';

const TYPE_OPTIONS = TYPE_VALUES.map((value) => ({
  label: `${TYPE_LABELS[value]}（${value}）`,
  value,
}));

function typeLabel(type: string): string {
  return (TYPE_LABELS as Record<string, string>)[type] ?? type;
}

const loading = ref(false);
const saving = ref(false);
const rules = ref<PostingRule[]>([]);
const accounts = ref<AccountRecord[]>([]);
const dirty = ref(false);
const lastSave = ref<null | {
  subscribed: number;
  subscription_healthy: boolean;
}>(null);

const accountOptions = computed(() => [
  { label: '（不指定：负责人确认时自己补）', value: '' },
  ...accounts.value
    .filter((a) => !a.archived)
    .map((a) => ({ label: a.name, value: a.name })),
]);

async function load() {
  loading.value = true;
  try {
    const [r, a] = await Promise.all([
      listPostingRulesApi(),
      listAccountsApi(),
    ]);
    rules.value = r.rules;
    accounts.value = a.accounts;
    dirty.value = false;
  } catch (error) {
    message.error(`加载失败：${(error as Error)?.message ?? error}`);
  } finally {
    loading.value = false;
  }
}

// ---------- 编辑弹窗（新增/编辑同一块） ----------
const EMPTY_RULE: PostingRule = {
  account: '',
  category: '报销',
  code: '',
  enabled: true,
  field_map: {},
  name: '',
  type: 'reimburse',
};
const formOpen = ref(false);
const editingIndex = ref(-1);
const form = reactive<PostingRule>({ ...EMPTY_RULE, field_map: {} });

function openCreate() {
  editingIndex.value = -1;
  Object.assign(form, { ...EMPTY_RULE, field_map: {} });
  formOpen.value = true;
}

function openEdit(index: number) {
  const r = rules.value[index];
  if (!r) return;
  editingIndex.value = index;
  Object.assign(form, { ...r, field_map: { ...r.field_map } });
  formOpen.value = true;
}

function onFormOk() {
  const code = form.code.trim();
  const name = form.name.trim();
  if (code === '')
    return message.warning(
      '请填审批定义的 approval_code（飞书管理后台 → 审批 → 该定义详情页网址里 definitionCode= 后面那串）',
    );
  if (name === '') return message.warning('请给规则起个人话名（如：费用报销）');
  const duplicate = rules.value.findIndex(
    (r, i) => r.code === code && i !== editingIndex.value,
  );
  if (duplicate !== -1)
    return message.warning(
      `approval_code 重复：已有规则「${rules.value[duplicate]?.name}」用了它`,
    );
  const amount = form.field_map.amount?.trim() ?? '';
  const reason = form.field_map.reason?.trim() ?? '';
  const next: PostingRule = {
    account: form.account ?? '',
    category: form.category.trim() || '报销',
    code,
    enabled: form.enabled,
    field_map: { ...(amount ? { amount } : {}), ...(reason ? { reason } : {}) },
    name,
    type: form.type,
  };
  if (editingIndex.value === -1) rules.value.push(next);
  else rules.value.splice(editingIndex.value, 1, next);
  dirty.value = true;
  formOpen.value = false;
}

function removeRule(index: number) {
  rules.value.splice(index, 1);
  dirty.value = true;
}

function toggleEnabled(index: number, enabled: boolean) {
  const r = rules.value[index];
  if (!r) return;
  r.enabled = enabled;
  dirty.value = true;
}

async function save() {
  saving.value = true;
  try {
    const body = await savePostingRulesApi(rules.value);
    rules.value = body.rules;
    dirty.value = false;
    lastSave.value = {
      subscribed: body.subscribed,
      subscription_healthy: body.subscription_healthy,
    };
    if (body.subscription_healthy) {
      message.success(
        `已保存 ${body.rules.length} 条规则，已订阅 ${body.subscribed} 个审批定义的事件`,
      );
    } else {
      message.warning(
        `规则已保存，但审批事件订阅没全成功（已订 ${body.subscribed}）——服务每 10 分钟自愈重订；漏掉的审批也会被定时补抓`,
        8,
      );
    }
  } catch (error) {
    message.error(`保存失败：${(error as Error)?.message ?? error}`);
  } finally {
    saving.value = false;
  }
}

// ---------- 预览解析 ----------
const previewOpen = ref(false);
const previewCode = ref('');
const previewLoading = ref(false);
const preview = ref<null | PostingPreview>(null);

async function runPreview() {
  const code = previewCode.value.trim();
  if (code === '') return message.warning('贴一个审批实例码（instance_code）');
  previewLoading.value = true;
  preview.value = null;
  try {
    preview.value = await previewPostingApi(code);
  } catch (error) {
    message.error(`预览失败：${(error as Error)?.message ?? error}`);
  } finally {
    previewLoading.value = false;
  }
}

const columns = [
  { key: 'name', title: '规则', width: 150 },
  {
    dataIndex: 'code',
    ellipsis: true,
    key: 'code',
    title: '审批定义 approval_code',
  },
  { key: 'type', title: '记账类型', width: 100 },
  { dataIndex: 'category', key: 'category', title: '分类', width: 90 },
  { key: 'account', title: '默认账户', width: 140 },
  { key: 'field_map', title: '字段映射', width: 230 },
  { key: 'enabled', title: '启用', width: 70 },
  { key: 'actions', title: '操作', width: 120 },
];

onMounted(load);
</script>

<template>
  <div class="p-4">
    <Alert class="mb-3" show-icon type="info">
      <template #message>审批通过自动记账怎么走</template>
      <template #description>
        员工在飞书提交报销/付款等审批 → 审批通过 →
        系统按下面的规则生成一笔待确认记账 → 负责人飞书收到卡片点「确认入账」→
        进台账（也可到「待确认记账」页确认）。
        这里只配"哪张审批对应哪类账"；钱进不进账本仍由负责人确认。保存即订阅该审批定义的事件。
      </template>
    </Alert>

    <div class="mb-3 flex flex-wrap items-center gap-2">
      <Button type="primary" @click="openCreate">新增规则</Button>
      <Button @click="previewOpen = true">预览解析</Button>
      <div class="flex-1"></div>
      <span v-if="lastSave" class="text-xs text-gray-500">
        上次保存：已订阅 {{ lastSave.subscribed }} 个定义
        <Tag :color="lastSave.subscription_healthy ? 'green' : 'orange'">
          {{ lastSave.subscription_healthy ? '订阅健康' : '订阅待自愈' }}
        </Tag>
      </span>
      <Tag v-if="dirty" color="orange">有未保存改动</Tag>
      <Button :disabled="!dirty" :loading="saving" type="primary" @click="save">
        保存并订阅
      </Button>
    </div>

    <Table
      :columns="columns"
      :data-source="rules"
      :loading="loading"
      :pagination="false"
      row-key="code"
      size="small"
    >
      <template #bodyCell="{ column, record, index }">
        <template v-if="column.key === 'name'">
          <b>{{ (record as PostingRule).name }}</b>
        </template>
        <template v-else-if="column.key === 'type'">
          {{ typeLabel((record as PostingRule).type) }}
        </template>
        <template v-else-if="column.key === 'account'">
          <span v-if="(record as PostingRule).account">{{
            (record as PostingRule).account
          }}</span>
          <span v-else class="text-gray-400">负责人确认时补</span>
        </template>
        <template v-else-if="column.key === 'field_map'">
          <template
            v-if="
              (record as PostingRule).field_map.amount ||
              (record as PostingRule).field_map.reason
            "
          >
            <div
              v-if="(record as PostingRule).field_map.amount"
              class="text-xs"
            >
              金额 ← {{ (record as PostingRule).field_map.amount }}
            </div>
            <div
              v-if="(record as PostingRule).field_map.reason"
              class="text-xs"
            >
              事由 ← {{ (record as PostingRule).field_map.reason }}
            </div>
          </template>
          <span v-else class="text-xs text-gray-400">启发式：表单顶层首个金额字段 +
            名字含"事由/原因/说明/用途"的文本</span>
        </template>
        <template v-else-if="column.key === 'enabled'">
          <Switch
            :checked="(record as PostingRule).enabled"
            size="small"
            @change="(v: unknown) => toggleEnabled(index, v === true)"
          />
        </template>
        <template v-else-if="column.key === 'actions'">
          <Button size="small" type="link" @click="openEdit(index)">
            编辑
          </Button>
          <Popconfirm
            title="删除这条规则？已生成的记账单不受影响；该审批再通过时不再自动记账。"
            @confirm="removeRule(index)"
          >
            <Button danger size="small" type="link">删除</Button>
          </Popconfirm>
        </template>
      </template>
    </Table>
    <div class="mt-2 text-xs text-gray-400">
      改动先在页面上攒着，点「保存并订阅」整表生效。停用的规则：事件照收但不记账（审计记
      ignored），补抓也会扫到它。
    </div>

    <Modal
      :open="formOpen"
      :title="editingIndex === -1 ? '新增规则' : `编辑 ${form.name}`"
      @cancel="formOpen = false"
      @ok="onFormOk"
    >
      <div class="grid grid-cols-2 gap-x-4 gap-y-3">
        <div>
          <div class="mb-1 text-sm text-gray-500">规则名 *</div>
          <Input v-model:value="form.name" placeholder="如：费用报销" />
        </div>
        <div>
          <div class="mb-1 text-sm text-gray-500">审批定义 approval_code *</div>
          <Input
            v-model:value="form.code"
            :disabled="editingIndex !== -1"
            placeholder="如：APPRxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
          />
        </div>
        <div>
          <div class="mb-1 text-sm text-gray-500">记账类型</div>
          <Select
            v-model:value="form.type"
            :options="TYPE_OPTIONS"
            class="w-full"
          />
        </div>
        <div>
          <div class="mb-1 text-sm text-gray-500">分类</div>
          <Input v-model:value="form.category" placeholder="报销" />
        </div>
        <div>
          <div class="mb-1 text-sm text-gray-500">默认账户</div>
          <Select
            v-model:value="form.account"
            :options="accountOptions"
            class="w-full"
          />
        </div>
        <div class="flex items-end gap-2 pb-1">
          <Switch v-model:checked="form.enabled" />
          <span class="text-sm">{{ form.enabled ? '启用' : '停用' }}</span>
        </div>
        <div>
          <div class="mb-1 text-sm text-gray-500">金额字段（可选）</div>
          <Input
            v-model:value="form.field_map.amount"
            placeholder="表单控件 custom_id 或 id，如 widget1651…"
          />
        </div>
        <div>
          <div class="mb-1 text-sm text-gray-500">事由字段（可选）</div>
          <Input
            v-model:value="form.field_map.reason"
            placeholder="同上；不填取名字含事由/原因的文本"
          />
        </div>
        <div class="col-span-2 text-xs text-gray-400">
          字段 id
          不确定时先保存规则，再用「预览解析」贴一张已通过的实例码核对。指定了金额字段但表单里没有=规则失效（不建记账单、通知负责人），不会悄悄退回启发式。
        </div>
      </div>
    </Modal>

    <Modal
      :footer="null"
      :open="previewOpen"
      title="预览解析（不建记账单、不落账）"
      width="640px"
      @cancel="previewOpen = false"
    >
      <div class="mb-3 flex gap-2">
        <Input
          v-model:value="previewCode"
          placeholder="审批实例码 instance_code（审批详情网址或接口里那串）"
          @press-enter="runPreview"
        />
        <Button :loading="previewLoading" type="primary" @click="runPreview">
          解析
        </Button>
      </div>
      <Descriptions v-if="preview" :column="1" bordered size="small">
        <Descriptions.Item label="命中规则">
          {{ preview.rule.name }}（{{ typeLabel(preview.rule.type) }} /
          {{ preview.rule.category }}）
        </Descriptions.Item>
        <Descriptions.Item label="金额">
          <b v-if="preview.amount !== null">{{ preview.amount.toFixed(2) }} 元</b>
          <Tag v-else color="red">解析不出</Tag>
          <span class="ml-2 text-xs text-gray-500">{{
            preview.amount_source
          }}</span>
        </Descriptions.Item>
        <Descriptions.Item label="事由">
          {{ preview.reason || '（空）' }}
        </Descriptions.Item>
        <Descriptions.Item label="申请人">
          {{ preview.counterparty }}
        </Descriptions.Item>
        <Descriptions.Item label="记账日">{{ preview.date }}</Descriptions.Item>
        <Descriptions.Item label="单号">
          {{ preview.serial_number || '（无）' }}
        </Descriptions.Item>
        <Descriptions.Item label="备注">{{ preview.note }}</Descriptions.Item>
      </Descriptions>
    </Modal>
  </div>
</template>

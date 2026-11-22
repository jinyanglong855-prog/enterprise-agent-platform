<script lang="ts" setup>
import type { ProposalKind, ProposalRecord } from '#/api/finance';

import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { useAccess } from '@vben/access';

import {
  Button,
  message,
  Modal,
  Popconfirm,
  Table,
  Tabs,
  Tag,
  Tooltip,
} from 'ant-design-vue';

import {
  confirmProposalApi,
  isImportPayload,
  listProposalsApi,
  rejectProposalApi,
  STATUS_LABELS,
  TYPE_LABELS,
} from '#/api/finance';

const { hasAccessByCodes } = useAccess();
const canWrite = hasAccessByCodes(['finance:write']);
const route = useRoute();
const router = useRouter();

const activeTab = ref<'all' | 'pending'>('pending');
const loading = ref(false);
const proposals = ref<ProposalRecord[]>([]);
const count = ref(0);

const columns = [
  { title: '单号', key: 'id', width: 210 },
  { title: '内容', key: 'summary' },
  { title: '类型', key: 'kind', width: 90 },
  { title: '发起', dataIndex: 'created_by', key: 'created_by', width: 90 },
  { title: '时间', key: 'created_at', width: 150 },
  { title: '状态', key: 'status', width: 90 },
  { title: '操作', key: 'actions', width: 190 },
];

async function load() {
  loading.value = true;
  try {
    const status = activeTab.value === 'pending' ? 'pending' : undefined;
    const body = await listProposalsApi(status);
    proposals.value = body.proposals;
    count.value = body.count;
  } catch (error) {
    message.error(`加载失败：${(error as Error)?.message ?? error}`);
  } finally {
    loading.value = false;
  }
}

// ---------- 详情展开：单笔字段 / 批量行预览 ----------
function importRowsOf(p: ProposalRecord) {
  return p.kind === 'import' && isImportPayload(p.payload)
    ? p.payload.rows
    : [];
}
function importNoteOf(p: ProposalRecord): string {
  return p.kind === 'import' && isImportPayload(p.payload)
    ? p.payload.note
    : '';
}
function singleOf(p: ProposalRecord) {
  return p.kind === 'single' && !isImportPayload(p.payload)
    ? p.payload
    : undefined;
}
function typeLabel(t?: string): string {
  return t ? (TYPE_LABELS[t as keyof typeof TYPE_LABELS] ?? t) : '';
}
function statusLabel(s?: string): string {
  return s ? (STATUS_LABELS[s as keyof typeof STATUS_LABELS] ?? s) : '';
}
function fmtTime(iso: string): string {
  return iso ? iso.slice(0, 16).replace('T', ' ') : '';
}

// ---------- 确认 / 拒绝 ----------
const busyId = ref('');

async function onConfirm(p: ProposalRecord) {
  busyId.value = p.id;
  try {
    const r = await confirmProposalApi(p.id);
    if (r.entries) {
      message.success(`已批量入账 ${r.entries.length} 笔（批次 ${r.batch}）`);
    } else if (r.entry) {
      message.success(`已入账 ${r.entry.id}`);
    }
    await load();
  } catch (error) {
    message.error(`确认失败：${(error as Error)?.message ?? error}`);
  } finally {
    busyId.value = '';
  }
}

function onReject(p: ProposalRecord) {
  Modal.confirm({
    content: '拒绝后不会入账；发起方（智能体/审批）需要重新提交。',
    okText: '拒绝',
    okType: 'danger',
    onOk: async () => {
      try {
        await rejectProposalApi(p.id, '在「待确认记账」页拒绝');
        message.success('已拒绝');
        await load();
      } catch (error) {
        message.error(`操作失败：${(error as Error)?.message ?? error}`);
      }
    },
    title: '拒绝这笔入账？',
  });
}

// ---------- 跳台账 ----------
function gotoEntry(p: ProposalRecord) {
  if (!p.entry_id) return;
  router.push({ path: '/finance/ledger', query: { id: p.entry_id } });
}

// ---------- 深链：?id= 定位单子 ----------
const expandedKeys = ref<string[]>([]);
const highlightId = ref('');

/** 深链 ?id=：id 不带状态信息，三个状态各查一次找到为止；没带 id 就正常加载。 */
async function applyDeepLink(): Promise<void> {
  const wantId = typeof route.query.id === 'string' ? route.query.id : '';
  if (wantId) {
    for (const status of ['pending', 'confirmed', 'rejected'] as const) {
      try {
        const body = await listProposalsApi(status);
        if (body.proposals.some((p) => p.id === wantId)) {
          activeTab.value = status === 'pending' ? 'pending' : 'all';
          highlightId.value = wantId;
          expandedKeys.value = [wantId];
          await load();
          await nextTickScroll(wantId);
          return;
        }
      } catch {
        break;
      }
    }
  }
  await load();
}

onMounted(applyDeepLink);

// 页签 keep-alive：页面已开着又从工作台/工资页跳过来时 onMounted 不会再跑，靠 query 变化重新定位
watch(
  () => route.query,
  (q, old) => {
    if (
      route.path === '/finance/proposals' &&
      JSON.stringify(q) !== JSON.stringify(old)
    )
      void applyDeepLink();
  },
);

async function nextTickScroll(id: string) {
  await new Promise((r) => setTimeout(r, 300));
  document
    .querySelector(`tr[data-row-key="${CSS.escape(id)}"]`)
    ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function rowClassName(record: ProposalRecord): string {
  return record.id === highlightId.value ? 'row-highlight' : '';
}

const kindLabel = computed<Record<ProposalKind, string>>(() => ({
  import: '批量导入',
  single: '单笔记账',
}));
</script>

<template>
  <div class="p-4">
    <div class="mb-2 flex flex-wrap items-center gap-2">
      <span class="text-sm text-gray-500">
        智能体记的账和飞书审批通过的报销，都先到这里来一张"入账单"，确认后才会写进台账；不确认账本不变。
      </span>
      <div class="flex-1"></div>
      <Button @click="router.push('/assistant')">去对话让智能体记账</Button>
    </div>
    <Tabs v-model:active-key="activeTab" @change="load">
      <Tabs.TabPane key="pending" tab="待确认" />
      <Tabs.TabPane key="all" tab="全部" />
    </Tabs>
    <Table
      :columns="columns"
      :data-source="proposals"
      :expanded-row-keys="expandedKeys"
      :loading="loading"
      :pagination="{ pageSize: 20, showTotal: (t: number) => `共 ${t} 张` }"
      :row-class-name="rowClassName"
      row-key="id"
      size="small"
      @expanded-rows-change="(keys) => (expandedKeys = keys.map(String))"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'id'">
          <span class="font-mono text-xs">{{
            (record as ProposalRecord).id
          }}</span>
        </template>
        <template v-else-if="column.key === 'summary'">
          {{ (record as ProposalRecord).summary }}
        </template>
        <template v-else-if="column.key === 'kind'">
          {{ kindLabel[(record as ProposalRecord).kind] }}
        </template>
        <template v-else-if="column.key === 'created_at'">
          {{ fmtTime((record as ProposalRecord).created_at) }}
        </template>
        <template v-else-if="column.key === 'status'">
          <Tag
            :color="
              (record as ProposalRecord).status === 'confirmed'
                ? 'green'
                : (record as ProposalRecord).status === 'rejected'
                  ? 'default'
                  : 'orange'
            "
          >
            {{
              (record as ProposalRecord).status === 'confirmed'
                ? '已入账'
                : (record as ProposalRecord).status === 'rejected'
                  ? '已拒绝'
                  : '待确认'
            }}
          </Tag>
        </template>
        <template v-else-if="column.key === 'actions'">
          <template v-if="(record as ProposalRecord).status === 'pending'">
            <template v-if="canWrite">
              <Popconfirm
                :title="
                  (record as ProposalRecord).kind === 'import'
                    ? '确认后整批入账，导入不成功整批不落。'
                    : '确认后这笔账写进台账。'
                "
                @confirm="onConfirm(record as ProposalRecord)"
              >
                <Button
                  :loading="busyId === (record as ProposalRecord).id"
                  size="small"
                  type="primary"
                >
                  {{
                    (record as ProposalRecord).kind === 'import'
                      ? '确认导入'
                      : '确认入账'
                  }}
                </Button>
              </Popconfirm>
              <Button
                :disabled="busyId === (record as ProposalRecord).id"
                danger
                size="small"
                type="link"
                @click="onReject(record as ProposalRecord)"
              >
                拒绝
              </Button>
            </template>
            <Tooltip
              v-else
              title="你的账号没有入账权限（finance:write），只能查看"
            >
              <span class="text-xs text-gray-400">无入账权限</span>
            </Tooltip>
          </template>
          <Button
            v-else-if="(record as ProposalRecord).entry_id"
            size="small"
            type="link"
            @click="gotoEntry(record as ProposalRecord)"
          >
            看台账
          </Button>
        </template>
      </template>
      <template #expandedRowRender="{ record }">
        <div class="pl-2">
          <template v-if="singleOf(record as ProposalRecord)">
            <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs">
              <template
                v-for="(v, k) in {
                  类型: typeLabel(singleOf(record as ProposalRecord)?.type),
                  金额:
                    singleOf(record as ProposalRecord)?.amount !== undefined
                      ? `${singleOf(record as ProposalRecord)?.amount} 元`
                      : '',
                  日期: singleOf(record as ProposalRecord)?.date || '',
                  对方: singleOf(record as ProposalRecord)?.counterparty || '',
                  账户: singleOf(record as ProposalRecord)?.account || '',
                  分类: singleOf(record as ProposalRecord)?.category || '',
                  状态: statusLabel(singleOf(record as ProposalRecord)?.status),
                  到期: singleOf(record as ProposalRecord)?.due_date || '',
                  备注: singleOf(record as ProposalRecord)?.note || '',
                }"
                :key="k"
              >
                <span v-if="v"
                  ><span class="text-gray-400">{{ k }}：</span>{{ v }}</span
                >
              </template>
            </div>
          </template>
          <template v-else>
            <div
              v-if="importNoteOf(record as ProposalRecord)"
              class="mb-1 text-xs text-gray-500"
            >
              来源：{{ importNoteOf(record as ProposalRecord) }}
            </div>
            <table class="w-full text-xs">
              <thead>
                <tr class="text-left text-gray-400">
                  <th class="py-1 pr-4">日期</th>
                  <th class="py-1 pr-4">类型</th>
                  <th class="py-1 pr-4 text-right">金额</th>
                  <th class="py-1 pr-4">对方</th>
                  <th class="py-1 pr-4">账户</th>
                  <th class="py-1">状态</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="(row, i) in importRowsOf(record as ProposalRecord)"
                  :key="i"
                  class="border-t border-gray-100"
                >
                  <td class="py-1 pr-4">{{ row.date }}</td>
                  <td class="py-1 pr-4">{{ typeLabel(row.type) }}</td>
                  <td class="py-1 pr-4 text-right">{{ row.amount }}</td>
                  <td class="py-1 pr-4">{{ row.counterparty }}</td>
                  <td class="py-1 pr-4">{{ row.account || '—' }}</td>
                  <td class="py-1">{{ statusLabel(row.status) || '—' }}</td>
                </tr>
              </tbody>
            </table>
          </template>
          <div
            v-if="(record as ProposalRecord).reason"
            class="mt-1 text-xs text-gray-400"
          >
            说明：{{ (record as ProposalRecord).reason }}
          </div>
        </div>
      </template>
    </Table>
  </div>
</template>

<style scoped>
:deep(.row-highlight) td {
  background: hsl(var(--primary) / 8%) !important;
}
</style>

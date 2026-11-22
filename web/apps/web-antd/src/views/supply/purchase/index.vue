<script lang="ts" setup>
import type { PoRow } from '#/api/supply';

import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

import { useAccess } from '@vben/access';

import {
  Alert,
  Button,
  Checkbox,
  message,
  Popconfirm,
  Select,
  Table,
  Tag,
} from 'ant-design-vue';

import { listPosApi, updatePoApi } from '#/api/supply';
import { PO_STATUS_LABELS } from '#/constants/labels';

import ImportModal from '../import-modal.vue';

const route = useRoute();
const { hasAccessByCodes } = useAccess();
/** 收货/取消/重开/导入都是写：只读账号不该看到会 403 的按钮。 */
const canWrite = computed(() => hasAccessByCodes(['supply:write']));

const loading = ref(false);
const pos = ref<PoRow[]>([]);
/** 同一筛选的真实总数（列表有页长，超出部分不静默吞掉）。 */
const total = ref(0);
const limit = ref(0);
const truncated = computed(() => total.value > pos.value.length);
const status = ref<'all' | PoRow['status']>('open');
const overdueOnly = ref(false);
/** 深链 ?id= 命中的行：高亮滚到可见（本页无详情抽屉）。 */
const highlightId = ref('');

const importOpen = ref(false);
const today = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

async function load() {
  loading.value = true;
  try {
    const body = await listPosApi({
      overdue: overdueOnly.value,
      status: status.value,
    });
    pos.value = body.pos;
    total.value = body.total;
    limit.value = body.limit;
    // 高亮目标不在当前筛选里（如已到货但深链带 overdue=1）：放宽到全部再取一次，别让人点链接扑空
    if (
      highlightId.value !== '' &&
      !pos.value.some((p) => String(p.id) === highlightId.value)
    ) {
      status.value = 'all';
      overdueOnly.value = false;
      const wider = await listPosApi({ overdue: false, status: 'all' });
      pos.value = wider.pos;
      total.value = wider.total;
      limit.value = wider.limit;
    }
  } catch (error) {
    message.error(`加载失败：${(error as Error)?.message ?? error}`);
  } finally {
    loading.value = false;
  }
}

/** 深链预定位（/supply/purchase?id=&overdue=1）：先按 query 开筛选加载，命中行高亮滚动。 */
async function applyDeepLink() {
  overdueOnly.value = route.query.overdue === '1';
  const id = typeof route.query.id === 'string' ? route.query.id.trim() : '';
  highlightId.value = id;
  await load();
  if (id !== '') {
    await new Promise((r) => setTimeout(r, 300));
    document
      .querySelector(`tr[data-row-key="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

async function setStatus(record: PoRow, next: PoRow['status']) {
  try {
    await updatePoApi(record.id, { status: next });
    message.success(
      next === 'received'
        ? `${record.po_no} 已记到货（到货日 ${today()}）`
        : `${record.po_no} 已改为${PO_STATUS_LABELS[next]}`,
    );
    await load();
  } catch (error) {
    message.error(`操作失败：${(error as Error)?.message ?? error}`);
  }
}

function qty(record: PoRow): string {
  return `${record.qty_milli / 1000}${record.unit}`;
}

function isOverdue(record: PoRow): boolean {
  return (
    record.status === 'open' &&
    record.promised_date !== '' &&
    record.promised_date < today()
  );
}

const columns = [
  { dataIndex: 'po_no', key: 'po_no', title: '采购单号', width: 130 },
  { key: 'item', title: '物料', ellipsis: true },
  {
    dataIndex: 'supplier',
    key: 'supplier',
    title: '供应商',
    ellipsis: true,
    width: 130,
  },
  { key: 'qty', title: '数量', align: 'right' as const, width: 90 },
  { dataIndex: 'ordered_date', key: 'ordered', title: '下单日', width: 100 },
  { key: 'promised', title: '承诺到货', width: 110 },
  { key: 'status', title: '状态', width: 90 },
  { dataIndex: 'received_date', key: 'received', title: '到货日', width: 100 },
  { dataIndex: 'note', key: 'note', title: '备注', ellipsis: true, width: 120 },
  { key: 'actions', title: '操作', width: 160 },
];

onMounted(() => {
  applyDeepLink();
});

// 页签 keep-alive：页面已开着又从工作台/待办跳过来时 onMounted 不会再跑，靠 query 变化重新定位
watch(
  () => route.query,
  (q, old) => {
    if (
      route.path === '/supply/purchase' &&
      JSON.stringify(q) !== JSON.stringify(old)
    )
      void applyDeepLink();
  },
);
</script>

<template>
  <div class="p-4">
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <div class="text-sm text-gray-500">
        采购单行只记"什么时候该到多少货"：收货/取消改状态不删行；承诺日已过仍未到货的会进待办预警（到货即自动消除）。
        单价与金额在财务域，这里没有。
      </div>
      <div class="flex-1"></div>
      <Select v-model:value="status" style="width: 120px" @change="load">
        <Select.Option value="open">未到货</Select.Option>
        <Select.Option value="received">已到货</Select.Option>
        <Select.Option value="cancelled">已取消</Select.Option>
        <Select.Option value="all">全部</Select.Option>
      </Select>
      <Checkbox v-model:checked="overdueOnly" @change="load">只看逾期</Checkbox>
      <span class="text-xs text-gray-400">共 {{ total }} 张</span>
      <Button v-if="canWrite" type="primary" ghost @click="importOpen = true">
        导入采购单
      </Button>
    </div>
    <Alert
      v-if="truncated"
      class="mb-3"
      show-icon
      type="info"
      :message="`这个筛法下共 ${total} 张，只列出了前 ${pos.length} 张（页长 ${limit}）——换状态筛选或只看逾期缩小范围。`"
    />

    <Table
      :columns="columns"
      :data-source="pos"
      :loading="loading"
      :pagination="{ pageSize: 20 }"
      :row-class-name="
        (r: PoRow) => (String(r.id) === highlightId ? 'row-highlight' : '')
      "
      row-key="id"
      size="small"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'item'">
          {{ (record as PoRow).name }}（{{ (record as PoRow).code }}）
        </template>
        <template v-else-if="column.key === 'qty'">
          {{ qty(record as PoRow) }}
        </template>
        <template v-else-if="column.key === 'promised'">
          <span
            :class="
              isOverdue(record as PoRow) ? 'font-medium text-red-600' : ''
            "
          >
            {{ (record as PoRow).promised_date || '—'
            }}{{ isOverdue(record as PoRow) ? '（逾期）' : '' }}
          </span>
        </template>
        <template v-else-if="column.key === 'status'">
          <Tag
            :color="
              (record as PoRow).status === 'open'
                ? isOverdue(record as PoRow)
                  ? 'red'
                  : 'orange'
                : (record as PoRow).status === 'received'
                  ? 'green'
                  : 'default'
            "
          >
            {{ PO_STATUS_LABELS[(record as PoRow).status] }}
          </Tag>
        </template>
        <template v-else-if="column.key === 'actions'">
          <span v-if="!canWrite" class="text-xs text-gray-400">只读</span>
          <template v-else-if="(record as PoRow).status === 'open'">
            <Popconfirm
              :title="`确认 ${(record as PoRow).po_no} 已到货？到货日记为今天。`"
              @confirm="setStatus(record as PoRow, 'received')"
            >
              <Button size="small" type="link">收货</Button>
            </Popconfirm>
            <Popconfirm
              :title="`确认取消 ${(record as PoRow).po_no}？取消后不再预警。`"
              @confirm="setStatus(record as PoRow, 'cancelled')"
            >
              <Button danger size="small" type="link">取消</Button>
            </Popconfirm>
          </template>
          <template v-else>
            <Button
              size="small"
              type="link"
              @click="setStatus(record as PoRow, 'open')"
            >
              重开
            </Button>
          </template>
        </template>
      </template>
    </Table>

    <ImportModal
      v-if="canWrite"
      v-model:open="importOpen"
      kind="pos"
      @imported="load"
    />
  </div>
</template>

<style scoped>
:deep(tr.row-highlight > td) {
  background-color: rgb(250 173 20 / 15%);
}
</style>

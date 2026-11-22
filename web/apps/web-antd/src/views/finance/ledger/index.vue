<script lang="ts" setup>
import type {
  EntryFilter,
  EntryRecord,
  EntryStatus,
  EntryType,
  ReportedMonth,
} from '#/api/finance';

import {
  computed,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
} from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { useAccess } from '@vben/access';

import {
  Button,
  DatePicker,
  Dropdown,
  Input,
  Menu,
  message,
  Modal,
  Select,
  Table,
  Tag,
  Textarea,
} from 'ant-design-vue';

import {
  deleteEntryApi,
  getEntryApi,
  listAccountsApi,
  listEntriesApi,
  listPeriodsApi,
  listProposalsApi,
  markReportedApi,
  reverseEntryApi,
  STATUS_LABELS,
  STATUS_VALUES,
  TYPE_LABELS,
  TYPE_VALUES,
  unmarkReportedApi,
  updateEntryApi,
} from '#/api/finance';
import { ENTRY_STATUS_COLORS } from '#/constants/labels';

import ArchiveModal from './archive-modal.vue';
import EntryDetailDrawer from './entry-detail-drawer.vue';
import EntryFormModal from './entry-form-modal.vue';
import ImportModal from './import-modal.vue';
import PackModal from './pack-modal.vue';
import StatementModal from './statement-modal.vue';

const router = useRouter();
const route = useRoute();
const loading = ref(false);
const records = ref<EntryRecord[]>([]);
const filters = reactive<{
  account?: string;
  counterparty: string;
  month?: string;
  status?: EntryStatus;
  type?: EntryType;
}>({
  counterparty: '',
});
/** 只看未结清（工作台"应收/应付未收付"点进来）：未取消、未收/付完、不在冲销对里。 */
const outstandingOnly = ref(false);
/** 深链 ?id= 命中的行：高亮并滚到可见。 */
const highlightId = ref('');
const pagination = reactive({ current: 1, pageSize: 20, total: 0 });

const formOpen = ref(false);
const editing: { record?: EntryRecord } = reactive({});
const detail = reactive({
  open: false,
  record: undefined as EntryRecord | undefined,
});
const deleting = reactive({
  busy: false,
  open: false,
  reason: '',
  record: undefined as EntryRecord | undefined,
});
const reversing = reactive({
  busy: false,
  open: false,
  reason: '',
  record: undefined as EntryRecord | undefined,
});

const periodsOpen = ref(false);
const periods = ref<ReportedMonth[]>([]);
const periodsBusy = ref(false);
const pendingCount = ref(0);

// 批量导入（§0.6 通道 a：标准模板 CSV/粘贴）
const importOpen = ref(false);

// 报表三件（A8 往来对账单 / F5 检查应答包 / E5 年度归档）
const statementOpen = ref(false);
const packOpen = ref(false);
const archiveOpen = ref(false);

function onReportMenu({ key }: { key: number | string }) {
  if (key === 'statement') statementOpen.value = true;
  else if (key === 'pack') packOpen.value = true;
  else if (key === 'archive') archiveOpen.value = true;
}

// 批量编辑（§0.6 通道 c：勾选多行，只改填了的那几个字段）
const selectedIds = ref<string[]>([]);
const batch = reactive({
  account: undefined as string | undefined,
  busy: false,
  category: '',
  status: undefined as EntryStatus | undefined,
});
const accounts = ref<{ name: string }[]>([]);
const batchFieldFilled = computed(
  () =>
    batch.status !== undefined ||
    batch.account !== undefined ||
    batch.category.trim() !== '',
);

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function loadPending() {
  try {
    const body = await listProposalsApi('pending');
    pendingCount.value = body.count;
  } catch {
    pendingCount.value = 0;
  }
}

// 按钮显隐与后端口径一致：改账/锁结账要 finance:write，删账/解锁要 admin:manage。
const { hasAccessByCodes } = useAccess();
const canWrite = hasAccessByCodes(['finance:write']);
const canManage = hasAccessByCodes(['admin:manage']);

async function load() {
  loading.value = true;
  try {
    const filter: EntryFilter = {
      account: filters.account,
      counterparty: filters.counterparty.trim() || undefined,
      limit: 100, // 后端暂无 offset 分页（月账量小够用）；超百条靠筛选收窄，需要时后端加分页
      month: filters.month,
      outstanding: outstandingOnly.value || undefined,
      status: filters.status,
      type: filters.type,
    };
    const body = await listEntriesApi(filter);
    records.value = body.records;
    pagination.total = body.records.length;
    pagination.current = 1;
    // 列表换了（筛选/导入刷新）就清勾选：不然"已选 N 笔"能应用到已经看不见的行（对抗审查 P3-7）
    selectedIds.value = [];
    if (body.records.length >= 100) {
      message.warning(
        '已达单次加载上限 100 条，更早记录未显示；请用筛选收窄范围',
      );
    }
  } catch (error) {
    message.error(`加载失败：${(error as Error)?.message ?? error}`);
  } finally {
    loading.value = false;
  }
}

function resetFilters() {
  filters.counterparty = '';
  filters.month = undefined;
  filters.status = undefined;
  filters.type = undefined;
  filters.account = undefined;
  outstandingOnly.value = false;
  load();
}

/** 深链预定位（/finance/ledger?id=&month=&type=&status=&account=&outstanding=1）：
 *  先按 query 预填筛选并加载，命中 id 再开详情抽屉、高亮滚动。query 值不在合法集里就忽略（不报错）。 */
async function applyDeepLink() {
  const q = route.query;
  const month =
    typeof q.month === 'string' && /^\d{4}-\d{2}$/.test(q.month)
      ? q.month
      : undefined;
  const type =
    typeof q.type === 'string' &&
    (TYPE_VALUES as readonly string[]).includes(q.type)
      ? (q.type as EntryType)
      : undefined;
  const status =
    typeof q.status === 'string' &&
    (STATUS_VALUES as readonly string[]).includes(q.status)
      ? (q.status as EntryStatus)
      : undefined;
  const account =
    typeof q.account === 'string' && q.account !== '' ? q.account : undefined;
  const id =
    typeof q.id === 'string' && /^FIN-\d{8}-\d{3}$/.test(q.id) ? q.id : '';
  outstandingOnly.value = q.outstanding === '1';
  filters.month = month;
  filters.type = type;
  filters.status = status;
  filters.account = account;
  await load();
  if (id !== '') {
    highlightId.value = id;
    try {
      detail.record = await getEntryApi(id);
      detail.open = true;
    } catch {
      // 404 的"找不到记录 FIN-…"已由 request 拦截器弹出，这里不再重复提示
    }
    await scrollToRow(id);
  }
}

async function scrollToRow(id: string) {
  await new Promise((r) => setTimeout(r, 300));
  document
    .querySelector(`tr[data-row-key="${CSS.escape(id)}"]`)
    ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function openCreate() {
  editing.record = undefined;
  formOpen.value = true;
}

function openEdit(record: EntryRecord) {
  editing.record = record;
  formOpen.value = true;
}

async function openDetail(record: EntryRecord) {
  detail.record = record;
  detail.open = true;
  // 按 id 读全文：拿最新 followups（列表接口不带）
  try {
    detail.record = await getEntryApi(record.id);
  } catch {
    // 列表数据兜底展示，不打断
  }
}

/** 作废：走 update status=cancelled（与 md 工具语义一致），留一条跟踪记录。 */
function voidEntry(record: EntryRecord) {
  Modal.confirm({
    content: `作废后不进统计但保留在库（可再改回）。确认作废 ${record.id}？`,
    okText: '作废',
    okType: 'danger',
    onOk: async () => {
      try {
        await updateEntryApi(record.id, {
          followup_note: '作废（台账界面）',
          status: 'cancelled',
        });
        message.success(`已作废 ${record.id}`);
        await load();
      } catch (error) {
        message.error(`作废失败：${(error as Error)?.message ?? error}`);
      }
    },
    title: '作废这笔账？',
  });
}

/** 冲销：追加全额反向条目（原条目保留）；出数月份的唯一修正路径。 */
async function confirmReverse() {
  if (!reversing.record || reversing.busy) return;
  reversing.busy = true;
  try {
    const rev = await reverseEntryApi(
      reversing.record.id,
      reversing.reason.trim(),
    );
    message.success(
      `已冲销：新增反向条目 ${rev.id}，原 ${reversing.record.id} 保留`,
    );
    reversing.open = false;
    reversing.reason = '';
    await load();
  } catch (error) {
    message.error(`冲销失败：${(error as Error)?.message ?? error}`);
  } finally {
    reversing.busy = false;
  }
}

async function openPeriods() {
  periodsOpen.value = true;
  try {
    const body = await listPeriodsApi();
    periods.value = body.months;
  } catch (error) {
    message.error(
      `读取结账锁定记录失败：${(error as Error)?.message ?? error}`,
    );
  }
}

async function toggleMonthReport(month: string, reported: boolean) {
  periodsBusy.value = true;
  try {
    if (reported) {
      await unmarkReportedApi(month);
      message.success(`已解除 ${month} 的结账锁定（该月恢复可编辑）`);
    } else {
      await markReportedApi(month);
      message.success(`已锁定 ${month}：该月账目冻结，只许冲销`);
    }
    await openPeriods();
  } catch (error) {
    message.error(`操作失败：${(error as Error)?.message ?? error}`);
  } finally {
    periodsBusy.value = false;
  }
}

/** 删除：软删除（deleted_at），需 admin:manage；仅误录兜底用。 */
async function confirmDelete() {
  if (!deleting.record || deleting.busy) return;
  deleting.busy = true;
  try {
    await deleteEntryApi(deleting.record.id, deleting.reason.trim());
    message.success(`已删除 ${deleting.record.id}（软删除，数据仍保留在库中）`);
    deleting.open = false;
    deleting.reason = '';
    await load();
  } catch (error) {
    message.error(`删除失败：${(error as Error)?.message ?? error}`);
  } finally {
    deleting.busy = false;
  }
}

/** 批量修改：对勾选的行逐条 PATCH（只带填了的字段）；冲销对/出数月会被后端拒，结果如实统计。 */
async function applyBatch() {
  if (!batchFieldFilled.value || selectedIds.value.length === 0 || batch.busy)
    return;
  const patch: Record<string, unknown> = {};
  if (batch.status !== undefined) patch.status = batch.status;
  if (batch.account !== undefined) patch.account = batch.account;
  if (batch.category.trim() !== '') patch.category = batch.category.trim();
  batch.busy = true;
  try {
    const results = await Promise.allSettled(
      selectedIds.value.map((id) => updateEntryApi(id, patch)),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.length - ok;
    if (failed === 0) {
      message.success(`已批量修改 ${ok} 笔`);
    } else {
      const firstErr = (
        results.find((r) => r.status === 'rejected') as PromiseRejectedResult
      )?.reason;
      message.warning(
        `成功 ${ok} 笔，失败 ${failed} 笔（冲销对/已锁定结账的月份不可改）${firstErr ? `：${(firstErr as Error)?.message ?? firstErr}` : ''}`,
      );
    }
    selectedIds.value = [];
    batch.status = undefined;
    batch.account = undefined;
    batch.category = '';
    await load();
  } finally {
    batch.busy = false;
  }
}

async function loadAccounts() {
  if (accounts.value.length > 0) return;
  try {
    const body = await listAccountsApi();
    accounts.value = body.accounts.filter((a) => !a.archived);
  } catch {
    // 批量条里的账户下拉拿不到就空着，靠后端 400 兜底
  }
}

const columns = [
  { dataIndex: 'id', key: 'id', title: '编号', width: 150 },
  { dataIndex: 'date', key: 'date', title: '日期', width: 105 },
  { key: 'type', title: '类型', width: 80 },
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
    width: 90,
    ellipsis: true,
  },
  {
    dataIndex: 'amount',
    key: 'amount',
    title: '金额(元)',
    align: 'right' as const,
    width: 100,
  },
  {
    dataIndex: 'paid_amount',
    key: 'paid',
    title: '已收付(元)',
    align: 'right' as const,
    width: 100,
  },
  { key: 'status', title: '状态', width: 95 },
  { dataIndex: 'due_date', key: 'due', title: '到期日', width: 105 },
  { key: 'actions', title: '操作', width: 240 },
];

let pendingTimer: number | undefined;
onMounted(() => {
  loadAccounts();
  applyDeepLink();
  loadPending();
  // 台账横幅跟手：对话框里确认/拒绝后长挂页面也能收敛（对抗审查 P2-6）
  pendingTimer = window.setInterval(loadPending, 30_000);
});

// 页面已开着又收到新深链（如工作台/待办跳过来）：重新预定位
watch(
  () => route.query,
  (q, old) => {
    if (
      route.path === '/finance/ledger' &&
      JSON.stringify(q) !== JSON.stringify(old)
    )
      applyDeepLink();
  },
);

onBeforeUnmount(() => {
  if (pendingTimer !== undefined) window.clearInterval(pendingTimer);
});
</script>

<template>
  <div class="p-4">
    <div
      v-if="pendingCount > 0"
      class="mb-3 flex items-center gap-2 rounded border border-orange-300 bg-orange-50 px-3 py-2 text-sm"
    >
      <span>有 <b>{{ pendingCount }}</b> 笔待确认记账，确认后才入账</span>
      <Button
        size="small"
        type="primary"
        @click="router.push('/finance/proposals')"
      >
        去处理
      </Button>
    </div>

    <div class="mb-3 flex flex-wrap items-center gap-2">
      <Select
        v-model:value="filters.type"
        :options="TYPE_VALUES.map((v) => ({ label: TYPE_LABELS[v], value: v }))"
        allow-clear
        class="w-28"
        placeholder="类型"
      />
      <Select
        v-model:value="filters.status"
        :options="
          STATUS_VALUES.map((v) => ({ label: STATUS_LABELS[v], value: v }))
        "
        allow-clear
        class="w-28"
        placeholder="状态"
      />
      <DatePicker
        v-model:value="filters.month"
        :allow-clear="true"
        picker="month"
        placeholder="月份"
        value-format="YYYY-MM"
      />
      <Select
        v-model:value="filters.account"
        :options="accounts.map((a) => ({ label: a.name, value: a.name }))"
        allow-clear
        class="w-32"
        placeholder="账户"
        @dropdown-visible-change="(v: boolean) => v && loadAccounts()"
      />
      <Input
        v-model:value="filters.counterparty"
        allow-clear
        class="w-44"
        placeholder="对方（模糊）"
        @press-enter="load"
      />
      <Button
        :type="outstandingOnly ? 'primary' : 'default'"
        ghost
        @click="
          outstandingOnly = !outstandingOnly;
          load();
        "
      >
        只看未结清
      </Button>
      <Button type="primary" @click="load">查询</Button>
      <Button @click="resetFilters">重置</Button>
      <div class="flex-1"></div>
      <Button v-if="canWrite" @click="importOpen = true">导入流水</Button>
      <!-- 点击触发：工具栏悬停菜单容易误开，点一下才弹；click 处理器必须在 Menu 上（Dropdown 自身不发 click 事件，挂在它上菜单项永远没反应） -->
      <Dropdown :trigger="['click']">
        <Button>
          报表与归档
          <span class="ml-1">▾</span>
        </Button>
        <template #overlay>
          <Menu @click="onReportMenu">
            <Menu.Item key="statement">往来对账单（按对方）</Menu.Item>
            <Menu.Item key="pack">检查应答包（专管员/代账要数）</Menu.Item>
            <Menu.Item key="archive">年度归档导出（JSON+哈希清单）</Menu.Item>
          </Menu>
        </template>
      </Dropdown>
      <Button v-if="canWrite" @click="openPeriods">月份结账</Button>
      <Button v-if="canWrite" type="primary" @click="openCreate">记一笔</Button>
    </div>

    <div
      v-if="selectedIds.length > 0"
      class="mb-3 flex flex-wrap items-center gap-2 rounded border border-blue-200 bg-blue-50 px-3 py-2 text-sm"
    >
      <span>已选 <b>{{ selectedIds.length }}</b> 笔，只改下面填了的字段：</span>
      <Select
        v-model:value="batch.status"
        :options="
          STATUS_VALUES.map((v) => ({ label: STATUS_LABELS[v], value: v }))
        "
        allow-clear
        class="w-32"
        placeholder="改状态"
        size="small"
      />
      <Select
        v-model:value="batch.account"
        :options="accounts.map((a) => ({ label: a.name, value: a.name }))"
        allow-clear
        class="w-32"
        placeholder="改账户"
        size="small"
        @dropdown-visible-change="(v: boolean) => v && loadAccounts()"
      />
      <Input
        v-model:value="batch.category"
        allow-clear
        class="w-32"
        placeholder="改分类"
        size="small"
      />
      <Button
        :disabled="!batchFieldFilled"
        :loading="batch.busy"
        size="small"
        type="primary"
        @click="applyBatch"
      >
        应用
      </Button>
      <Button size="small" @click="selectedIds = []">取消选择</Button>
    </div>

    <Table
      :columns="columns"
      :data-source="records"
      :loading="loading"
      :pagination="{
        current: pagination.current,
        pageSize: pagination.pageSize,
        total: pagination.total,
        showSizeChanger: false,
        onChange: (p: number) => (pagination.current = p),
      }"
      :row-selection="
        canWrite
          ? {
              selectedRowKeys: selectedIds,
              getCheckboxProps: (r: EntryRecord) => ({
                disabled:
                  Boolean(r.reverses || r.reversed_by) ||
                  r.status === 'cancelled',
              }),
              onChange: (keys: any[]) => (selectedIds = keys.map(String)),
            }
          : undefined
      "
      :scroll="{ x: 1100 }"
      :row-class-name="
        (r: EntryRecord) => (r.id === highlightId ? 'row-highlight' : '')
      "
      row-key="id"
      size="small"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'type'">
          {{
            TYPE_LABELS[(record as EntryRecord).type] ??
            (record as EntryRecord).type
          }}
        </template>
        <template v-else-if="column.key === 'status'">
          <Tag :color="ENTRY_STATUS_COLORS[(record as EntryRecord).status]">
            {{ STATUS_LABELS[(record as EntryRecord).status] }}
          </Tag>
        </template>
        <template v-else-if="column.key === 'actions'">
          <Button
            size="small"
            type="link"
            @click="openDetail(record as EntryRecord)"
          >
            详情
          </Button>
          <Button
            v-if="
              canWrite &&
              !(record as EntryRecord).reverses &&
              !(record as EntryRecord).reversed_by
            "
            size="small"
            type="link"
            @click="openEdit(record as EntryRecord)"
          >
            编辑
          </Button>
          <Button
            v-if="
              canWrite &&
              (record as EntryRecord).status !== 'cancelled' &&
              !(record as EntryRecord).reverses &&
              !(record as EntryRecord).reversed_by
            "
            size="small"
            type="link"
            @click="voidEntry(record as EntryRecord)"
          >
            作废
          </Button>
          <Button
            v-if="
              canWrite &&
              !(record as EntryRecord).reverses &&
              !(record as EntryRecord).reversed_by
            "
            size="small"
            type="link"
            @click="
              reversing.open = true;
              reversing.record = record as EntryRecord;
            "
          >
            冲销
          </Button>
          <Button
            v-if="canManage"
            danger
            size="small"
            type="link"
            @click="
              deleting.open = true;
              deleting.record = record as EntryRecord;
            "
          >
            删除
          </Button>
        </template>
      </template>
    </Table>

    <EntryFormModal
      v-model:open="formOpen"
      :record="editing.record"
      @saved="load"
    />
    <!-- 抽屉里挂联/传附件会改证据现状，关掉后列表随之刷新 -->
    <EntryDetailDrawer
      v-model:open="detail.open"
      :record="detail.record"
      @changed="load"
    />
    <ImportModal v-model:open="importOpen" @imported="load" />
    <StatementModal v-model:open="statementOpen" />
    <PackModal v-model:open="packOpen" />
    <ArchiveModal v-model:open="archiveOpen" />

    <Modal
      :confirm-loading="deleting.busy"
      :open="deleting.open"
      ok-text="删除"
      ok-type="danger"
      title="软删除这笔账？"
      @cancel="deleting.open = false"
      @ok="confirmDelete"
    >
      <p class="mb-2">
        删除 <b>{{ deleting.record?.id }}</b>：不进统计、编号不复用；这是误录兜底，日常纠错请用「作废」。
      </p>
      <Textarea
        v-model:value="deleting.reason"
        :rows="2"
        placeholder="删除原因（选填）"
      />
    </Modal>

    <Modal
      :confirm-loading="reversing.busy"
      :open="reversing.open"
      ok-text="冲销"
      title="冲销这笔账？"
      @cancel="reversing.open = false"
      @ok="confirmReverse"
    >
      <p class="mb-2">
        冲销 <b>{{ reversing.record?.id }}</b>：保留原账不动，新增一条全额反向账目相抵，两边都留痕。已锁定结账（给过代账/申报）的月份只能用冲销修正。
      </p>
      <Textarea
        v-model:value="reversing.reason"
        :rows="2"
        placeholder="冲销原因（建议填写，如：金额录错）"
      />
    </Modal>

    <Modal
      :footer="null"
      :open="periodsOpen"
      title="月份结账"
      @cancel="periodsOpen = false"
    >
      <p class="mb-3 text-sm text-gray-500">
        给代账/报过数的月份在这里锁定结账：整月账目随即冻结（禁改禁删禁补录），只许冲销。
        标错了可撤销（需管理员权限）。
      </p>
      <div class="mb-3 flex items-center gap-2 rounded border px-3 py-2">
        <span class="text-sm">{{ currentMonth() }}（本月）</span>
        <Tag v-if="periods.some((m) => m.month === currentMonth())" color="red">
          已锁定结账
        </Tag>
        <div class="flex-1"></div>
        <Button
          v-if="canWrite && !periods.some((m) => m.month === currentMonth())"
          :loading="periodsBusy"
          size="small"
          @click="toggleMonthReport(currentMonth(), false)"
        >
          锁定本月结账
        </Button>
        <Button
          v-else-if="canManage"
          :loading="periodsBusy"
          danger
          size="small"
          @click="toggleMonthReport(currentMonth(), true)"
        >
          解除锁定
        </Button>
      </div>
      <div
        v-for="m in periods"
        :key="m.month"
        class="mb-2 flex items-center gap-2 border-b pb-2 text-sm"
      >
        <b>{{ m.month }}</b>
        <span class="text-gray-400">{{ m.reported_by }} · {{ m.reported_at }}</span>
        <div class="flex-1"></div>
        <Button
          v-if="canManage"
          :loading="periodsBusy"
          size="small"
          @click="toggleMonthReport(m.month, true)"
        >
          解除锁定
        </Button>
      </div>
      <div v-if="periods.length === 0" class="text-sm text-gray-400">
        还没有任何月份被锁定结账
      </div>
      <div v-if="!canManage" class="mt-2 text-xs text-gray-400">
        解除锁定需要管理员权限；标错了找管理员处理。
      </div>
    </Modal>
  </div>
</template>

<style scoped>
:deep(tr.row-highlight > td) {
  background-color: rgb(250 173 20 / 15%);
}
</style>

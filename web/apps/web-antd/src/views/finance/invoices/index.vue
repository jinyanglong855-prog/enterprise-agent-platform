<script lang="ts" setup>
import type {
  EntryType,
  EvidenceChecklist,
  InvoiceOutputSummary,
  InvoiceQuota,
  InvoiceRecord,
} from '#/api/finance';

import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { useAccess } from '@vben/access';

import {
  Button,
  Input,
  InputNumber,
  message,
  Modal,
  Select,
  Table,
  Tabs,
  Tag,
} from 'ant-design-vue';

import {
  evidenceChecklistApi,
  getInvoiceQuotaApi,
  INVOICE_KIND_LABELS,
  INVOICE_STATUS_LABELS,
  invoiceOutputSummaryApi,
  listInvoicesApi,
  listMissingInvoicesApi,
  setInvoiceQuotaApi,
  TYPE_LABELS,
} from '#/api/finance';
import { INVOICE_STATUS_COLORS } from '#/constants/labels';
import { ledgerLink } from '#/utils/entity-links';

import InvoiceDetailDrawer from './invoice-detail-drawer.vue';
import InvoiceFormModal from './invoice-form-modal.vue';

const route = useRoute();
const router = useRouter();
const { hasAccessByCodes } = useAccess();
const canWrite = hasAccessByCodes(['finance:write']);

const KIND_OPTIONS = [
  { label: '全部方向', value: '' },
  ...Object.entries(INVOICE_KIND_LABELS).map(([value, label]) => ({
    label,
    value,
  })),
];
const STATUS_OPTIONS = [
  { label: '全部状态', value: '' },
  ...Object.entries(INVOICE_STATUS_LABELS).map(([value, label]) => ({
    label,
    value,
  })),
];

const KIND_COLORS: Record<string, string> = {
  internal: 'default',
  purchase: 'green',
  sales: 'blue',
};

const activeTab = ref('wallet');

// ---------------- 票夹列表 ----------------
const loading = ref(false);
const invoices = ref<InvoiceRecord[]>([]);
const invoicesTotal = ref(0);
const filters = reactive<{
  counterparty: string;
  kind: string;
  month: string;
  number: string;
  status: string;
}>({
  counterparty: '',
  kind: '',
  month: '',
  number: '',
  status: '',
});
/** 深链 ?no= 命中的票：高亮并开详情。 */
const highlightId = ref('');

async function load() {
  loading.value = true;
  try {
    const body = await listInvoicesApi({
      counterparty: filters.counterparty.trim() || undefined,
      kind: filters.kind || undefined,
      limit: 200,
      month: filters.month.trim() || undefined,
      number: filters.number.trim() || undefined,
      status: filters.status || undefined,
    });
    invoices.value = body.invoices;
    invoicesTotal.value = body.total;
    // 深链票号定位：精确匹配到一张就开抽屉
    if (filters.number.trim() !== '' && body.invoices.length > 0) {
      const hit = body.invoices[0]!;
      highlightId.value = hit.id;
      openDetail(hit);
    } else if (filters.number.trim() !== '' && body.invoices.length === 0) {
      message.warning(`票夹里没有票号 ${filters.number.trim()} 的票`);
    }
  } catch (error) {
    console.error('加载失败', error); // 拦截器已弹后端文案，这里只记日志
  } finally {
    loading.value = false;
  }
}

// ---------------- 数电票额度（手工抄入的参考跟踪，A5 残余最小形态） ----------------
const quota = ref<InvoiceQuota | undefined>(undefined);
const quotaModalOpen = ref(false);
const quotaForm = reactive({ as_of: '', quota_total: 0, quota_used: 0 });

const quotaBannerClass = computed(() => {
  const base =
    'mb-3 flex flex-wrap items-center gap-3 rounded border px-3 py-2 text-sm';
  if (!quota.value?.configured)
    return `${base} border-gray-200 bg-gray-50 text-gray-500`;
  return quota.value.warn
    ? `${base} border-red-300 bg-red-50 text-red-700`
    : `${base} border-gray-200 text-gray-700`;
});

async function loadQuota() {
  try {
    quota.value = await getInvoiceQuotaApi();
  } catch (error) {
    console.error('额度加载失败', error);
  }
}

function openQuotaModal() {
  quotaForm.quota_total = quota.value?.quota_total ?? 0;
  quotaForm.quota_used = quota.value?.quota_used ?? 0;
  quotaForm.as_of = quota.value?.as_of || today();
  quotaModalOpen.value = true;
}

async function saveQuota() {
  try {
    quota.value = await setInvoiceQuotaApi({
      as_of: quotaForm.as_of.trim() || undefined,
      quota_total: quotaForm.quota_total,
      quota_used: quotaForm.quota_used,
    });
    message.success('额度已抄入（参考数，以电子税务局实时为准）');
    quotaModalOpen.value = false;
  } catch (error) {
    console.error('额度保存失败', error); // 拦截器已弹后端文案
  }
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------------- 建票 / 编辑 / 详情 ----------------
const formOpen = ref(false);
const editing = ref<InvoiceRecord | undefined>(undefined);
const drawerOpen = ref(false);
const detail = ref<InvoiceRecord | undefined>(undefined);

function openCreate() {
  editing.value = undefined;
  formOpen.value = true;
}

function openEdit(record: InvoiceRecord) {
  editing.value = record;
  formOpen.value = true;
}

function openDetail(record: InvoiceRecord) {
  detail.value = record;
  drawerOpen.value = true;
}

/** 抽屉里挂联/解挂后：用服务端返回的新票对象替换 detail（抽屉随之刷新），同时刷新列表的挂联计数；
 *  挂联会让账目从缺票清单消失（解挂则回来），所以缺票清单一并刷新。 */
function onInvoiceChanged(rec: InvoiceRecord) {
  detail.value = rec;
  void load();
  void loadMissing();
}

/** 切到缺票清单/凭证对照/销项汇总时重新拉：票夹那边登记/挂联/台账补票号都会改变它们，不能用挂载时那份。 */
function onTabChange(key: number | string) {
  if (key === 'missing') void loadMissing();
  if (key === 'evidence') void loadEvidence();
  if (key === 'output') void loadOutput();
}

// ---------------- 销项汇总（义务维：开出去的票按月计税参考） ----------------
const outputLoading = ref(false);
const output = ref<InvoiceOutputSummary | undefined>(undefined);
const outputYear = ref('');

async function loadOutput() {
  outputLoading.value = true;
  try {
    output.value = await invoiceOutputSummaryApi(
      outputYear.value.trim() || undefined,
    );
  } catch (error) {
    console.error('销项汇总加载失败', error); // 拦截器已弹后端文案
  } finally {
    outputLoading.value = false;
  }
}

function currentYear(): string {
  return String(new Date().getFullYear());
}

// ---------------- 缺票清单 ----------------
const missingLoading = ref(false);
const missing = ref<
  {
    amount: number;
    category: string;
    counterparty: string;
    date: string;
    id: string;
    note: string;
    paid_amount: number;
    type: string;
  }[]
>([]);
const missingTotal = ref(0);
const missingMonth = ref('');

async function loadMissing() {
  missingLoading.value = true;
  try {
    const body = await listMissingInvoicesApi({
      limit: 200,
      month: missingMonth.value.trim() || undefined,
    });
    missing.value = body.entries;
    missingTotal.value = body.total;
  } catch (error) {
    console.error('加载失败', error); // 拦截器已弹后端文案，这里只记日志
  } finally {
    missingLoading.value = false;
  }
}

// ---------------- 凭证对照清单（C4：当月每笔账的三路证据现状） ----------------
const evidenceLoading = ref(false);
const evidence = ref<EvidenceChecklist | undefined>(undefined);
const evidenceMonth = ref('');

async function loadEvidence() {
  evidenceLoading.value = true;
  try {
    evidence.value = await evidenceChecklistApi(
      evidenceMonth.value.trim() || undefined,
    );
  } catch (error) {
    console.error('凭证对照加载失败', error); // 拦截器已弹后端文案，这里只记日志
  } finally {
    evidenceLoading.value = false;
  }
}

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

const invoiceColumns = [
  { dataIndex: 'id', key: 'id', title: '编号', width: 170 },
  { key: 'kind', title: '方向', width: 90 },
  { dataIndex: 'number', key: 'number', title: '票号', ellipsis: true },
  { dataIndex: 'date', key: 'date', title: '开票日期', width: 110 },
  {
    dataIndex: 'amount',
    key: 'amount',
    title: '票面金额(元)',
    align: 'right' as const,
    width: 120,
  },
  {
    dataIndex: 'counterparty',
    key: 'counterparty',
    title: '对方单位',
    ellipsis: true,
  },
  { key: 'status', title: '状态', width: 90 },
  { key: 'entries', title: '关联', width: 70 },
  { key: 'actions', title: '操作', width: 130 },
];

const missingColumns = [
  { dataIndex: 'id', key: 'id', title: '账目编号', width: 170 },
  { dataIndex: 'date', key: 'date', title: '日期', width: 110 },
  { dataIndex: 'type', title: '类型', width: 80 },
  {
    dataIndex: 'amount',
    key: 'amount',
    title: '金额(元)',
    align: 'right' as const,
    width: 110,
  },
  {
    dataIndex: 'counterparty',
    key: 'counterparty',
    title: '对方',
    ellipsis: true,
  },
  { dataIndex: 'category', key: 'category', title: '分类', width: 110 },
  { dataIndex: 'note', key: 'note', title: '备注', ellipsis: true },
];

const outputColumns = [
  { dataIndex: 'month', key: 'month', title: '月份', width: 110 },
  {
    dataIndex: 'issued',
    key: 'issued',
    title: '开票(元)',
    align: 'right' as const,
  },
  {
    dataIndex: 'red',
    key: 'red',
    title: '红冲冲减(元)',
    align: 'right' as const,
  },
  { key: 'net', title: '净计税参考(元)', align: 'right' as const },
  { key: 'memo', title: '口径备注', width: 200 },
];

const evidenceColumns = [
  { dataIndex: 'id', key: 'id', title: '账目编号', width: 160 },
  { dataIndex: 'date', key: 'date', title: '日期', width: 100 },
  { key: 'type', title: '类型', width: 70 },
  {
    dataIndex: 'amount',
    key: 'amount',
    title: '金额(元)',
    align: 'right' as const,
    width: 100,
  },
  {
    dataIndex: 'counterparty',
    key: 'counterparty',
    title: '对方',
    ellipsis: true,
  },
  { key: 'evidence', title: '证据现状', width: 200 },
  { key: 'voucher', title: '凭证', width: 90 },
];

/** 深链预定位（/finance/invoices?tab=&month=&no=）：tab 切页、month 预填（缺票清单也吃）、no 按票号精确过滤开抽屉。 */
function applyDeepLink() {
  const q = route.query;
  const tab =
    typeof q.tab === 'string' &&
    ['evidence', 'missing', 'output', 'wallet'].includes(q.tab)
      ? q.tab
      : 'wallet';
  activeTab.value = tab;
  const month =
    typeof q.month === 'string' && /^\d{4}-\d{2}$/.test(q.month) ? q.month : '';
  const no = typeof q.no === 'string' ? q.no.trim() : '';
  if (tab === 'missing') {
    missingMonth.value = month;
    void loadMissing();
  } else if (tab === 'evidence') {
    evidenceMonth.value = month;
    void loadEvidence();
  } else {
    filters.month = month;
    filters.number = no;
    void load();
  }
}

onMounted(() => {
  applyDeepLink();
  loadQuota();
});

// 页签 keep-alive：页面已开着又从台账抽屉/待办跳过来时 onMounted 不会再跑，靠 query 变化重新定位
watch(
  () => route.query,
  (q, old) => {
    if (
      route.path === '/finance/invoices' &&
      JSON.stringify(q) !== JSON.stringify(old)
    )
      applyDeepLink();
  },
);
</script>

<template>
  <div class="p-4">
    <Tabs v-model:active-key="activeTab" @change="onTabChange">
      <Tabs.TabPane key="wallet" tab="票夹">
        <div class="mb-3 text-sm text-gray-500">
          票是收付款的证据：销项=开出去的票，进项=收进来的票，内部凭证=工资单/银行回单等。
          票与账目关联形成证据链；方向与票面金额登记后不可改，记错就作废重录。
        </div>
        <div :class="quotaBannerClass">
          <span v-if="quota?.configured">
            数电票额度（抄入于 {{ quota.as_of }}）：总额度
            {{ quota.quota_total.toLocaleString() }} 元 · 已用
            {{ quota.quota_used.toLocaleString() }} 元 · 剩余
            <b>{{ quota.remaining.toLocaleString() }}</b> 元<template
              v-if="quota.warn"
            >
              （不足两成，该去电子税务局申请调额或放缓开票节奏了）</template
            >
            · 票夹当月开票
            {{ quota.month_sales.toLocaleString() }} 元（自动算，对照抄入数用）
          </span>
          <span v-else
            >数电票额度未抄入——把电子税务局里的总额度/已用抄进来即可跟踪剩余，低了会亮警示（参考数）。</span
          >
          <Button v-if="canWrite" size="small" @click="openQuotaModal">
            设置额度
          </Button>
        </div>
        <div class="mb-3 flex flex-wrap items-center gap-2">
          <Select
            v-model:value="filters.kind"
            :options="KIND_OPTIONS"
            class="w-32"
          />
          <Select
            v-model:value="filters.status"
            :options="STATUS_OPTIONS"
            class="w-32"
          />
          <Input
            v-model:value="filters.counterparty"
            class="w-44"
            placeholder="对方单位，模糊"
            @press-enter="load"
          />
          <Input
            v-model:value="filters.month"
            class="w-36"
            placeholder="月份 YYYY-MM"
            @press-enter="load"
          />
          <Input
            v-model:value="filters.number"
            class="w-44"
            placeholder="票号，精确"
            @press-enter="load"
          />
          <Button @click="load">查询</Button>
          <Tag
            v-if="filters.number.trim() !== ''"
            closable
            @close="
              filters.number = '';
              load();
            "
          >
            票号 {{ filters.number }}
          </Tag>
          <div class="flex-1"></div>
          <span class="text-sm text-gray-500">共 {{ invoicesTotal }} 张</span>
          <span
            v-if="invoicesTotal > invoices.length"
            class="text-sm text-orange-500"
          >
            只显示最新
            {{ invoices.length }} 张——加筛选（方向/状态/月份/对方）缩小范围
          </span>
          <Button v-if="canWrite" type="primary" @click="openCreate">
            登记票
          </Button>
        </div>

        <Table
          :columns="invoiceColumns"
          :data-source="invoices"
          :loading="loading"
          :pagination="{ pageSize: 20, showSizeChanger: false }"
          :row-class-name="
            (r: InvoiceRecord) => (r.id === highlightId ? 'row-highlight' : '')
          "
          row-key="id"
          size="small"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'kind'">
              <Tag
                :color="
                  KIND_COLORS[(record as InvoiceRecord).kind] ?? 'default'
                "
              >
                {{
                  INVOICE_KIND_LABELS[(record as InvoiceRecord).kind] ??
                  (record as InvoiceRecord).kind
                }}
              </Tag>
            </template>
            <template v-else-if="column.key === 'status'">
              <Tag
                :color="
                  INVOICE_STATUS_COLORS[(record as InvoiceRecord).status] ??
                  'default'
                "
              >
                {{
                  INVOICE_STATUS_LABELS[(record as InvoiceRecord).status] ??
                  (record as InvoiceRecord).status
                }}
              </Tag>
            </template>
            <template v-else-if="column.key === 'entries'">
              {{ (record as InvoiceRecord).entry_ids.length }}
            </template>
            <template v-else-if="column.key === 'actions'">
              <Button
                size="small"
                type="link"
                @click="openDetail(record as InvoiceRecord)"
              >
                详情
              </Button>
              <Button
                v-if="canWrite"
                size="small"
                type="link"
                @click="openEdit(record as InvoiceRecord)"
              >
                编辑
              </Button>
            </template>
          </template>
        </Table>
      </Tabs.TabPane>

      <Tabs.TabPane key="missing" tab="缺票清单">
        <div class="mb-3 text-sm text-gray-500">
          下面是还没见到票的支出/报销（既没关联"在手"的发票，也没填票号；已作废/已红冲的票不算证据）。
          补上票后在票夹登记并关联，或直接在台账里补票号；工资、税费不是发票，不在这里催。
        </div>
        <div class="mb-3 flex flex-wrap items-center gap-2">
          <Input
            v-model:value="missingMonth"
            class="w-36"
            placeholder="月份 YYYY-MM，空=全部"
            @press-enter="loadMissing"
          />
          <Button @click="loadMissing">查询</Button>
          <span class="text-sm text-gray-500">共 {{ missingTotal }} 笔</span>
          <span
            v-if="missingTotal > missing.length"
            class="text-sm text-orange-500"
          >
            只显示最早的 {{ missing.length }} 笔，按月份筛选看其余
          </span>
        </div>
        <Table
          :columns="missingColumns"
          :data-source="missing"
          :loading="missingLoading"
          :pagination="{ pageSize: 20, showSizeChanger: false }"
          row-key="id"
          size="small"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'id'">
              <Button
                size="small"
                type="link"
                @click="
                  router.push(ledgerLink({ id: (record as { id: string }).id }))
                "
              >
                {{ (record as { id: string }).id }}
              </Button>
            </template>
            <template v-else-if="column.key === 'type'">
              {{
                TYPE_LABELS[(record as { type: EntryType }).type] ??
                (record as { type: string }).type
              }}
            </template>
          </template>
        </Table>
      </Tabs.TabPane>

      <Tabs.TabPane key="evidence" tab="凭证对照">
        <div class="mb-3 text-sm text-gray-500">
          当月每笔账的证据现状：票号/关联的票、附件、银行流水配对三路都有数。
          "缺票"只作提示不拦账（凭证齐=有票或有附件其一）；按"整理一张补一张"来，
          附件在台账详情传，票在这里登记关联。
        </div>
        <div class="mb-3 flex flex-wrap items-center gap-2">
          <Input
            v-model:value="evidenceMonth"
            class="w-36"
            :placeholder="`月份 YYYY-MM，空=${currentMonth()}`"
            @press-enter="loadEvidence"
          />
          <Button @click="loadEvidence">查询</Button>
          <template v-if="evidence">
            <span class="text-sm text-gray-500">
              共 {{ evidence.count }} 笔；凭证齐
              {{ evidence.with_voucher }} 笔、缺
              {{ evidence.missing_voucher }} 笔；已与银行对上
              {{ evidence.bank_matched }} 笔
            </span>
          </template>
        </div>
        <div
          v-if="evidence"
          class="mb-3 whitespace-pre-wrap rounded border border-gray-200 px-3 py-2 text-sm leading-6"
        >
          {{ evidence.hint }}
        </div>
        <Table
          :columns="evidenceColumns"
          :data-source="evidence?.entries ?? []"
          :loading="evidenceLoading"
          :pagination="{ pageSize: 20, showSizeChanger: false }"
          row-key="id"
          size="small"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'id'">
              <Button
                size="small"
                type="link"
                @click="
                  router.push(ledgerLink({ id: (record as { id: string }).id }))
                "
              >
                {{ (record as { id: string }).id }}
              </Button>
            </template>
            <template v-else-if="column.key === 'type'">
              {{
                TYPE_LABELS[(record as { type: EntryType }).type] ??
                (record as { type: string }).type
              }}
            </template>
            <template v-else-if="column.key === 'evidence'">
              <div class="text-xs leading-5">
                <div>
                  票号
                  {{
                    (record as EvidenceChecklist['entries'][number]).evidence
                      .invoice_no || '—'
                  }}
                  · 挂票
                  {{
                    (record as EvidenceChecklist['entries'][number]).evidence
                      .linked_held_invoices
                  }}
                  · 附件
                  {{
                    (record as EvidenceChecklist['entries'][number]).evidence
                      .attachments
                  }}
                  · 银行
                  {{
                    (record as EvidenceChecklist['entries'][number]).evidence
                      .bank_matches
                  }}
                </div>
                <div
                  v-if="
                    (record as EvidenceChecklist['entries'][number]).missing
                      .length > 0
                  "
                >
                  <Tag
                    v-for="m in (record as EvidenceChecklist['entries'][number])
                      .missing"
                    :key="m"
                    color="orange"
                  >
                    缺{{ m }}
                  </Tag>
                </div>
              </div>
            </template>
            <template v-else-if="column.key === 'voucher'">
              <Tag
                :color="
                  (record as EvidenceChecklist['entries'][number]).voucher_ok
                    ? 'green'
                    : 'orange'
                "
              >
                {{
                  (record as EvidenceChecklist['entries'][number]).voucher_ok
                    ? '齐'
                    : '缺'
                }}
              </Tag>
            </template>
          </template>
        </Table>
      </Tabs.TabPane>
      <Tabs.TabPane key="output" tab="销项汇总">
        <div class="mb-3 text-sm text-gray-500">
          开出去的票按月汇总（计税参考口径）：开票=在手销项票按票期；红冲按红冲执行日冲减执行当月。
          备料非核算——申报数以电子税务局为准，这里帮你看开票节奏和规模。
        </div>
        <div class="mb-3 flex flex-wrap items-center gap-2">
          <Input
            v-model:value="outputYear"
            class="w-36"
            :placeholder="`年份 YYYY，空=${currentYear()}`"
            @press-enter="loadOutput"
          />
          <Button @click="loadOutput">查询</Button>
          <template v-if="output">
            <span class="text-sm text-gray-500">
              {{ output.year }} 年合计：开票
              {{ output.total.issued.toLocaleString() }} 元 · 红冲冲减
              {{ output.total.red.toLocaleString() }} 元 · 净
              {{ output.total.net.toLocaleString() }} 元
            </span>
          </template>
        </div>
        <Table
          :columns="outputColumns"
          :data-source="output?.rows ?? []"
          :loading="outputLoading"
          :pagination="false"
          row-key="month"
          size="small"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'net'">
              <span
                :class="
                  (record as InvoiceOutputSummary['rows'][number]).net < 0
                    ? 'text-red-600'
                    : ''
                "
              >
                {{
                  (
                    record as InvoiceOutputSummary['rows'][number]
                  ).net.toLocaleString()
                }}
              </span>
            </template>
            <template v-else-if="column.key === 'memo'">
              <Tag
                v-if="
                  (record as InvoiceOutputSummary['rows'][number]).legacy_red
                "
                color="orange"
              >
                含老红票按票期估算
              </Tag>
            </template>
          </template>
        </Table>
        <div
          v-if="output"
          class="mt-3 whitespace-pre-wrap rounded border border-gray-200 px-3 py-2 text-xs leading-5 text-gray-500"
        >
          {{ output.note }}
        </div>
      </Tabs.TabPane>
    </Tabs>

    <Modal
      v-model:open="quotaModalOpen"
      cancel-text="取消"
      ok-text="抄入"
      title="抄入数电票额度（来自电子税务局）"
      @ok="saveQuota"
    >
      <div class="space-y-3 pt-2">
        <div class="text-xs leading-5 text-gray-500">
          {{
            quota?.note ??
            '额度以电子税务局实时为准，这里只是手工抄入的参考跟踪。'
          }}
        </div>
        <div class="flex items-center gap-2">
          <span class="w-24 text-right">总额度(元)</span>
          <InputNumber
            v-model:value="quotaForm.quota_total"
            class="flex-1"
            :min="0"
          />
        </div>
        <div class="flex items-center gap-2">
          <span class="w-24 text-right">已用(元)</span>
          <InputNumber
            v-model:value="quotaForm.quota_used"
            class="flex-1"
            :min="0"
          />
        </div>
        <div class="flex items-center gap-2">
          <span class="w-24 text-right">抄入日期</span>
          <Input
            v-model:value="quotaForm.as_of"
            class="flex-1"
            placeholder="YYYY-MM-DD"
          />
        </div>
      </div>
    </Modal>

    <InvoiceFormModal v-model:open="formOpen" :record="editing" @saved="load" />
    <InvoiceDetailDrawer
      v-model:open="drawerOpen"
      :record="detail"
      @changed="onInvoiceChanged"
    />
  </div>
</template>

<style scoped>
:deep(tr.row-highlight > td) {
  background-color: rgb(250 173 20 / 15%);
}
</style>

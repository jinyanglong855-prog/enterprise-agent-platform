<script lang="ts" setup>
import type { BankReport, ReconciliationReport } from '#/api/finance';

import { computed, ref, watch } from 'vue';

import {
  Button,
  Input,
  InputNumber,
  message,
  Modal,
  Popconfirm,
  Table,
  Tabs,
  Tag,
  Textarea,
} from 'ant-design-vue';

import {
  bankReportApi,
  deleteBankLineApi,
  importBankLinesApi,
  reconcilePreviewApi,
  setBankLineMatchApi,
  TYPE_LABELS,
} from '#/api/finance';

const props = defineProps<{
  account?: string;
  open: boolean;
}>();

const emit = defineEmits<{ 'update:open': [boolean] }>();

const activeTab = ref('balance');

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmt(n: number): string {
  return n.toLocaleString('zh-CN', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  });
}

// ---------------- Tab 1：余额对照（网银余额 vs 账面余额） ----------------

const asOf = ref('');
const statement = ref<number | undefined>(undefined);
const loading = ref(false);
const report = ref<ReconciliationReport | undefined>(undefined);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    asOf.value = localToday();
    statement.value = undefined;
    report.value = undefined;
    activeTab.value = 'balance';
    matchText.value = '';
    bankReport.value = undefined;
    matchFrom.value = '';
    matchTo.value = localToday();
  },
  { immediate: true },
);

async function run() {
  if (!props.account) return;
  if (asOf.value.trim() && !/^\d{4}-\d{2}-\d{2}$/.test(asOf.value.trim())) {
    return message.warning('截止日格式应为 YYYY-MM-DD（留空=今天）');
  }
  // InputNumber 清空后给的是 null（不是 undefined），两种都当没填
  if (statement.value == null || Number.isNaN(statement.value)) {
    return message.warning('请填对账单余额（网银/手机银行里截止日显示的余额）');
  }
  loading.value = true;
  try {
    report.value = await reconcilePreviewApi({
      account: props.account,
      as_of: asOf.value.trim() || undefined,
      statement_balance: statement.value,
    });
  } catch (error) {
    report.value = undefined;
    console.error('对账失败', error); // 拦截器已弹后端文案，这里只记日志
  } finally {
    loading.value = false;
  }
}

const diffClass = computed(() => {
  const d = report.value?.difference ?? 0;
  if (d === 0) return 'text-green-600';
  return 'text-red-600';
});

const diffLabel = computed(() => {
  const d = report.value?.difference ?? 0;
  if (d === 0) return '对上了';
  return d > 0 ? '账面比银行多' : '账面比银行少';
});

const flowColumns = [
  { dataIndex: 'date', key: 'date', title: '日期', width: 100 },
  { dataIndex: 'id', key: 'id', title: '编号', width: 160 },
  { key: 'type', title: '类型', width: 80 },
  { key: 'moved', title: '动钱(元)', align: 'right' as const, width: 110 },
  {
    dataIndex: 'counterparty',
    key: 'counterparty',
    title: '对方',
    ellipsis: true,
  },
  { dataIndex: 'note', key: 'note', title: '备注', ellipsis: true },
];

// ---------------- Tab 2：逐笔比对（银行流水行 vs 账本动钱流水） ----------------

const matchText = ref('');
const importing = ref(false);
const importResult = ref('');
const matchFrom = ref('');
const matchTo = ref(localToday());
const matchLoading = ref(false);
const bankReport = ref<BankReport | undefined>(undefined);
const pairingId = ref('');
const matchInput = ref<Record<number, string>>({});

async function doImport() {
  if (!props.account) return;
  if (matchText.value.trim() === '')
    return message.warning('先把网银导出的流水粘进来（CSV，第一行列头）');
  importing.value = true;
  try {
    const r = await importBankLinesApi(props.account, matchText.value);
    importResult.value = `导入完成：新入 ${r.inserted} 行，跳过重复 ${r.skipped} 行（同一份对账单重复导入不会翻倍）。`;
    matchText.value = '';
    await runReport();
  } catch (error) {
    console.error('流水导入失败', error); // 拦截器已弹后端文案（列头/格式），这里只记日志
  } finally {
    importing.value = false;
  }
}

async function runReport() {
  if (!props.account) return;
  if (
    matchFrom.value.trim() &&
    !/^\d{4}-\d{2}-\d{2}$/.test(matchFrom.value.trim())
  ) {
    return message.warning('起始日格式应为 YYYY-MM-DD（留空=最早一笔流水）');
  }
  if (
    matchTo.value.trim() &&
    !/^\d{4}-\d{2}-\d{2}$/.test(matchTo.value.trim())
  ) {
    return message.warning('截止日格式应为 YYYY-MM-DD（留空=今天）');
  }
  matchLoading.value = true;
  try {
    bankReport.value = await bankReportApi({
      account: props.account,
      from: matchFrom.value.trim() || undefined,
      to: matchTo.value.trim() || undefined,
    });
  } catch (error) {
    bankReport.value = undefined;
    console.error('比对失败', error); // 拦截器已弹后端文案，这里只记日志
  } finally {
    matchLoading.value = false;
  }
}

/** 人工配对（允许金额不等——手续费/部分收付的场景），配完重跑报告。 */
async function pair(entryId: number) {
  const target = (matchInput.value[entryId] ?? '').trim();
  if (!target)
    return message.warning('先填这行对应的账目编号（FIN-YYYYMMDD-NNN）');
  pairingId.value = String(entryId);
  try {
    await setBankLineMatchApi(entryId, target);
    message.success(`已配对 #${entryId} ↔ ${target}`);
    matchInput.value = { ...matchInput.value, [entryId]: '' };
    await runReport();
  } catch (error) {
    console.error('配对失败', error); // 拦截器已弹后端文案，这里只记日志
  } finally {
    pairingId.value = '';
  }
}

async function unmatch(lineId: number) {
  try {
    await setBankLineMatchApi(lineId, '');
    message.success(`已解除 #${lineId} 的配对`);
    await runReport();
  } catch (error) {
    console.error('解除失败', error);
  }
}

async function dropLine(lineId: number) {
  try {
    await deleteBankLineApi(lineId);
    message.success(`已删流水行 #${lineId}（只删这行，不动账本）`);
    await runReport();
  } catch (error) {
    console.error('删行失败', error);
  }
}

const matchedColumns = [
  { dataIndex: 'date', key: 'date', title: '流水日', width: 95 },
  { key: 'flow', title: '流水（银行）', width: 150 },
  { key: 'arrow', title: '', width: 40 },
  { key: 'entry', title: '账目（账本）', width: 170 },
  { key: 'how', title: '怎么对的', width: 80 },
];

const lineColumns = [
  { dataIndex: 'date', key: 'date', title: '日期', width: 95 },
  { key: 'dir', title: '方向', width: 60 },
  {
    dataIndex: 'amount',
    key: 'amount',
    title: '金额(元)',
    align: 'right' as const,
    width: 95,
  },
  {
    dataIndex: 'counterparty',
    key: 'counterparty',
    title: '对方',
    ellipsis: true,
  },
  { dataIndex: 'ref', key: 'ref', title: '流水号', ellipsis: true, width: 120 },
  { key: 'actions', title: '', width: 220 },
];

const bookOnlyColumns = [
  { dataIndex: 'date', key: 'date', title: '日期', width: 95 },
  { dataIndex: 'entry_id', key: 'id', title: '编号', width: 160 },
  { key: 'type', title: '类型', width: 70 },
  { key: 'moved', title: '动钱(元)', align: 'right' as const, width: 95 },
  {
    dataIndex: 'counterparty',
    key: 'counterparty',
    title: '对方',
    ellipsis: true,
  },
];
</script>

<template>
  <Modal
    :footer="null"
    :open="open"
    :title="`银行对账 · ${account ?? ''}`"
    width="860"
    @cancel="emit('update:open', false)"
  >
    <Tabs v-model:active-key="activeTab">
      <Tabs.TabPane key="balance" tab="余额对照">
        <div class="mb-3 text-sm text-gray-500">
          打开网银/手机银行，看该账户截止某一天的余额，抄到下面；系统按同一天算账本上的余额，给出差额和该去核对什么。
          不接网银、不落库，想对几次对几次。
        </div>
        <div class="mb-4 flex flex-wrap items-end gap-3">
          <div>
            <div class="mb-1 text-sm text-gray-500">截止日（含，空=今天）</div>
            <Input
              v-model:value="asOf"
              class="w-40"
              placeholder="YYYY-MM-DD"
              @press-enter="run"
            />
          </div>
          <div>
            <div class="mb-1 text-sm text-gray-500">
              对账单余额（元，可为负）
            </div>
            <InputNumber
              v-model:value="statement"
              :precision="2"
              class="w-44"
              placeholder="网银显示的余额"
              @press-enter="run"
            />
          </div>
          <Button :loading="loading" type="primary" @click="run">
            生成对照
          </Button>
        </div>

        <template v-if="report">
          <div class="mb-3 grid grid-cols-3 gap-3">
            <div class="rounded border border-gray-200 p-3">
              <div class="text-xs text-gray-500">
                账面余额（截止 {{ report.as_of }}）
              </div>
              <div class="text-lg font-semibold">
                {{ fmt(report.book_balance) }}
              </div>
            </div>
            <div class="rounded border border-gray-200 p-3">
              <div class="text-xs text-gray-500">对账单余额</div>
              <div class="text-lg font-semibold">
                {{ fmt(report.statement_balance) }}
              </div>
            </div>
            <div class="rounded border border-gray-200 p-3">
              <div class="text-xs text-gray-500">差额（账面 − 银行）</div>
              <div class="text-lg font-semibold" :class="[diffClass]">
                {{ report.difference > 0 ? '+' : ''
                }}{{ fmt(report.difference) }}
                <span class="ml-1 text-xs font-normal">{{ diffLabel }}</span>
              </div>
            </div>
          </div>
          <div class="mb-3 flex items-center gap-2 text-xs text-gray-500">
            <span>今天账面余额 {{ fmt(report.book_balance_current) }} 元</span>
            <Tag v-if="report.account_archived" color="default">账户已停用</Tag>
          </div>
          <div
            class="mb-3 whitespace-pre-wrap rounded border border-gray-200 p-3 text-sm leading-6"
          >
            {{ report.hint }}
          </div>

          <template v-if="report.flows_after.length > 0">
            <div class="mb-2 text-sm font-medium text-gray-500">
              截止日之后已记账的流水（{{ report.flows_after.length }} 笔，净影响
              {{ report.net_after >= 0 ? '+' : ''
              }}{{ fmt(report.net_after) }} 元）——不参与本次对账
            </div>
            <Table
              :columns="flowColumns"
              :data-source="report.flows_after"
              :pagination="
                report.flows_after.length > 20
                  ? { pageSize: 20, showSizeChanger: false }
                  : false
              "
              row-key="id"
              size="small"
            >
              <template #bodyCell="{ column, record }">
                <template v-if="column.key === 'type'">
                  {{
                    TYPE_LABELS[
                      (record as ReconciliationReport['flows_after'][number])
                        .type as keyof typeof TYPE_LABELS
                    ] ?? (record as { type: string }).type
                  }}
                  <Tag
                    v-if="(record as { reverses: string }).reverses"
                    color="orange"
                  >
                    冲销
                  </Tag>
                </template>
                <template v-else-if="column.key === 'moved'">
                  <span
                    :class="
                      (record as { direction: string }).direction === 'in'
                        ? 'text-green-600'
                        : 'text-red-600'
                    "
                  >
                    {{
                      (record as { direction: string }).direction === 'in'
                        ? '+'
                        : '−'
                    }}{{ fmt((record as { moved: number }).moved) }}
                  </span>
                </template>
              </template>
            </Table>
          </template>
        </template>
      </Tabs.TabPane>

      <Tabs.TabPane key="lines" tab="逐笔比对">
        <div class="mb-3 text-sm text-gray-500">
          把网银导出的流水明细（CSV，列头：日期,方向,金额,对方,流水号,备注）粘进来导入本账户，
          系统与账本"动了钱的流水"逐笔比对，给出三张清单：对上的、银行有账本没有的、账本有银行没有的。
          比对只出清单不调平——银行有的要补记走正常记账，账本多的先确认是不是在途。
        </div>

        <div class="mb-3">
          <div class="mb-1 text-sm text-gray-500">
            流水粘贴区（第一行列头；金额恒正，方向写
            收入/支出/转入/转出；同一账户重复导入自动去重〔流水号+金额+日期+对方做指纹〕；自动配对按金额+方向+3
            天内日期贪心撮合〔流水号不参与撮合〕，同额多笔也会配上，配错了在清单里人工改）
          </div>
          <Textarea
            v-model:value="matchText"
            :rows="4"
            placeholder="日期,方向,金额,对方,流水号,备注&#10;2026-10-08,收入,12000.00,甬城科技,BK20261008001,10月货款&#10;2026-10-09,支出,368.50,顺丰速运,BK20261009002,快递费"
          />
          <div class="mt-2 flex items-center gap-3">
            <Button :loading="importing" type="primary" @click="doImport">
              导入流水
            </Button>
            <span v-if="importResult" class="text-sm text-green-600">{{
              importResult
            }}</span>
          </div>
        </div>

        <div class="mb-3 flex flex-wrap items-end gap-3">
          <div>
            <div class="mb-1 text-sm text-gray-500">起始日（空=最早一笔）</div>
            <Input
              v-model:value="matchFrom"
              class="w-40"
              placeholder="YYYY-MM-DD"
              @press-enter="runReport"
            />
          </div>
          <div>
            <div class="mb-1 text-sm text-gray-500">截止日（空=今天）</div>
            <Input
              v-model:value="matchTo"
              class="w-40"
              placeholder="YYYY-MM-DD"
              @press-enter="runReport"
            />
          </div>
          <Button :loading="matchLoading" @click="runReport">逐笔比对</Button>
        </div>

        <template v-if="bankReport">
          <div class="mb-3 grid grid-cols-4 gap-3">
            <div class="rounded border border-gray-200 p-3">
              <div class="text-xs text-gray-500">银行收入合计</div>
              <div class="text-lg font-semibold">
                {{ fmt(bankReport.totals.bank_in) }}
              </div>
              <div class="text-xs text-gray-400">
                账本 {{ fmt(bankReport.totals.book_in) }}
              </div>
            </div>
            <div class="rounded border border-gray-200 p-3">
              <div class="text-xs text-gray-500">银行支出合计</div>
              <div class="text-lg font-semibold">
                {{ fmt(bankReport.totals.bank_out) }}
              </div>
              <div class="text-xs text-gray-400">
                账本 {{ fmt(bankReport.totals.book_out) }}
              </div>
            </div>
            <div class="rounded border border-gray-200 p-3">
              <div class="text-xs text-gray-500">对上</div>
              <div class="text-lg font-semibold">
                {{ bankReport.totals.matched }}
                <span class="text-xs font-normal text-gray-400">人工{{ bankReport.totals.manual }}·自动{{
                    bankReport.totals.auto
                  }}</span>
              </div>
            </div>
            <div class="rounded border border-gray-200 p-3">
              <div class="text-xs text-gray-500">没对上</div>
              <div
                class="text-lg font-semibold"
                :class="
                  bankReport.bank_only.length + bankReport.book_only.length > 0
                    ? 'text-red-600'
                    : 'text-green-600'
                "
              >
                {{ bankReport.bank_only.length + bankReport.book_only.length }}
              </div>
              <div class="text-xs text-gray-400">
                银行多 {{ bankReport.bank_only.length }}·账本多
                {{ bankReport.book_only.length }}
              </div>
            </div>
          </div>
          <div
            class="mb-3 whitespace-pre-wrap rounded border border-gray-200 p-3 text-sm leading-6"
          >
            {{ bankReport.hint }}
          </div>

          <div class="mb-2 text-sm font-medium text-gray-500">
            对上的（{{ bankReport.matched.length }}）
          </div>
          <Table
            :columns="matchedColumns"
            :data-source="bankReport.matched"
            :pagination="
              bankReport.matched.length > 10
                ? { pageSize: 10, showSizeChanger: false }
                : false
            "
            row-key="entry_id"
            size="small"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'flow'">
                {{ (record as BankReport['matched'][number]).line.date }}
                <span
                  :class="
                    (record as BankReport['matched'][number]).line.direction ===
                    'in'
                      ? 'text-green-600'
                      : 'text-red-600'
                  "
                >
                  {{
                    (record as BankReport['matched'][number]).line.direction ===
                    'in'
                      ? '+'
                      : '−'
                  }}{{
                    fmt((record as BankReport['matched'][number]).line.amount)
                  }}
                </span>
              </template>
              <template v-else-if="column.key === 'arrow'">
                <span class="text-gray-300">→</span>
              </template>
              <template v-else-if="column.key === 'entry'">
                {{
                  (record as BankReport['matched'][number]).entry_id ||
                  '（账本窗口内没这笔）'
                }}
                <div
                  v-if="!(record as BankReport['matched'][number]).entry_id"
                  class="text-xs text-orange-500"
                >
                  人工配到过已被删/作废的账，建议解除重配
                </div>
              </template>
              <template v-else-if="column.key === 'how'">
                <Tag
                  :color="
                    (record as BankReport['matched'][number]).how === 'manual'
                      ? 'blue'
                      : 'default'
                  "
                >
                  {{
                    (record as BankReport['matched'][number]).how === 'manual'
                      ? '人工'
                      : '自动'
                  }}
                </Tag>
                <Popconfirm
                  v-if="
                    (record as BankReport['matched'][number]).how === 'manual'
                  "
                  title="解除这条人工配对？"
                  @confirm="
                    unmatch((record as BankReport['matched'][number]).line.id)
                  "
                >
                  <Button size="small" type="link">解除</Button>
                </Popconfirm>
              </template>
            </template>
          </Table>

          <div class="mt-4 mb-2 text-sm font-medium text-gray-500">
            银行有、账本没有（{{
              bankReport.bank_only.length
            }}）——最常见是手续费/利息/代扣还没记账；金额对得上只是日子差点的，也可以人工配到别的账
          </div>
          <Table
            :columns="lineColumns"
            :data-source="bankReport.bank_only"
            :pagination="
              bankReport.bank_only.length > 10
                ? { pageSize: 10, showSizeChanger: false }
                : false
            "
            row-key="id"
            size="small"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'dir'">
                <Tag
                  :color="
                    (record as BankReport['bank_only'][number]).direction ===
                    'in'
                      ? 'green'
                      : 'red'
                  "
                >
                  {{
                    (record as BankReport['bank_only'][number]).direction ===
                    'in'
                      ? '收'
                      : '支'
                  }}
                </Tag>
              </template>
              <template v-else-if="column.key === 'actions'">
                <div class="flex items-center gap-1">
                  <Input
                    v-model:value="
                      matchInput[(record as BankReport['bank_only'][number]).id]
                    "
                    class="w-40"
                    placeholder="配到的账目编号"
                    size="small"
                  />
                  <Button
                    :loading="
                      pairingId ===
                      String((record as BankReport['bank_only'][number]).id)
                    "
                    size="small"
                    type="link"
                    @click="
                      pair((record as BankReport['bank_only'][number]).id)
                    "
                  >
                    配对
                  </Button>
                  <Popconfirm
                    :title="`删除流水行 #${(record as BankReport['bank_only'][number]).id}？（导入错了用）`"
                    @confirm="
                      dropLine((record as BankReport['bank_only'][number]).id)
                    "
                  >
                    <Button danger size="small" type="link">删行</Button>
                  </Popconfirm>
                </div>
              </template>
            </template>
          </Table>

          <div class="mt-4 mb-2 text-sm font-medium text-gray-500">
            账本动了钱、银行没有（{{
              bankReport.book_only.length
            }}）——先确认是在途、记错账户还是漏导流水，别急着改账
          </div>
          <Table
            :columns="bookOnlyColumns"
            :data-source="bankReport.book_only"
            :pagination="
              bankReport.book_only.length > 10
                ? { pageSize: 10, showSizeChanger: false }
                : false
            "
            row-key="entry_id"
            size="small"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'type'">
                {{
                  TYPE_LABELS[
                    (record as BankReport['book_only'][number])
                      .type as keyof typeof TYPE_LABELS
                  ] ?? (record as { type: string }).type
                }}
                <Tag
                  v-if="(record as { reverses: string }).reverses"
                  color="orange"
                >
                  冲销
                </Tag>
              </template>
              <template v-else-if="column.key === 'moved'">
                <span
                  :class="
                    (record as BankReport['book_only'][number]).direction ===
                    'in'
                      ? 'text-green-600'
                      : 'text-red-600'
                  "
                >
                  {{
                    (record as BankReport['book_only'][number]).direction ===
                    'in'
                      ? '+'
                      : '−'
                  }}{{ fmt((record as BankReport['book_only'][number]).moved) }}
                </span>
              </template>
            </template>
          </Table>
        </template>
        <div v-else class="text-sm text-gray-400">
          导入流水后点「逐笔比对」出清单。
        </div>
      </Tabs.TabPane>
    </Tabs>
  </Modal>
</template>

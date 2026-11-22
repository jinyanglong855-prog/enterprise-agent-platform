<script lang="ts" setup>
import type { FinanceSummary, ProposalRecord } from '#/api/finance';
import type { SupplySummary } from '#/api/supply';
import type { Obligation, TodoSummary } from '#/api/todos';

import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { useAccess } from '@vben/access';

import { Button, Card, Input, Spin, Tag } from 'ant-design-vue';
import dayjs from 'dayjs';

import { getSummaryApi, listProposalsApi } from '#/api/finance';
import { supplySummaryApi } from '#/api/supply';
import { listTodosApi, scanRunsApi, todoSummaryApi } from '#/api/todos';
import { TODO_SEVERITY_COLOR, TODO_SOURCE_LABELS } from '#/constants/labels';

/**
 * 工作台（2026-11-02 前端分区）：登录后的第一屏——把各域"今天要处理什么"收到一页，每块都能点进对应页面。
 * 按权限裁剪：没有某域读权限的人看不到那一块，而不是看到一块空的或报 403。各块独立加载，一块失败不拖累其他。
 */
const router = useRouter();
const { hasAccessByCodes } = useAccess();

const showTodos = computed(() => hasAccessByCodes(['todo:read']));
const showFinance = computed(() => hasAccessByCodes(['finance:read']));
const showSupply = computed(() => hasAccessByCodes(['supply:read']));
const showScan = computed(() => hasAccessByCodes(['admin:manage']));
const showHr = computed(() => hasAccessByCodes(['payroll:read']));
const showAssistant = computed(() => hasAccessByCodes(['agent:read']));
const showKnowledge = computed(() => hasAccessByCodes(['knowledge:read']));

const today = dayjs().format('YYYY-MM-DD');
const month = today.slice(0, 7);

interface Block<T> {
  data: null | T;
  error: string;
  loading: boolean;
}
function block<T>(): Block<T> {
  return { data: null, error: '', loading: false };
}

const todoSummary = ref<Block<TodoSummary>>(block<TodoSummary>());
const todoList = ref<Block<Obligation[]>>(block<Obligation[]>());
const proposals = ref<Block<ProposalRecord[]>>(block<ProposalRecord[]>());
const finance = ref<Block<FinanceSummary>>(block<FinanceSummary>());
const supply = ref<Block<SupplySummary>>(block<SupplySummary>());
const scan =
  ref<Block<Record<string, unknown>[]>>(block<Record<string, unknown>[]>());

async function loadBlock<T>(
  target: { value: Block<T> },
  fetcher: () => Promise<T>,
) {
  target.value.loading = true;
  target.value.error = '';
  try {
    target.value.data = await fetcher();
  } catch (error) {
    target.value.error = (error as Error)?.message ?? String(error);
  } finally {
    target.value.loading = false;
  }
}

/** 待办列表取"我的"视图，只列未到期/已到期的在办项，按到期日近的在前；最多 6 条，全量去待办中心。 */
const TODO_PREVIEW = 6;
const todoPreview = computed(() => {
  const items = todoList.value.data ?? [];
  return items
    .toSorted((a, b) => {
      if (a.due_date === '' && b.due_date === '') return 0;
      if (a.due_date === '') return 1;
      if (b.due_date === '') return -1;
      return a.due_date.localeCompare(b.due_date);
    })
    .slice(0, TODO_PREVIEW);
});

function dueText(due: string): string {
  if (due === '') return '未定期';
  const diff = dayjs(due).startOf('day').diff(dayjs().startOf('day'), 'day');
  if (diff < 0) return `逾期 ${-diff} 天`;
  if (diff === 0) return '今天';
  return `${diff} 天后`;
}
function dueClass(due: string): string {
  if (due === '') return 'text-gray-400';
  const diff = dayjs(due).startOf('day').diff(dayjs().startOf('day'), 'day');
  if (diff < 0) return 'text-red-600';
  if (diff === 0) return 'text-orange-600';
  return 'text-gray-500';
}

const PROPOSAL_PREVIEW = 5;
const proposalPreview = computed(() =>
  (proposals.value.data ?? []).slice(0, PROPOSAL_PREVIEW),
);

/** 收支口径与「月度看板」一致：收入=income；支出=expense+payroll+reimburse+tax；结余=收入−支出。 */
const OUT_FLOW_TYPES = ['expense', 'payroll', 'reimburse', 'tax'];
function r2(n: number): number {
  return Math.round(n * 100) / 100;
}
const financeFigures = computed(() => {
  const s = finance.value.data;
  if (!s) return null;
  const income = s.byType.find((row) => row.type === 'income')?.total ?? 0;
  const outflow = r2(
    OUT_FLOW_TYPES.reduce(
      (sum, t) => sum + (s.byType.find((row) => row.type === t)?.total ?? 0),
      0,
    ),
  );
  return {
    count: s.count,
    income: r2(income),
    outflow,
    payable: r2(s.payableOutstanding),
    profit: r2(income - outflow),
    receivable: r2(s.receivableOutstanding),
  };
});
function money(n: number): string {
  return n.toLocaleString('zh-CN', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  });
}

/** scan_runs 每个检查器一行；同一轮的行 ran_at 相同——取最新一轮汇总。 */
const latestScan = computed(() => {
  const rows = scan.value.data ?? [];
  if (rows.length === 0) return null;
  const ranAt = String(rows[0]?.ran_at ?? '');
  const batch = rows.filter((r) => String(r.ran_at ?? '') === ranAt);
  const failed = batch.filter((r) => String(r.errors ?? '') !== '');
  return {
    created: batch.reduce((sum, r) => sum + Number(r.created ?? 0), 0),
    failed: failed.map((r) => String(r.scanner)),
    ranAt: ranAt.slice(0, 16).replace('T', ' '),
    resolved: batch.reduce((sum, r) => sum + Number(r.auto_resolved ?? 0), 0),
    scanners: batch.length,
  };
});

async function loadAll() {
  const jobs: Promise<void>[] = [];
  if (showTodos.value) {
    jobs.push(
      loadBlock(todoSummary, () => todoSummaryApi()),
      loadBlock(todoList, async () => {
        const body = await listTodosApi({
          scope: 'mine',
          status: 'active',
          limit: 50,
        });
        return body.items;
      }),
    );
  }
  if (showFinance.value) {
    jobs.push(
      loadBlock(proposals, async () => {
        const body = await listProposalsApi('pending');
        return body.proposals;
      }),
      loadBlock(finance, () => getSummaryApi(month)),
    );
  }
  if (showSupply.value) jobs.push(loadBlock(supply, () => supplySummaryApi()));
  if (showScan.value) {
    jobs.push(
      loadBlock(scan, async () => {
        const body = await scanRunsApi(40);
        return body.runs;
      }),
    );
  }
  await Promise.all(jobs);
}

function go(path: string, query?: Record<string, string>) {
  router.push(query ? { path, query } : { path });
}

// 问一问：把问题带到知识库页，由那边自动搜索——工作台只负责收集问题，不直接调接口
const kbQuestion = ref('');
function askKnowledge() {
  const q = kbQuestion.value.trim();
  go('/knowledge', q === '' ? undefined : { q });
}

onMounted(loadAll);
</script>

<template>
  <div class="p-4">
    <div class="mb-4 flex flex-wrap items-end justify-between gap-2">
      <div>
        <div class="text-lg font-medium">工作台</div>
        <div class="text-sm text-gray-500">
          {{ today }} · 今天要处理的事都在这一页，点任一块进入对应页面
        </div>
      </div>
      <Button @click="loadAll">刷新</Button>
    </div>

    <div class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      <!-- 待办 -->
      <Card
        v-if="showTodos"
        class="xl:col-span-2"
        size="small"
        title="待办事项"
      >
        <template #extra>
          <Button size="small" type="link" @click="go('/todos')">
            查看全部 →
          </Button>
        </template>
        <Spin :spinning="todoSummary.loading || todoList.loading">
          <div
            v-if="todoSummary.error || todoList.error"
            class="text-sm text-red-600"
          >
            暂时拉不到待办：{{ todoSummary.error || todoList.error }}
          </div>
          <template v-else>
            <div class="mb-3 grid grid-cols-4 gap-2 text-center">
              <div
                class="cursor-pointer rounded bg-red-50 py-2"
                @click="go('/todos')"
              >
                <div class="text-xl font-semibold text-red-600">
                  {{ todoSummary.data?.overdue ?? '—' }}
                </div>
                <div class="text-xs text-gray-500">已逾期</div>
              </div>
              <div
                class="cursor-pointer rounded bg-orange-50 py-2"
                @click="go('/todos')"
              >
                <div class="text-xl font-semibold text-orange-600">
                  {{ todoSummary.data?.today ?? '—' }}
                </div>
                <div class="text-xs text-gray-500">今天到期</div>
              </div>
              <div
                class="cursor-pointer rounded bg-gray-50 py-2"
                @click="go('/todos')"
              >
                <div class="text-xl font-semibold">
                  {{ todoSummary.data?.upcoming7 ?? '—' }}
                </div>
                <div class="text-xs text-gray-500">7 天内到期</div>
              </div>
              <div
                class="cursor-pointer rounded bg-gray-50 py-2"
                @click="go('/todos')"
              >
                <div class="text-xl font-semibold">
                  {{ todoSummary.data?.undated ?? '—' }}
                </div>
                <div class="text-xs text-gray-500">未定期</div>
              </div>
            </div>
            <div v-if="todoPreview.length === 0" class="text-sm text-gray-400">
              没有在办的待办，一切正常。
            </div>
            <div
              v-for="it in todoPreview"
              :key="it.id"
              class="flex cursor-pointer items-center gap-2 border-b py-1.5 text-sm last:border-b-0 hover:bg-gray-50"
              @click="go('/todos', { id: String(it.id) })"
            >
              <Tag
                :color="TODO_SEVERITY_COLOR[it.severity] ?? 'default'"
                class="m-0"
              >
                {{
                  it.severity === 'critical'
                    ? '紧急'
                    : it.severity === 'warn'
                      ? '提醒'
                      : '知会'
                }}
              </Tag>
              <span class="flex-1 truncate" :title="it.detail">{{
                it.title
              }}</span>
              <span
                class="w-20 text-right text-xs"
                :class="dueClass(it.due_date)"
                >{{ dueText(it.due_date) }}</span
              >
            </div>
            <div
              v-if="(todoList.data?.length ?? 0) > TODO_PREVIEW"
              class="mt-2 text-xs text-gray-400"
            >
              还有
              {{ (todoList.data?.length ?? 0) - TODO_PREVIEW }}
              条，到待办中心查看
            </div>
          </template>
        </Spin>
      </Card>

      <!-- 待确认记账 -->
      <Card v-if="showFinance" size="small" title="待确认记账">
        <template #extra>
          <Button size="small" type="link" @click="go('/finance/proposals')">
            去处理 →
          </Button>
        </template>
        <Spin :spinning="proposals.loading">
          <div v-if="proposals.error" class="text-sm text-red-600">
            暂时拉不到：{{ proposals.error }}
          </div>
          <template v-else>
            <div class="mb-2 text-sm text-gray-500">
              共
              <b class="text-base text-orange-600">{{
                proposals.data?.length ?? '—'
              }}</b>
              笔等确认，确认后才入账本
            </div>
            <div
              v-if="proposalPreview.length === 0"
              class="text-sm text-gray-400"
            >
              没有待确认的记账。
            </div>
            <div
              v-for="p in proposalPreview"
              :key="p.id"
              class="cursor-pointer border-b py-1.5 text-sm last:border-b-0 hover:bg-gray-50"
              @click="go('/finance/proposals', { id: p.id })"
            >
              <div class="truncate">{{ p.summary }}</div>
              <div class="text-xs text-gray-400">
                {{ p.created_by }} ·
                {{ p.created_at.slice(0, 16).replace('T', ' ') }}
              </div>
            </div>
          </template>
        </Spin>
      </Card>

      <!-- 本月收支 -->
      <Card v-if="showFinance" size="small" :title="`本月收支（${month}）`">
        <template #extra>
          <Button size="small" type="link" @click="go('/finance')">
            月度看板 →
          </Button>
        </template>
        <Spin :spinning="finance.loading">
          <div v-if="finance.error" class="text-sm text-red-600">
            暂时拉不到：{{ finance.error }}
          </div>
          <template v-else-if="financeFigures">
            <div class="grid grid-cols-3 gap-2 text-center">
              <div
                class="cursor-pointer rounded bg-gray-50 py-2"
                @click="go('/finance/ledger', { month, type: 'income' })"
              >
                <div class="text-base font-semibold text-green-700">
                  {{ money(financeFigures.income) }}
                </div>
                <div class="text-xs text-gray-500">收入</div>
              </div>
              <div
                class="cursor-pointer rounded bg-gray-50 py-2"
                title="支出=费用+工资+报销+税费四类合计；台账按类型只能单选，点进去看本月全部流水"
                @click="go('/finance/ledger', { month })"
              >
                <div class="text-base font-semibold text-red-700">
                  {{ money(financeFigures.outflow) }}
                </div>
                <div class="text-xs text-gray-500">
                  支出（含工资/报销/税费）
                </div>
              </div>
              <div class="rounded bg-gray-50 py-2">
                <div
                  class="text-base font-semibold"
                  :class="
                    financeFigures.profit >= 0
                      ? 'text-green-700'
                      : 'text-red-700'
                  "
                >
                  {{ money(financeFigures.profit) }}
                </div>
                <div class="text-xs text-gray-500">结余</div>
              </div>
            </div>
            <div
              class="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500"
            >
              <span
                class="cursor-pointer hover:text-blue-600"
                @click="
                  go('/finance/ledger', { outstanding: '1', type: 'income' })
                "
              >
                应收未收
                <b class="text-sm text-gray-700">{{
                  money(financeFigures.receivable)
                }}</b>
              </span>
              <span
                class="cursor-pointer hover:text-blue-600"
                @click="
                  go('/finance/ledger', { outstanding: '1', type: 'expense' })
                "
              >
                应付未付
                <b class="text-sm text-gray-700">{{
                  money(financeFigures.payable)
                }}</b>
              </span>
              <span>本月 {{ financeFigures.count }} 笔</span>
            </div>
          </template>
        </Spin>
      </Card>

      <!-- 供应链 -->
      <Card v-if="showSupply" size="small" title="供应链提醒">
        <template #extra>
          <Button size="small" type="link" @click="go('/supply')">
            库存物料 →
          </Button>
        </template>
        <Spin :spinning="supply.loading">
          <div v-if="supply.error" class="text-sm text-red-600">
            暂时拉不到：{{ supply.error }}
          </div>
          <template v-else-if="supply.data">
            <div class="grid grid-cols-3 gap-2 text-center">
              <div
                class="cursor-pointer rounded py-2"
                :class="
                  supply.data.belowSafety > 0 ? 'bg-red-50' : 'bg-gray-50'
                "
                @click="go('/supply', { filter: 'below' })"
              >
                <div
                  class="text-xl font-semibold"
                  :class="supply.data.belowSafety > 0 ? 'text-red-600' : ''"
                >
                  {{ supply.data.belowSafety }}
                </div>
                <div class="text-xs text-gray-500">低于安全库存</div>
              </div>
              <div
                class="cursor-pointer rounded py-2"
                :class="
                  supply.data.expiringBatches > 0
                    ? 'bg-orange-50'
                    : 'bg-gray-50'
                "
                @click="go('/supply', { filter: 'expiring' })"
              >
                <div
                  class="text-xl font-semibold"
                  :class="
                    supply.data.expiredBatches > 0
                      ? 'text-red-600'
                      : supply.data.expiringBatches > 0
                        ? 'text-orange-600'
                        : ''
                  "
                >
                  {{ supply.data.expiringBatches }}
                </div>
                <div class="text-xs text-gray-500">
                  临期批次<template v-if="supply.data.expiredBatches > 0">
                    （过期 {{ supply.data.expiredBatches }}）
                  </template>
                </div>
              </div>
              <div
                class="cursor-pointer rounded py-2"
                :class="supply.data.overduePos > 0 ? 'bg-red-50' : 'bg-gray-50'"
                @click="go('/supply/purchase', { overdue: '1' })"
              >
                <div
                  class="text-xl font-semibold"
                  :class="supply.data.overduePos > 0 ? 'text-red-600' : ''"
                >
                  {{ supply.data.overduePos }}
                </div>
                <div class="text-xs text-gray-500">逾期未到货</div>
              </div>
            </div>
            <div class="mt-3 text-xs text-gray-500">
              在用物料 {{ supply.data.items }} 个，未到货采购单
              {{ supply.data.openPos }} 张，最近库存快照
              {{ supply.data.lastSnapshotDate || '还没导入' }}
            </div>
          </template>
        </Spin>
      </Card>

      <!-- 自动检查 -->
      <Card v-if="showScan" size="small" title="自动检查">
        <template #extra>
          <Button size="small" type="link" @click="go('/todos')">
            待办中心 →
          </Button>
        </template>
        <Spin :spinning="scan.loading">
          <div v-if="scan.error" class="text-sm text-red-600">
            暂时拉不到：{{ scan.error }}
          </div>
          <div v-else-if="!latestScan" class="text-sm text-gray-400">
            还没有跑过自动检查。
          </div>
          <template v-else>
            <div class="text-sm">
              最近一次 <b>{{ latestScan.ranAt }}</b
              >，跑了 {{ latestScan.scanners }} 项检查， 新增待办
              <b>{{ latestScan.created }}</b> 条，自动消除
              {{ latestScan.resolved }} 条
            </div>
            <div
              v-if="latestScan.failed.length > 0"
              class="mt-2 text-sm text-red-600"
            >
              有 {{ latestScan.failed.length }} 项检查出错：{{
                latestScan.failed
                  .map((k) => TODO_SOURCE_LABELS[k] ?? k)
                  .join('、')
              }}（到待办中心看详情）
            </div>
            <div v-else class="mt-2 text-xs text-green-700">全部检查正常。</div>
          </template>
        </Spin>
      </Card>

      <!-- 问一问 -->
      <Card v-if="showKnowledge" size="small" title="问一问">
        <div class="flex flex-wrap items-center gap-2">
          <Input
            v-model:value="kbQuestion"
            class="min-w-52 flex-1"
            :maxlength="500"
            placeholder="政策、流程上的疑问，如：发票丢了怎么处理"
            @press-enter="askKnowledge"
          />
          <Button type="primary" @click="askKnowledge">去查一查</Button>
        </div>
        <div class="mt-2 text-xs text-gray-400">
          公司的制度、承诺、经验都存档在知识库里，查到的每条都带出处。
        </div>
      </Card>

      <!-- 快捷入口 -->
      <Card size="small" title="快捷入口">
        <div class="flex flex-wrap gap-2">
          <Button v-if="showFinance" @click="go('/finance/ledger')">
            流水台账
          </Button>
          <Button v-if="showFinance" @click="go('/finance/invoices')">
            票夹
          </Button>
          <Button v-if="showHr" @click="go('/hr/payroll')">工资表</Button>
          <Button v-if="showHr" @click="go('/hr')">员工名册</Button>
          <Button v-if="showSupply" @click="go('/supply/purchase')">
            采购台账
          </Button>
          <Button v-if="showSupply" @click="go('/supply/report')">
            生产月报
          </Button>
          <Button
            v-if="showAssistant"
            type="primary"
            ghost
            @click="go('/assistant')"
          >
            智能助手
          </Button>
        </div>
      </Card>
    </div>
  </div>
</template>

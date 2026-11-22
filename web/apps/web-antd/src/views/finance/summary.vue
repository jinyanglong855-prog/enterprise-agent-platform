<script lang="ts" setup>
// 财务月度看板 + 轻量 BI（任务全图 §4-4）：环比条 + 近 6 月收支趋势 + 支出分类占比
// + 应收应付已收未收 + 逾期账龄。数据全走现有 API（getSummaryApi / listEntriesApi），零后端改动。
import type { Ref } from 'vue';

import type { FlowPoint } from './bi/flow-trend.vue';
import type { AgingBucket } from './bi/overdue-aging.vue';

import type { EntryType, FinanceSummary } from '#/api/finance';

import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { Button, Card, message, Table } from 'ant-design-vue';

import { getSummaryApi, listEntriesApi, TYPE_LABELS } from '#/api/finance';
import { ledgerLink } from '#/utils/entity-links';

import CategoryPie from './bi/category-pie.vue';
import FlowTrend from './bi/flow-trend.vue';
import OverdueAging from './bi/overdue-aging.vue';
import ReceivablePayable from './bi/receivable-payable.vue';

const router = useRouter();

/** 流出类（利润参考=收入−这些的合计；发票是证据维不计） */
const OUT_FLOW_TYPES: EntryType[] = ['expense', 'payroll', 'reimburse', 'tax'];

const summary: Ref<FinanceSummary | null> = ref(null);
const loading = ref(true);
const trendPoints = ref<FlowPoint[]>([]);
const overdue = ref<
  { amount: number; paid_amount: number; due_date: string; type: string }[]
>([]);
const biReady = ref(false); // 图表区一次性加载完成（失败不挡基础三卡）
const biError = ref(false); // 本月 summary 都拿不到：BI 区显示错误态，不无限骨架
const trendMissing = ref<string[]>([]); // 拉取失败的月份（趋势图按 0 计并在卡片标注）
const overdueLoadFailed = ref(false); // 逾期清单单独失败：逾期卡/账龄图显示失败态
const overdueBaselineFailed = ref(false); // 上月末基线拉取失败：逾期卡环比位置标注，不静默消失
const overdueAsOfPrev = ref<null | { amount: number; count: number }>(null); // 上月末已到期且至今未结（环比基线）

function byTypeTotal(s: FinanceSummary, type: EntryType): number {
  return s.byType.find((row) => row.type === type)?.total ?? 0;
}
function r2(n: number): number {
  return Math.round(n * 100) / 100;
}
function outflowTotal(s: FinanceSummary): number {
  return r2(OUT_FLOW_TYPES.reduce((sum, t) => sum + byTypeTotal(s, t), 0));
}
/** 以服务端返回的本月为锚，倒推近 n 个自然月（升序）。 */
function lastMonths(anchor: string, n: number): string[] {
  const [y, m] = anchor.split('-').map(Number);
  const months: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(y!, m! - 1 - i, 1);
    months.push(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
    );
  }
  return months.reverse();
}
function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/**
 * 统一按本地零点解析 YYYY-MM-DD：直接 Date.parse 纯日期串各浏览器宽松程度不一（V8 放过 '2026-02-1'，Safari 返 NaN），
 * 加 T00:00:00 强制严格 ISO，脏值一律 NaN；两侧同口径相减天数为整数（仅夏令时时区可能差 1 天，国内不受影响）。
 */
function parseDue(due: string): number {
  return Date.parse(`${due}T00:00:00`);
}

onMounted(async () => {
  loading.value = true;
  try {
    summary.value = await getSummaryApi();
  } catch (error) {
    biError.value = true; // HTTP 错误由 request 拦截器统一弹 toast，这里只转错误态 + 留日志
    console.error('看板数据加载失败', error);
    return;
  } finally {
    loading.value = false;
  }
  // 以下 BI 数据任何一处失败都不再拖垮整块：失败月份按 0 计并标注，逾期单独标失败
  const anchor = summary.value as FinanceSummary;
  const months = lastMonths(anchor.month, 6);
  const settled = await Promise.allSettled(
    months.map((m) =>
      m === anchor.month ? Promise.resolve(anchor) : getSummaryApi(m),
    ),
  );
  trendMissing.value = settled
    .map((r, i) => (r.status === 'rejected' ? (months[i] ?? '') : ''))
    .filter(Boolean);
  trendPoints.value = settled.map((r, i) => {
    const s = r.status === 'fulfilled' ? r.value : null;
    const income = s ? byTypeTotal(s, 'income') : 0;
    const outflow = s ? outflowTotal(s) : 0;
    return {
      income,
      month: months[i] ?? '',
      outflow,
      profit: s ? r2(income - outflow) : 0,
    };
  });
  const [curOverdue, prevOverdue] = await Promise.allSettled([
    listEntriesApi({ due_before: localToday(), limit: 200 }),
    // due_before 严格小于：传当月 1 日 = 上月末（含）之前到期、至今未结，作逾期环比基线
    listEntriesApi({ due_before: `${anchor.month}-01`, limit: 200 }),
  ]);
  if (curOverdue.status === 'fulfilled') {
    if (curOverdue.value.count >= 200) {
      message.warning(
        '逾期未结超过 200 笔，账龄分布只统计最近 200 笔（更早的未含在内）',
      );
    }
    // 后端 due_before 已滤掉已付/作废/冲销对；发票、零余额、脏 due_date（后端不校验格式，NaN 没法分桶）再剔除
    overdue.value = curOverdue.value.records.filter((r) => {
      if (r.type === 'invoice' || r.amount - r.paid_amount <= 0) return false;
      return !Number.isNaN(parseDue(r.due_date));
    });
  } else {
    overdueLoadFailed.value = true;
  }
  if (prevOverdue.status === 'fulfilled') {
    if (prevOverdue.value.count >= 200) {
      message.warning('上月末逾期基线超过 200 笔，逾期环比只按最近 200 笔计');
    }
    const rows = prevOverdue.value.records.filter(
      (r) =>
        r.type !== 'invoice' &&
        r.amount - r.paid_amount > 0 &&
        !Number.isNaN(parseDue(r.due_date)),
    );
    overdueAsOfPrev.value = {
      amount: r2(rows.reduce((sum, r) => sum + (r.amount - r.paid_amount), 0)),
      count: rows.length,
    };
  } else {
    overdueBaselineFailed.value = true;
  }
  biReady.value = true;
});

// ----------------------------------------------------------- 环比（本月 vs 上月）

const cur = computed(() => trendPoints.value.at(-1) ?? null);
const prev = computed(() => trendPoints.value.at(-2) ?? null);

/** 百分比环比；基线为 0 或任一侧为负（冲销净负）时百分比无意义，返回 null 只看金额差。 */
function pctOf(curV: number, prevV: number): null | number {
  if (prevV === 0 || prevV < 0 || curV < 0) return null;
  return r2(((curV - prevV) / prevV) * 100);
}
function deltaText(delta: number): string {
  const d = r2(delta);
  if (d === 0) return '持平';
  return `${d > 0 ? '+' : ''}${d.toLocaleString('zh-CN')} 元`;
}
/** 好坏着色：收入/利润涨=好（绿），流出涨=坏（红）；持平（差额 0）中性灰不算好坏。 */
function goodClass(delta: number, goodWhenPositive: boolean): string {
  if (delta === 0) return 'text-gray-400';
  return delta > 0 === goodWhenPositive ? 'text-green-600' : 'text-red-500';
}

const incomeChange = computed(() => {
  if (!cur.value || !prev.value) return null;
  return {
    pct: pctOf(cur.value.income, prev.value.income),
    raw: cur.value.income - prev.value.income,
  };
});
const outflowChange = computed(() => {
  if (!cur.value || !prev.value) return null;
  return {
    pct: pctOf(cur.value.outflow, prev.value.outflow),
    raw: cur.value.outflow - prev.value.outflow,
  };
});
const profitChange = computed(() => {
  if (!cur.value || !prev.value) return null;
  return { raw: r2(cur.value.profit - prev.value.profit) };
});
/** 上月 summary 拉取失败（按 0 补位）：环比失真，三卡不显示环比行、改标缺失。 */
const prevMissing = computed(
  () => prev.value !== null && trendMissing.value.includes(prev.value.month),
);

// ----------------------------------------------------------- 应收/应付堆叠（本月）

const settledSplit = computed(() => {
  const s = summary.value;
  if (!s) return null;
  const incomeRow = s.byType.find((row) => row.type === 'income');
  const paid = r2(
    OUT_FLOW_TYPES.reduce(
      (sum, t) => sum + (s.byType.find((row) => row.type === t)?.paid ?? 0),
      0,
    ),
  );
  const outstanding = r2(
    OUT_FLOW_TYPES.reduce(
      (sum, t) =>
        sum + (s.byType.find((row) => row.type === t)?.outstanding ?? 0),
      0,
    ),
  );
  return {
    income: {
      outstanding: incomeRow?.outstanding ?? 0,
      paid: incomeRow?.paid ?? 0,
    },
    outflow: { outstanding, paid },
  };
});

// ----------------------------------------------------------- 逾期账龄分桶

const overdueBuckets = computed<AgingBucket[]>(() => {
  const todayMs = parseDue(localToday());
  const defs: { label: string; max: number; min: number }[] = [
    { label: '1-30 天', max: 30, min: 1 },
    { label: '31-60 天', max: 60, min: 31 },
    { label: '61-90 天', max: 90, min: 61 },
    { label: '90 天以上', max: Number.POSITIVE_INFINITY, min: 91 },
  ];
  return defs.map(({ label, max, min }) => {
    const rows = overdue.value.filter((r) => {
      const days = Math.floor((todayMs - parseDue(r.due_date)) / 86_400_000);
      return days >= min && days <= max;
    });
    const balance = (r: { amount: number; paid_amount: number }) =>
      r.amount - r.paid_amount;
    return {
      count: rows.length,
      label,
      payable: r2(
        rows
          .filter((r) => (OUT_FLOW_TYPES as string[]).includes(r.type))
          .reduce((sum, r) => sum + balance(r), 0),
      ),
      receivable: r2(
        rows
          .filter((r) => r.type === 'income')
          .reduce((sum, r) => sum + balance(r), 0),
      ),
    };
  });
});
const overdueTotal = computed(() => {
  const balance = (r: { amount: number; paid_amount: number }) =>
    r.amount - r.paid_amount;
  return {
    count: overdue.value.length,
    payable: r2(
      overdue.value
        .filter((r) => (OUT_FLOW_TYPES as string[]).includes(r.type))
        .reduce((sum, r) => sum + balance(r), 0),
    ),
    receivable: r2(
      overdue.value
        .filter((r) => r.type === 'income')
        .reduce((sum, r) => sum + balance(r), 0),
    ),
  };
});
const overdueChange = computed(() => {
  const prev = overdueAsOfPrev.value;
  if (!prev) return null;
  const curAmount = r2(
    overdueTotal.value.receivable + overdueTotal.value.payable,
  );
  return {
    count: overdueTotal.value.count - prev.count,
    amount: r2(curAmount - prev.amount),
  };
});

const columns = [
  { dataIndex: 'type', key: 'type', title: '类型' },
  { dataIndex: 'count', key: 'count', title: '笔数' },
  { dataIndex: 'total', key: 'total', title: '金额合计(元)' },
  { dataIndex: 'paid', key: 'paid', title: '已收付(元)' },
  { dataIndex: 'outstanding', key: 'outstanding', title: '未收付(元)' },
];
</script>

<template>
  <div class="p-4">
    <div class="mb-2 flex flex-wrap items-center justify-end gap-2">
      <!-- 卡片数字是汇总，明细永远在台账：应收/应付两张卡点过去按"未结清"过滤，其余按月过滤 -->
      <Button
        size="small"
        @click="router.push(ledgerLink({ month: summary?.month }))"
      >
        本月流水明细 →
      </Button>
      <Button
        size="small"
        @click="router.push(ledgerLink({ outstanding: '1', type: 'income' }))"
      >
        应收未收明细 →
      </Button>
      <Button
        size="small"
        @click="router.push(ledgerLink({ outstanding: '1', type: 'expense' }))"
      >
        应付未付明细 →
      </Button>
    </div>
    <div class="mb-4 grid grid-cols-3 gap-4">
      <Card :loading="loading">
        <div class="text-sm text-gray-500">本月账目笔数</div>
        <div class="text-2xl font-semibold">
          {{ summary?.count ?? '—' }}
        </div>
      </Card>
      <Card>
        <div class="text-sm text-gray-500">应收未收(元)</div>
        <div class="text-2xl font-semibold text-red-500">
          {{ summary?.receivableOutstanding ?? '—' }}
        </div>
      </Card>
      <Card>
        <div class="text-sm text-gray-500">应付未付(元)</div>
        <div class="text-2xl font-semibold text-green-600">
          {{ summary?.payableOutstanding ?? '—' }}
        </div>
      </Card>
    </div>

    <!-- 环比条（本月 vs 上月，口径=在账发生额，不含取消） -->
    <div class="mb-4 grid grid-cols-2 gap-4 md:grid-cols-4">
      <Card :loading="loading || (!biReady && !biError)" size="small">
        <div class="text-sm text-gray-500">本月收入</div>
        <div class="text-xl font-semibold">
          {{ cur?.income?.toLocaleString('zh-CN') ?? '—' }}
        </div>
        <div v-if="biError" class="text-xs text-gray-400">
          加载失败，请刷新重试
        </div>
        <div v-else-if="prevMissing" class="text-xs text-amber-500">
          上月数据加载失败，无法环比
        </div>
        <div
          v-else-if="incomeChange"
          class="text-xs"
          :class="goodClass(incomeChange.raw, true)"
        >
          较上月 {{ deltaText(incomeChange.raw)
          }}<template v-if="incomeChange.pct !== null">
            （{{ incomeChange.pct > 0 ? '+' : '' }}{{ incomeChange.pct }}%）
          </template>
        </div>
      </Card>
      <Card :loading="loading || (!biReady && !biError)" size="small">
        <div class="text-sm text-gray-500">本月流出</div>
        <div class="text-xl font-semibold">
          {{ cur?.outflow?.toLocaleString('zh-CN') ?? '—' }}
        </div>
        <div v-if="biError" class="text-xs text-gray-400">
          加载失败，请刷新重试
        </div>
        <div v-else-if="prevMissing" class="text-xs text-amber-500">
          上月数据加载失败，无法环比
        </div>
        <div
          v-else-if="outflowChange"
          class="text-xs"
          :class="goodClass(outflowChange.raw, false)"
        >
          较上月 {{ deltaText(outflowChange.raw)
          }}<template v-if="outflowChange.pct !== null">
            （{{ outflowChange.pct > 0 ? '+' : '' }}{{ outflowChange.pct }}%）
          </template>
        </div>
      </Card>
      <Card :loading="loading || (!biReady && !biError)" size="small">
        <div class="text-sm text-gray-500">利润参考（收入−流出）</div>
        <div
          class="text-xl font-semibold"
          :class="
            (cur?.profit ?? 0) > 0
              ? 'text-green-600'
              : (cur?.profit ?? 0) < 0
                ? 'text-red-500'
                : ''
          "
        >
          {{ cur?.profit?.toLocaleString('zh-CN') ?? '—' }}
        </div>
        <div v-if="biError" class="text-xs text-gray-400">
          加载失败，请刷新重试
        </div>
        <div v-else-if="prevMissing" class="text-xs text-amber-500">
          上月数据加载失败，无法环比
        </div>
        <div
          v-else-if="profitChange"
          class="text-xs"
          :class="goodClass(profitChange.raw, true)"
        >
          较上月 {{ deltaText(profitChange.raw) }}
        </div>
      </Card>
      <Card :loading="loading || (!biReady && !biError)" size="small">
        <div class="text-sm text-gray-500">逾期未结（到期未收付）</div>
        <template v-if="overdueLoadFailed">
          <div class="text-xl font-semibold text-gray-400">加载失败</div>
          <div class="text-xs text-gray-400">请刷新页面重试</div>
        </template>
        <template v-else-if="!biError">
          <div
            class="text-xl font-semibold"
            :class="overdueTotal.count > 0 ? 'text-red-500' : ''"
          >
            {{ overdueTotal.count }} 笔
          </div>
          <div class="text-xs text-gray-500">
            应收 {{ overdueTotal.receivable.toLocaleString('zh-CN') }} 元 · 应付
            {{ overdueTotal.payable.toLocaleString('zh-CN') }} 元
          </div>
          <div v-if="overdueBaselineFailed" class="text-xs text-amber-500">
            上月末基线加载失败，无法环比
          </div>
          <div
            v-else-if="overdueChange"
            class="text-xs"
            :class="
              goodClass(
                overdueChange.count !== 0
                  ? overdueChange.count
                  : overdueChange.amount,
                false,
              )
            "
          >
            较上月末 {{ overdueChange.count > 0 ? '+' : ''
            }}{{ overdueChange.count }} 笔 /
            {{ deltaText(overdueChange.amount) }}
          </div>
          <div class="text-xs text-gray-400">
            按到期日算天数，见下方账龄分布
          </div>
        </template>
        <template v-else>
          <div class="text-xl font-semibold text-gray-400">—</div>
        </template>
      </Card>
    </div>

    <div class="mb-4 grid gap-4 lg:grid-cols-3">
      <Card
        :loading="loading || (!biReady && !biError)"
        class="lg:col-span-2"
        title="近 6 个月收支与利润参考（在账口径，不含取消）"
      >
        <template #extra>
          <span v-if="trendMissing.length > 0" class="text-xs text-amber-500">
            {{ trendMissing.join('、') }} 月数据加载失败，趋势按 0 计
          </span>
        </template>
        <div
          v-if="biError"
          class="flex h-[300px] items-center justify-center text-gray-400"
        >
          看板数据加载失败，请刷新重试
        </div>
        <FlowTrend v-else :points="trendPoints" />
      </Card>
      <Card
        :loading="loading || (!biReady && !biError)"
        title="本月支出分类占比"
      >
        <div
          v-if="biError"
          class="flex h-[300px] items-center justify-center text-gray-400"
        >
          看板数据加载失败，请刷新重试
        </div>
        <CategoryPie
          v-else
          :rows="
            summary?.byCategory?.map((r) => ({
              category: r.category,
              total: r.total,
            })) ?? []
          "
        />
      </Card>
    </div>

    <div class="mb-4 grid gap-4 lg:grid-cols-2">
      <Card
        :loading="loading || (!biReady && !biError)"
        title="逾期未结账龄（按超过到期日的天数）"
      >
        <div
          v-if="biError || overdueLoadFailed"
          class="flex h-[300px] items-center justify-center text-gray-400"
        >
          {{
            biError
              ? '看板数据加载失败，请刷新重试'
              : '逾期数据加载失败，请刷新重试'
          }}
        </div>
        <OverdueAging v-else :buckets="overdueBuckets" />
      </Card>
      <Card
        :loading="loading || (!biReady && !biError)"
        title="本月已收/未收 · 已付/未付（元）"
      >
        <div
          v-if="biError"
          class="flex h-[300px] items-center justify-center text-gray-400"
        >
          看板数据加载失败，请刷新重试
        </div>
        <ReceivablePayable
          v-else
          :income="settledSplit?.income ?? null"
          :outflow="settledSplit?.outflow ?? null"
        />
      </Card>
    </div>

    <Card title="分类型汇总（本月在账，不含取消）">
      <Table
        :columns="columns"
        :data-source="summary?.byType ?? []"
        :loading="loading"
        :pagination="false"
        row-key="type"
        size="small"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'type'">
            {{ TYPE_LABELS[record.type as EntryType] ?? record.type }}
          </template>
        </template>
      </Table>
    </Card>
  </div>
</template>

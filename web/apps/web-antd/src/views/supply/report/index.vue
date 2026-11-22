<script lang="ts" setup>
import type { SupplyMonthlyReport } from '#/api/supply';

import { onMounted, ref } from 'vue';

import {
  Alert,
  Button,
  Card,
  DatePicker,
  Descriptions,
  message,
  Table,
  Tag,
} from 'ant-design-vue';

import { monthlyReportApi } from '#/api/supply';

/** 生产月报（2026-11-01 R1）：数量口径——库存变动/采购/批次/预警四块 + 口径说明。
 *  金额在财务域月报里，这里一个金额都没有（不碰钱是本域的结构级约束）。 */

const month = ref<string>();
const loading = ref(false);
const report = ref<SupplyMonthlyReport>();

async function load() {
  loading.value = true;
  try {
    report.value = await monthlyReportApi(month.value);
  } catch (error) {
    message.error(`加载失败：${(error as Error)?.message ?? error}`);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

const moverColumns = [
  { dataIndex: 'code', key: 'code', title: '编码', width: 110 },
  { dataIndex: 'name', key: 'name', title: '名称', ellipsis: true },
  { dataIndex: 'unit', key: 'unit', title: '单位', width: 60 },
  { key: 'start', title: '月初', align: 'right' as const, width: 90 },
  { key: 'end', title: '月末/至今', align: 'right' as const, width: 100 },
  { key: 'change', title: '变动', align: 'right' as const, width: 90 },
];

const batchColumns = [
  { dataIndex: 'code', key: 'code', title: '编码', width: 110 },
  { dataIndex: 'name', key: 'name', title: '名称', ellipsis: true },
  { dataIndex: 'warehouse', key: 'warehouse', title: '仓库', width: 90 },
  { dataIndex: 'batchNo', key: 'batchNo', title: '批次', width: 110 },
  { dataIndex: 'expiryDate', key: 'expiryDate', title: '效期', width: 100 },
  {
    dataIndex: 'quantity',
    key: 'quantity',
    title: '现存',
    align: 'right' as const,
    width: 80,
  },
  { key: 'daysLeft', title: '状态', width: 130 },
];
</script>

<template>
  <div class="p-4">
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <div class="text-sm text-gray-500">
        生产/供应链月报：数量口径（库存变动、采购到货、批次效期、预警进出）。
        库存按"截止日各仓最新报数之和"回看快照流水；采购单没有状态历史，在途/逾期按当前状态算——口径细节见页尾说明。
      </div>
      <div class="flex-1"></div>
      <DatePicker
        v-model:value="month"
        :allow-clear="true"
        picker="month"
        placeholder="月份（缺省当月）"
        value-format="YYYY-MM"
      />
      <Button :loading="loading" type="primary" ghost @click="load">
        查月报
      </Button>
    </div>

    <template v-if="report">
      <Alert
        v-if="report.partial"
        class="mb-3"
        show-icon
        type="info"
        :message="`${report.month} 还没过完：数据截止 ${report.asOf}，月内再看数字会变。`"
      />

      <Card class="mb-3" size="small" title="库存">
        <Descriptions :column="3" size="small">
          <Descriptions.Item label="在用物料">
            {{ report.stock.activeItems }}
          </Descriptions.Item>
          <Descriptions.Item label="期间有读数">
            {{ report.stock.reportedItems }}
          </Descriptions.Item>
          <Descriptions.Item label="当前低于安全库存线（按合计比）">
            <span
              :class="
                report.stock.belowSafety > 0 ? 'font-medium text-red-600' : ''
              "
            >
              {{ report.stock.belowSafety }}
            </span>
          </Descriptions.Item>
        </Descriptions>
        <div v-if="report.stock.moversTotal > 0" class="mt-2">
          <div class="mb-1 text-xs text-gray-500">
            库存变动榜（按变动绝对值排序，共
            {{ report.stock.moversTotal }} 项，列前
            {{ report.stock.movers.length }}；无读数≠0，是"还没盘过"）
          </div>
          <Table
            :columns="moverColumns"
            :data-source="report.stock.movers"
            :pagination="false"
            row-key="code"
            size="small"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'start'">
                {{
                  (record as { startQuantity: null | number }).startQuantity ??
                  '—'
                }}
              </template>
              <template v-else-if="column.key === 'end'">
                {{
                  (record as { endQuantity: null | number }).endQuantity ?? '—'
                }}
              </template>
              <template v-else-if="column.key === 'change'">
                <span
                  :class="
                    (record as { change: number }).change > 0
                      ? 'text-green-600'
                      : (record as { change: number }).change < 0
                        ? 'text-red-600'
                        : 'text-gray-400'
                  "
                >
                  {{ (record as { change: number }).change > 0 ? '+' : ''
                  }}{{ (record as { change: number }).change }}
                </span>
              </template>
            </template>
          </Table>
        </div>
      </Card>

      <Card class="mb-3" size="small" :title="`采购（${report.month}）`">
        <Descriptions :column="4" size="small">
          <Descriptions.Item label="下单">
            {{ report.purchase.orderedPos }} 张 /
            {{ report.purchase.orderedLines }} 行
          </Descriptions.Item>
          <Descriptions.Item label="下单数量">
            {{ report.purchase.orderedQty }}
          </Descriptions.Item>
          <Descriptions.Item label="到货">
            {{ report.purchase.receivedLines }} 行
          </Descriptions.Item>
          <Descriptions.Item label="到货数量">
            {{ report.purchase.receivedQty }}
          </Descriptions.Item>
          <Descriptions.Item label="取消">
            {{ report.purchase.cancelledLines }} 行
          </Descriptions.Item>
          <Descriptions.Item label="当前在途">
            {{ report.purchase.openNow }} 行
          </Descriptions.Item>
          <Descriptions.Item :label="`当前逾期（截至 ${report.asOf}）`">
            <span
              :class="
                report.purchase.overdueAsOf > 0
                  ? 'font-medium text-red-600'
                  : ''
              "
            >
              {{ report.purchase.overdueAsOf }} 行
            </span>
          </Descriptions.Item>
        </Descriptions>
      </Card>

      <Card
        class="mb-3"
        size="small"
        :title="`批次效期（截至 ${report.asOf}）`"
      >
        <Descriptions :column="2" size="small">
          <Descriptions.Item label="临期批次（窗口天数见口径说明）">
            <span
              :class="
                report.batches.expiring > 0 ? 'font-medium text-orange-600' : ''
              "
              >{{ report.batches.expiring }}</span>
          </Descriptions.Item>
          <Descriptions.Item label="其中已过期">
            <span
              :class="
                report.batches.expired > 0 ? 'font-medium text-red-600' : ''
              "
              >{{ report.batches.expired }}</span>
          </Descriptions.Item>
        </Descriptions>
        <div
          v-if="report.batches.rowsTotal > report.batches.rows.length"
          class="mt-2 text-xs text-gray-500"
        >
          共 {{ report.batches.rowsTotal }} 条批次在窗口内，这里只列前
          {{ report.batches.rows.length }}
          条（按效期先后）；全部见库存物料页临期提醒。
        </div>
        <Table
          v-if="report.batches.rows.length > 0"
          :columns="batchColumns"
          :data-source="report.batches.rows"
          :pagination="false"
          :row-key="
            (r: { batchNo: string; code: string; warehouse: string }) =>
              `${r.code}|${r.warehouse}|${r.batchNo}`
          "
          size="small"
          class="mt-2"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'daysLeft'">
              <Tag
                :color="
                  (record as { daysLeft: number }).daysLeft < 0
                    ? 'red'
                    : 'orange'
                "
              >
                {{
                  (record as { daysLeft: number }).daysLeft < 0
                    ? `已过期 ${-(record as { daysLeft: number }).daysLeft} 天`
                    : `还剩 ${(record as { daysLeft: number }).daysLeft} 天`
                }}
              </Tag>
            </template>
          </template>
        </Table>
      </Card>

      <Card class="mb-3" size="small" :title="`预警（${report.month}）`">
        <Descriptions :column="3" size="small">
          <Descriptions.Item label="本月新进场">
            {{ report.alerts.raised }}
          </Descriptions.Item>
          <Descriptions.Item label="本月自动消除">
            {{ report.alerts.closed }}
          </Descriptions.Item>
          <Descriptions.Item label="当前未消除">
            <span
              :class="
                report.alerts.openNow > 0 ? 'font-medium text-red-600' : ''
              "
              >{{ report.alerts.openNow }}</span>
          </Descriptions.Item>
        </Descriptions>
        <div class="mt-1 text-xs text-gray-500">
          分来源：库存安全线
          {{ report.alerts.raisedBySource['scan.supply.below_safety'] ?? 0 }} ·
          到货逾期
          {{ report.alerts.raisedBySource['scan.supply.po_overdue'] ?? 0 }} ·
          批次临期
          {{ report.alerts.raisedBySource['scan.supply.expiry_near'] ?? 0 }}
        </div>
      </Card>

      <Card size="small" title="口径说明">
        <ul class="list-disc pl-5 text-xs text-gray-500">
          <li v-for="(n, i) in report.notes" :key="i">{{ n }}</li>
        </ul>
      </Card>
    </template>
  </div>
</template>

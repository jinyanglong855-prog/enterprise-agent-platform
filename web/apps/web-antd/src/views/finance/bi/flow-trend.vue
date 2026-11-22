<script lang="ts" setup>
// 近 N 个月收支柱状 + 利润参考趋势线（数据源：父组件逐月 summary，口径与工具一致）
import type { EchartsUIType } from '@vben/plugins/echarts';

import { onMounted, ref, watch } from 'vue';

import { EchartsUI, useEcharts } from '@vben/plugins/echarts';

export interface FlowPoint {
  income: number;
  month: string;
  outflow: number;
  profit: number;
}

const props = defineProps<{ points: FlowPoint[] }>();

const chartRef = ref<EchartsUIType>();
const { renderEcharts, resize } = useEcharts(chartRef);

/** 硬刷新时页面进场动画/字体加载会让容器宽度晚于首次渲染就位：渲染后补一次 resize，避免瞬态挤压停留（后续尺寸变化仍有 ResizeObserver 兜底）。 */
function renderThenResize(options: Parameters<typeof renderEcharts>[0]) {
  void renderEcharts(options);
  window.setTimeout(() => resize(), 400);
}

function fmtWan(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return Math.abs(n) >= 10_000
    ? `${(n / 10_000).toFixed(Math.abs(n % 10_000) > 0 ? 1 : 0)}万`
    : `${n}`;
}
function fmtYuan(value: unknown): string {
  const n = Number(value);
  return `${(Number.isFinite(n) ? n : 0).toLocaleString('zh-CN', { maximumFractionDigits: 2, minimumFractionDigits: 2 })} 元`;
}

function render() {
  if (chartRef.value === undefined) return;
  // 近 6 个月全 0（新库/新装机）：不画 0-1 的假坐标轴，直接一句人话
  if (
    props.points.every(
      (p) => p.income === 0 && p.outflow === 0 && p.profit === 0,
    )
  ) {
    void renderEcharts({
      graphic: [
        {
          left: 'center',
          style: { fill: '#666', text: '近 6 个月还没有账目记录' },
          top: 'middle',
          type: 'text',
        },
      ],
    });
    return;
  }
  renderThenResize({
    grid: { bottom: 40, containLabel: true, left: 8, right: 8, top: 32 },
    legend: { bottom: 0 },
    series: [
      {
        barMaxWidth: 26,
        data: props.points.map((p) => p.income),
        itemStyle: { borderRadius: [3, 3, 0, 0] },
        name: '收入',
        type: 'bar',
      },
      {
        barMaxWidth: 26,
        data: props.points.map((p) => p.outflow),
        itemStyle: { borderRadius: [3, 3, 0, 0] },
        name: '流出',
        type: 'bar',
      },
      {
        data: props.points.map((p) => p.profit),
        lineStyle: { width: 2 },
        name: '利润参考',
        smooth: true,
        type: 'line',
      },
    ],
    tooltip: { trigger: 'axis', valueFormatter: fmtYuan },
    xAxis: { data: props.points.map((p) => p.month), type: 'category' },
    yAxis: { axisLabel: { formatter: fmtWan }, type: 'value' },
  });
}

onMounted(render);
watch(() => props.points, render);
</script>

<template>
  <EchartsUI ref="chartRef" height="300px" />
</template>

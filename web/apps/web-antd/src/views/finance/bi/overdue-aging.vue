<script lang="ts" setup>
// 逾期未结账龄分桶（1-30/31-60/61-90/90+ 天）：每桶分"应收逾期"（该收没收）与"应付逾期"（该付没付）两根条，
// 桶金额=未结余额合计；方向分开，老板一眼看出是别人欠我还是我欠别人
import type { EchartsUIType } from '@vben/plugins/echarts';

import { onMounted, ref, watch } from 'vue';

import { EchartsUI, useEcharts } from '@vben/plugins/echarts';

export interface AgingBucket {
  count: number;
  label: string;
  payable: number;
  receivable: number;
}

const props = defineProps<{ buckets: AgingBucket[] }>();

const chartRef = ref<EchartsUIType>();
const { renderEcharts, resize } = useEcharts(chartRef);

/** 硬刷新时页面进场动画/字体加载会让容器宽度晚于首次渲染就位：渲染后补一次 resize，避免瞬态挤压停留（后续尺寸变化仍有 ResizeObserver 兜底）。 */
function renderThenResize(options: Parameters<typeof renderEcharts>[0]) {
  void renderEcharts(options);
  window.setTimeout(() => resize(), 400);
}

function fmt(value: unknown): string {
  const n = Number(value);
  return n > 0 ? n.toLocaleString('zh-CN') : '';
}

function render() {
  if (chartRef.value === undefined) return;
  if (props.buckets.every((b) => b.count === 0)) {
    void renderEcharts({
      graphic: [
        {
          left: 'center',
          style: { fill: '#666', text: '没有逾期未结的账' },
          top: 'middle',
          type: 'text',
        },
      ],
    });
    return;
  }
  renderThenResize({
    grid: { bottom: 36, containLabel: true, left: 8, right: 56, top: 16 },
    legend: { bottom: 0 },
    series: [
      {
        barMaxWidth: 18,
        data: props.buckets.map((b) => b.receivable),
        itemStyle: { borderRadius: [0, 3, 3, 0], color: '#e06666' },
        label: {
          formatter: (p) => fmt(p.value),
          position: 'right',
          show: true,
        },
        name: '应收逾期（该收没收）',
        type: 'bar',
      },
      {
        barMaxWidth: 18,
        data: props.buckets.map((b) => b.payable),
        itemStyle: { borderRadius: [0, 3, 3, 0], color: '#f0ad4e' },
        label: {
          formatter: (p) => fmt(p.value),
          position: 'right',
          show: true,
        },
        name: '应付逾期（该付没付）',
        type: 'bar',
      },
    ],
    tooltip: {
      trigger: 'axis',
      valueFormatter: (value) =>
        `${Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 2, minimumFractionDigits: 2 })} 元`,
    },
    xAxis: { type: 'value' },
    yAxis: {
      data: props.buckets.map((b) => `${b.label}（${b.count} 笔）`),
      type: 'category',
    },
  });
}

onMounted(render);
watch(() => props.buckets, render);
</script>

<template>
  <EchartsUI ref="chartRef" height="300px" />
</template>

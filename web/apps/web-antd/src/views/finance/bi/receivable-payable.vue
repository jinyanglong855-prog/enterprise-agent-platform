<script lang="ts" setup>
// 应收 vs 应付（已收/未收、已付/未付）横向堆叠条——本月口径，数据源：summary.byType
import type { EchartsUIType } from '@vben/plugins/echarts';

import { onMounted, ref, watch } from 'vue';

import { EchartsUI, useEcharts } from '@vben/plugins/echarts';

export interface SettledSplit {
  /** 已收（应付侧=已付） */
  paid: number;
  /** 未收（应付侧=未付） */
  outstanding: number;
}

const props = defineProps<{
  income: null | SettledSplit;
  outflow: null | SettledSplit;
}>();

const chartRef = ref<EchartsUIType>();
const { renderEcharts, resize } = useEcharts(chartRef);

/** 硬刷新时页面进场动画/字体加载会让容器宽度晚于首次渲染就位：渲染后补一次 resize，避免瞬态挤压停留（后续尺寸变化仍有 ResizeObserver 兜底）。 */
function renderThenResize(options: Parameters<typeof renderEcharts>[0]) {
  void renderEcharts(options);
  window.setTimeout(() => resize(), 400);
}

function render() {
  if (chartRef.value === undefined) return;
  if (
    props.income === null ||
    props.outflow === null ||
    // 本月一笔账都没有：不画 0-1 的假坐标轴
    (props.income.paid + props.income.outstanding === 0 &&
      props.outflow.paid + props.outflow.outstanding === 0)
  ) {
    void renderEcharts({
      graphic: [
        {
          left: 'center',
          style: { fill: '#666', text: '本月还没有账目记录' },
          top: 'middle',
          type: 'text',
        },
      ],
    });
    return;
  }
  renderThenResize({
    grid: { bottom: 8, containLabel: true, left: 8, right: 40, top: 32 },
    legend: { top: 0 },
    series: [
      {
        data: [props.income.paid, props.outflow.paid],
        itemStyle: { borderRadius: [3, 0, 0, 3] },
        label: {
          formatter: (p: { value: unknown }) =>
            Number(p.value) > 0 ? Number(p.value).toLocaleString('zh-CN') : '',
          show: true,
        },
        name: '已收/已付',
        stack: 'total',
        type: 'bar',
      },
      {
        data: [props.income.outstanding, props.outflow.outstanding],
        itemStyle: { borderRadius: [0, 3, 3, 0] },
        label: {
          formatter: (p: { value: unknown }) =>
            Number(p.value) > 0 ? Number(p.value).toLocaleString('zh-CN') : '',
          show: true,
        },
        name: '未收/未付',
        stack: 'total',
        type: 'bar',
      },
    ],
    tooltip: {
      trigger: 'axis',
      valueFormatter: (value) =>
        `${Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 2, minimumFractionDigits: 2 })} 元`,
    },
    xAxis: { type: 'value' },
    yAxis: { data: ['收入（应收）', '流出（应付）'], type: 'category' },
  });
}

onMounted(render);
watch([() => props.income, () => props.outflow], render);
</script>

<template>
  <EchartsUI ref="chartRef" height="300px" />
</template>

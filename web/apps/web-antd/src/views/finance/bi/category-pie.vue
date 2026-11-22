<script lang="ts" setup>
// 本月流出分类占比环形图（数据源：summary.byCategory，后端已只统计流出类、排除空分类）
import type { EchartsUIType } from '@vben/plugins/echarts';

import { onMounted, ref, watch } from 'vue';

import { EchartsUI, useEcharts } from '@vben/plugins/echarts';

export interface CategorySlice {
  category: string;
  total: number;
}

const props = defineProps<{ rows: CategorySlice[] }>();

const chartRef = ref<EchartsUIType>();
const { renderEcharts, resize } = useEcharts(chartRef);

/** 硬刷新时页面进场动画/字体加载会让容器宽度晚于首次渲染就位：渲染后补一次 resize，避免瞬态挤压停留（后续尺寸变化仍有 ResizeObserver 兜底）。 */
function renderThenResize(options: Parameters<typeof renderEcharts>[0]) {
  void renderEcharts(options);
  window.setTimeout(() => resize(), 400);
}

function render() {
  if (chartRef.value === undefined) return;
  if (props.rows.length === 0) {
    void renderEcharts({
      graphic: [
        {
          left: 'center',
          style: { fill: '#666', text: '暂无支出分类数据' },
          top: 'middle',
          type: 'text',
        },
      ],
    });
    return;
  }
  renderThenResize({
    legend: { bottom: 0, type: 'scroll' },
    series: [
      {
        avoidLabelOverlap: true,
        data: props.rows.map((r) => ({ name: r.category, value: r.total })),
        label: { formatter: '{b}: {d}%' },
        name: '支出分类',
        radius: ['40%', '68%'],
        type: 'pie',
      },
    ],
    tooltip: {
      trigger: 'item',
      valueFormatter: (value) =>
        `${Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 2, minimumFractionDigits: 2 })} 元`,
    },
  });
}

onMounted(render);
watch(() => props.rows, render);
</script>

<template>
  <EchartsUI ref="chartRef" height="300px" />
</template>

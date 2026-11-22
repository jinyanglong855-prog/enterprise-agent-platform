<script lang="ts" setup>
// 待办行（2026-10-31 待办预警方案 §七；同日二批按用户口述定版）：一条义务的展示与动作。
// 按钮口径：人工待办 =「修改」「已完成」（可填备注）；系统推导 =「修改」「暂不处理」「已完成」——
// 「已完成」由后端先核实源头（消失→闭合；还在→告知并恢复提醒；无法核实→填备注强制确认）。
// 点标题打开详情抽屉（信息 + 处理流程 + 时间线）。动作由父组件调后端。
// 动作按钮按 todo:write 显隐（2026-11-02 对抗审查 P2-1 统一全站口径：只读角色不看会 403 的按钮）；
// 后端仍逐请求鉴权，前端显隐只是不让人白点。
import type { Obligation } from '#/api/todos';

import { computed } from 'vue';
import { useRouter } from 'vue-router';

import { useAccess } from '@vben/access';

import { Button, Tag } from 'ant-design-vue';
import dayjs from 'dayjs';

import { TODO_SEVERITY_COLOR, TODO_SOURCE_LABELS } from '#/constants/labels';
import { todoEntityLink } from '#/utils/entity-links';

const props = defineProps<{
  item: Obligation;
  showOwner?: boolean;
}>();

const emit = defineEmits<{
  (e: 'complete', item: Obligation): void;
  (e: 'ack', item: Obligation): void;
  (e: 'edit', item: Obligation): void;
  (e: 'open', item: Obligation): void;
}>();

const { hasAccessByCodes } = useAccess();
const canWrite = hasAccessByCodes(['todo:write']);

const router = useRouter();
/** source_ref 里的实体编号 → 直达链接（如"看这笔账""去确认"）；没有对应实体的类型为 undefined。 */
const entityLink = computed(() =>
  todoEntityLink(props.item.source_type, props.item.source_ref),
);

const STATUS_LABEL: Record<string, string> = {
  open: '待处理',
  escalated: '已逾期',
  resolved: '已消除',
  dismissed: '已确认完成',
  done: '已完成',
};

const active = computed(
  () => props.item.status === 'open' || props.item.status === 'escalated',
);
const isManual = computed(() => props.item.origin === 'manual');
const sourceLabel = computed(
  () => TODO_SOURCE_LABELS[props.item.source_type] ?? props.item.source_type,
);
const muted = computed(() => props.item.last_notified.startsWith('ack:'));

/** 关闭时留下的话：强制确认/静默的备注，或完成/核实闭合时填的备注。 */
const noteText = computed(() => {
  const it = props.item;
  if (it.status === 'dismissed') return it.dismissed_reason;
  if ((it.status === 'done' || it.status === 'resolved') && it.done_note)
    return it.done_note;
  return '';
});

/** 到期人话：已逾期 N 天 / 今天到期 / 明天 / N 天后 / 无固定到期日。 */
const dueText = computed(() => {
  const d = props.item.due_date;
  if (d === '') return '无固定到期日';
  const diff = dayjs(d).startOf('day').diff(dayjs().startOf('day'), 'day');
  if (diff < 0) return `已逾期 ${-diff} 天（${d}）`;
  if (diff === 0) return `今天到期（${d}）`;
  if (diff === 1) return `明天到期（${d}）`;
  return `${diff} 天后到期（${d}）`;
});

const dueClass = computed(() => {
  const d = props.item.due_date;
  if (d === '' || !active.value) return 'text-gray-500';
  const diff = dayjs(d).startOf('day').diff(dayjs().startOf('day'), 'day');
  if (diff < 0) return 'text-red-600 font-medium';
  if (diff === 0) return 'text-orange-600 font-medium';
  return 'text-gray-600';
});
</script>

<template>
  <div
    class="flex items-start justify-between gap-3 border-b py-2 last:border-b-0"
  >
    <div class="min-w-0 flex-1">
      <div class="flex flex-wrap items-center gap-1">
        <Tag :color="TODO_SEVERITY_COLOR[item.severity]" class="mr-0">
          {{
            item.severity === 'critical'
              ? '紧急'
              : item.severity === 'warn'
                ? '提醒'
                : '一般'
          }}
        </Tag>
        <button
          class="text-left font-medium hover:text-blue-600 hover:underline"
          title="查看详情与处理流程"
          type="button"
          @click="emit('open', item)"
        >
          {{ item.title }}
        </button>
        <Tag v-if="!active" class="ml-1">
          {{ STATUS_LABEL[item.status] ?? item.status }}
        </Tag>
        <Tag
          v-if="muted && active"
          class="ml-1"
          color="default"
          title="已标记暂不处理：不再推送，到期升级时再提醒一次"
        >
          暂不处理中
        </Tag>
        <Tag
          v-if="!isManual && active && item.user_edited === 1"
          class="ml-1"
          color="purple"
          title="到期/严重度/责任人经人工调整，系统自动检查不再覆盖这三项"
        >
          已调整
        </Tag>
      </div>
      <div class="mt-1 text-xs text-gray-500">
        <span :class="dueClass">{{ dueText }}</span>
        <span class="mx-1">·</span>
        <span>{{ sourceLabel }}</span>
        <template v-if="showOwner">
          <span class="mx-1">·</span>
          <span>{{
            item.owner_type === 'role'
              ? `岗位：${item.owner_id}`
              : `负责人：${item.owner_id}`
          }}</span>
        </template>
        <template v-if="noteText">
          <span class="mx-1">·</span>
          <span>备注：{{ noteText }}</span>
        </template>
      </div>
      <p
        v-if="item.detail"
        class="mt-1 whitespace-pre-wrap text-xs text-gray-600"
      >
        {{ item.detail }}
      </p>
    </div>
    <div
      v-if="active"
      class="flex shrink-0 flex-wrap items-start justify-end gap-1"
    >
      <Button
        v-if="entityLink"
        size="small"
        type="link"
        @click="router.push(entityLink.to)"
      >
        {{ entityLink.text }}
      </Button>
      <template v-if="canWrite">
        <Button size="small" @click="emit('edit', item)">修改</Button>
        <Button
          v-if="!isManual && !muted"
          size="small"
          title="不再推送这条（待办中心仍可见），到期升级时再提醒一次"
          @click="emit('ack', item)"
        >
          暂不处理
        </Button>
        <Button size="small" type="primary" @click="emit('complete', item)">
          已完成
        </Button>
      </template>
    </div>
  </div>
</template>

<script lang="ts" setup>
import type { EntryInput, ImportPayload, ProposalRecord } from '#/api/finance';

import { computed, ref } from 'vue';

import { useAccess } from '@vben/access';

import { Button, message, Modal, Tag } from 'ant-design-vue';

import {
  confirmProposalApi,
  isImportPayload,
  rejectProposalApi,
  STATUS_LABELS,
  TYPE_LABELS,
} from '#/api/finance';

const props = defineProps<{ proposal: ProposalRecord }>();
const emit = defineEmits<{ resolved: [] }>();

// 与待确认记账页同口径：确认/拒绝走 finance:write，只读角色看卡片但不给会 403 的按钮
const { hasAccessByCodes } = useAccess();
const canWrite = hasAccessByCodes(['finance:write']);

const busy = ref(false);

const importPayload = computed<ImportPayload | undefined>(() =>
  props.proposal.kind === 'import' && isImportPayload(props.proposal.payload)
    ? props.proposal.payload
    : undefined,
);
const importRows = computed<EntryInput[]>(
  () => importPayload.value?.rows ?? [],
);
/** 卡片里最多展开前 5 行，全量看 summary/确认后进台账。 */
const previewRows = computed(() => importRows.value.slice(0, 5));

function singlePayload(): EntryInput | undefined {
  return props.proposal.kind === 'single' &&
    !isImportPayload(props.proposal.payload)
    ? props.proposal.payload
    : undefined;
}

async function onConfirm() {
  if (busy.value) return;
  busy.value = true;
  try {
    const r = await confirmProposalApi(props.proposal.id);
    if (r.entries) {
      message.success(
        `已批量入账 ${r.entries.length} 笔（批次 ${r.batch}），可在台账查看`,
      );
    } else if (r.entry) {
      message.success(`已入账 ${r.entry.id}`);
    }
    emit('resolved');
  } catch (error) {
    message.error(`确认失败：${(error as Error)?.message ?? error}`);
  } finally {
    busy.value = false;
  }
}

function onReject() {
  Modal.confirm({
    content: '拒绝后智能助手会重新拟一版；可以在对话里告诉它哪里不对。',
    okText: '拒绝',
    okType: 'danger',
    onOk: async () => {
      try {
        await rejectProposalApi(props.proposal.id, '负责人在卡片上拒绝');
        message.success('已拒绝');
        emit('resolved');
      } catch (error) {
        message.error(`操作失败：${(error as Error)?.message ?? error}`);
      }
    },
    title: '拒绝这张记账单？',
  });
}
</script>

<template>
  <div class="proposal-card">
    <div class="proposal-head">
      <Tag color="orange">待确认</Tag>
      <b>{{ proposal.summary }}</b>
      <span class="proposal-id">{{ proposal.id }}</span>
    </div>

    <!-- 单笔记账卡 -->
    <div v-if="singlePayload()" class="proposal-detail">
      <template
        v-for="(v, k) in {
          type: singlePayload()?.type
            ? (TYPE_LABELS[singlePayload()!.type as keyof typeof TYPE_LABELS] ??
              singlePayload()?.type)
            : undefined,
          amount:
            singlePayload()?.amount !== undefined
              ? `${singlePayload()?.amount} 元`
              : undefined,
          date: singlePayload()?.date,
          counterparty: singlePayload()?.counterparty
            ? `对方 ${singlePayload()?.counterparty}`
            : undefined,
          account: singlePayload()?.account
            ? `走 ${singlePayload()?.account}`
            : undefined,
          category: singlePayload()?.category,
          status: singlePayload()?.status
            ? `状态 ${STATUS_LABELS[singlePayload()!.status as keyof typeof STATUS_LABELS] ?? singlePayload()?.status}`
            : undefined,
          due_date: singlePayload()?.due_date
            ? `到期 ${singlePayload()?.due_date}`
            : undefined,
          note: singlePayload()?.note,
        }"
        :key="k"
      >
        <span v-if="v">{{ v }}</span>
      </template>
    </div>

    <!-- 批量导入卡：前 5 行预览 -->
    <template v-else-if="importPayload">
      <div v-if="importPayload.note" class="proposal-detail">
        <span>来源：{{ importPayload.note }}</span>
      </div>
      <table class="proposal-table">
        <thead>
          <tr>
            <th>日期</th>
            <th>类型</th>
            <th class="num">金额</th>
            <th>对方</th>
            <th>账户</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, i) in previewRows" :key="i">
            <td>{{ row.date }}</td>
            <td>
              {{
                TYPE_LABELS[row.type as keyof typeof TYPE_LABELS] ?? row.type
              }}
            </td>
            <td class="num">{{ row.amount }}</td>
            <td>{{ row.counterparty }}</td>
            <td>{{ row.account || '—' }}</td>
            <td>
              {{
                row.status
                  ? (STATUS_LABELS[row.status as keyof typeof STATUS_LABELS] ??
                    row.status)
                  : '—'
              }}
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="importRows.length > 5" class="proposal-more">
        …其余 {{ importRows.length - 5 }} 笔，确认后进台账查看
      </div>
    </template>

    <div class="proposal-actions">
      <template v-if="canWrite">
        <Button :loading="busy" size="small" type="primary" @click="onConfirm">
          {{ importPayload ? '确认导入' : '确认入账' }}
        </Button>
        <Button :disabled="busy" size="small" @click="onReject">拒绝</Button>
        <span class="proposal-hint">
          {{
            importPayload
              ? `确认后 ${importRows.length} 笔一次性入账，导入不成功整批不落`
              : '确认前这笔账不在账本里'
          }}
        </span>
      </template>
      <span v-else class="proposal-hint">
        无入账权限（只能查看）——这笔要由有入账权限的同事在「待确认记账」里确认
      </span>
    </div>
  </div>
</template>

<style scoped>
.proposal-card {
  padding: 10px 12px;
  background: hsl(var(--card));
  border: 1px solid hsl(var(--primary) / 30%);
  border-radius: 8px;
}

.proposal-head {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.proposal-id {
  font-size: 12px;
  color: hsl(var(--foreground) / 45%);
}

.proposal-detail {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin: 6px 0 8px;
  font-size: 12px;
  color: hsl(var(--foreground) / 70%);
}

.proposal-table {
  width: 100%;
  margin: 6px 0 4px;
  font-size: 12px;
  border-collapse: collapse;
}

.proposal-table th,
.proposal-table td {
  padding: 3px 6px;
  text-align: left;
  white-space: nowrap;
  border-bottom: 1px solid hsl(var(--foreground) / 10%);
}

.proposal-table th {
  font-weight: 500;
  color: hsl(var(--foreground) / 50%);
}

.proposal-table .num {
  text-align: right;
}

.proposal-more {
  margin-bottom: 6px;
  font-size: 12px;
  color: hsl(var(--foreground) / 45%);
}

.proposal-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.proposal-hint {
  font-size: 12px;
  color: hsl(var(--foreground) / 40%);
}
</style>

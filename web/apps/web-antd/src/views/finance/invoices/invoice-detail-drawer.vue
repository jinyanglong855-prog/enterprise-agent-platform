<script lang="ts" setup>
import type {
  EntryRecord,
  InvoiceMatchSuggestion,
  InvoiceRecord,
} from '#/api/finance';

import { ref, watch } from 'vue';
import { useRouter } from 'vue-router';

import { useAccess } from '@vben/access';

import {
  Button,
  Descriptions,
  Drawer,
  Input,
  message,
  Table,
  Tag,
} from 'ant-design-vue';

import {
  getEntryApi,
  INVOICE_KIND_LABELS,
  INVOICE_STATUS_LABELS,
  linkInvoiceApi,
  listInvoiceMatchesApi,
  STATUS_LABELS,
  TYPE_LABELS,
  unlinkInvoiceApi,
} from '#/api/finance';
import { INVOICE_STATUS_COLORS } from '#/constants/labels';
import { ledgerLink } from '#/utils/entity-links';

const props = defineProps<{
  open: boolean;
  record?: InvoiceRecord;
}>();

const emit = defineEmits<{
  changed: [InvoiceRecord];
  'update:open': [boolean];
}>();

const router = useRouter();
const { hasAccessByCodes } = useAccess();
const canWrite = hasAccessByCodes(['finance:write']);

const linked = ref<EntryRecord[]>([]);
const linkLoading = ref(false);
const linking = ref(false);
const linkInput = ref('');

// ---------------- 猜该挂的账（只读建议，挂联仍是人的写动作） ----------------

const suggestions = ref<InvoiceMatchSuggestion[]>([]);
const suggestLoading = ref(false);
const linkingEntryId = ref('');

async function loadSuggestions() {
  if (!props.record) return;
  suggestLoading.value = true;
  try {
    const body = await listInvoiceMatchesApi(props.record.id);
    suggestions.value = body.suggestions;
  } catch (error) {
    suggestions.value = [];
    console.error('猜挂加载失败', error);
  } finally {
    suggestLoading.value = false;
  }
}

async function onLinkSuggestion(s: InvoiceMatchSuggestion) {
  if (!props.record) return;
  linkingEntryId.value = s.entry_id;
  try {
    const rec = await linkInvoiceApi(props.record.id, s.entry_id);
    message.success(`已关联 ${s.entry_id}`);
    emit('changed', rec);
  } catch (error) {
    console.error('挂联失败', error); // 拦截器已弹后端文案，这里只记日志
  } finally {
    linkingEntryId.value = '';
  }
}

const suggestColumns = [
  { dataIndex: 'entry_id', key: 'id', title: '账目', width: 150 },
  { dataIndex: 'date', key: 'date', title: '日期', width: 95 },
  { key: 'type', title: '类型', width: 64 },
  {
    dataIndex: 'amount',
    key: 'amount',
    title: '金额(元)',
    align: 'right' as const,
    width: 85,
  },
  { key: 'reason', title: '猜的依据', ellipsis: true },
  { key: 'actions', title: '', width: 70 },
];

let fetchSeq = 0;

async function fetchLinked(ids: string[]) {
  // 挂联列表只有编号，逐个取详情让"挂了哪笔账"看得懂；失败的条目退回只显编号。
  // 快速连续挂联/换票时旧请求可能后到，用序号丢弃过期结果
  const seq = ++fetchSeq;
  linkLoading.value = true;
  const results = await Promise.allSettled(ids.map((id) => getEntryApi(id)));
  if (seq !== fetchSeq) return;
  linked.value = results.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : ({ id: ids[i] } as unknown as EntryRecord),
  );
  linkLoading.value = false;
}

// 挂联/解挂不改票的 updated_at，所以盯 entry_ids 本身：父页换成新票对象时这里跟着刷
watch(
  () =>
    [props.open, props.record?.id, props.record?.entry_ids.join(',')] as const,
  ([open]) => {
    if (!open || !props.record) return;
    void fetchLinked(props.record.entry_ids);
    void loadSuggestions(); // 挂联后已挂的候选自动从建议里消失
  },
  { immediate: true },
);

async function onLink() {
  if (!props.record) return;
  const entryId = linkInput.value.trim();
  if (!entryId)
    return message.warning('请填要关联的账目编号（FIN-YYYYMMDD-NNN）');
  linking.value = true;
  try {
    const rec = await linkInvoiceApi(props.record.id, entryId);
    message.success(`已关联 ${entryId}`);
    linkInput.value = '';
    emit('changed', rec);
  } catch (error) {
    console.error('挂联失败', error); // 拦截器已弹后端文案，这里只记日志
  } finally {
    linking.value = false;
  }
}

async function onUnlink(entryId: string) {
  if (!props.record) return;
  try {
    const rec = await unlinkInvoiceApi(props.record.id, entryId);
    message.success(`已取消关联 ${entryId}`);
    emit('changed', rec);
  } catch (error) {
    console.error('解挂失败', error); // 拦截器已弹后端文案，这里只记日志
  }
}

// 固定列合计须小于抽屉内容宽（640 − 48 内边距），否则"对方"弹性列会被挤到零宽
const columns = [
  { dataIndex: 'id', key: 'id', title: '账目编号', width: 160 },
  { dataIndex: 'date', key: 'date', title: '日期', width: 100 },
  { key: 'type', title: '类型', width: 64 },
  {
    dataIndex: 'amount',
    key: 'amount',
    title: '金额(元)',
    align: 'right' as const,
    width: 90,
  },
  {
    dataIndex: 'counterparty',
    key: 'counterparty',
    title: '对方',
    ellipsis: true,
  },
  { key: 'actions', title: '', width: 110 },
];
</script>

<template>
  <Drawer
    :open="open"
    :title="record?.id"
    width="640"
    @close="emit('update:open', false)"
  >
    <template v-if="record">
      <!-- ant-design-vue 4.x 的 Descriptions 没有 items prop（那是 React 版 API），必须用 Item 子组件 -->
      <Descriptions :column="1" bordered size="small">
        <Descriptions.Item label="方向">
          {{ INVOICE_KIND_LABELS[record.kind] ?? record.kind }}
        </Descriptions.Item>
        <Descriptions.Item label="票号">
          {{ record.number || '—' }}
        </Descriptions.Item>
        <Descriptions.Item label="开票日期">
          {{ record.date }}
        </Descriptions.Item>
        <Descriptions.Item v-if="record.status === 'red'" label="红冲执行日">
          {{ record.red_date || '未记（老红票，销项汇总按票期估算）' }}
        </Descriptions.Item>
        <Descriptions.Item label="票面金额">
          {{ record.amount }} 元
        </Descriptions.Item>
        <Descriptions.Item label="对方单位">
          {{ record.counterparty || '—' }}
        </Descriptions.Item>
        <Descriptions.Item label="状态">
          <Tag :color="INVOICE_STATUS_COLORS[record.status] ?? 'default'">
            {{ INVOICE_STATUS_LABELS[record.status] ?? record.status }}
          </Tag>
        </Descriptions.Item>
        <Descriptions.Item label="备注">
          {{ record.note || '—' }}
        </Descriptions.Item>
        <Descriptions.Item label="最后更新">
          {{ record.updated_by }} · {{ record.updated_at }}
        </Descriptions.Item>
      </Descriptions>

      <div class="mt-4 mb-2 text-sm font-medium text-gray-500">
        关联账目（{{
          record.entry_ids.length
        }}）——票与账的证据链，一笔账可收多张票，一张票可关联多笔账
      </div>
      <Table
        :columns="columns"
        :data-source="linked"
        :loading="linkLoading"
        :pagination="false"
        row-key="id"
        size="small"
      >
        <template #bodyCell="{ column, record: entry }">
          <template v-if="column.key === 'type'">
            {{
              TYPE_LABELS[(entry as EntryRecord).type] ??
              (entry as EntryRecord).type ??
              '—'
            }}
          </template>
          <template v-else-if="column.key === 'actions'">
            <Button
              v-if="(entry as EntryRecord).type"
              size="small"
              type="link"
              @click="
                router.push(ledgerLink({ id: (entry as EntryRecord).id }))
              "
            >
              看账
            </Button>
            <Button
              v-if="canWrite"
              danger
              size="small"
              type="link"
              @click="onUnlink((entry as EntryRecord).id)"
            >
              取消关联
            </Button>
          </template>
          <template
            v-else-if="column.key === 'id' && !(entry as EntryRecord).type"
          >
            {{ (entry as EntryRecord).id }}（详情加载失败）
          </template>
          <template v-else-if="column.key === 'id'">
            <div>{{ (entry as EntryRecord).id }}</div>
            <Tag
              v-if="(entry as EntryRecord).status === 'cancelled'"
              color="default"
            >
              已作废
            </Tag>
            <div
              v-else-if="(entry as EntryRecord).status"
              class="text-xs text-gray-400"
            >
              {{ STATUS_LABELS[(entry as EntryRecord).status] }}
            </div>
          </template>
        </template>
      </Table>

      <template v-if="canWrite">
        <div class="mt-3 flex items-center gap-2">
          <Input
            v-model:value="linkInput"
            class="flex-1"
            placeholder="账目编号，如 FIN-20261005-001"
            @press-enter="onLink"
          />
          <Button :loading="linking" type="primary" @click="onLink">
            关联
          </Button>
        </div>

        <div class="mt-4 mb-2 text-sm font-medium text-gray-500">
          推荐关联的账目（{{
            suggestions.length
          }}）——按金额/日期/对方自动配，是否关联由人确认
        </div>
        <Table
          v-if="suggestions.length > 0"
          :columns="suggestColumns"
          :data-source="suggestions"
          :loading="suggestLoading"
          :pagination="false"
          row-key="entry_id"
          size="small"
        >
          <template #bodyCell="{ column, record: s }">
            <template v-if="column.key === 'type'">
              {{
                TYPE_LABELS[
                  (s as InvoiceMatchSuggestion)
                    .type as keyof typeof TYPE_LABELS
                ] ?? (s as InvoiceMatchSuggestion).type
              }}
            </template>
            <template v-else-if="column.key === 'reason'">
              <Tag class="mr-1" color="blue">
                {{ (s as InvoiceMatchSuggestion).score }} 分
              </Tag>
              <span class="text-xs">{{
                (s as InvoiceMatchSuggestion).reason
              }}</span>
            </template>
            <template v-else-if="column.key === 'actions'">
              <Button
                :loading="
                  linkingEntryId === (s as InvoiceMatchSuggestion).entry_id
                "
                size="small"
                type="link"
                @click="onLinkSuggestion(s as InvoiceMatchSuggestion)"
              >
                关联
              </Button>
            </template>
          </template>
        </Table>
        <div v-else-if="!suggestLoading" class="text-sm text-gray-400">
          没有够格的候选（台账里还没有金额/日期/对方对得上的在账账目）
        </div>
      </template>
    </template>
  </Drawer>
</template>

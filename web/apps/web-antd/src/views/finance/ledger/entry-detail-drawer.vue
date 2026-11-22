<script lang="ts" setup>
import type {
  AttachmentRecord,
  EntryMatchSuggestion,
  EntryRecord,
} from '#/api/finance';

import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';

import { useAccess } from '@vben/access';

import {
  Button,
  Descriptions,
  Drawer,
  Input,
  message,
  Popconfirm,
  Table,
  Tag,
  Timeline,
  Upload,
} from 'ant-design-vue';

import {
  addAttachmentApi,
  deleteAttachmentApi,
  downloadAttachmentApi,
  fileToBase64,
  INVOICE_KIND_LABELS,
  linkInvoiceApi,
  listAttachmentsApi,
  listEntryMatchesApi,
  STATUS_LABELS,
  TYPE_LABELS,
} from '#/api/finance';
import { invoiceLink } from '#/utils/entity-links';

const props = defineProps<{
  open: boolean;
  record?: EntryRecord;
}>();

const emit = defineEmits<{
  changed: [EntryRecord];
  'update:open': [boolean];
}>();

const router = useRouter();
const { hasAccessByCodes } = useAccess();
const canWrite = hasAccessByCodes(['finance:write']);

const items = computed(() => {
  const r = props.record;
  if (!r) return [];
  const list = [
    { children: r.id, key: 'id', label: '编号' },
    { children: `${r.amount} 元`, key: 'amount', label: '金额' },
    { children: `${r.paid_amount} 元`, key: 'paid', label: '已收付' },
    { children: TYPE_LABELS[r.type] ?? r.type, key: 'type', label: '类型' },
    {
      children: STATUS_LABELS[r.status] ?? r.status,
      key: 'status',
      label: '状态',
    },
    { children: r.date, key: 'date', label: '日期' },
    { children: r.due_date || '—', key: 'due', label: '到期日' },
    { children: r.counterparty || '—', key: 'counterparty', label: '对方' },
    { children: r.category || '—', key: 'category', label: '分类' },
    { children: r.account || '—', key: 'account', label: '账户' },
    { children: r.invoice_no || '—', key: 'invoice', label: '发票号' },
    {
      children: r.approved_by || r.created_by,
      key: 'approved',
      label: '谁认的',
    },
    { children: r.note || '—', key: 'note', label: '备注' },
    {
      children: `${r.updated_by} · ${r.updated_at}`,
      key: 'updated',
      label: '最后更新',
    },
  ];
  if (r.reverses) {
    list.splice(1, 0, {
      children: r.reverses,
      key: 'reverses',
      label: '冲销的是',
    });
  }
  if (r.reversed_by) {
    list.splice(1, 0, {
      children: r.reversed_by,
      key: 'reversed_by',
      label: '已被冲销为',
    });
  }
  return list;
});

// ---------------- 附件归档（回单/发票文件挂账目） ----------------

const attachments = ref<AttachmentRecord[]>([]);
const attachLoading = ref(false);
const uploading = ref(false);
const attachNote = ref('');

async function loadAttachments() {
  if (!props.record) return;
  attachLoading.value = true;
  try {
    const body = await listAttachmentsApi(props.record.id);
    attachments.value = body.attachments;
  } catch (error) {
    console.error('附件加载失败', error); // 拦截器已弹后端文案，这里只记日志
  } finally {
    attachLoading.value = false;
  }
}

function fmtSize(size: number): string {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(size / 1024))} KB`;
}

async function onUpload({ file }: { file: File }) {
  if (!props.record) return;
  uploading.value = true;
  try {
    const data = await fileToBase64(file);
    await addAttachmentApi(props.record.id, {
      data_base64: data,
      file_name: file.name,
      note: attachNote.value.trim() || undefined,
    });
    message.success(`已归档 ${file.name}`);
    attachNote.value = '';
    await loadAttachments();
  } catch (error) {
    console.error('上传失败', error); // 拦截器已弹后端文案（白名单/大小），这里只记日志
  } finally {
    uploading.value = false;
  }
}

async function onDownload(att: AttachmentRecord) {
  try {
    const blob = await downloadAttachmentApi(att.id);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = att.file_name;
    a.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error('下载失败', error); // 拦截器已弹后端文案，这里只记日志
  }
}

async function onRemoveAtt(att: AttachmentRecord) {
  try {
    await deleteAttachmentApi(att.id, '详情页摘除');
    message.success(
      `已摘除 ${att.file_name}（记录与文件仍留档，但界面上不再显示；恢复需管理员操作数据库）`,
    );
    await loadAttachments();
  } catch (error) {
    console.error('摘除失败', error);
  }
}

// ---------------- 猜该收的票（只读建议，挂联是写动作） ----------------

const suggestions = ref<EntryMatchSuggestion[]>([]);
const suggestLoading = ref(false);
const linkingId = ref('');

async function loadSuggestions() {
  if (!props.record) return;
  if (props.record.type === 'payroll' || props.record.type === 'tax') {
    suggestions.value = []; // 工资/税费不是发票的事，不出建议
    return;
  }
  suggestLoading.value = true;
  try {
    const body = await listEntryMatchesApi(props.record.id);
    suggestions.value = body.suggestions;
  } catch (error) {
    suggestions.value = [];
    console.error('猜挂加载失败', error);
  } finally {
    suggestLoading.value = false;
  }
}

async function onLinkSuggestion(s: EntryMatchSuggestion) {
  if (!props.record) return;
  linkingId.value = s.invoice_id;
  try {
    await linkInvoiceApi(s.invoice_id, props.record.id);
    message.success(`已关联 ${s.invoice_id}`);
    await Promise.all([loadSuggestions(), loadAttachments()]);
    emit('changed', props.record);
  } catch (error) {
    console.error('挂联失败', error); // 拦截器已弹后端文案，这里只记日志
  } finally {
    linkingId.value = '';
  }
}

watch(
  () => [props.open, props.record?.id] as const,
  ([open]) => {
    if (!open || !props.record) return;
    void loadAttachments();
    void loadSuggestions();
  },
  { immediate: true },
);

const suggestColumns = [
  { dataIndex: 'invoice_id', key: 'id', title: '票', width: 150 },
  { dataIndex: 'date', key: 'date', title: '日期', width: 95 },
  {
    dataIndex: 'amount',
    key: 'amount',
    title: '金额(元)',
    align: 'right' as const,
    width: 85,
  },
  { key: 'reason', title: '猜的依据', width: 170 },
  { key: 'actions', title: '', width: 70 },
];

const attachColumns = [
  { dataIndex: 'file_name', key: 'name', title: '文件', ellipsis: true },
  { dataIndex: 'created_at', key: 'meta', title: '归档于', width: 150 },
  { key: 'actions', title: '', width: 110 },
];
</script>

<template>
  <Drawer
    :open="open"
    :title="record?.id"
    width="560"
    @close="emit('update:open', false)"
  >
    <template v-if="record">
      <!-- ant-design-vue 4.x 的 Descriptions 没有 items prop（那是 React 版 API），必须用 Item 子组件 -->
      <Descriptions :column="1" bordered size="small">
        <Descriptions.Item v-for="it in items" :key="it.key" :label="it.label">
          {{ it.children }}
        </Descriptions.Item>
      </Descriptions>
      <!-- 填了票号直接去票夹定位这张票（双向证据链：票夹抽屉里也有"看账"跳回来） -->
      <Button
        v-if="record.invoice_no"
        class="mt-2"
        size="small"
        type="link"
        @click="router.push(invoiceLink({ no: record.invoice_no }))"
      >
        去票夹看这张票（{{ record.invoice_no }}）
      </Button>

      <div class="mt-4 mb-2 text-sm font-medium text-gray-500">
        附件归档（{{
          attachments.length
        }}）——回单/发票/合同文件挂在这笔账上，删除只是摘引用、文件不消灭
      </div>
      <Table
        :columns="attachColumns"
        :data-source="attachments"
        :loading="attachLoading"
        :pagination="false"
        row-key="id"
        size="small"
      >
        <template #bodyCell="{ column, record: att }">
          <template v-if="column.key === 'meta'">
            <span class="text-xs text-gray-400">
              {{ (att as AttachmentRecord).created_by }} ·
              {{ fmtSize((att as AttachmentRecord).size) }}
            </span>
          </template>
          <template v-else-if="column.key === 'actions'">
            <Button
              size="small"
              type="link"
              @click="onDownload(att as AttachmentRecord)"
            >
              下载
            </Button>
            <Popconfirm
              v-if="canWrite"
              :title="`摘除 ${(att as AttachmentRecord).file_name}？（记录仍留档，恢复需管理员操作数据库）`"
              @confirm="onRemoveAtt(att as AttachmentRecord)"
            >
              <Button danger size="small" type="link"> 摘除 </Button>
            </Popconfirm>
          </template>
        </template>
      </Table>
      <div v-if="canWrite" class="mt-2 flex items-center gap-2">
        <Input
          v-model:value="attachNote"
          class="w-44"
          placeholder="备注（选填，如：10月回单）"
          size="small"
        />
        <Upload
          :before-upload="() => false"
          :show-upload-list="false"
          accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.heic,.ofd,.doc,.docx,.xls,.xlsx,.csv,.txt"
          @change="
            (info: any) =>
              info.file && onUpload({ file: info.file as unknown as File })
          "
        >
          <Button :loading="uploading" size="small" type="primary">
            上传附件
          </Button>
        </Upload>
        <span class="text-xs text-gray-400">≤ 8MB，pdf/图片/文档</span>
      </div>

      <template v-if="canWrite">
        <div class="mt-4 mb-2 text-sm font-medium text-gray-500">
          推荐关联（{{
            suggestions.length
          }}）——按金额/日期/对方自动配，是否关联由人确认
        </div>
        <Table
          v-if="suggestions.length > 0"
          :columns="suggestColumns"
          :data-source="suggestions"
          :loading="suggestLoading"
          :pagination="false"
          row-key="invoice_id"
          size="small"
        >
          <template #bodyCell="{ column, record: s }">
            <template v-if="column.key === 'reason'">
              <div class="text-xs">
                <Tag class="mr-1" color="blue">
                  {{ (s as EntryMatchSuggestion).score }} 分
                </Tag>
                {{ (s as EntryMatchSuggestion).reason }}
              </div>
              <div class="text-xs text-gray-400">
                {{
                  INVOICE_KIND_LABELS[(s as EntryMatchSuggestion).kind] ??
                  (s as EntryMatchSuggestion).kind
                }}
                {{ (s as EntryMatchSuggestion).number || '（无票号）' }}
              </div>
            </template>
            <template v-else-if="column.key === 'actions'">
              <Button
                :loading="linkingId === (s as EntryMatchSuggestion).invoice_id"
                size="small"
                type="link"
                @click="onLinkSuggestion(s as EntryMatchSuggestion)"
              >
                关联
              </Button>
            </template>
          </template>
        </Table>
        <div v-else-if="!suggestLoading" class="text-sm text-gray-400">
          没有够格的候选（票夹里还没有金额/日期/对方对得上的在手发票）
        </div>
      </template>

      <div class="mt-4 mb-2 text-sm font-medium text-gray-500">跟踪记录</div>
      <Timeline v-if="(record.followups?.length ?? 0) > 0">
        <Timeline.Item v-for="(f, i) in record.followups" :key="i">
          <div class="text-xs text-gray-400">
            {{ f.date }} · {{ f.created_by }}
          </div>
          <div>{{ f.note }}</div>
        </Timeline.Item>
      </Timeline>
      <div v-else class="text-sm text-gray-400">无</div>
    </template>
  </Drawer>
</template>

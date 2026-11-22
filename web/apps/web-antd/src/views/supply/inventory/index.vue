<script lang="ts" setup>
import type {
  BelowSafetyItem,
  BitableRegistry,
  BitableSyncResult,
  ExpiringInfo,
  SupplyItem,
  SupplySummary,
} from '#/api/supply';

import { computed, h, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { useAccess } from '@vben/access';

import {
  Alert,
  Button,
  Dropdown,
  Input,
  InputNumber,
  Menu,
  message,
  Modal,
  Popconfirm,
  Table,
  Tag,
  Textarea,
} from 'ant-design-vue';

import {
  archiveItemApi,
  belowSafetyApi,
  bitableRegistryApi,
  bitableSyncApi,
  createItemApi,
  expiringApi,
  listItemsApi,
  setAliasesApi,
  supplySummaryApi,
  unarchiveItemApi,
  updateItemApi,
} from '#/api/supply';

import ImportModal from '../import-modal.vue';

const router = useRouter();
const route = useRoute();
const { hasAccessByCodes } = useAccess();
/** 写入口（新建/编辑/归档/导入）只给 supply:write：只读账号不该看到会 403 的按钮。 */
const canWrite = computed(() => hasAccessByCodes(['supply:write']));

const loading = ref(false);
const items = ref<SupplyItem[]>([]);
const summary = ref<SupplySummary>();
const belowList = ref<BelowSafetyItem[]>([]);
const expiring = ref<ExpiringInfo>();
const query = ref('');
const showArchived = ref(false);
/** 只看低于安全线（工作台/待办深链 filter=below 进来）：前端过滤，与红色"低于安线"标签同一字段。 */
const belowOnly = ref(false);
/** 只看临期（工作台/待办深链 filter=expiring 进来）：只留有批次落在效期窗口内的物料。 */
const expiringOnly = ref(false);
/** 深链 ?id= 命中的物料行：高亮滚到可见。 */
const highlightId = ref('');

/** 展示行 = 搜索词 + 归档开关 + 低于安线开关 + 临期开关 的叠加。 */
const displayItems = computed(() => {
  let list = items.value;
  if (belowOnly.value)
    list = list.filter((it) => !it.archived && it.belowSafety);
  if (expiringOnly.value) {
    const ids = new Set((expiring.value?.items ?? []).map((e) => e.itemId));
    list = list.filter((it) => ids.has(it.id));
  }
  return list;
});

const formOpen = ref(false);
const saving = ref(false);
const editing = reactive<{ record?: SupplyItem }>({});
const form = reactive<{
  aliases: string;
  category: string;
  code: string;
  name: string;
  note: string;
  safetyStock: number | undefined;
  unit: string;
}>({
  code: '',
  name: '',
  unit: '',
  category: '',
  safetyStock: undefined,
  aliases: '',
  note: '',
});

const importOpen = ref(false);
const importKind = ref<'inventory' | 'items'>('inventory');

/** 通道 B（多维表格只读同步）：同步/试跑=supply:write；登记表地址在「供应链设置」页（admin:manage）。 */
const canManage = computed(() => hasAccessByCodes(['admin:manage']));
const bitableReg = ref<BitableRegistry | null>(null);
const bitableSyncing = ref(false);

async function loadBitable() {
  try {
    bitableReg.value = (await bitableRegistryApi()).registry;
  } catch {
    bitableReg.value = null;
  }
}

function hintLines(r: BitableSyncResult): string {
  return r.hints && r.hints.length > 0
    ? `\n${r.hints.map((hint) => `  提示：${hint}`).join('\n')}`
    : '';
}

function describeSync(results: BitableSyncResult[]): string {
  return results
    .map((r) => {
      if (r.error !== undefined) return `【${r.kindLabel}】失败：${r.error}`;
      if (r.dryRun) {
        return `【${r.kindLabel}】试跑：拉到 ${r.fetched} 行，可导 ${r.valid ?? 0} 行${
          r.invalid
            ? `，问题 ${r.invalid} 行（${(r.errors ?? [])
                .map((e) => `第${e.line}行 ${e.error}`)
                .slice(0, 2)
                .join('；')}）`
            : ''
        }${hintLines(r)}`;
      }
      if (r.unchanged === true) return `【${r.kindLabel}】表里没变化`;
      return `【${r.kindLabel}】新建 ${r.created ?? 0}、更新 ${r.updated ?? 0}、跳过 ${r.skipped ?? 0}${
        r.itemsCreated && r.itemsCreated.length > 0
          ? `，自动建档 ${r.itemsCreated.join('、')}`
          : ''
      }${
        r.archivedTargets && r.archivedTargets.length > 0
          ? `，落到归档物料 ${r.archivedTargets.join('、')}（默认列表看不见）`
          : ''
      }${
        r.protectedClosed && r.protectedClosed.length > 0
          ? `，已收货/取消被护住 ${r.protectedClosed.join('、')}`
          : ''
      }${hintLines(r)}`;
    })
    .join('\n');
}

async function bitableSync(dryRun: boolean) {
  if (bitableReg.value === null)
    return message.warning('先到「供应链设置」页登记多维表格');
  bitableSyncing.value = true;
  try {
    const { results } = await bitableSyncApi({ dryRun });
    const failed = results.some((r) => r.error !== undefined);
    const content = h(
      'div',
      { style: { whiteSpace: 'pre-wrap' } },
      describeSync(results),
    );
    if (failed) {
      Modal.warning({
        title: dryRun ? '试跑有失败项' : '同步有失败项',
        content,
        width: 640,
      });
    } else {
      Modal.info({
        title: dryRun ? '试跑结果（未落库）' : '同步完成',
        content,
        width: 640,
      });
    }
    if (!dryRun) await load();
  } catch (error) {
    message.error(`同步失败：${(error as Error)?.message ?? error}`);
  } finally {
    bitableSyncing.value = false;
  }
}

function onBitableMenu({ key }: { key: number | string }) {
  if (key === 'set') return router.push('/supply/settings');
  if (key === 'dry') return bitableSync(true);
  bitableSync(false);
}

async function load() {
  loading.value = true;
  try {
    const [list, sum, below, exp] = await Promise.all([
      listItemsApi({ archived: showArchived.value, query: query.value }),
      supplySummaryApi(),
      belowSafetyApi(),
      expiringApi(),
    ]);
    items.value = list.items;
    summary.value = sum;
    belowList.value = below.items;
    expiring.value = exp;
    await loadBitable();
  } catch (error) {
    message.error(`加载失败：${(error as Error)?.message ?? error}`);
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  editing.record = undefined;
  Object.assign(form, {
    code: '',
    name: '',
    unit: '',
    category: '',
    safetyStock: undefined,
    aliases: '',
    note: '',
  });
  formOpen.value = true;
}

function openEdit(record: SupplyItem) {
  editing.record = record;
  Object.assign(form, {
    code: record.code,
    name: record.name,
    unit: record.unit,
    category: record.category,
    safetyStock: record.safetyStock ?? undefined,
    aliases: record.aliases.join('；'),
    note: record.note,
  });
  formOpen.value = true;
}

async function onOk() {
  if (!editing.record && !form.code.trim())
    return message.warning('请填物料编码');
  saving.value = true;
  try {
    if (editing.record) {
      await updateItemApi(editing.record.id, {
        category: form.category,
        name: form.name,
        note: form.note,
        // 显式 null（不是 undefined）：清空输入框=撤掉安全线，键被丢掉后端就不覆盖了
        safetyStock: form.safetyStock ?? null,
        unit: form.unit,
      });
      await setAliasesApi(editing.record.id, parseAliases(form.aliases));
      message.success(`已更新 ${form.name || form.code}`);
    } else {
      const { item } = await createItemApi({
        category: form.category,
        code: form.code.trim(),
        name: form.name.trim(),
        note: form.note,
        safetyStock: form.safetyStock ?? null,
        unit: form.unit,
      });
      if (parseAliases(form.aliases).length > 0) {
        await setAliasesApi(item.id, parseAliases(form.aliases));
      }
      message.success(`已建档 ${form.code.trim()}`);
    }
    formOpen.value = false;
    await load();
  } catch (error) {
    message.error(`保存失败：${(error as Error)?.message ?? error}`);
    // 两段式保存（主档 + 别名）可能前半已落库：刷新列表让界面反映真实状态，而不是停在旧数据上
    await load();
  } finally {
    saving.value = false;
  }
}

function parseAliases(raw: string): string[] {
  return raw
    .split(/[;；、,，|]/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

async function toggleArchive(record: SupplyItem) {
  try {
    await (record.archived
      ? unarchiveItemApi(record.id)
      : archiveItemApi(record.id));
    message.success(
      record.archived ? `已启用 ${record.name}` : `已归档 ${record.name}`,
    );
    await load();
  } catch (error) {
    message.error(`操作失败：${(error as Error)?.message ?? error}`);
  }
}

function toggleArchivedFilter() {
  showArchived.value = !showArchived.value;
  load();
}

function onImportMenu({ key }: { key: number | string }) {
  importKind.value = key as 'inventory' | 'items';
  importOpen.value = true;
}

function stockText(record: SupplyItem): string {
  if (record.stock.length === 0) return '—';
  return record.stock
    .map(
      (s) =>
        `${s.warehouse} ${s.quantity}${s.batchNo === '' ? '' : `（批 ${s.batchNo}）`}`,
    )
    .join('，');
}

function stockTitle(record: SupplyItem): string {
  return record.stock
    .map(
      (s) =>
        `${s.warehouse}${s.batchNo === '' ? '' : ` 批次 ${s.batchNo}`}：${s.quantity}（快照 ${s.snapshotDate}${s.expiryDate === '' ? '' : `，效期 ${s.expiryDate}`}）`,
    )
    .join('\n');
}

const BELOW_PREVIEW = 5;
/** 预警条只列前几项，其余靠表格里的红色"低于安线"标签——几十项拼成一行没人读得完。
 *  口径=按物料合计比（2026-11-01 用户拍板）：合计数 + 分仓明细，不是每仓一条。 */
const belowText = computed(() => {
  const head = belowList.value
    .slice(0, BELOW_PREVIEW)
    .map(
      (b) =>
        `${b.name}（${b.warehouses}，合计 ${b.quantity}/线 ${b.safetyStock}）`,
    )
    .join('；');
  const rest =
    belowList.value.length > BELOW_PREVIEW
      ? `……等 ${belowList.value.length} 项（表格里红色标记）`
      : '';
  return `⚠ ${belowList.value.length} 项低于安全线（按各仓合计比）：${head}${rest}——补货入库后重新导入库存快照，预警自动消除。`;
});

const EXPIRY_PREVIEW = 5;
/** 临期条（S5）：先过期后临期排序在后端（expiringRows），这里直接展示。 */
const expiringText = computed(() => {
  const list = expiring.value;
  if (!list || list.items.length === 0) return '';
  const head = list.items
    .slice(0, EXPIRY_PREVIEW)
    .map(
      (e) =>
        `${e.name} 批 ${e.batchNo}（${e.warehouse}，存 ${e.quantity}${e.unit}，${e.daysLeft < 0 ? `已过期 ${-e.daysLeft} 天` : `还剩 ${e.daysLeft} 天`}）`,
    )
    .join('；');
  const rest =
    list.items.length > EXPIRY_PREVIEW ? `……等 ${list.items.length} 批` : '';
  return `⏰ ${list.items.length} 个批次在效期窗口内（${list.warnDays} 天）：${head}${rest}——优先处置过期批次。`;
});

const columns = [
  { dataIndex: 'code', key: 'code', title: '编码', width: 120 },
  { dataIndex: 'name', key: 'name', title: '名称', ellipsis: true },
  { dataIndex: 'unit', key: 'unit', title: '单位', width: 70 },
  { dataIndex: 'category', key: 'category', title: '分类', width: 90 },
  { key: 'stock', title: '各仓最新读数', width: 220 },
  { key: 'total', title: '合计', align: 'right' as const, width: 90 },
  { key: 'safety', title: '安全线', width: 90, align: 'right' as const },
  { key: 'aliases', title: '别名', ellipsis: true },
  { key: 'status', title: '状态', width: 90 },
  { key: 'actions', title: '操作', width: 150 },
];

/** 深链预定位（/supply?id=&filter=below|expiring）：filter 开对应"只看"开关，id 高亮滚到那行物料。 */
async function applyDeepLink() {
  belowOnly.value = route.query.filter === 'below';
  expiringOnly.value = route.query.filter === 'expiring';
  const id = typeof route.query.id === 'string' ? route.query.id.trim() : '';
  highlightId.value = id;
  await load();
  if (id !== '') {
    // 高亮目标不在当前列表（如已归档）就开"含归档"再看一次，别让人点链接扑空
    if (!items.value.some((it) => String(it.id) === id)) {
      showArchived.value = true;
      await load();
    }
    await new Promise((r) => setTimeout(r, 300));
    document
      .querySelector(`tr[data-row-key="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

onMounted(() => {
  applyDeepLink();
});

// 页签 keep-alive：页面已开着又从工作台/待办跳过来时 onMounted 不会再跑，靠 query 变化重新定位
watch(
  () => route.query,
  (q, old) => {
    if (route.path === '/supply' && JSON.stringify(q) !== JSON.stringify(old))
      void applyDeepLink();
  },
);
</script>

<template>
  <div class="p-4">
    <Alert
      v-if="belowList.length > 0"
      class="mb-3"
      show-icon
      type="warning"
      :message="belowText"
    />
    <Alert
      v-if="expiringText !== ''"
      class="mb-3"
      show-icon
      :type="expiringText.includes('已过期') ? 'error' : 'warning'"
      :message="expiringText"
    />
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <div class="text-sm text-gray-500">
        物料 {{ summary?.items ?? '–' }} 个，未到货采购单
        {{ summary?.openPos ?? '–' }} 张（逾期
        {{ summary?.overduePos ?? '–' }}），最近快照
        {{ summary?.lastSnapshotDate || '–' }}。
        库存只记读数不调账：最新一次报数就是当前库存；带批次的行会显示批次号，临期批次在上方提醒；金额在财务域，这里只有数量。
      </div>
      <div class="flex-1"></div>
      <Input
        v-model:value="query"
        allow-clear
        placeholder="搜编码/名称/分类/别名"
        style="width: 200px"
        @press-enter="load"
      />
      <Button @click="load">搜索</Button>
      <Button
        :type="showArchived ? 'primary' : 'default'"
        ghost
        @click="toggleArchivedFilter"
      >
        {{ showArchived ? '含归档' : '仅在用' }}
      </Button>
      <Button
        :type="belowOnly ? 'primary' : 'default'"
        ghost
        @click="belowOnly = !belowOnly"
      >
        只看低于安全线
      </Button>
      <Button
        :type="expiringOnly ? 'primary' : 'default'"
        ghost
        @click="expiringOnly = !expiringOnly"
      >
        只看临期
      </Button>
      <Dropdown v-if="canWrite">
        <Button type="primary" ghost>批量导入</Button>
        <template #overlay>
          <Menu @click="onImportMenu">
            <Menu.Item key="inventory">库存快照（CSV）</Menu.Item>
            <Menu.Item key="items">物料主数据（CSV）</Menu.Item>
          </Menu>
        </template>
      </Dropdown>
      <Dropdown v-if="canWrite || canManage">
        <Button :loading="bitableSyncing" ghost type="primary">
          多维表格{{ bitableReg ? '' : '（未登记）' }}
        </Button>
        <template #overlay>
          <Menu @click="onBitableMenu">
            <Menu.Item v-if="canWrite" key="dry" :disabled="!bitableReg">
              先试跑（只看不落库）
            </Menu.Item>
            <Menu.Item v-if="canWrite" key="sync" :disabled="!bitableReg">
              同步三张表到系统
            </Menu.Item>
            <Menu.Item v-if="canManage" key="set">
              同步设置（登记 appToken / table_id）
            </Menu.Item>
          </Menu>
        </template>
      </Dropdown>
      <Button @click="router.push('/supply/settings')">供应链设置</Button>
      <Button v-if="canWrite" type="primary" @click="openCreate">
        新建物料
      </Button>
    </div>

    <Table
      :columns="columns"
      :data-source="displayItems"
      :loading="loading"
      :pagination="{ pageSize: 20 }"
      :row-class-name="
        (r: SupplyItem) => (String(r.id) === highlightId ? 'row-highlight' : '')
      "
      row-key="id"
      size="small"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'stock'">
          <span :title="stockTitle(record as SupplyItem)">{{
            stockText(record as SupplyItem)
          }}</span>
        </template>
        <template v-else-if="column.key === 'total'">
          {{ (record as SupplyItem).totalQuantity
          }}{{ (record as SupplyItem).unit }}
        </template>
        <template v-else-if="column.key === 'safety'">
          <span
            v-if="(record as SupplyItem).safetyStock === null"
            class="text-gray-400"
            >未设</span
          >
          <span
            v-else
            :class="
              (record as SupplyItem).belowSafety
                ? 'font-medium text-red-600'
                : ''
            "
          >
            {{ (record as SupplyItem).safetyStock
            }}{{ (record as SupplyItem).unit }}
          </span>
        </template>
        <template v-else-if="column.key === 'aliases'">
          {{ (record as SupplyItem).aliases.join('；') || '—' }}
        </template>
        <template v-else-if="column.key === 'status'">
          <!-- 归档优先：归档物料不参与安全线预警（扫描器口径），标签不能还亮红 -->
          <Tag
            :color="
              (record as SupplyItem).archived
                ? 'default'
                : (record as SupplyItem).belowSafety
                  ? 'red'
                  : 'green'
            "
          >
            {{
              (record as SupplyItem).archived
                ? '已归档'
                : (record as SupplyItem).belowSafety
                  ? '低于安全线'
                  : '在用'
            }}
          </Tag>
        </template>
        <template v-else-if="column.key === 'actions'">
          <template v-if="canWrite">
            <Button
              size="small"
              type="link"
              @click="openEdit(record as SupplyItem)"
            >
              编辑
            </Button>
            <Popconfirm
              :title="`确认${(record as SupplyItem).archived ? '启用' : '归档'} ${(record as SupplyItem).name}？归档后不再参与安全线预警。`"
              @confirm="toggleArchive(record as SupplyItem)"
            >
              <Button size="small" type="link">
                {{ (record as SupplyItem).archived ? '启用' : '归档' }}
              </Button>
            </Popconfirm>
          </template>
          <span v-else class="text-xs text-gray-400">只读</span>
        </template>
      </template>
    </Table>

    <Modal
      :confirm-loading="saving"
      :open="formOpen"
      :title="editing.record ? `编辑 ${editing.record.code}` : '新建物料'"
      @cancel="formOpen = false"
      @ok="onOk"
    >
      <div class="grid grid-cols-2 gap-x-4 gap-y-3">
        <div>
          <div class="mb-1 text-sm text-gray-500">物料编码 *</div>
          <Input
            v-model:value="form.code"
            :disabled="!!editing.record"
            placeholder="如 WL-001（导入按它对号）"
          />
        </div>
        <div>
          <div class="mb-1 text-sm text-gray-500">物料名称</div>
          <Input v-model:value="form.name" placeholder="如：猫砂盆 L 号" />
        </div>
        <div>
          <div class="mb-1 text-sm text-gray-500">单位</div>
          <Input v-model:value="form.unit" placeholder="个 / 千克 / 米" />
        </div>
        <div>
          <div class="mb-1 text-sm text-gray-500">分类</div>
          <Input
            v-model:value="form.category"
            placeholder="成品 / 原料 / 包材"
          />
        </div>
        <div>
          <div class="mb-1 text-sm text-gray-500">
            安全库存（低于它进待办预警）
          </div>
          <InputNumber
            v-model:value="form.safetyStock"
            class="w-full"
            :min="0"
            :precision="3"
            placeholder="不填=不预警"
          />
        </div>
        <div>
          <div class="mb-1 text-sm text-gray-500">
            别名（外部系统的别的叫法，；分隔）
          </div>
          <Input
            v-model:value="form.aliases"
            placeholder="如 SB-001；litter-L"
          />
        </div>
        <div class="col-span-2">
          <div class="mb-1 text-sm text-gray-500">备注</div>
          <Textarea v-model:value="form.note" :rows="2" />
        </div>
      </div>
    </Modal>

    <ImportModal
      v-if="canWrite"
      v-model:open="importOpen"
      :kind="importKind"
      @imported="load"
    />
  </div>
</template>

<style scoped>
:deep(tr.row-highlight > td) {
  background-color: rgb(250 173 20 / 15%);
}
</style>

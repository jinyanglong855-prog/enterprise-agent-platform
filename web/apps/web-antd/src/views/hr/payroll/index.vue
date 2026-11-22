<script lang="ts" setup>
import type {
  OpeningRecord,
  PayrollPostingStatus,
  PayrollPostOutcome,
  PayslipRecord,
} from '#/api/payroll';

import { onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { useAccess } from '@vben/access';

import {
  Button,
  DatePicker,
  Descriptions,
  Drawer,
  Input,
  InputNumber,
  message,
  Modal,
  Popconfirm,
  Table,
  Tag,
} from 'ant-design-vue';

import {
  confirmPayslipApi,
  deletePayslipApi,
  employeeYearApi,
  exportPayslipsCsvApi,
  generatePayslipsApi,
  getOpeningApi,
  payrollPostingStatusApi,
  postPayrollMonthApi,
  pushPayslipsApi,
  registerApi,
  unconfirmPayslipApi,
  updatePayslipApi,
} from '#/api/payroll';
import { ledgerLink, proposalLink } from '#/utils/entity-links';

const router = useRouter();
// 按后端口径门控：生成/推送/编辑/确认/撤回/删除/生成入账单要 payroll:write；看表与导出 CSV 只要 payroll:read
const { hasAccessByCodes } = useAccess();
const canWrite = hasAccessByCodes(['payroll:write']);

function localMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function fmt(n: number): string {
  return n.toFixed(2);
}

const route = useRoute();

// ---------- 工资表 ----------
const month = ref(
  typeof route.query.month === 'string' &&
    /^\d{4}-\d{2}$/.test(route.query.month)
    ? route.query.month
    : localMonth(),
);
const reg = ref<Awaited<ReturnType<typeof registerApi>> | null>(null);
const regLoading = ref(false);
const generating = ref(false);

const registerColumns = [
  { title: '姓名', key: 'name' },
  { title: '部门', dataIndex: 'department', key: 'department' },
  { title: '状态', key: 'status', width: 90 },
  {
    title: '计税月数',
    dataIndex: 'months_count',
    key: 'months_count',
    width: 90,
  },
  { title: '应发（元）', key: 'gross', align: 'right' as const },
  { title: '个人社保（元）', key: 'social', align: 'right' as const },
  { title: '专项附加（元）', key: 'extra', align: 'right' as const },
  { title: '本月个税（元）', key: 'tax', align: 'right' as const },
  { title: '实发（元）', key: 'net', align: 'right' as const },
  { title: '操作', key: 'actions', width: 230 },
];

async function loadRegister() {
  if (!month.value) return;
  regLoading.value = true;
  try {
    reg.value = await registerApi(month.value);
    await loadPosting();
  } catch (error) {
    message.error(`工资表加载失败：${(error as Error)?.message ?? error}`);
  } finally {
    regLoading.value = false;
  }
}

async function onGenerate() {
  generating.value = true;
  try {
    const body = await generatePayslipsApi(month.value);
    message.success(
      `已生成：新出 ${body.created} 张草稿，${body.skipped} 张已有不覆盖`,
    );
    if (body.skipped_no_salary.length > 0) {
      message.warning(
        `${body.skipped_no_salary.length} 人默认应发为 0 没出单：${body.skipped_no_salary.join('、')}——先到「人事 › 员工名册」填参数`,
        8,
      );
    }
    if (body.skipped_out_of_order.length > 0) {
      message.warning(
        `${body.skipped_out_of_order.length} 人没出单（同年已有更晚月份的单，累计预扣要按月份顺序来）：${body.skipped_out_of_order
          .map((x) => `${x.name}（已有 ${x.later_month}）`)
          .join('、')}——要补早月份先删掉更晚的单`,
        10,
      );
    }
    if (body.skipped_in_opening.length > 0) {
      message.warning(
        `${body.skipped_in_opening.length} 人没出单（期初累计已覆盖到该月，再出就重复算了）：${body.skipped_in_opening
          .map((x) => `${x.name}（期初截至 ${x.through_month}）`)
          .join('、')}——从期初截止月的下一个月开始生成`,
        10,
      );
    }
    if (body.no_hire_date.length > 0) {
      message.warning(
        `${body.no_hire_date.length} 人没填入职日期，按 1 月起算减除费用：${body.no_hire_date.join('、')}——年中入职的请到「人事 › 员工名册」补入职日期后删单重出`,
        10,
      );
    }
    reg.value = body;
  } catch (error) {
    message.error(`生成失败：${(error as Error)?.message ?? error}`);
  } finally {
    generating.value = false;
  }
}

// ---------- 落账 / 工资条 / 导出（2026-11-02 财务线残余②） ----------
// 该月工资单全部确认 → 后端自动生成一笔 type=payroll 提案（金额=实发合计）→ 老板飞书卡片确认入账；
// 这里只展示状态 + 手动兜底按钮（自动那一步没成时人再点）。已落账的月份锁定：撤回/再生成会被服务端挡下。
const posting = ref<null | PayrollPostingStatus>(null);
const postingBusy = ref(false);
const pushing = ref(false);
const exporting = ref(false);

async function loadPosting() {
  if (!month.value) return;
  try {
    posting.value = await payrollPostingStatusApi(month.value);
  } catch {
    posting.value = null; // 状态条拿不到就不显示，不打断工资表本身
  }
}

function describeOutcome(o: PayrollPostOutcome): void {
  if (o.status === 'created') {
    message.success(
      o.card === 'sent'
        ? `已生成工资入账单 ${o.proposal}，负责人飞书卡片确认后入账`
        : `已生成工资入账单 ${o.proposal}，但飞书卡片没发出去——请到「财务 › 待确认记账」页确认`,
      8,
    );
  } else if (o.status === 'duplicate') {
    message.info(
      `该月已有入账单 ${o.proposal}（${o.proposalStatus === 'confirmed' ? '已入账' : '待确认'}），不重复生成`,
    );
  } else if (o.status === 'failed') {
    message.error(`入账单生成失败：${o.error}`, 8);
  }
  // skipped（还有草稿没确认等）：状态条已经在说，不再弹
}

async function onPostMonth() {
  postingBusy.value = true;
  try {
    describeOutcome(await postPayrollMonthApi(month.value));
    await loadPosting();
  } catch (error) {
    message.error(`生成失败：${(error as Error)?.message ?? error}`);
  } finally {
    postingBusy.value = false;
  }
}

async function onPush() {
  pushing.value = true;
  try {
    const body = await pushPayslipsApi(month.value);
    message.success(
      `已私聊发出 ${body.sent.length} 人的工资条${body.sent.length > 0 ? `：${body.sent.join('、')}` : ''}`,
      6,
    );
    if (body.skipped.length > 0) {
      message.warning(
        `${body.skipped.length} 人没发：${body.skipped.map((s) => `${s.name}（${s.reason}）`).join('；')}`,
        10,
      );
    }
  } catch (error) {
    message.error(`推送失败：${(error as Error)?.message ?? error}`);
  } finally {
    pushing.value = false;
  }
}

async function onExport() {
  exporting.value = true;
  try {
    const blob = await exportPayslipsCsvApi(month.value);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `工资表-${month.value}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    message.error(`导出失败：${(error as Error)?.message ?? error}`);
  } finally {
    exporting.value = false;
  }
}

// 编辑（草稿）：改本月数后服务端按累计预扣法重算
const editOpen = ref(false);
const editSaving = ref(false);
const editTarget = ref<null | PayslipRecord>(null);
const editForm = reactive({
  extra_deduct: undefined as number | undefined,
  gross: undefined as number | undefined,
  note: '',
  relief: undefined as number | undefined,
  social: undefined as number | undefined,
});

function openEdit(record: PayslipRecord) {
  editTarget.value = record;
  editForm.gross = record.gross;
  editForm.social = record.social;
  editForm.extra_deduct = record.extra_deduct;
  editForm.relief = record.relief;
  editForm.note = record.note;
  editOpen.value = true;
}

async function onEditOk() {
  if (!editTarget.value) return;
  editSaving.value = true;
  try {
    await updatePayslipApi(editTarget.value.id, {
      extra_deduct: editForm.extra_deduct,
      gross: editForm.gross,
      note: editForm.note,
      relief: editForm.relief,
      social: editForm.social,
    });
    message.success(
      `已重算 ${editTarget.value.employee_name} ${editTarget.value.month}`,
    );
    editOpen.value = false;
    await loadRegister();
  } catch (error) {
    message.error(`保存失败：${(error as Error)?.message ?? error}`);
  } finally {
    editSaving.value = false;
  }
}

async function onConfirm(record: PayslipRecord) {
  try {
    const body = await confirmPayslipApi(record.id);
    message.success(`已确认 ${record.employee_name} ${record.month}，单子锁定`);
    if (body.posting) describeOutcome(body.posting);
    await loadRegister();
  } catch (error) {
    message.error(`确认失败：${(error as Error)?.message ?? error}`);
  }
}

async function onUnconfirm(record: PayslipRecord) {
  try {
    await unconfirmPayslipApi(record.id);
    message.success(
      `已撤回确认，${record.employee_name} ${record.month} 回到草稿`,
    );
    await loadRegister();
  } catch (error) {
    message.error(`撤回失败：${(error as Error)?.message ?? error}`);
  }
}

async function onDelete(record: PayslipRecord) {
  try {
    await deletePayslipApi(record.id);
    message.success(`已删除 ${record.employee_name} ${record.month}`);
    await loadRegister();
  } catch (error) {
    message.error(`删除失败：${(error as Error)?.message ?? error}`);
  }
}

// 详情抽屉（含累计快照=当时的算数依据）
const drawerOpen = ref(false);
const drawerRows = ref<PayslipRecord[]>([]);
const drawerOpening = ref<null | OpeningRecord>(null);
const drawerEmployee = ref<null | { id: number; name: string }>(null);
const drawerLoading = ref(false);

async function openDrawer(record: PayslipRecord) {
  drawerOpen.value = true;
  drawerEmployee.value = { id: record.employee_id, name: record.employee_name };
  drawerLoading.value = true;
  try {
    const year = record.month.slice(0, 4);
    const body = await employeeYearApi(record.employee_id, year);
    drawerRows.value = body.rows;
    drawerOpening.value = await getOpeningApi(record.employee_id, year).catch(
      () => null,
    );
  } catch (error) {
    message.error(`工资单加载失败：${(error as Error)?.message ?? error}`);
  } finally {
    drawerLoading.value = false;
  }
}

onMounted(() => {
  loadRegister();
});

// 页签 keep-alive：页面已开着又从工作台/待办带 ?month= 跳过来时 onMounted 不会再跑，靠 query 变化切月
watch(
  () => route.query,
  (q, old) => {
    if (
      route.path !== '/hr/payroll' ||
      JSON.stringify(q) === JSON.stringify(old)
    )
      return;
    const m =
      typeof q.month === 'string' && /^\d{4}-\d{2}$/.test(q.month)
        ? q.month
        : '';
    if (m !== '' && m !== month.value) {
      month.value = m;
      void loadRegister();
    }
  },
);
</script>

<template>
  <div class="p-4">
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <span class="text-sm text-gray-500">月份</span>
      <DatePicker
        v-model:value="month"
        :allow-clear="false"
        picker="month"
        value-format="YYYY-MM"
        @change="loadRegister"
      />
      <Popconfirm
        v-if="canWrite"
        title="按名册默认参数给当月在册员工出草稿？已有工资单的人不覆盖。"
        @confirm="onGenerate"
      >
        <Button :loading="generating" type="primary">生成本月工资表</Button>
      </Popconfirm>
      <Popconfirm
        v-if="canWrite"
        title="把本月每人的工资条私聊发到飞书（只发已确认的单，按名册 open_id；没绑的点名跳过）。发？"
        @confirm="onPush"
      >
        <Button :disabled="!reg || reg.count === 0" :loading="pushing">
          推送工资条
        </Button>
      </Popconfirm>
      <Button
        :disabled="!reg || reg.count === 0"
        :loading="exporting"
        @click="onExport"
      >
        导出 CSV
      </Button>
      <div class="flex-1"></div>
      <div v-if="reg" class="text-sm text-gray-600">
        共 {{ reg.count }} 人 · 应发 <b>{{ fmt(reg.totals.gross) }}</b> ·
        个人社保 {{ fmt(reg.totals.social) }} · 个税 {{ fmt(reg.totals.tax) }} ·
        实发 <b>{{ fmt(reg.totals.net) }}</b> 元
      </div>
    </div>
    <div class="mb-2 text-xs text-gray-400">
      个税按累计预扣法（61
      号公告）计算：此前累计取同年此前各月工资单之和，改数要按月份顺序来。
      该月工资单全部确认后自动生成一笔工资入账单（金额=实发合计；个税/社保缴纳时另记），负责人飞书卡片确认后入账，已入账的月份锁定。
      正式申报在自然人电子税务局（扣缴端）。员工参数在「人事 › 员工名册」维护。
    </div>
    <div
      v-if="posting && posting.payslips.total > 0"
      class="mb-2 flex flex-wrap items-center gap-2 text-xs"
    >
      <span class="text-gray-500">入账：</span>
      <template v-if="posting.proposal?.status === 'confirmed'">
        <Tag color="green">
          已入账 {{ posting.proposal.entry_id }}（入账单
          {{ posting.proposal.id }}）
        </Tag>
        <Button
          size="small"
          type="link"
          @click="router.push(ledgerLink({ id: posting.proposal?.entry_id }))"
        >
          看台账 →
        </Button>
      </template>
      <template v-else-if="posting.proposal">
        <Tag color="orange">入账单 {{ posting.proposal.id }} 等待确认</Tag>
        <Button
          size="small"
          type="link"
          @click="router.push(proposalLink(posting.proposal.id))"
        >
          去确认 →
        </Button>
      </template>
      <template v-else-if="posting.postable">
        <Tag color="blue">已全部确认，可生成入账单</Tag>
        <Button
          v-if="canWrite"
          :loading="postingBusy"
          size="small"
          type="primary"
          @click="onPostMonth"
        >
          生成入账单
        </Button>
      </template>
      <span v-else class="text-gray-500">{{ posting.reason }}</span>
    </div>
    <Table
      :columns="registerColumns"
      :data-source="reg?.rows ?? []"
      :loading="regLoading"
      :pagination="false"
      row-key="id"
      size="small"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'name'">
          {{ (record as PayslipRecord).employee_name }}
          <span class="text-xs text-gray-400"
            >#{{ (record as PayslipRecord).employee_id }}</span
          >
        </template>
        <template v-else-if="column.key === 'status'">
          <Tag
            :color="
              (record as PayslipRecord).status === 'confirmed'
                ? 'green'
                : 'orange'
            "
          >
            {{
              (record as PayslipRecord).status === 'confirmed'
                ? '已确认'
                : '草稿'
            }}
          </Tag>
        </template>
        <template v-else-if="column.key === 'gross'">
          {{ fmt((record as PayslipRecord).gross) }}
        </template>
        <template v-else-if="column.key === 'social'">
          {{ fmt((record as PayslipRecord).social) }}
        </template>
        <template v-else-if="column.key === 'extra'">
          {{ fmt((record as PayslipRecord).extra_deduct) }}
        </template>
        <template v-else-if="column.key === 'tax'">
          {{ fmt((record as PayslipRecord).tax) }}
        </template>
        <template v-else-if="column.key === 'net'">
          <b>{{ fmt((record as PayslipRecord).net) }}</b>
        </template>
        <template v-else-if="column.key === 'actions'">
          <Button
            size="small"
            type="link"
            @click="openDrawer(record as PayslipRecord)"
          >
            详情
          </Button>
          <Button
            v-if="canWrite && (record as PayslipRecord).status === 'draft'"
            size="small"
            type="link"
            @click="openEdit(record as PayslipRecord)"
          >
            编辑
          </Button>
          <Popconfirm
            v-if="canWrite && (record as PayslipRecord).status === 'draft'"
            :title="`确认后 ${record.month} 这张单锁定（可撤回）。确认？`"
            @confirm="onConfirm(record as PayslipRecord)"
          >
            <Button size="small" type="link">确认</Button>
          </Popconfirm>
          <Button
            v-if="canWrite && (record as PayslipRecord).status === 'confirmed'"
            size="small"
            type="link"
            @click="onUnconfirm(record as PayslipRecord)"
          >
            撤回
          </Button>
          <Popconfirm
            v-if="canWrite && (record as PayslipRecord).status === 'draft'"
            title="删除后可重新生成；只许删同年最后一月，更早月份不受影响。"
            @confirm="onDelete(record as PayslipRecord)"
          >
            <Button danger size="small" type="link">删除</Button>
          </Popconfirm>
        </template>
      </template>
    </Table>

    <Modal
      :confirm-loading="editSaving"
      :open="editOpen"
      :title="
        editTarget
          ? `编辑 ${editTarget.employee_name} ${editTarget.month}（草稿，保存即重算）`
          : ''
      "
      @cancel="editOpen = false"
      @ok="onEditOk"
    >
      <div class="grid grid-cols-2 gap-x-4 gap-y-3">
        <div>
          <div class="mb-1 text-sm text-gray-500">应发工资（元）</div>
          <InputNumber
            v-model:value="editForm.gross"
            class="w-full"
            :min="0"
            :precision="2"
          />
        </div>
        <div>
          <div class="mb-1 text-sm text-gray-500">个人社保公积金（元）</div>
          <InputNumber
            v-model:value="editForm.social"
            class="w-full"
            :min="0"
            :precision="2"
          />
        </div>
        <div>
          <div class="mb-1 text-sm text-gray-500">专项附加扣除（元，本月）</div>
          <InputNumber
            v-model:value="editForm.extra_deduct"
            class="w-full"
            :min="0"
            :precision="2"
          />
        </div>
        <div>
          <div class="mb-1 text-sm text-gray-500">
            减免税额（元，本月，一般 0）
          </div>
          <InputNumber
            v-model:value="editForm.relief"
            class="w-full"
            :min="0"
            :precision="2"
          />
        </div>
        <div class="col-span-2">
          <div class="mb-1 text-sm text-gray-500">备注</div>
          <Input v-model:value="editForm.note" />
        </div>
        <div class="col-span-2 text-xs text-gray-400">
          改这张单不影响更晚月份（它们得先删掉才能让你改这张）；删掉更晚月份重新生成即可拿到新累计。
        </div>
      </div>
    </Modal>

    <Drawer
      v-model:open="drawerOpen"
      :title="drawerEmployee ? `${drawerEmployee.name} 的工资单` : '工资单'"
      width="560"
    >
      <div class="mb-2 text-xs text-gray-400">
        按年逐月列出；"此前累计"等快照是出单那一刻的算数依据，事后不改。
      </div>
      <div v-if="drawerLoading">加载中…</div>
      <template v-else>
        <div
          v-if="drawerOpening"
          class="mb-3 rounded border border-dashed border-gray-300 p-2 text-xs text-gray-600"
        >
          期初累计（截至
          {{ drawerOpening.through_month }} 月末，年中启用开账）：应发
          {{ fmt(drawerOpening.gross) }} · 个人社保
          {{ fmt(drawerOpening.social) }} · 专项附加
          {{ fmt(drawerOpening.extra_deduct) }} · 已预扣
          {{ fmt(drawerOpening.withheld) }}
          <span v-if="drawerOpening.note">· {{ drawerOpening.note }}</span>
        </div>
        <div v-for="row in drawerRows" :key="row.id" class="mb-4">
          <div class="mb-1 flex items-center gap-2">
            <b>{{ row.month }}</b>
            <Tag :color="row.status === 'confirmed' ? 'green' : 'orange'">
              {{ row.status === 'confirmed' ? '已确认' : '草稿' }}
            </Tag>
          </div>
          <Descriptions :column="2" bordered size="small">
            <Descriptions.Item label="应发">
              {{ fmt(row.gross) }}
            </Descriptions.Item>
            <Descriptions.Item label="个人社保">
              {{ fmt(row.social) }}
            </Descriptions.Item>
            <Descriptions.Item label="专项附加">
              {{ fmt(row.extra_deduct) }}
            </Descriptions.Item>
            <Descriptions.Item label="减免">
              {{ fmt(row.relief) }}
            </Descriptions.Item>
            <Descriptions.Item label="计税月数">
              {{ row.months_count }}
            </Descriptions.Item>
            <Descriptions.Item label="累计应纳税所得">
              {{ fmt(row.taxable_cum) }}
            </Descriptions.Item>
            <Descriptions.Item label="此前累计收入">
              {{ fmt(row.gross_prev) }}
            </Descriptions.Item>
            <Descriptions.Item label="此前已预扣">
              {{ fmt(row.withheld_prev) }}
            </Descriptions.Item>
            <Descriptions.Item label="本月个税">
              {{ fmt(row.tax) }}
            </Descriptions.Item>
            <Descriptions.Item label="实发">
              <b>{{ fmt(row.net) }}</b>
            </Descriptions.Item>
            <Descriptions.Item
              v-if="row.negative_diff > 0"
              :span="2"
              label="负差留抵"
            >
              本月按 0 预扣，差额
              {{ fmt(row.negative_diff) }} 元留待以后月份继续抵减{{
                row.month.endsWith('-12')
                  ? '；12 月仍有负差=今年多扣了，次年 3–6 月年度汇算清缴可退'
                  : ''
              }}
            </Descriptions.Item>
            <Descriptions.Item v-if="row.note" :span="2" label="备注">
              {{ row.note }}
            </Descriptions.Item>
          </Descriptions>
        </div>
        <div v-if="drawerRows.length === 0" class="text-sm text-gray-400">
          该员工本年还没有工资单。
        </div>
      </template>
    </Drawer>
  </div>
</template>

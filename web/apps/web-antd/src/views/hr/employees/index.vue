<script lang="ts" setup>
import type { EmployeeRecord, OpeningRecord } from '#/api/payroll';

import { onMounted, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

import { useAccess } from '@vben/access';

import {
  Button,
  DatePicker,
  Input,
  InputNumber,
  message,
  Modal,
  Popconfirm,
  Switch,
  Table,
  Tag,
} from 'ant-design-vue';

import {
  archiveEmployeeApi,
  createEmployeeApi,
  deleteOpeningApi,
  getOpeningApi,
  listEmployeesApi,
  setOpeningApi,
  syncRosterApi,
  unarchiveEmployeeApi,
  updateEmployeeApi,
} from '#/api/payroll';

const route = useRoute();
// 按后端口径门控：新增/同步/编辑/归档/恢复/期初改删要 payroll:write；看名册与期初只要 payroll:read
const { hasAccessByCodes } = useAccess();
const canWrite = hasAccessByCodes(['payroll:write']);

function fmt(n: number): string {
  return n.toFixed(2);
}

// ---------- 名册 ----------
const employees = ref<EmployeeRecord[]>([]);
const empLoading = ref(false);
const showArchived = ref(false);
const syncing = ref(false);
/** 深链 ?id= 命中的员工行：高亮滚到可见。 */
const highlightId = ref('');

const employeeColumns = [
  { title: '姓名', key: 'name' },
  { title: '部门', dataIndex: 'department', key: 'department' },
  { title: '入职', dataIndex: 'hire_date', key: 'hire_date', width: 110 },
  { title: '离职', dataIndex: 'leave_date', key: 'leave_date', width: 110 },
  { title: '默认应发（元）', key: 'salary', align: 'right' as const },
  { title: '个人社保（元/月）', key: 'social', align: 'right' as const },
  { title: '专项附加（元/月）', key: 'extra', align: 'right' as const },
  { title: '来源', key: 'source', width: 90 },
  { title: '操作', key: 'actions', width: 210 },
];

async function loadEmployees() {
  empLoading.value = true;
  try {
    const body = await listEmployeesApi(showArchived.value);
    employees.value = body.employees;
    // 深链 ?id=（待办"看这名员工"跳过来）：不在当前列表（如已归档）就开"含归档"再取一次，然后高亮滚动
    const want =
      typeof route.query.id === 'string' ? route.query.id.trim() : '';
    if (want !== '') {
      highlightId.value = want;
      if (!employees.value.some((e) => String(e.id) === want)) {
        showArchived.value = true;
        const all = await listEmployeesApi(true);
        employees.value = all.employees;
      }
      if (employees.value.some((e) => String(e.id) === want)) {
        await new Promise((r) => setTimeout(r, 300));
        document
          .querySelector(`tr[data-row-key="${CSS.escape(want)}"]`)
          ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } else {
        message.warning(`没找到员工 #${want}（可能已删除，或名册还没同步）`);
      }
    }
  } catch (error) {
    message.error(`名册加载失败：${(error as Error)?.message ?? error}`);
  } finally {
    empLoading.value = false;
  }
}

async function onSync() {
  syncing.value = true;
  try {
    const body = await syncRosterApi();
    Modal.info({
      content: [
        `新建 ${body.created} 人、更新 ${body.updated} 人。`,
        body.skipped_archived > 0
          ? `跳过已归档 ${body.skipped_archived} 人（不复活）。`
          : '',
        body.missing_on_platform.length > 0
          ? `平台里查无此人：${body.missing_on_platform.join('、')}——不自动标离职，请人工确认后填离职日期。`
          : '平台里的人都在册。',
        body.pending_bind.length > 0
          ? `待绑定 ${body.pending_bind.length} 人（平台有同名、名册里是手工登记，没自动合并）：${body.pending_bind
              .map((x) => `${x.name}〔${x.open_id}〕`)
              .join(
                '、',
              )}——请编辑该员工把平台 open_id 填进去，下次同步就会接上。`
          : '',
        body.root_members === 'unavailable'
          ? '根部门直属成员平台没给（权限不足），这些人请手工登记。'
          : '',
        body.truncated ? '（平台名单被分页护栏截断，可能不全）' : '',
        body.note,
      ]
        .filter(Boolean)
        .join(' '),
      title: '同步完成',
    });
    await loadEmployees();
  } catch (error) {
    message.error(`同步失败：${(error as Error)?.message ?? error}`);
  } finally {
    syncing.value = false;
  }
}

const empFormOpen = ref(false);
const empSaving = ref(false);
const empEditing = ref<EmployeeRecord | null>(null);
const empForm = reactive({
  base_salary: undefined as number | undefined,
  department: '',
  extra_deduct: undefined as number | undefined,
  hire_date: undefined as string | undefined,
  leave_date: undefined as string | undefined,
  name: '',
  note: '',
  open_id: '',
  social: undefined as number | undefined,
});

function openEmpCreate() {
  empEditing.value = null;
  empForm.name = '';
  empForm.open_id = '';
  empForm.department = '';
  empForm.hire_date = undefined;
  empForm.leave_date = undefined;
  empForm.base_salary = undefined;
  empForm.social = undefined;
  empForm.extra_deduct = undefined;
  empForm.note = '';
  empFormOpen.value = true;
}

function openEmpEdit(record: EmployeeRecord) {
  empEditing.value = record;
  empForm.name = record.name;
  empForm.open_id = record.open_id;
  empForm.department = record.department;
  empForm.hire_date = record.hire_date || undefined;
  empForm.leave_date = record.leave_date || undefined;
  empForm.base_salary = record.base_salary;
  empForm.social = record.social;
  empForm.extra_deduct = record.extra_deduct;
  empForm.note = record.note;
  empFormOpen.value = true;
}

async function onEmpOk() {
  if (!empForm.name.trim()) return message.warning('请填姓名');
  empSaving.value = true;
  try {
    // 清空的 DatePicker 运行时会给 null/undefined：归一成空串（后端对空串不校验格式）
    const input = {
      base_salary: empForm.base_salary,
      department: empForm.department,
      extra_deduct: empForm.extra_deduct,
      hire_date: empForm.hire_date ?? '',
      leave_date: empForm.leave_date ?? '',
      name: empForm.name.trim(),
      note: empForm.note,
      open_id: empForm.open_id.trim(),
      social: empForm.social,
    };
    if (empEditing.value) {
      await updateEmployeeApi(empEditing.value.id, input);
      message.success(`已更新 ${input.name}`);
    } else {
      await createEmployeeApi(input);
      message.success(`已建员工 ${input.name}，记得填默认参数`);
    }
    empFormOpen.value = false;
    await loadEmployees();
  } catch (error) {
    message.error(`保存失败：${(error as Error)?.message ?? error}`);
  } finally {
    empSaving.value = false;
  }
}

async function onArchive(record: EmployeeRecord) {
  try {
    await archiveEmployeeApi(record.id);
    message.success(`已归档 ${record.name}（历史工资单保留）`);
    await loadEmployees();
  } catch (error) {
    message.error(`归档失败：${(error as Error)?.message ?? error}`);
  }
}

async function onUnarchive(record: EmployeeRecord) {
  try {
    await unarchiveEmployeeApi(record.id);
    message.success(`已恢复 ${record.name}，回到在册`);
    await loadEmployees();
  } catch (error) {
    message.error(`恢复失败：${(error as Error)?.message ?? error}`);
  }
}

// 期初累计（开账）：年中启用时，把今年启用前的累计数填在这里；之后从截止月的下一个月开始出单
const openingOpen = ref(false);
const openingSaving = ref(false);
const openingLoading = ref(false);
const openingTarget = ref<EmployeeRecord | null>(null);
const openingExisting = ref<null | OpeningRecord>(null);
const openingForm = reactive({
  extra_deduct: undefined as number | undefined,
  gross: undefined as number | undefined,
  note: '',
  relief: undefined as number | undefined,
  social: undefined as number | undefined,
  through_month: undefined as string | undefined,
  withheld: undefined as number | undefined,
  year: undefined as string | undefined,
});

function currentYear(): string {
  return String(new Date().getFullYear());
}

async function loadOpening() {
  if (!openingTarget.value || !openingForm.year) return;
  openingLoading.value = true;
  try {
    const rec = await getOpeningApi(openingTarget.value.id, openingForm.year);
    openingExisting.value = rec;
    openingForm.through_month = rec?.through_month ?? undefined;
    openingForm.gross = rec?.gross ?? undefined;
    openingForm.social = rec?.social ?? undefined;
    openingForm.extra_deduct = rec?.extra_deduct ?? undefined;
    openingForm.relief = rec?.relief ?? undefined;
    openingForm.withheld = rec?.withheld ?? undefined;
    openingForm.note = rec?.note ?? '';
  } catch (error) {
    message.error(`期初累计加载失败：${(error as Error)?.message ?? error}`);
  } finally {
    openingLoading.value = false;
  }
}

async function openOpening(record: EmployeeRecord) {
  openingTarget.value = record;
  openingForm.year = currentYear();
  openingOpen.value = true;
  await loadOpening();
}

async function onOpeningOk() {
  if (!openingTarget.value || !openingForm.year) return;
  if (!openingForm.through_month)
    return message.warning('请选"累计截至哪个月"');
  openingSaving.value = true;
  try {
    await setOpeningApi({
      employee_id: openingTarget.value.id,
      extra_deduct: openingForm.extra_deduct ?? 0,
      gross: openingForm.gross ?? 0,
      note: openingForm.note,
      relief: openingForm.relief ?? 0,
      social: openingForm.social ?? 0,
      through_month: openingForm.through_month,
      withheld: openingForm.withheld ?? 0,
      year: openingForm.year,
    });
    message.success(
      `已保存 ${openingTarget.value.name} ${openingForm.year} 年期初累计，从 ${openingForm.through_month} 的下一个月开始生成工资单`,
    );
    openingOpen.value = false;
  } catch (error) {
    message.error(`保存失败：${(error as Error)?.message ?? error}`);
  } finally {
    openingSaving.value = false;
  }
}

async function onOpeningDelete() {
  if (!openingTarget.value || !openingForm.year) return;
  try {
    await deleteOpeningApi(openingTarget.value.id, openingForm.year);
    message.success('已删除期初累计');
    openingOpen.value = false;
  } catch (error) {
    message.error(`删除失败：${(error as Error)?.message ?? error}`);
  }
}

onMounted(() => {
  loadEmployees();
});

// 页签 keep-alive：页面已开着又从待办「看这名员工」跳过来时 onMounted 不会再跑，靠 query 变化重新定位
watch(
  () => route.query,
  (q, old) => {
    if (route.path === '/hr' && JSON.stringify(q) !== JSON.stringify(old))
      void loadEmployees();
  },
);
</script>

<template>
  <div class="p-4">
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <span class="text-sm text-gray-500">
        名册=人+算工资的参数；「从飞书同步」只更新姓名/部门，工资参数永远本地维护
      </span>
      <div class="flex-1"></div>
      <span class="text-sm text-gray-500">已归档</span>
      <Switch v-model:checked="showArchived" @change="loadEmployees" />
      <Button v-if="canWrite" @click="openEmpCreate">新增员工</Button>
      <Button v-if="canWrite" :loading="syncing" type="primary" @click="onSync">
        从飞书同步
      </Button>
    </div>
    <Table
      :columns="employeeColumns"
      :data-source="employees"
      :loading="empLoading"
      :pagination="false"
      :row-class-name="
        (r: EmployeeRecord) =>
          String(r.id) === highlightId ? 'row-highlight' : ''
      "
      row-key="id"
      size="small"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'name'">
          {{ (record as EmployeeRecord).name }}
          <span class="text-xs text-gray-400"
            >#{{ (record as EmployeeRecord).id }}</span
          >
          <Tag v-if="(record as EmployeeRecord).archived_at" color="default">
            已归档
          </Tag>
        </template>
        <template v-else-if="column.key === 'salary'">
          {{ fmt((record as EmployeeRecord).base_salary) }}
        </template>
        <template v-else-if="column.key === 'social'">
          {{ fmt((record as EmployeeRecord).social) }}
        </template>
        <template v-else-if="column.key === 'extra'">
          {{ fmt((record as EmployeeRecord).extra_deduct) }}
        </template>
        <template v-else-if="column.key === 'source'">
          <Tag :color="(record as EmployeeRecord).open_id ? 'blue' : 'default'">
            {{ (record as EmployeeRecord).open_id ? '平台' : '手工' }}
          </Tag>
        </template>
        <template v-else-if="column.key === 'actions'">
          <Button
            v-if="canWrite && !(record as EmployeeRecord).archived_at"
            size="small"
            type="link"
            @click="openEmpEdit(record as EmployeeRecord)"
          >
            编辑
          </Button>
          <Button
            v-if="!(record as EmployeeRecord).archived_at"
            size="small"
            type="link"
            @click="openOpening(record as EmployeeRecord)"
          >
            期初
          </Button>
          <Popconfirm
            v-if="canWrite && !(record as EmployeeRecord).archived_at"
            :title="`归档 ${record.name}？名册里不再出现，历史工资单保留。`"
            @confirm="onArchive(record as EmployeeRecord)"
          >
            <Button danger size="small" type="link">归档</Button>
          </Popconfirm>
          <Popconfirm
            v-if="canWrite && (record as EmployeeRecord).archived_at"
            :title="`恢复 ${record.name} 到在册？平台绑定若已被别人占用会拒绝。`"
            @confirm="onUnarchive(record as EmployeeRecord)"
          >
            <Button size="small" type="link">恢复</Button>
          </Popconfirm>
        </template>
      </template>
    </Table>

    <Modal
      :confirm-loading="empSaving"
      :open="empFormOpen"
      :title="empEditing ? `编辑 ${empEditing.name}` : '新增员工'"
      @cancel="empFormOpen = false"
      @ok="onEmpOk"
    >
      <div class="grid grid-cols-2 gap-x-4 gap-y-3">
        <div>
          <div class="mb-1 text-sm text-gray-500">姓名 *</div>
          <Input v-model:value="empForm.name" />
        </div>
        <div>
          <div class="mb-1 text-sm text-gray-500">部门</div>
          <Input v-model:value="empForm.department" />
        </div>
        <div>
          <div class="mb-1 text-sm text-gray-500">入职日期</div>
          <DatePicker
            v-model:value="empForm.hire_date"
            class="w-full"
            value-format="YYYY-MM-DD"
          />
        </div>
        <div>
          <div class="mb-1 text-sm text-gray-500">离职日期（留空=在职）</div>
          <DatePicker
            v-model:value="empForm.leave_date"
            class="w-full"
            value-format="YYYY-MM-DD"
          />
        </div>
        <div>
          <div class="mb-1 text-sm text-gray-500">默认应发（元/月）</div>
          <InputNumber
            v-model:value="empForm.base_salary"
            class="w-full"
            :min="0"
            :precision="2"
          />
        </div>
        <div>
          <div class="mb-1 text-sm text-gray-500">个人社保公积金（元/月）</div>
          <InputNumber
            v-model:value="empForm.social"
            class="w-full"
            :min="0"
            :precision="2"
          />
        </div>
        <div>
          <div class="mb-1 text-sm text-gray-500">专项附加扣除（元/月）</div>
          <InputNumber
            v-model:value="empForm.extra_deduct"
            class="w-full"
            :min="0"
            :precision="2"
          />
        </div>
        <div>
          <div class="mb-1 text-sm text-gray-500">备注</div>
          <Input v-model:value="empForm.note" />
        </div>
        <div class="col-span-2">
          <div class="mb-1 text-sm text-gray-500">
            平台 open_id（留空=手工登记；同步时按它认人）
          </div>
          <Input
            v-model:value="empForm.open_id"
            placeholder="ou_xxx，从飞书同步结果的「待绑定」里拿"
          />
        </div>
        <div class="col-span-2 text-xs text-gray-400">
          入职月份决定个税减除费用的起算月（年中入职的人务必填入职日期）；已出过工资单的年份，入职/离职日期改不动，先删单再改。
          历史工资单在「人事 › 工资表」查看。
        </div>
      </div>
    </Modal>

    <Modal
      :confirm-loading="openingSaving"
      :footer="canWrite ? undefined : null"
      :open="openingOpen"
      :title="
        openingTarget ? `${openingTarget.name} 的期初累计（开账）` : '期初累计'
      "
      @cancel="openingOpen = false"
      @ok="onOpeningOk"
    >
      <div class="mb-3 text-xs text-gray-400">
        年中启用用这个：把今年启用前（截至某月末）这个人的累计应发、个人社保公积金、专项附加、减免、已预扣个税填进来，
        工资单从截止月的下一个月开始生成。没填的按 0 算（前面没有就按 0
        登记）。该年已出过工资单就改不了，要先从最后一月起把单删掉。
      </div>
      <div v-if="openingLoading" class="text-sm text-gray-400">加载中…</div>
      <div v-else class="grid grid-cols-2 gap-x-4 gap-y-3">
        <div>
          <div class="mb-1 text-sm text-gray-500">年份</div>
          <DatePicker
            v-model:value="openingForm.year"
            class="w-full"
            picker="year"
            value-format="YYYY"
            @change="loadOpening"
          />
        </div>
        <div>
          <div class="mb-1 text-sm text-gray-500">累计截至哪个月（月末）*</div>
          <DatePicker
            v-model:value="openingForm.through_month"
            class="w-full"
            :disabled="!canWrite"
            picker="month"
            value-format="YYYY-MM"
          />
        </div>
        <div>
          <div class="mb-1 text-sm text-gray-500">累计应发（元）</div>
          <InputNumber
            v-model:value="openingForm.gross"
            class="w-full"
            :disabled="!canWrite"
            :min="0"
            :precision="2"
          />
        </div>
        <div>
          <div class="mb-1 text-sm text-gray-500">累计个人社保公积金（元）</div>
          <InputNumber
            v-model:value="openingForm.social"
            class="w-full"
            :disabled="!canWrite"
            :min="0"
            :precision="2"
          />
        </div>
        <div>
          <div class="mb-1 text-sm text-gray-500">累计专项附加扣除（元）</div>
          <InputNumber
            v-model:value="openingForm.extra_deduct"
            class="w-full"
            :disabled="!canWrite"
            :min="0"
            :precision="2"
          />
        </div>
        <div>
          <div class="mb-1 text-sm text-gray-500">
            累计减免税额（元，一般 0）
          </div>
          <InputNumber
            v-model:value="openingForm.relief"
            class="w-full"
            :disabled="!canWrite"
            :min="0"
            :precision="2"
          />
        </div>
        <div>
          <div class="mb-1 text-sm text-gray-500">累计已预扣个税（元）</div>
          <InputNumber
            v-model:value="openingForm.withheld"
            class="w-full"
            :disabled="!canWrite"
            :min="0"
            :precision="2"
          />
        </div>
        <div>
          <div class="mb-1 text-sm text-gray-500">备注</div>
          <Input v-model:value="openingForm.note" :disabled="!canWrite" />
        </div>
        <div
          v-if="openingExisting"
          class="col-span-2 flex items-center justify-between text-xs text-gray-400"
        >
          <span
            >已有记录：{{ openingExisting.updated_by }} 于
            {{ openingExisting.updated_at.slice(0, 10) }} 保存</span
          >
          <Popconfirm
            v-if="canWrite"
            title="删除这一年的期初累计？该年已出过工资单会被拒绝。"
            @confirm="onOpeningDelete"
          >
            <Button danger size="small" type="link">删除期初</Button>
          </Popconfirm>
        </div>
      </div>
    </Modal>
  </div>
</template>

<style scoped>
:deep(tr.row-highlight > td) {
  background-color: rgb(250 173 20 / 15%);
}
</style>

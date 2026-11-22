<script lang="ts" setup>
import type { Dayjs } from 'dayjs';

import type { RouteLocationRaw } from 'vue-router';

// 待办中心（2026-10-31 待办预警方案 §七；同日二批按用户口述定版）：预警/待办/晨报是同一实体
// （obligations）的三种投影，这里是界面投影。四视图：今日（我的，按到期分桶）/ 日历（我的+岗位池，月格）/
// 岗位池（持岗可见）/ 企业（admin:manage，全员+责任路由+立即扫描）。
// 动作口径：人工待办=修改/已完成（备注可选）；推导型=修改/暂不处理/已完成——「已完成」由后端先核实
// 源头（消失→闭合；还在→告知并恢复提醒；无法核实→填备注强制确认，永久关闭）。
// 点标题/日历条目打开详情抽屉：信息 + 处理流程指引 + 时间线。责任路由默认收起，点开再管理。
import type {
  CompleteOutcome,
  Obligation,
  ObligationSeverity,
  RecurringItem,
  TodoRoute,
} from '#/api/todos';

import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { useAccess } from '@vben/access';

import {
  Alert,
  Button,
  Card,
  Collapse,
  DatePicker,
  Drawer,
  Empty,
  Input,
  message,
  Modal,
  Radio,
  RadioGroup,
  Select,
  Switch,
  Tabs,
  Tag,
  Textarea,
  Timeline,
} from 'ant-design-vue';
import dayjs from 'dayjs';

import {
  ackTodoApi,
  createTodoApi,
  doneTodoApi,
  listTodosApi,
  recurringTodosApi,
  runScanApi,
  setTodoRouteApi,
  todoOwnersApi,
  todoRoutesApi,
  todoSummaryApi,
  updateTodoApi,
} from '#/api/todos';
import { TODO_SOURCE_LABELS } from '#/constants/labels';
import { todoEntityLink } from '#/utils/entity-links';

import TodoItem from './todo-item.vue';

const { hasAccessByCodes } = useAccess();
const isAdmin = computed(() => hasAccessByCodes(['admin:manage']));
// 新建/修改/完成/暂不处理要 todo:write（与全站"只读角色不看会 403 的按钮"口径一致）
const canWrite = hasAccessByCodes(['todo:write']);
const route = useRoute();
const router = useRouter();

const activeTab = ref<'calendar' | 'enterprise' | 'pool' | 'today'>('today');
const loading = ref(false);
const mine = ref<Obligation[]>([]);
const pool = ref<Obligation[]>([]);
const enterprise = ref<Obligation[]>([]);
const enterpriseStatus = ref<'active' | 'all'>('active');
const summary = ref({ overdue: 0, today: 0, upcoming7: 0, undated: 0 });

const today = () => dayjs().startOf('day');

/** 今日视图分桶：逾期 / 今天 / 未来 7 天 / 更远 / 无日期。 */
const buckets = computed(() => {
  const t = today();
  const b = {
    overdue: [] as Obligation[],
    today: [] as Obligation[],
    week: [] as Obligation[],
    later: [] as Obligation[],
    undated: [] as Obligation[],
  };
  for (const it of mine.value) {
    if (it.due_date === '') {
      b.undated.push(it);
      continue;
    }
    const diff = dayjs(it.due_date).startOf('day').diff(t, 'day');
    if (diff < 0) b.overdue.push(it);
    else if (diff === 0) b.today.push(it);
    else if (diff <= 7) b.week.push(it);
    else b.later.push(it);
  }
  return b;
});

/** 岗位池按岗位分组。 */
const poolByRole = computed(() => {
  const m = new Map<string, Obligation[]>();
  for (const it of pool.value) {
    const arr = m.get(it.owner_id) ?? [];
    arr.push(it);
    m.set(it.owner_id, arr);
  }
  return [...m.entries()];
});

// ---------- 日历（月格） ----------
const monthCursor = ref<Dayjs>(dayjs().startOf('month'));
const selectedDay = ref<string>(dayjs().format('YYYY-MM-DD'));

/** 每月固定事项（全月历投影）：报税/社保等整月预列——提早=提示，当天起=预警；随月份切换重取。 */
const recurringItems = ref<RecurringItem[]>([]);

let loadRecurringSeq = 0;

async function loadRecurring() {
  const seq = ++loadRecurringSeq; // 连续切月时慢响应不得覆盖当前月（后完成者胜→丢当月投影）
  try {
    const items = (await recurringTodosApi(monthCursor.value.format('YYYY-MM')))
      .items;
    if (seq === loadRecurringSeq) recurringItems.value = items;
  } catch {
    if (seq === loadRecurringSeq) recurringItems.value = [];
  }
}

watch(monthCursor, () => {
  void loadRecurring();
});

/** 日历数据源=我的+岗位池（按 id 去重）。 */
const calendarItems = computed(() => {
  const seen = new Set<number>();
  const out: Obligation[] = [];
  for (const it of [...mine.value, ...pool.value]) {
    if (seen.has(it.id) || it.due_date === '') continue;
    seen.add(it.id);
    out.push(it);
  }
  return out;
});

const itemsByDay = computed(() => {
  const m = new Map<string, Obligation[]>();
  for (const it of calendarItems.value) {
    const arr = m.get(it.due_date) ?? [];
    arr.push(it);
    m.set(it.due_date, arr);
  }
  return m;
});

const recurringByDay = computed(() => {
  const m = new Map<string, RecurringItem[]>();
  for (const r of recurringItems.value) {
    const arr = m.get(r.due) ?? [];
    arr.push(r);
    m.set(r.due, arr);
  }
  return m;
});

/** 月格：周一起，6 行 × 7 列铺满。 */
const monthGrid = computed(() => {
  const first = monthCursor.value;
  const offset = (first.day() + 6) % 7;
  const start = first.subtract(offset, 'day');
  const cells: {
    date: string;
    inMonth: boolean;
    items: Obligation[];
    recurring: RecurringItem[];
  }[] = [];
  for (let i = 0; i < 42; i++) {
    const d = start.add(i, 'day');
    const key = d.format('YYYY-MM-DD');
    cells.push({
      date: key,
      inMonth: d.month() === first.month(),
      items: itemsByDay.value.get(key) ?? [],
      recurring: recurringByDay.value.get(key) ?? [],
    });
  }
  return cells;
});

const selectedDayItems = computed(
  () => itemsByDay.value.get(selectedDay.value) ?? [],
);

const selectedDayRecurring = computed(
  () => recurringByDay.value.get(selectedDay.value) ?? [],
);

function cellColor(
  items: Obligation[],
  recurring: RecurringItem[],
  date: string,
): string {
  // 每月固定事项：当天/已逾期算预警（红），提早只是提示（蓝）；真待办口径不变
  const alert =
    (items.length > 0 &&
      (items.some((i) => i.severity === 'critical') ||
        dayjs(date).isBefore(today()))) ||
    recurring.some((r) => r.phase !== 'early');
  if (alert) return 'bg-red-50 border-red-200';
  if (items.some((i) => i.severity === 'warn'))
    return 'bg-orange-50 border-orange-200';
  if (items.length > 0 || recurring.length > 0)
    return 'bg-blue-50 border-blue-200';
  return '';
}

// ---------- 加载 ----------
async function loadAll() {
  loading.value = true;
  try {
    const [m, p, s] = await Promise.all([
      listTodosApi({ scope: 'mine' }),
      listTodosApi({ scope: 'pool' }),
      todoSummaryApi(),
    ]);
    mine.value = m.items;
    pool.value = p.items;
    summary.value = s;
    if (isAdmin.value && activeTab.value === 'enterprise')
      await loadEnterprise();
  } finally {
    loading.value = false;
  }
}

async function loadEnterprise() {
  const r = await listTodosApi({
    scope: 'enterprise',
    status: enterpriseStatus.value,
    limit: 500,
  });
  enterprise.value = r.items;
}

watch(activeTab, (t) => {
  if (t === 'enterprise' && isAdmin.value)
    void loadEnterprise().then(loadRoutes);
});
watch(enterpriseStatus, () => {
  if (isAdmin.value) void loadEnterprise();
});

// ---------- 已完成（核实式） ----------
const completing = ref<Obligation>();
const completeNote = ref('');
const completeBusy = ref(false);
/** 首次点「已完成」后的核实结果：pending/unverifiable 时弹窗不关，给出强制确认的出口。 */
const completeVerdict = ref<{ message?: string; outcome: CompleteOutcome }>();

function onComplete(item: Obligation) {
  completing.value = item;
  completeNote.value = '';
  completeVerdict.value = undefined;
}

const completingDerived = computed(() => completing.value?.origin === 'scan');

/** 强制确认的备注快选：按来源给常用理由，点一下填进输入框（可再改）。 */
const FORCE_PRESETS: Record<string, string[]> = {
  'scan.filing': ['已申报并缴费', '已办理完成'],
  'scan.receivable': [
    '已收款并核销',
    '客户现金付清，账还没记',
    '对方确认延期，先关掉',
  ],
  'scan.payable': ['已付款', '对方取消'],
  'scan.proposal_pending': ['已确认入账', '记账单已退回'],
  'scan.missing_invoice': ['已补票挂票'],
  'scan.zero_role_account': ['账号已处理'],
  'scan.supply.below_safety': [
    '已补货入库并重新导库存',
    '该物料已停产，改安全线或归档',
  ],
  'scan.supply.po_overdue': ['货已收到但还没记到货', '供应商确认延期，先关掉'],
  'scan.supply.expiry_near': ['批次已处置（用掉/退回/报损）'],
  'scan.payroll.roster': ['已核实，名册与通讯录无需改动', '差异已处理'],
  'scan.payroll.social': ['社保增减员已在社保系统办结'],
  'scan.finance.profile': ['参数已按最新情况核对，无需改动'],
};
const forcePresets = computed(
  () => FORCE_PRESETS[completing.value?.source_type ?? ''] ?? [],
);

async function submitComplete(force = false) {
  const item = completing.value;
  if (!item) return;
  const note = completeNote.value.trim();
  if (force && note === '') {
    message.warning(
      '强制确认完成必须填一句备注原因——这是回看时唯一的"为什么这样处理"',
    );
    return;
  }
  completeBusy.value = true;
  try {
    const r = await doneTodoApi(item.id, {
      note: note === '' ? undefined : note,
      force: force || undefined,
    });
    if (r.outcome === 'done') {
      message.success(`已完成：${r.item.title}`);
      completing.value = undefined;
      await loadAll();
    } else if (r.outcome === 'resolved') {
      message.success(r.message ?? '已核实：源头已处理完，待办自动消除', 5);
      completing.value = undefined;
      await loadAll();
    } else if (r.outcome === 'forced') {
      message.success('已按备注确认完成：永久关闭，源头再出现也不再提醒', 5);
      completing.value = undefined;
      await loadAll();
    } else {
      // pending（源头还在）/ unverifiable（无法核实）：弹窗不关，给「强制确认完成」的出口；用最新行回填防陈旧
      completeVerdict.value = { message: r.message, outcome: r.outcome };
      completing.value = r.item;
      await loadAll();
    }
  } catch {
    // 已关闭/没权限等由后端 400/403 统一提示
  } finally {
    completeBusy.value = false;
  }
}

async function onAck(item: Obligation) {
  try {
    await ackTodoApi(item.id);
    message.success(
      '已标记暂不处理：不再推送这条（待办中心仍可见），到期升级时会再提醒一次',
    );
    await loadAll();
  } catch {
    // 后端统一提示
  }
}

// ---------- 详情抽屉 ----------
const detailItem = ref<Obligation>();

function openDetail(item: Obligation) {
  detailItem.value = item;
}

/** 每月固定事项点开：同一只详情抽屉，喂一条"尚未成为待办"的预列条目（id=0 → 抽屉隐藏责任人行与操作钮）。 */
function openRecurringDetail(r: RecurringItem, siblings: RecurringItem[]) {
  const others = siblings.filter((x) => x.key !== r.key).map((x) => x.title);
  detailItem.value = {
    id: 0,
    source_type: 'scan.filing',
    source_ref: '',
    dedupe_key: r.key,
    title: r.title,
    detail: `企业每月固定事项，整月预列（${r.phase === 'early' ? '现在只是提示' : '已到预警期'}，还不是正式待办）。截止 ${r.due}，办理渠道：${r.channel}。${
      r.phase === 'early'
        ? '进入临期窗口（截止前 7 天）后，每日扫描会把它生成待办中心的正式待办并开始提醒。'
        : '已到预警期：尽快办理。到期前后它会出现在待办中心，办完点「已完成」由系统核实关闭。'
    }${others.length > 0 ? `\n同一天还有：${others.join('、')}。` : ''}`,
    owner_type: 'user',
    owner_id: '',
    due_date: r.due,
    severity: r.severity,
    status: r.phase === 'overdue' ? 'escalated' : 'open',
    origin: 'scan',
    first_seen_at: '',
    escalated_at: null,
    last_notified: '',
    resolved_at: null,
    dismissed_by: '',
    dismissed_reason: '',
    dismissed_at: null,
    done_by: '',
    done_at: null,
    done_note: '',
    user_edited: 0,
    created_by: '',
    created_at: '',
  };
}

/** 每类待办的处理流程指引：几步走 + 直达入口（落到页面级，不在这一步做行内定位）。 */
const PROCESS_GUIDE: Record<
  string,
  { links: { path: string; text: string }[]; steps: string[] }
> = {
  'scan.filing': {
    steps: [
      '到财务「流水台账」打开征期数据包，备好申报数字',
      '去对应渠道完成申报/缴费（电子税务局、社保费模块等，渠道见下方说明）',
      '回来点「已完成」填备注（如"已申报"）——这类事系统无法核实，备注是唯一记录',
    ],
    links: [{ path: '/finance/ledger', text: '财务·流水台账（征期数据包）' }],
  },
  'scan.receivable': {
    steps: [
      '催收并确认到账',
      '到财务「流水台账」找到这笔账目（下方说明里有编号），把收款登记进去（核销）',
      '核销后本条自动消除；也可以直接点「已完成」，系统会先核实源头',
    ],
    links: [{ path: '/finance/ledger', text: '财务·流水台账' }],
  },
  'scan.payable': {
    steps: [
      '安排付款并确认出账',
      '到财务「流水台账」找到这笔账目，把付款登记进去（核销）',
      '核销后本条自动消除；也可以直接点「已完成」，系统会先核实源头',
    ],
    links: [{ path: '/finance/ledger', text: '财务·流水台账' }],
  },
  'scan.proposal_pending': {
    steps: [
      '到财务「待确认记账」找到这条记账单',
      '确认入账，或退回让智能助手重新提交',
      '处理后本条自动消除',
    ],
    links: [{ path: '/finance/proposals', text: '财务·待确认记账' }],
  },
  'scan.zero_role_account': {
    steps: [
      '到「系统·角色权限」给这个账号配角色（在岗就配岗）',
      '确认不用了就停用账号',
      '处理后本条自动消除',
    ],
    links: [{ path: '/system', text: '系统·角色权限' }],
  },
  'scan.missing_invoice': {
    steps: [
      '到财务「票夹」切到「缺票清单」，逐笔核对',
      '挂上在手发票或补票',
      '清单清零后本条自动消除',
    ],
    links: [{ path: '/finance/invoices', text: '财务·票夹（缺票清单）' }],
  },
  'scan.supply.below_safety': {
    steps: [
      '补货：到货后把新读数导入库存（CSV 或多维表格同步）',
      '补到安全线上本条自动消除；确实不备了就改安全线或归档物料',
    ],
    links: [{ path: '/supply', text: '供应链·库存物料（只看低于安全线）' }],
  },
  'scan.supply.po_overdue': {
    steps: [
      '联系供应商确认到货时间',
      '货到了点「收货」，确定不来了点「取消」——处理后本条自动消除',
    ],
    links: [{ path: '/supply/purchase', text: '供应链·采购台账（只看逾期）' }],
  },
  'scan.supply.expiry_near': {
    steps: [
      '优先用掉临期批次，或与供应商协商退换',
      '确实过期的按报损处理；处置完重新导库存读数，本条自动消除',
    ],
    links: [{ path: '/supply', text: '供应链·库存物料（顶部临期提醒）' }],
  },
  'scan.payroll.roster': {
    steps: [
      '新同事入职：到「人事 › 员工名册」建档（点待办上的"看这名员工"直达）',
      '离职同事：名册里归档',
      '处理完点「已完成」，下轮检查核实，源头消失后自动消除',
    ],
    links: [{ path: '/hr', text: '人事·员工名册' }],
  },
  'scan.payroll.social': {
    steps: [
      '到社保经办系统办增员/减员',
      '回来点「已完成」：系统按名册核实增减员口径是否一致（按月比对）',
      '口径不一致会提示差额，核对无误后可强制确认',
    ],
    links: [{ path: '/hr', text: '人事·员工名册' }],
  },
  'scan.finance.profile': {
    steps: [
      '到「财务 › 财务设置」核对该参数的新旧值',
      '按最新情况改参数或确认无需改动后点「已完成」',
    ],
    links: [{ path: '/finance/settings', text: '财务·财务设置' }],
  },
  manual: {
    steps: [
      '按待办说明把事办完',
      '点「已完成」，可写一句备注；要改内容/到期/分给谁点「修改」',
    ],
    links: [],
  },
};

const detailGuide = computed(
  () =>
    PROCESS_GUIDE[detailItem.value?.source_type ?? ''] ?? PROCESS_GUIDE.manual!,
);

/** 详情抽屉的直达链接：source_ref 里有实体编号就直接给"看源头"按钮（与待办行上的一致）。 */
const detailEntityLink = computed(() =>
  detailItem.value && detailItem.value.id !== 0
    ? todoEntityLink(detailItem.value.source_type, detailItem.value.source_ref)
    : undefined,
);

const fmtTs = (ts?: null | string): string =>
  ts ? dayjs(ts).format('YYYY-MM-DD HH:mm') : '';

/** 详情时间线：创建/发现 → 逾期升级 → 暂不处理 → 终态（备注一并展示）。 */
const detailTimeline = computed(() => {
  const it = detailItem.value;
  if (!it) return [];
  const out: { color: string; text: string }[] = [];
  if (it.first_seen_at === '' && it.created_at === '') {
    out.push({
      color: 'blue',
      text: '全月历预列（每月固定事项，尚未生成正式待办）',
    });
  } else {
    out.push(
      it.origin === 'manual'
        ? {
            color: 'blue',
            text: `创建于 ${fmtTs(it.created_at)}（${it.created_by}）`,
          }
        : {
            color: 'blue',
            text: `系统扫描首次发现 ${fmtTs(it.first_seen_at)}`,
          },
    );
  }
  if (it.escalated_at)
    out.push({
      color: 'red',
      text: `到期未办，升级提醒 ${fmtTs(it.escalated_at)}`,
    });
  if (it.last_notified.startsWith('ack:'))
    out.push({
      color: 'gray',
      text: `标记暂不处理 ${it.last_notified.slice(4)}（日期）`,
    });
  if (it.status === 'resolved')
    out.push({
      color: 'green',
      text: `已消除 ${fmtTs(it.resolved_at)}${it.done_by ? `（${it.done_by} 点已完成，系统核实源头已处理）` : '（源头消失，自动消除）'}`,
    });
  if (it.status === 'done')
    out.push({
      color: 'green',
      text: `已完成 ${fmtTs(it.done_at)}（${it.done_by}）${it.done_note ? `，备注：${it.done_note}` : ''}`,
    });
  if (it.status === 'dismissed')
    out.push({
      color: 'green',
      text: `按备注确认完成 ${fmtTs(it.dismissed_at)}（${it.dismissed_by}），备注：${it.dismissed_reason}——永久关闭，源头再出现也不再提醒`,
    });
  return out;
});

function goto(to: RouteLocationRaw) {
  detailItem.value = undefined;
  void router.push(to);
}

// ---------- 新建 / 编辑 ----------
const editorOpen = ref(false);
const editingId = ref<number>();
const editingItem = ref<Obligation>();
const editingDerived = computed(() => editingItem.value?.origin === 'scan');
const form = ref<{
  title: string;
  detail: string;
  ownerType: 'role' | 'user';
  ownerId: string | undefined;
  dueDate: Dayjs | undefined;
  severity: ObligationSeverity;
}>({
  title: '',
  detail: '',
  ownerType: 'user',
  ownerId: undefined,
  dueDate: undefined,
  severity: 'info',
});
const owners = ref<{
  users: { username: string; displayName: string }[];
  roles: string[];
}>({ users: [], roles: [] });
const saving = ref(false);

async function openCreate() {
  editingId.value = undefined;
  editingItem.value = undefined;
  form.value = {
    title: '',
    detail: '',
    ownerType: 'user',
    ownerId: undefined,
    dueDate: undefined,
    severity: 'info',
  };
  editorOpen.value = true;
  if (owners.value.users.length === 0) owners.value = await todoOwnersApi();
}

async function openEdit(item: Obligation) {
  editingId.value = item.id;
  editingItem.value = item;
  form.value = {
    title: item.title,
    detail: item.detail,
    ownerType: item.owner_type,
    ownerId: item.owner_id,
    dueDate: item.due_date ? dayjs(item.due_date) : undefined,
    severity: item.severity,
  };
  editorOpen.value = true;
  if (owners.value.users.length === 0) owners.value = await todoOwnersApi();
}

async function saveEditor() {
  const derived = editingDerived.value;
  const title = form.value.title.trim();
  if (!derived && title === '') {
    message.warning('先填标题');
    return;
  }
  saving.value = true;
  // 推导型只送可改的三项：标题/说明由系统从源头维护（后端同样守着）
  const base = {
    ownerType: form.value.ownerType,
    ownerId: form.value.ownerId,
    dueDate: form.value.dueDate ? form.value.dueDate.format('YYYY-MM-DD') : '',
    severity: form.value.severity,
  };
  const text = { title, detail: form.value.detail.trim() };
  try {
    if (editingId.value === undefined) {
      await createTodoApi({ ...base, ...text });
      message.success('待办已创建');
    } else {
      await updateTodoApi(
        editingId.value,
        derived ? base : { ...base, ...text },
      );
      message.success(
        derived
          ? '已更新（到期/严重度/责任人由你定，扫描不再覆盖）'
          : '待办已更新',
      );
    }
    editorOpen.value = false;
    await loadAll();
  } catch {
    // 校验错误由后端 400 统一提示
  } finally {
    saving.value = false;
  }
}

// ---------- 企业视图：扫描与路由 ----------
const scanning = ref(false);
async function runScan() {
  scanning.value = true;
  try {
    const r = await runScanApi();
    const created = r.scanners.reduce((n, s) => n + s.created, 0);
    const failed = r.scanners.filter((s) => s.error !== undefined);
    message.success(
      `检查完成：新建 ${created}、升级 ${r.escalated}、自动消除 ${r.scanners.reduce((n, s) => n + s.autoResolved, 0)}${failed.length > 0 ? `；${failed.length} 项检查失败：${failed.map((f) => TODO_SOURCE_LABELS[f.scanner] ?? f.label).join('、')}` : ''}`,
      6,
    );
    await loadAll();
    await loadEnterprise();
  } finally {
    scanning.value = false;
  }
}

const routes = ref<TodoRoute[]>([]);
async function loadRoutes() {
  if (!isAdmin.value) return;
  routes.value = (await todoRoutesApi()).routes;
  if (owners.value.users.length === 0) owners.value = await todoOwnersApi();
}

async function saveRoute(
  r: TodoRoute,
  patch: { ownerType?: 'role' | 'user'; ownerId?: string; enabled?: boolean },
) {
  try {
    const res = await setTodoRouteApi(r.source_type, patch);
    const idx = routes.value.findIndex((x) => x.source_type === r.source_type);
    if (idx !== -1) routes.value[idx] = res.route;
    delete routeDraft.value[r.source_type];
    message.success(
      patch.ownerId === undefined
        ? `「${TODO_SOURCE_LABELS[r.source_type] ?? r.source_type}」${patch.enabled === false ? '已停用' : '已恢复检查'}`
        : `「${TODO_SOURCE_LABELS[r.source_type] ?? r.source_type}」已改给 ${patch.ownerType === 'role' || (patch.ownerType === undefined && r.owner_type === 'role') ? '岗位' : ''}${patch.ownerId}，仍在处理的待办一并移交`,
    );
    void loadAll();
  } catch {
    // 用户/角色不存在由后端 400 提示
  }
}

/** 路由"人/岗位"切换只记草稿：选定具体责任人才真正保存（避免一点类型就按列表第一项瞬时改绑并移交）。 */
const routeDraft = ref<Record<string, 'role' | 'user'>>({});
function onRouteOwnerType(r: TodoRoute, e: { target: { value?: unknown } }) {
  const ownerType = e.target.value === 'role' ? 'role' : 'user';
  if (ownerType === r.owner_type) delete routeDraft.value[r.source_type];
  else routeDraft.value[r.source_type] = ownerType;
}
function routeOwnerType(r: TodoRoute): 'role' | 'user' {
  return routeDraft.value[r.source_type] ?? r.owner_type;
}
function onRouteOwnerPick(r: TodoRoute, v: unknown) {
  const ownerType = routeOwnerType(r);
  void saveRoute(
    r,
    ownerType === r.owner_type
      ? { ownerId: String(v) }
      : { ownerType, ownerId: String(v) },
  );
}

/** 企业视图按责任人分组（方案 §七：谁的事归谁，岗位→人两级串起来看）；来源在条目标签上。 */
const enterpriseGrouped = computed(() => {
  const m = new Map<string, Obligation[]>();
  for (const it of enterprise.value) {
    const key =
      it.owner_type === 'role'
        ? `岗位「${it.owner_id}」`
        : `负责人 ${it.owner_id}`;
    const arr = m.get(key) ?? [];
    arr.push(it);
    m.set(key, arr);
  }
  // 岗位在前、人在后，组内保持接口顺序（到期日升序）
  return [...m.entries()].sort(([a], [b]) =>
    a.startsWith('岗位') === b.startsWith('岗位')
      ? a.localeCompare(b)
      : a.startsWith('岗位')
        ? -1
        : 1,
  );
});

onMounted(async () => {
  await applyDeepLink();
  void loadRecurring();
});

// 页签 keep-alive：人停在待办中心时再点顶栏铃铛另一条，onMounted 不会再跑，靠 query 变化重新定位
watch(
  () => route.query,
  (q, old) => {
    if (route.path === '/todos' && JSON.stringify(q) !== JSON.stringify(old))
      void applyDeepLink();
  },
);

/** 深链预定位（/todos?id=N）：加载后在 mine/pool/企业视图里找这条待办，找到就开详情抽屉。 */
async function applyDeepLink() {
  const q = route.query;
  const id = typeof q.id === 'string' && /^\d+$/.test(q.id) ? Number(q.id) : 0;
  await loadAll();
  if (id === 0) return;
  const hit = [...mine.value, ...pool.value].find((it) => it.id === id);
  if (hit) {
    openDetail(hit);
    return;
  }
  if (isAdmin.value) {
    await loadEnterprise();
    const ent = enterprise.value.find((it) => it.id === id);
    if (ent) {
      openDetail(ent);
      return;
    }
  }
  message.warning(`没找到待办 #${id}（可能已消除，或不在你的可见范围）`);
}
</script>

<template>
  <div class="p-4">
    <Card :loading="loading">
      <template #title>
        <span>待办与预警</span>
        <Tag v-if="summary.overdue > 0" class="ml-2" color="red">
          逾期 {{ summary.overdue }}
        </Tag>
        <Tag v-if="summary.today > 0" class="ml-1" color="orange">
          今天 {{ summary.today }}
        </Tag>
        <Tag v-if="summary.upcoming7 > 0" class="ml-1" color="blue">
          7 天内 {{ summary.upcoming7 }}
        </Tag>
        <Tag v-if="summary.undated > 0" class="ml-1">
          无日期 {{ summary.undated }}
        </Tag>
      </template>
      <template #extra>
        <Button class="mr-2" size="small" @click="loadAll">刷新</Button>
        <Button v-if="canWrite" size="small" type="primary" @click="openCreate">
          新建待办
        </Button>
      </template>
      <p class="mb-3 text-xs text-gray-500">
        系统每天 08:30
        自动检查一遍账目、待确认记账、账号治理、缺票等状态，到期前后会推到你的飞书单聊。
        自己加的待办：办完点「已完成」，可以写一句备注；系统推导的待办（有来源标签的）点「已完成」会先核实源头——办完就自动消除，没办完会告诉你并恢复提醒，
        这类还有「暂不处理」可以让它先别推送。点标题或日历上的条目，看详情和处理流程。
      </p>

      <Tabs v-model:active-key="activeTab">
        <Tabs.TabPane key="today" tab="今日">
          <template v-if="mine.length === 0">
            <Empty description="我的待办是空的——今天没有到期的事" />
          </template>
          <template v-else>
            <template
              v-for="[key, label] in [
                ['overdue', '已逾期'],
                ['today', '今天到期'],
                ['week', '未来 7 天'],
                ['later', '更远'],
                ['undated', '无固定到期日'],
              ] as const"
              :key="key"
            >
              <div v-if="buckets[key].length > 0" class="mb-4">
                <p
                  class="mb-1 text-sm font-medium"
                  :class="
                    key === 'overdue'
                      ? 'text-red-600'
                      : key === 'today'
                        ? 'text-orange-600'
                        : ''
                  "
                >
                  {{ label }}（{{ buckets[key].length }}）
                </p>
                <TodoItem
                  v-for="it in buckets[key]"
                  :key="it.id"
                  :item="it"
                  @ack="onAck"
                  @complete="onComplete"
                  @edit="openEdit"
                  @open="openDetail"
                />
              </div>
            </template>
          </template>
        </Tabs.TabPane>

        <Tabs.TabPane key="calendar" tab="日历">
          <div class="mb-2 flex items-center gap-2">
            <Button
              size="small"
              @click="monthCursor = monthCursor.subtract(1, 'month')"
            >
              上月
            </Button>
            <span class="font-medium">{{
              monthCursor.format('YYYY 年 M 月')
            }}</span>
            <Button
              size="small"
              @click="monthCursor = monthCursor.add(1, 'month')"
            >
              下月
            </Button>
            <Button
              size="small"
              type="link"
              @click="
                monthCursor = dayjs().startOf('month');
                selectedDay = dayjs().format('YYYY-MM-DD');
              "
            >
              回到本月
            </Button>
            <span class="text-xs text-gray-500"
              >（我的 + 岗位池 +
              每月固定事项全月预列：没到期是提示、当天起是预警，进临期窗口才生成正式待办；点条目看详情与处理流程）</span
            >
          </div>
          <div class="grid grid-cols-7 gap-1 text-center text-xs text-gray-500">
            <div
              v-for="w in ['一', '二', '三', '四', '五', '六', '日']"
              :key="w"
              class="py-1"
            >
              周{{ w }}
            </div>
          </div>
          <div class="grid grid-cols-7 gap-1">
            <div
              v-for="c in monthGrid"
              :key="c.date"
              class="min-h-16 cursor-pointer rounded border p-1 text-xs"
              :class="[
                c.inMonth ? '' : 'opacity-40',
                cellColor(c.items, c.recurring, c.date),
                selectedDay === c.date ? 'ring-2 ring-blue-400' : '',
              ]"
              @click="selectedDay = c.date"
            >
              <div class="flex justify-between">
                <span
                  :class="
                    c.date === dayjs().format('YYYY-MM-DD')
                      ? 'font-bold text-blue-600'
                      : ''
                  "
                  >{{ dayjs(c.date).date() }}</span
                >
                <span
                  v-if="c.items.length + c.recurring.length > 0"
                  class="rounded bg-white px-1 text-gray-700"
                  >{{ c.items.length + c.recurring.length }}</span
                >
              </div>
              <div
                v-for="it in c.items.slice(0, 2)"
                :key="it.id"
                class="truncate text-gray-700 hover:text-blue-600 hover:underline"
                :title="it.title"
                @click.stop="
                  selectedDay = c.date;
                  openDetail(it);
                "
              >
                · {{ it.title }}
              </div>
              <div v-if="c.items.length > 2" class="text-gray-400">…</div>
              <div
                v-for="r in c.recurring.slice(0, 1)"
                :key="r.key"
                class="truncate"
                :class="
                  r.phase === 'early'
                    ? 'text-gray-400'
                    : 'font-medium text-red-600'
                "
                :title="`${r.phase === 'early' ? '提示' : '预警'}：${r.title}`"
                @click.stop="
                  selectedDay = c.date;
                  openRecurringDetail(r, c.recurring);
                "
              >
                ◆ {{ r.title
                }}{{
                  c.recurring.length > 1 ? ` 等 ${c.recurring.length} 项` : ''
                }}
              </div>
            </div>
          </div>
          <div class="mt-3">
            <p class="mb-1 text-sm font-medium">
              {{ selectedDay }}（{{ selectedDayItems.length }} 条）
            </p>
            <Empty
              v-if="
                selectedDayItems.length === 0 &&
                selectedDayRecurring.length === 0
              "
              :image="Empty.PRESENTED_IMAGE_SIMPLE"
              description="这天没有待办"
            />
            <TodoItem
              v-for="it in selectedDayItems"
              :key="it.id"
              :item="it"
              show-owner
              @ack="onAck"
              @complete="onComplete"
              @edit="openEdit"
              @open="openDetail"
            />
            <template v-if="selectedDayRecurring.length > 0">
              <p class="mb-1 mt-2 text-sm font-medium text-gray-600">
                每月固定事项（{{ selectedDayRecurring.length }}）
              </p>
              <div
                v-for="r in selectedDayRecurring"
                :key="r.key"
                class="mb-1 cursor-pointer rounded border p-2 text-xs"
                :class="
                  r.phase === 'early'
                    ? 'border-gray-200 bg-gray-50'
                    : 'border-red-200 bg-red-50'
                "
                @click="openRecurringDetail(r, selectedDayRecurring)"
              >
                <Tag :color="r.phase === 'early' ? 'default' : 'red'">
                  {{
                    r.phase === 'early'
                      ? '提示'
                      : r.phase === 'today'
                        ? '预警 · 今天截止'
                        : '预警 · 已逾期'
                  }}
                </Tag>
                <span class="font-medium">{{ r.title }}</span>
                <span class="ml-1 text-gray-500">渠道：{{ r.channel }}</span>
              </div>
            </template>
          </div>
        </Tabs.TabPane>

        <Tabs.TabPane key="pool" tab="岗位池">
          <p class="mb-2 text-xs text-gray-500">
            分给岗位而不是具体人的待办：同岗位的人都看得到，谁处理都行（处理后对所有持岗人消除）。
          </p>
          <Empty
            v-if="poolByRole.length === 0"
            description="你所在的岗位没有待办"
          />
          <div v-for="[role, items] in poolByRole" :key="role" class="mb-4">
            <p class="mb-1 text-sm font-medium">
              岗位「{{ role }}」（{{ items.length }}）
            </p>
            <TodoItem
              v-for="it in items"
              :key="it.id"
              :item="it"
              @ack="onAck"
              @complete="onComplete"
              @edit="openEdit"
              @open="openDetail"
            />
          </div>
        </Tabs.TabPane>

        <Tabs.TabPane v-if="isAdmin" key="enterprise" tab="企业">
          <div class="mb-3 flex flex-wrap items-center gap-2">
            <RadioGroup v-model:value="enterpriseStatus" size="small">
              <Radio.Button value="active">未消除</Radio.Button>
              <Radio.Button value="all">含已关闭</Radio.Button>
            </RadioGroup>
            <Button :loading="scanning" size="small" @click="runScan">
              立即扫描
            </Button>
            <span class="text-xs text-gray-500"
              >共 {{ enterprise.length }} 条（手动检查只对账不推每日简报）</span
            >
          </div>
          <Empty
            v-if="enterprise.length === 0"
            description="全员没有未消除的待办"
          />
          <div
            v-for="[label, items] in enterpriseGrouped"
            :key="label"
            class="mb-4"
          >
            <p class="mb-1 text-sm font-medium">
              {{ label }}（{{ items.length }}）
            </p>
            <TodoItem
              v-for="it in items"
              :key="it.id"
              :item="it"
              @ack="onAck"
              @complete="onComplete"
              @edit="openEdit"
              @open="openDetail"
            />
          </div>

          <Collapse class="mt-4">
            <Collapse.Panel
              key="routes"
              header="责任路由：每类系统推导的待办默认分给谁（点开管理）"
            >
              <p class="mb-2 text-xs text-gray-500">
                每类系统推导的待办有一个默认责任人或岗位；没配的兜底给负责人。改绑会把这一类仍在处理的待办一并移交给新责任人（已关闭的、被人手动改过责任人的不动）。关掉开关=该类不再检查新建，已有的照常显示。
              </p>
              <div
                v-for="r in routes"
                :key="r.source_type"
                class="flex flex-wrap items-center gap-2 border-b py-2 last:border-b-0"
              >
                <span class="w-44 text-sm">{{
                  TODO_SOURCE_LABELS[r.source_type] ?? r.source_type
                }}</span>
                <RadioGroup
                  :value="routeOwnerType(r)"
                  size="small"
                  @change="(e) => onRouteOwnerType(r, e)"
                >
                  <Radio.Button value="user">人</Radio.Button>
                  <Radio.Button value="role">岗位</Radio.Button>
                </RadioGroup>
                <Select
                  :options="
                    routeOwnerType(r) === 'user'
                      ? owners.users.map((u) => ({
                          label: `${u.username}（${u.displayName}）`,
                          value: u.username,
                        }))
                      : owners.roles.map((n) => ({ label: n, value: n }))
                  "
                  :placeholder="
                    routeOwnerType(r) === 'role' ? '选岗位后生效' : '选人后生效'
                  "
                  :value="
                    routeOwnerType(r) === r.owner_type ? r.owner_id : undefined
                  "
                  class="w-48"
                  size="small"
                  @change="(v: unknown) => onRouteOwnerPick(r, v)"
                />
                <Switch
                  :checked="r.enabled === 1"
                  checked-children="扫描中"
                  size="small"
                  un-checked-children="已停用"
                  @change="
                    (v: unknown) => saveRoute(r, { enabled: Boolean(v) })
                  "
                />
              </div>
            </Collapse.Panel>
          </Collapse>
        </Tabs.TabPane>
      </Tabs>
    </Card>

    <!-- 已完成（核实式）：人工直接关；推导型先核实，pending/unverifiable 后给「强制确认完成」出口 -->
    <Modal
      :open="completing !== undefined"
      :title="completingDerived ? '标记已完成（先核实源头）' : '标记已完成'"
      :width="560"
      @cancel="completing = undefined"
    >
      <template #footer>
        <Button @click="completing = undefined">取消</Button>
        <template v-if="completeVerdict === undefined">
          <Button
            :loading="completeBusy"
            type="primary"
            @click="submitComplete(false)"
          >
            {{ completingDerived ? '已完成（系统先核实）' : '确认完成' }}
          </Button>
        </template>
        <Button
          v-else
          :loading="completeBusy"
          danger
          type="primary"
          @click="submitComplete(true)"
        >
          强制确认完成（必填备注）
        </Button>
      </template>

      <p class="mb-2 text-sm font-medium">{{ completing?.title }}</p>

      <Alert
        v-if="completeVerdict === undefined && completingDerived"
        class="mb-2"
        show-icon
        type="info"
        message="这是系统推导的待办：点确认后系统会先核实源头（如账目是否已收付、记账单是否已确认）——已处理就直接消除；还在会告诉你并恢复提醒。"
      />
      <Alert
        v-if="completeVerdict?.outcome === 'pending'"
        class="mb-2"
        show-icon
        type="warning"
        :message="
          completeVerdict.message ?? '核实结果：源头还在，这条不能标记完成。'
        "
      />
      <Alert
        v-if="completeVerdict?.outcome === 'unverifiable'"
        class="mb-2"
        show-icon
        type="info"
        :message="
          completeVerdict.message ?? '这类事项系统无法核实，需要你确认。'
        "
      />

      <p class="mb-1 text-xs text-gray-500">
        {{
          completeVerdict === undefined
            ? '备注（可选）：写一句当时的情况，回看有据。'
            : '如确认确实办完了（或在系统外办完），写一句原因后强制确认：'
        }}
      </p>
      <div
        v-if="completeVerdict !== undefined && forcePresets.length > 0"
        class="mb-2 flex flex-wrap gap-1"
      >
        <Tag
          v-for="p in forcePresets"
          :key="p"
          class="cursor-pointer"
          color="blue"
          @click="completeNote = p"
        >
          {{ p }}
        </Tag>
      </div>
      <Textarea
        v-model:value="completeNote"
        :maxlength="200"
        :rows="3"
        placeholder="备注（200 字内）"
      />
    </Modal>

    <!-- 详情抽屉：信息 + 处理流程 + 时间线 -->
    <Drawer
      :open="detailItem !== undefined"
      :width="480"
      title="待办详情"
      @close="detailItem = undefined"
    >
      <template v-if="detailItem">
        <div class="mb-3 flex flex-wrap items-center gap-2">
          <Tag
            :color="
              detailItem.severity === 'critical'
                ? 'red'
                : detailItem.severity === 'warn'
                  ? 'orange'
                  : 'blue'
            "
          >
            {{
              detailItem.severity === 'critical'
                ? '紧急'
                : detailItem.severity === 'warn'
                  ? '提醒'
                  : '一般'
            }}
          </Tag>
          <Tag v-if="detailItem.status !== 'open'">
            {{
              detailItem.status === 'escalated'
                ? '已逾期'
                : detailItem.status === 'resolved'
                  ? '已消除'
                  : detailItem.status === 'dismissed'
                    ? '已确认完成'
                    : '已完成'
            }}
          </Tag>
          <Tag v-if="detailItem.origin === 'scan'">
            系统推导 ·
            {{
              TODO_SOURCE_LABELS[detailItem.source_type] ??
              detailItem.source_type
            }}
          </Tag>
          <Tag v-else>手工待办</Tag>
        </div>
        <p class="mb-3 text-base font-medium">{{ detailItem.title }}</p>
        <div class="mb-3 space-y-1 text-sm text-gray-600">
          <p v-if="detailItem.id !== 0">
            <span class="inline-block w-20 text-gray-400">责任人</span>
            {{
              detailItem.owner_type === 'role'
                ? `岗位「${detailItem.owner_id}」`
                : detailItem.owner_id
            }}
          </p>
          <p>
            <span class="inline-block w-20 text-gray-400">到期</span>
            {{
              detailItem.due_date === '' ? '无固定到期日' : detailItem.due_date
            }}
          </p>
          <p v-if="detailItem.detail">
            <span class="inline-block w-20 text-gray-400">说明</span>
            <span class="whitespace-pre-wrap">{{ detailItem.detail }}</span>
          </p>
          <p
            v-if="detailItem.origin === 'scan' && detailItem.user_edited === 1"
          >
            <span class="inline-block w-20 text-gray-400">调整</span>
            到期/严重度/责任人经人工调整，系统扫描不再覆盖这三项
          </p>
        </div>

        <div class="mb-2 text-sm font-medium">处理流程</div>
        <ol class="mb-2 list-decimal space-y-1 pl-5 text-sm text-gray-600">
          <li v-for="(s, i) in detailGuide.steps" :key="i">{{ s }}</li>
        </ol>
        <div v-if="detailGuide.links.length > 0" class="mb-3">
          <Button
            v-for="l in detailGuide.links"
            :key="l.path"
            size="small"
            type="link"
            @click="goto(l.path)"
          >
            前往：{{ l.text }} →
          </Button>
        </div>
        <Button
          v-if="detailEntityLink"
          class="mb-3"
          size="small"
          type="primary"
          ghost
          @click="detailEntityLink && goto(detailEntityLink.to)"
        >
          {{ detailEntityLink.text }} →
        </Button>

        <div class="mb-2 text-sm font-medium">时间线</div>
        <Timeline>
          <Timeline.Item
            v-for="(t, i) in detailTimeline"
            :key="i"
            :color="t.color"
          >
            <span class="text-sm text-gray-600">{{ t.text }}</span>
          </Timeline.Item>
        </Timeline>

        <div
          v-if="
            detailItem.id !== 0 &&
            (detailItem.status === 'open' || detailItem.status === 'escalated')
          "
          class="mt-3 flex justify-end gap-2"
        >
          <Button
            size="small"
            @click="
              openEdit(detailItem);
              detailItem = undefined;
            "
          >
            修改
          </Button>
          <Button
            v-if="
              detailItem.origin === 'scan' &&
              !detailItem.last_notified.startsWith('ack:')
            "
            size="small"
            @click="onAck(detailItem)"
          >
            暂不处理
          </Button>
          <Button
            size="small"
            type="primary"
            @click="
              onComplete(detailItem);
              detailItem = undefined;
            "
          >
            已完成
          </Button>
        </div>
      </template>
    </Drawer>

    <!-- 新建/编辑：推导型只开放到期/严重度/责任人 -->
    <Modal
      :confirm-loading="saving"
      :open="editorOpen"
      :title="
        editingId === undefined
          ? '新建待办'
          : editingDerived
            ? '修改待办（系统推导）'
            : '修改待办'
      "
      ok-text="保存"
      @cancel="editorOpen = false"
      @ok="saveEditor"
    >
      <div class="flex flex-col gap-3">
        <Alert
          v-if="editingDerived"
          show-icon
          type="info"
          message="系统推导的待办：标题与说明由系统从源头维护（改了也会被刷回来），这里只调整到期日、严重度和分给谁；调整后扫描不再覆盖这三项。"
        />
        <Input
          v-model:value="form.title"
          :disabled="editingDerived"
          :maxlength="120"
          placeholder="标题（必填，120 字内）"
        />
        <Textarea
          v-model:value="form.detail"
          :disabled="editingDerived"
          :maxlength="2000"
          :rows="3"
          placeholder="说明（可选）"
        />
        <div class="flex items-center gap-2">
          <span class="w-16 text-sm">到期日</span>
          <DatePicker
            v-model:value="form.dueDate"
            class="flex-1"
            placeholder="不填=无固定到期日"
          />
        </div>
        <div class="flex items-center gap-2">
          <span class="w-16 text-sm">严重度</span>
          <RadioGroup v-model:value="form.severity" size="small">
            <Radio.Button value="info">一般</Radio.Button>
            <Radio.Button value="warn">提醒</Radio.Button>
            <Radio.Button value="critical">紧急</Radio.Button>
          </RadioGroup>
        </div>
        <div class="flex items-center gap-2">
          <span class="w-16 text-sm">分给</span>
          <RadioGroup
            v-model:value="form.ownerType"
            size="small"
            @change="form.ownerId = undefined"
          >
            <Radio.Button value="user">人</Radio.Button>
            <Radio.Button value="role">岗位</Radio.Button>
          </RadioGroup>
          <Select
            v-model:value="form.ownerId"
            :options="
              form.ownerType === 'user'
                ? owners.users.map((u) => ({
                    label: `${u.username}（${u.displayName}）`,
                    value: u.username,
                  }))
                : owners.roles.map((n) => ({ label: n, value: n }))
            "
            :placeholder="form.ownerType === 'user' ? '不选=自己' : '选岗位'"
            allow-clear
            class="flex-1"
            show-search
          />
        </div>
        <Alert
          show-icon
          type="info"
          message="分给岗位=同岗位所有人都看得到、谁处理都行；分给人=只有 TA（和你这个创建人）看得到。"
        />
      </div>
    </Modal>
  </div>
</template>

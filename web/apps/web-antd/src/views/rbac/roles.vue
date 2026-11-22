<script lang="ts" setup>
// 系统权限（2026-10-30 拼装台面 → 2026-10-31 重设计）：学主流权限管理（RuoYi/GitHub 设置那类）的两段式——
// 「岗位角色」页签做主从：左边角色列表，右边一块固定编辑面板（新建与配权限同一块，分组勾选+全选）；
// 「用户账号」页签：搜人、看角色，行上「分配角色」弹窗一次配齐（勾选=绑，取消勾=摘）。
// 权限点清单只读（加权限点=底层系统发版）；技术角色 boss/agent-runtime 只读；
// 护栏（最后管理员守卫/自己改自己）在服务层，前端如实提示后端错误。
import type { RoleView, UserWithRoles } from '#/api/rbac';

import { computed, onMounted, ref } from 'vue';

import {
  Button,
  Card,
  Checkbox,
  CheckboxGroup,
  Empty,
  Input,
  message,
  Modal,
  Popconfirm,
  Table,
  Tabs,
  Tag,
} from 'ant-design-vue';

import {
  assignRoleApi,
  createRoleApi,
  deleteRoleApi,
  listPermissionsApi,
  listRolesApi,
  listUsersApi,
  removeRoleApi,
  updateRolePermissionsApi,
} from '#/api/rbac';

/** 权限点人话文案按域分组（界面唯一文案源；权限点代码本身不动）。 */
interface PermGroup {
  key: string;
  label: string;
  note?: string;
  perms: { code: string; label: string }[];
}

const PERMISSION_GROUPS: PermGroup[] = [
  {
    key: 'finance',
    label: '财务',
    perms: [
      { code: 'finance:read', label: '看账（财务查询）' },
      { code: 'finance:write', label: '记账改账（财务写入）' },
    ],
  },
  {
    key: 'agent',
    label: '智能体对话',
    note: '对话里上传/生成的文件放在企业共享工作区，持对话框权限的账号互相可见。',
    perms: [
      { code: 'agent:read', label: '发起对话' },
      { code: 'agent:write', label: '智能体执行动作（记账、传文件等）' },
    ],
  },
  {
    key: 'todo',
    label: '待办中心',
    perms: [
      { code: 'todo:read', label: '看待办（自己的 + 所在岗位池）' },
      { code: 'todo:write', label: '建/改待办、已完成、暂不处理' },
    ],
  },
  {
    key: 'payroll',
    label: '人事与工资',
    note: '谁看得见谁挣多少与能不能记账是两件事：财务权限不解锁工资页。',
    perms: [
      { code: 'payroll:read', label: '看名册与工资表' },
      { code: 'payroll:write', label: '维护名册、出工资表、确认与推送工资条' },
    ],
  },
  {
    key: 'supply',
    label: '供应链',
    perms: [
      { code: 'supply:read', label: '看库存、采购台账、生产月报' },
      { code: 'supply:write', label: '登记物料与采购、导入库存、收货/取消' },
    ],
  },
  {
    key: 'knowledge',
    label: '知识库',
    perms: [{ code: 'knowledge:read', label: '搜知识库、向 AI 提问' }],
  },
  {
    key: 'platform',
    label: '飞书平台数据',
    perms: [{ code: 'platform:read', label: '查看通讯录与审批记录（只读）' }],
  },
  {
    key: 'system',
    label: '系统',
    perms: [
      { code: 'audit:read', label: '审计查询' },
      { code: 'admin:manage', label: '系统管理（角色权限、待办路由、桥接）' },
    ],
  },
];

const permissions = ref<string[]>([]);
const roles = ref<RoleView[]>([]);
const users = ref<UserWithRoles[]>([]);
const loading = ref(true);

const activeTab = ref<'roles' | 'users'>('roles');

// ---------- 岗位角色：主从编辑 ----------
/** API 返回但分组没覆盖的权限点兜底进「其他」，避免后端加码后界面漏显。 */
const groups = computed<PermGroup[]>(() => {
  const known = new Set(
    PERMISSION_GROUPS.flatMap((g) => g.perms.map((p) => p.code)),
  );
  const rest = permissions.value.filter((c) => !known.has(c));
  const out = PERMISSION_GROUPS.map((g) => ({
    ...g,
    perms: g.perms.filter((p) => permissions.value.includes(p.code)),
  }));
  if (rest.length > 0)
    out.push({
      key: 'other',
      label: '其他',
      perms: rest.map((c) => ({ code: c, label: c })),
    });
  return out.filter((g) => g.perms.length > 0);
});

/** 编辑面板目标：existing=配既有角色；new=新建；undefined=未选。 */
const editing = ref<RoleView>();
const creating = ref(false);
const checked = ref<string[]>([]);
const newName = ref('');
const saving = ref(false);

const panelTitle = computed(() =>
  creating.value
    ? '新建角色'
    : editing.value
      ? `权限配置：${editing.value.name}`
      : '权限配置',
);

function groupAll(g: PermGroup): boolean {
  return g.perms.every((p) => checked.value.includes(p.code));
}

function toggleGroup(g: PermGroup, on: boolean) {
  const codes = g.perms.map((p) => p.code);
  checked.value = on
    ? [...new Set([...checked.value, ...codes])]
    : checked.value.filter((c) => !codes.includes(c));
}

function pickRole(role: RoleView) {
  creating.value = false;
  editing.value = role;
  checked.value = [...role.permissions];
}

function startCreate() {
  editing.value = undefined;
  creating.value = true;
  newName.value = '';
  checked.value = [];
}

async function loadAll() {
  loading.value = true;
  try {
    const [permRes, roleRes, userRes] = await Promise.all([
      listPermissionsApi(),
      listRolesApi(),
      listUsersApi(),
    ]);
    permissions.value = permRes.permissions;
    roles.value = roleRes.roles;
    users.value = userRes.users;
    // 编辑目标还在列表里就同步最新数据，否则清掉面板
    if (editing.value) {
      const still = roles.value.find((r) => r.name === editing.value!.name);
      if (still) {
        editing.value = still;
        checked.value = [...still.permissions];
      } else {
        editing.value = undefined;
        checked.value = [];
      }
    }
  } finally {
    loading.value = false;
  }
}

async function savePanel() {
  saving.value = true;
  try {
    if (creating.value) {
      const name = newName.value.trim();
      if (name === '') {
        message.warning('先填角色名');
        return;
      }
      await createRoleApi({ name, permissions: checked.value });
      message.success(`角色「${name}」已创建`);
      await loadAll();
      const made = roles.value.find((r) => r.name === name);
      if (made) pickRole(made);
    } else if (editing.value) {
      await updateRolePermissionsApi(editing.value.name, checked.value);
      message.success(
        `角色「${editing.value.name}」的权限已更新（后端逐请求实时鉴权，立即生效）`,
      );
      await loadAll();
    }
  } catch {
    // 重名/撞技术角色名/护栏错误由后端 400 统一提示
  } finally {
    saving.value = false;
  }
}

async function removeRole(role: RoleView) {
  try {
    await deleteRoleApi(role.name);
    message.success(
      `角色「${role.name}」已删除（${role.users} 个用户的绑定一并解除）`,
    );
    if (editing.value?.name === role.name) {
      editing.value = undefined;
      checked.value = [];
    }
    await loadAll();
  } catch {
    // 最后管理员守卫等由后端拒绝
  }
}

// ---------- 用户账号 ----------
const userKeyword = ref('');

const filteredUsers = computed(() => {
  const kw = userKeyword.value.trim().toLowerCase();
  if (kw === '') return users.value;
  return users.value.filter(
    (u) =>
      u.username.toLowerCase().includes(kw) ||
      u.displayName.toLowerCase().includes(kw),
  );
});

/** 分配角色弹窗：勾选=绑、取消勾=摘，保存时按差集调接口。 */
const assigning = ref<UserWithRoles>();
const assignChecked = ref<string[]>([]);
const assigningBusy = ref(false);

const assignableRoles = computed(() => roles.value.filter((r) => !r.technical));

function openAssign(user: UserWithRoles) {
  assigning.value = user;
  assignChecked.value = [...user.roles];
}

async function saveAssign() {
  const user = assigning.value;
  if (!user) return;
  const toAdd = assignChecked.value.filter((r) => !user.roles.includes(r));
  const toRemove = user.roles.filter((r) => !assignChecked.value.includes(r));
  if (toAdd.length === 0 && toRemove.length === 0) {
    assigning.value = undefined;
    return;
  }
  assigningBusy.value = true;
  const failed: string[] = [];
  try {
    for (const r of toAdd) {
      try {
        await assignRoleApi(user.username, r);
      } catch {
        failed.push(`+${r}`);
      }
    }
    for (const r of toRemove) {
      try {
        await removeRoleApi(user.username, r);
      } catch {
        failed.push(`-${r}`);
      }
    }
    if (failed.length === 0) {
      message.success(
        `${user.username} 的角色已更新（立即生效，对方重新登录后菜单刷新）`,
      );
    } else {
      message.warning(
        `${user.username} 部分角色没改成（${failed.join(' ')}），通常是护栏拦截（自己改自己/最后管理员），其余已生效`,
        6,
      );
    }
    assigning.value = undefined;
    await loadAll();
  } finally {
    assigningBusy.value = false;
  }
}

/** 角色标签旁的一行人话权限缩写（分配弹窗里辨认用）。 */
const SHORT_PERM: Record<string, string> = {
  'admin:manage': '系统管理',
  'agent:read': '对话',
  'agent:write': '执行',
  'audit:read': '审计',
  'finance:read': '看账',
  'finance:write': '记账',
  'knowledge:read': '知识库',
  'payroll:read': '看工资',
  'payroll:write': '办工资',
  'platform:read': '看平台',
  'supply:read': '看供应链',
  'supply:write': '办供应链',
  'todo:read': '看待办',
  'todo:write': '办待办',
};

const userColumns = [
  { dataIndex: 'username', title: '用户名' },
  { dataIndex: 'displayName', title: '姓名' },
  { dataIndex: 'roles', key: 'roles', title: '角色' },
  { key: 'action', title: '操作', width: 110 },
];

const roleColumns = [
  { dataIndex: 'name', title: '角色名' },
  { key: 'perms', title: '权限概览' },
  { dataIndex: 'users', title: '绑定用户', width: 90 },
  { key: 'action', title: '操作', width: 150 },
];

onMounted(loadAll);
</script>

<template>
  <div class="p-4">
    <Card :loading="loading">
      <template #title>
        <span>系统权限</span>
        <span class="ml-3 text-xs font-normal text-gray-500">
          权限点固定八项（加新权限点=系统发版）——把权限点拼成岗位角色，再把角色发给用户。
        </span>
      </template>
      <Tabs v-model:active-key="activeTab">
        <Tabs.TabPane key="roles" tab="岗位角色">
          <div class="flex gap-4">
            <div class="w-[46%] shrink-0">
              <div class="mb-2 flex items-center justify-between">
                <span class="text-sm font-medium"
                  >角色（企业自定岗位，如「会计」「业务员」）</span
                >
                <Button size="small" type="primary" @click="startCreate">
                  新建角色
                </Button>
              </div>
              <Table
                :columns="roleColumns"
                :custom-row="
                  (r: RoleView) => ({
                    class:
                      r.name === editing?.name && !creating
                        ? 'cursor-pointer bg-blue-50/60'
                        : 'cursor-pointer',
                    onClick: () => pickRole(r),
                  })
                "
                :data-source="roles"
                :pagination="false"
                :row-key="(r: RoleView) => r.name"
                size="small"
              >
                <template #bodyCell="{ column, record }">
                  <template v-if="column.dataIndex === 'name'">
                    {{ (record as RoleView).name }}
                    <Tag v-if="(record as RoleView).technical" class="ml-1">
                      技术
                    </Tag>
                    <Tag
                      v-if="(record as RoleView).permissions.length === 0"
                      class="ml-1"
                      color="orange"
                    >
                      未配权限
                    </Tag>
                  </template>
                  <template v-else-if="column.key === 'perms'">
                    <span
                      v-if="(record as RoleView).permissions.length === 0"
                      class="text-xs text-gray-400"
                      >未配</span
                    >
                    <span v-else class="text-xs text-gray-600">
                      {{
                        (record as RoleView).permissions
                          .map((p) => SHORT_PERM[p] ?? p)
                          .join('、')
                      }}
                    </span>
                  </template>
                  <template v-else-if="column.dataIndex === 'users'">
                    {{ (record as RoleView).users }}
                  </template>
                  <template v-else-if="column.key === 'action'">
                    <Button
                      v-if="!(record as RoleView).technical"
                      size="small"
                      type="link"
                      @click.stop="pickRole(record as RoleView)"
                    >
                      配权限
                    </Button>
                    <Popconfirm
                      v-if="!(record as RoleView).technical"
                      :title="`删除角色「${(record as RoleView).name}」？（${(record as RoleView).users} 个用户的绑定一并解除）`"
                      @confirm="removeRole(record as RoleView)"
                    >
                      <Button danger size="small" type="link" @click.stop>
                        删除
                      </Button>
                    </Popconfirm>
                    <span
                      v-if="(record as RoleView).technical"
                      class="text-xs text-gray-400"
                      >框架自用</span
                    >
                  </template>
                </template>
              </Table>
              <p class="mt-2 text-xs text-gray-400">
                灰「技术」角色是框架自用（boss=负责人岗全权、agent-runtime=智能体服务号），不可改删；点任意行在右边配权限。
              </p>
            </div>

            <div class="min-w-0 flex-1">
              <Card
                :title="panelTitle"
                size="small"
                :class="creating || editing ? '' : 'opacity-80'"
              >
                <template v-if="creating || editing">
                  <div v-if="creating" class="mb-3">
                    <Input
                      v-model:value="newName"
                      :maxlength="40"
                      placeholder="角色名，如 会计（40 字内）"
                      style="max-width: 280px"
                    />
                  </div>
                  <p
                    v-if="editing?.technical"
                    class="mb-3 text-xs text-gray-500"
                  >
                    技术角色由框架维护，权限点仅供参考，不可修改。
                  </p>
                  <CheckboxGroup
                    v-model:value="checked"
                    class="block"
                    :disabled="editing?.technical === true"
                  >
                    <div
                      v-for="g in groups"
                      :key="g.key"
                      class="mb-3 border-b border-dashed pb-3 last:border-b-0"
                    >
                      <div class="mb-1 flex items-center gap-1">
                        <span class="text-sm font-medium">{{ g.label }}</span>
                        <Button
                          :disabled="editing?.technical === true"
                          size="small"
                          type="link"
                          @click="toggleGroup(g, !groupAll(g))"
                        >
                          {{ groupAll(g) ? '清空本组' : '全选本组' }}
                        </Button>
                      </div>
                      <div class="ml-4 flex flex-col gap-1">
                        <Checkbox
                          v-for="p in g.perms"
                          :key="p.code"
                          :value="p.code"
                        >
                          {{ p.label }}
                        </Checkbox>
                      </div>
                      <p v-if="g.note" class="ml-4 mt-1 text-xs text-gray-400">
                        {{ g.note }}
                      </p>
                    </div>
                  </CheckboxGroup>
                  <div
                    v-if="editing?.technical !== true"
                    class="mt-3 flex gap-2"
                  >
                    <Button :loading="saving" type="primary" @click="savePanel">
                      {{ creating ? '创建角色' : '保存权限' }}
                    </Button>
                    <Button v-if="creating" @click="creating = false">
                      取消
                    </Button>
                  </div>
                </template>
                <template v-else>
                  <Empty
                    :image="Empty.PRESENTED_IMAGE_SIMPLE"
                    description="点左边任意角色在这里配权限，或点「新建角色」"
                  />
                </template>
              </Card>
            </div>
          </div>
        </Tabs.TabPane>

        <Tabs.TabPane key="users" tab="用户账号">
          <div class="mb-3 flex flex-wrap items-center gap-2">
            <Input
              v-model:value="userKeyword"
              allow-clear
              placeholder="搜用户名或姓名"
              style="max-width: 240px"
            />
            <span class="text-xs text-gray-500">
              员工经飞书审批开通账号后默认绑
              employee（待办中心+对话+看账）；在这里按人微调。
            </span>
          </div>
          <Table
            :columns="userColumns"
            :data-source="filteredUsers"
            :pagination="{ pageSize: 10 }"
            :row-key="(u: UserWithRoles) => u.username"
            size="small"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.dataIndex === 'username'">
                {{ (record as UserWithRoles).username }}
                <Tag v-if="(record as UserWithRoles).isService" class="ml-1">
                  服务号
                </Tag>
                <Tag
                  v-if="(record as UserWithRoles).disabled"
                  class="ml-1"
                  color="red"
                >
                  已停用
                </Tag>
              </template>
              <template v-else-if="column.key === 'roles'">
                <Tag
                  v-for="role in (record as UserWithRoles).roles"
                  :key="role"
                  color="blue"
                >
                  {{ role }}
                </Tag>
                <Tag
                  v-if="(record as UserWithRoles).roles.length === 0"
                  color="orange"
                >
                  无角色（零权限）
                </Tag>
              </template>
              <template v-else-if="column.key === 'action'">
                <Button
                  v-if="!(record as UserWithRoles).isService"
                  size="small"
                  type="link"
                  @click="openAssign(record as UserWithRoles)"
                >
                  分配角色
                </Button>
                <span v-else class="text-xs text-gray-400"
                  >服务号不配业务角色</span
                >
              </template>
            </template>
          </Table>
          <p class="mt-2 text-xs text-gray-400">
            自己（当前登录的管理员）的绑定与所持角色由系统保护，需其他管理员操作。
          </p>
        </Tabs.TabPane>
      </Tabs>
    </Card>

    <Modal
      :confirm-loading="assigningBusy"
      :open="assigning !== undefined"
      :title="`分配角色：${assigning?.username ?? ''}（${assigning?.displayName ?? ''}）`"
      ok-text="保存"
      @cancel="assigning = undefined"
      @ok="saveAssign"
    >
      <p class="mb-2 text-xs text-gray-500">
        勾选=绑定该角色，取消勾=摘掉。保存立即生效（对方重新登录后菜单刷新）。
      </p>
      <CheckboxGroup v-model:value="assignChecked" class="flex flex-col gap-1">
        <Checkbox v-for="r in assignableRoles" :key="r.name" :value="r.name">
          {{ r.name }}
          <span class="ml-1 text-xs text-gray-400">
            {{ r.permissions.map((p) => SHORT_PERM[p] ?? p).join('、') }}
          </span>
        </Checkbox>
      </CheckboxGroup>
      <p v-if="assignableRoles.length === 0" class="text-sm text-gray-500">
        还没有可分配的角色——先到「岗位角色」页签新建。
      </p>
    </Modal>
  </div>
</template>

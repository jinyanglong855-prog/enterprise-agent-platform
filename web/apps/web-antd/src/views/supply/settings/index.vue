<script lang="ts" setup>
import type { BitableRegistry, SupplySettings } from '#/api/supply';

import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';

import { useAccess } from '@vben/access';

import { Button, Card, Input, InputNumber, message } from 'ant-design-vue';

import {
  bitableRegistryApi,
  setBitableRegistryApi,
  setSupplySettingsApi,
  supplySettingsApi,
} from '#/api/supply';

const router = useRouter();
const { hasAccessByCodes } = useAccess();
/** 读（看当前设置）跟菜单一样是 supply:read；改要 admin:manage——没权限只看得到说明，不给能点但会失败的保存按钮。 */
const canManage = computed(() => hasAccessByCodes(['admin:manage']));

// 临期窗口：名单/待办/每日简报/月报共用这一个数
const settings = ref<SupplySettings>();
const settingsRange = ref<[number, number]>([1, 365]);
const settingsSaving = ref(false);
const settingsForm = reactive<{ expiryWarnDays: number }>({
  expiryWarnDays: 90,
});

async function loadSettings() {
  try {
    const r = await supplySettingsApi();
    settings.value = r.settings;
    settingsRange.value = r.range.expiryWarnDays;
    settingsForm.expiryWarnDays = r.settings.expiryWarnDays;
  } catch {
    settings.value = undefined;
  }
}

async function saveSettings() {
  settingsSaving.value = true;
  try {
    const { settings: saved } = await setSupplySettingsApi({
      expiryWarnDays: settingsForm.expiryWarnDays,
    });
    settings.value = saved;
    message.success(
      `临期窗口已改为 ${saved.expiryWarnDays} 天，名单与预警即时按新窗口算`,
    );
  } catch (error) {
    message.error(`保存失败：${(error as Error)?.message ?? error}`);
  } finally {
    settingsSaving.value = false;
  }
}

// 多维表格（通道 B，只读同步）：登记后到「库存物料」页点同步
const registry = ref<BitableRegistry | null>(null);
const bitableSaving = ref(false);
const bitableForm = reactive<{
  appToken: string;
  inventory: string;
  items: string;
  pos: string;
}>({
  appToken: '',
  inventory: '',
  items: '',
  pos: '',
});

async function loadRegistry() {
  try {
    const body = await bitableRegistryApi();
    registry.value = body.registry;
  } catch {
    registry.value = null;
  }
  Object.assign(bitableForm, {
    appToken: registry.value?.appToken ?? '',
    inventory: registry.value?.tables.inventory ?? '',
    items: registry.value?.tables.items ?? '',
    pos: registry.value?.tables.pos ?? '',
  });
}

async function saveBitable() {
  bitableSaving.value = true;
  try {
    const { registry: saved } = await setBitableRegistryApi({
      appToken: bitableForm.appToken.trim(),
      tables: {
        inventory: bitableForm.inventory.trim(),
        items: bitableForm.items.trim(),
        pos: bitableForm.pos.trim(),
      },
    });
    registry.value = saved;
    message.success(
      '多维表格登记已保存。到「库存物料」页点「多维表格 → 同步」生效',
    );
  } catch (error) {
    message.error(`保存失败：${(error as Error)?.message ?? error}`);
  } finally {
    bitableSaving.value = false;
  }
}

function lastSyncText(): string {
  const reg = registry.value;
  if (!reg) return '';
  const parts: string[] = [];
  const names = { inventory: '库存', items: '物料', pos: '采购单' } as const;
  for (const k of ['items', 'inventory', 'pos'] as const) {
    const s = reg.lastSync[k];
    if (s) {
      parts.push(
        `${names[k]} ${s.at.slice(0, 16).replace('T', ' ')}（${s.by}，新建 ${s.created}/更新 ${s.updated}）`,
      );
    }
  }
  return parts.length > 0 ? parts.join('；') : '还没同步过';
}

onMounted(async () => {
  await Promise.all([loadSettings(), loadRegistry()]);
});
</script>

<template>
  <div class="p-4">
    <div class="mb-1 text-base font-medium">供应链设置</div>
    <div class="mb-4 text-sm text-gray-500">
      这里是供应链域的全局参数。日常的导入、同步、预警处理都在「库存物料」和「采购台账」页做，这一页改一次、全域生效。
    </div>

    <Card class="mb-4" title="临期预警窗口">
      <template #extra>
        <Button
          v-if="canManage"
          :loading="settingsSaving"
          :disabled="settingsForm.expiryWarnDays === settings?.expiryWarnDays"
          type="primary"
          @click="saveSettings"
        >
          保存
        </Button>
      </template>
      <div class="mb-3 text-sm text-gray-500">
        效期落在「今天 + N
        天」以内的批次，会进临期名单、生成临期待办、出现在每日简报和月报里；已经过期的批次单独按紧急算。
        这个窗口全供应链共用一个数（库存页的临期提醒条、待办中心的临期待办、月报里的临期统计都按它算），改完即时生效，不用重新导数据。
      </div>
      <div class="flex flex-wrap items-center gap-3">
        <div class="text-sm text-gray-500">
          临期窗口（天，{{ settingsRange[0] }}–{{ settingsRange[1] }}）
        </div>
        <InputNumber
          v-model:value="settingsForm.expiryWarnDays"
          :disabled="!canManage"
          :max="settingsRange[1]"
          :min="settingsRange[0]"
          :precision="0"
          style="width: 140px"
        />
        <span v-if="settings?.updatedAt" class="text-xs text-gray-400">
          上次修改：{{ settings.updatedAt.slice(0, 16).replace('T', ' ') }}（{{
            settings.updatedBy
          }}）
        </span>
        <span v-else class="text-xs text-gray-400">还没改过，用的是缺省值</span>
      </div>
      <div v-if="!canManage" class="mt-3 text-xs text-gray-400">
        修改此项需要管理员权限（admin:manage）。
      </div>
    </Card>

    <Card title="飞书多维表格同步（只读）">
      <template #extra>
        <Button
          v-if="canManage"
          :loading="bitableSaving"
          type="primary"
          @click="saveBitable"
        >
          保存登记
        </Button>
      </template>
      <div class="mb-3 text-sm text-gray-500">
        系统只<b>读</b>这张多维表格、从不往里写。表格里改了数，到「库存物料」页点「多维表格
        → 同步」，库存读数和采购台账就更新，预警自动重算。
        三张表的列名照「库存物料」页批量导入的模板来（库存快照可以多「批次」「效期」两列）；多出来的列会被忽略，金额类列不进系统。
      </div>
      <div class="mb-3 text-xs text-gray-500">
        表的地址在飞书多维表格
        appToken：<code>/base/&lt;appToken&gt;?table=&lt;table_id&gt;</code>（表格地址栏直接能抄）。
        记得把表格共享给本应用（可阅读即可），否则同步会失败。
      </div>
      <div class="grid grid-cols-1 gap-x-4 gap-y-3 lg:grid-cols-2">
        <div class="lg:col-span-2">
          <div class="mb-1 text-sm text-gray-500">appToken *</div>
          <Input
            v-model:value="bitableForm.appToken"
            :disabled="!canManage"
            placeholder="如 bascnXXXXXXXX"
          />
        </div>
        <div>
          <div class="mb-1 text-sm text-gray-500">库存快照表 table_id</div>
          <Input
            v-model:value="bitableForm.inventory"
            :disabled="!canManage"
            placeholder="tblXXXX（留空=不同步此类）"
          />
        </div>
        <div>
          <div class="mb-1 text-sm text-gray-500">物料主数据表 table_id</div>
          <Input
            v-model:value="bitableForm.items"
            :disabled="!canManage"
            placeholder="tblXXXX（留空=不同步此类）"
          />
        </div>
        <div>
          <div class="mb-1 text-sm text-gray-500">采购单行表 table_id</div>
          <Input
            v-model:value="bitableForm.pos"
            :disabled="!canManage"
            placeholder="tblXXXX（留空=不同步此类）"
          />
        </div>
      </div>
      <div class="mt-3 text-xs text-gray-400">
        {{ registry ? `上次同步：${lastSyncText()}` : '还没登记多维表格' }}
      </div>
      <div v-if="!canManage" class="mt-3 text-xs text-gray-400">
        修改此项需要管理员权限（admin:manage）。
      </div>
    </Card>

    <div class="mt-4">
      <Button @click="router.push('/supply')">去「库存物料」同步 / 导入</Button>
      <Button class="ml-2" @click="router.push('/supply/purchase')">
        去「采购台账」
      </Button>
    </div>
  </div>
</template>

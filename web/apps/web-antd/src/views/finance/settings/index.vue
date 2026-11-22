<script lang="ts" setup>
import { onMounted, reactive, ref } from 'vue';

import { useAccess } from '@vben/access';

import { AutoComplete, Button, Input, message, Tag } from 'ant-design-vue';

import { getFinanceProfileApi, setFinanceProfileApi } from '#/api/finance';

const { hasAccessByCodes } = useAccess();
const canWrite = hasAccessByCodes(['finance:write']);

interface FieldDef {
  /** 后端按关键词认值：含"公司/个体"分主体分支、含"定期定额"单独分支、/按月|月报/ 认按月申报 */
  hint: string;
  key: string;
  options?: string[];
  placeholder?: string;
}

// 与后端 PROFILE_TEMPLATE_KEYS 对齐；四项关键参数（scan.finance.profile 盯着变化的就是它们）放最上面
const WATCHED: FieldDef[] = [
  {
    hint: '个体户交经营所得个税（季预缴）；公司交企业所得税（季预缴+年度汇算）',
    key: '主体类型',
    options: ['个体工商户', '有限责任公司', '个人独资企业', '合伙企业'],
  },
  {
    hint: '小规模与一般纳税人：增值税税率、进项能否抵扣、按季还是按月申报都不同',
    key: '纳税人身份',
    options: ['小规模纳税人', '一般纳税人'],
  },
  {
    hint: '查账按实际利润交；核定按核定额/率交；定期定额的个体户不出季度预缴提醒',
    key: '征收方式',
    options: ['查账征收', '核定征收', '定期定额征收'],
  },
  {
    hint: '小规模增值税默认按季；已在税务局备案按月申报的选按月',
    key: '纳税期限',
    options: ['按季申报', '按月申报'],
  },
];

const REFERENCE: FieldDef[] = [
  {
    hint: '开票抬头、税号等，智能体开发票登记时参考',
    key: '开票信息',
    placeholder: '名称 / 税号 / 地址电话…',
  },
  {
    hint: '人数影响残保金（30 人以下免征但仍要申报）',
    key: '员工人数',
    placeholder: '如 2',
  },
  {
    hint: '每年 7 月前后随社平工资调整，以当年人社通知为准',
    key: '社保基数上下限',
    placeholder: '如 下限 4812 / 上限 24930',
  },
  {
    hint: '个人+企业两部分，社保缴费金额按这个算',
    key: '社保比例',
    placeholder: '如 个人 10.5% + 企业 27.5%（以当期为准）',
  },
  {
    hint: '公积金缴存比例，个人+企业',
    key: '公积金比例',
    placeholder: '如 个人 5%–12%（以当期为准）',
  },
  {
    hint: '记账报税的外部服务联系人',
    key: '代账联系人',
    placeholder: '姓名 / 电话',
  },
  {
    hint: '公司主账户，付款登记时参考',
    key: '对公账户',
    placeholder: '开户行 + 账号',
  },
  {
    hint: '收货款用的账户，应收对账时参考',
    key: '常用收款账户',
    placeholder: '微信 / 支付宝 / 个人卡…',
  },
  {
    hint: '智能体记账时优先从这里选分类，口径更稳',
    key: '常用分类',
    placeholder: '如 货物成本、快递、推广费…',
  },
];

const loading = ref(false);
const savingKey = ref('');
const form = reactive<Record<string, string>>({});
const customKeys = ref<string[]>([]);

async function load() {
  loading.value = true;
  try {
    const body = await getFinanceProfileApi();
    for (const k of Object.keys(body.profile)) form[k] = body.profile[k] ?? '';
    customKeys.value = Object.keys(body.profile).filter(
      (k) =>
        k !== '更新日期' &&
        ![...WATCHED, ...REFERENCE].some((f) => f.key === k),
    );
  } catch (error) {
    message.error(`加载失败：${(error as Error)?.message ?? error}`);
  } finally {
    loading.value = false;
  }
}

async function save(key: string) {
  savingKey.value = key;
  try {
    // 更新日期自动维护：任何一次保存都刷新，便于每年政策参数核对（E6）
    await setFinanceProfileApi(key, (form[key] ?? '').trim());
    if (key !== '更新日期') {
      await setFinanceProfileApi(
        '更新日期',
        new Date().toISOString().slice(0, 10),
      );
    }
    message.success(`已保存「${key}」`);
    await load();
  } catch (error) {
    message.error(`保存失败：${(error as Error)?.message ?? error}`);
  } finally {
    savingKey.value = '';
  }
}

const newKey = ref('');

async function addCustomKey() {
  const k = newKey.value.trim();
  if (!k) return;
  if ([...WATCHED, ...REFERENCE].some((f) => f.key === k)) {
    return message.warning('这个参数已经在表单里了');
  }
  newKey.value = '';
  await save(k);
}

onMounted(() => {
  load();
});
</script>

<template>
  <div class="p-4">
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <span class="text-sm text-gray-500">
        这里是公司的财务档案：主体类型、征收方式这些参数决定系统怎么提醒报税、怎么算工资个税。
        改动会自动留痕，改完的下一轮自动检查（每日 08:30
        或手动扫描）里会出现"参数变化"待办。
      </span>
      <div class="flex-1"></div>
    </div>

    <div class="mb-4 rounded-lg border p-3">
      <div class="mb-2 flex items-center gap-2">
        <b>关键参数</b>
        <Tag color="blue">改动会触发待办提醒</Tag>
      </div>
      <div class="grid grid-cols-1 gap-x-6 gap-y-3 lg:grid-cols-2">
        <div v-for="f in WATCHED" :key="f.key">
          <div class="mb-1 flex items-baseline gap-2">
            <span class="text-sm font-medium">{{ f.key }}</span>
            <span class="text-xs text-gray-400">{{ f.hint }}</span>
          </div>
          <div class="flex gap-2">
            <AutoComplete
              v-model:value="form[f.key]"
              :disabled="!canWrite || loading"
              :options="(f.options ?? []).map((o) => ({ value: o }))"
              class="w-full"
              :placeholder="f.options?.join(' / ')"
            />
            <Button
              v-if="canWrite"
              :loading="savingKey === f.key"
              @click="save(f.key)"
            >
              保存
            </Button>
          </div>
        </div>
      </div>
    </div>

    <div class="mb-4 rounded-lg border p-3">
      <div class="mb-2"><b>参考参数</b></div>
      <div class="grid grid-cols-1 gap-x-6 gap-y-3 lg:grid-cols-2">
        <div v-for="f in REFERENCE" :key="f.key">
          <div class="mb-1 flex items-baseline gap-2">
            <span class="text-sm font-medium">{{ f.key }}</span>
            <span v-if="f.hint" class="text-xs text-gray-400">{{
              f.hint
            }}</span>
          </div>
          <div class="flex gap-2">
            <Input
              v-model:value="form[f.key]"
              :disabled="!canWrite || loading"
              :placeholder="f.placeholder"
            />
            <Button
              v-if="canWrite"
              :loading="savingKey === f.key"
              @click="save(f.key)"
            >
              保存
            </Button>
          </div>
        </div>
      </div>
    </div>

    <div class="rounded-lg border p-3">
      <div class="mb-2 flex flex-wrap items-center gap-2">
        <b>自定义参数</b>
        <span class="text-xs text-gray-400">想多记什么就加什么（比如"税号后六位"）；清空内容再保存=清除该参数的值</span>
        <div class="flex-1"></div>
        <template v-if="canWrite">
          <Input
            v-model:value="newKey"
            class="w-48"
            placeholder="参数名，如 主营业务"
            @press-enter="addCustomKey"
          />
          <Button @click="addCustomKey">添加参数</Button>
        </template>
      </div>
      <div v-if="customKeys.length === 0" class="text-sm text-gray-400">
        暂无自定义参数。
      </div>
      <div v-else class="grid grid-cols-1 gap-x-6 gap-y-3 lg:grid-cols-2">
        <div v-for="k in customKeys" :key="k">
          <div class="mb-1 text-sm font-medium">{{ k }}</div>
          <div class="flex gap-2">
            <Input v-model:value="form[k]" :disabled="!canWrite || loading" />
            <Button
              v-if="canWrite"
              :loading="savingKey === k"
              @click="save(k)"
            >
              保存
            </Button>
          </div>
        </div>
      </div>
    </div>

    <div class="mt-3 text-xs text-gray-400">
      数电票开票额度在「财务 ›
      票夹」页抄入维护；临期提醒窗口等供应链参数在「供应链 › 供应链设置」页。
    </div>
  </div>
</template>

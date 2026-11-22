<script lang="ts" setup>
import type {
  KnowledgeHit,
  KnowledgeSource,
  KnowledgeStatus,
} from '#/api/knowledge';

import { onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

import { Button, Card, Input, message, Spin, Tag } from 'ant-design-vue';

import {
  knowledgeAskApi,
  knowledgeSearchApi,
  knowledgeStatusApi,
} from '#/api/knowledge';

// 能进到这页就已经过了路由 authority（knowledge:read），页内不再重复判权限
const route = useRoute();

const status = ref<KnowledgeStatus | undefined>(undefined);
const question = ref('');
const searching = ref(false);
const asking = ref(false);
const hits = ref<KnowledgeHit[]>([]);
const raw = ref('');
const answer = ref('');
// kb-rag 侧的索引状态提示（⚠ 行）不进正文，单独拆给人话转述
const notice = ref('');
const sources = ref<KnowledgeSource[]>([]);
const searched = ref(false); // 已经搜过至少一次：空结果时区分"还没搜"和"没搜到"

const notReady = () => status.value !== undefined && !status.value.configured;

const fileName = (path: string) => path.split('/').pop() ?? path;

async function loadStatus(): Promise<void> {
  try {
    status.value = await knowledgeStatusApi();
  } catch {
    status.value = undefined; // 拦截器已弹后端文案
  }
}

async function doSearch(): Promise<void> {
  const q = question.value.trim();
  if (q === '') {
    message.warning('输入想查的内容再搜索');
    return;
  }
  searching.value = true;
  answer.value = '';
  notice.value = '';
  sources.value = [];
  hits.value = []; // 上一次的结果先清掉，失败时不会把旧结果当成这次的
  raw.value = '';
  searched.value = false; // 失败时不显示"没找到"（那是搜成功但为空才说的话）
  try {
    const body = await knowledgeSearchApi(q);
    hits.value = body.hits;
    raw.value = body.raw ?? '';
    searched.value = true;
  } catch {
    // 拦截器已弹后端文案（未接入 503 等）
  } finally {
    searching.value = false;
  }
}

async function doAsk(): Promise<void> {
  const q = question.value.trim();
  if (q === '') {
    message.warning('输入想问的问题再提问');
    return;
  }
  asking.value = true;
  hits.value = [];
  raw.value = '';
  answer.value = '';
  notice.value = '';
  searched.value = false; // 提问一旦开始就不按"没搜到"处理——失败时弹的是拦截器的错误文案，不该说"库里没有"
  try {
    const body = await knowledgeAskApi(q);
    answer.value = body.answer;
    notice.value = body.notice ?? '';
    sources.value = body.sources;
    searched.value = true;
  } catch {
    // 拦截器已弹后端文案
  } finally {
    asking.value = false;
  }
}

/** 深链 ?q=：只自动搜索（便宜）；提问要点按钮，避免一进页面就花一次 LLM 调用。 */
async function applyDeepLink(): Promise<void> {
  const q = typeof route.query.q === 'string' ? route.query.q.trim() : '';
  if (q !== '') {
    question.value = q;
    await doSearch();
  }
}

onMounted(async () => {
  await loadStatus();
  await applyDeepLink();
});

// 页签 keep-alive：页面已开着又从工作台问一问跳过来时 onMounted 不会再跑，靠 query 变化重新搜
watch(
  () => route.query,
  (q, old) => {
    if (
      route.path === '/knowledge' &&
      JSON.stringify(q) !== JSON.stringify(old)
    )
      void applyDeepLink();
  },
);
</script>

<template>
  <div class="p-4">
    <div class="mb-4">
      <div class="text-lg font-medium">知识库</div>
      <div class="text-sm text-gray-500">
        公司的政策、流程、对外承诺都在这里存档——先搜索，查不到再让 AI
        带着出处回答。
      </div>
    </div>

    <Card v-if="notReady()" class="mb-4">
      <div class="py-6 text-center text-sm text-gray-500">
        知识库还没接入：需要在服务端配置知识库目录（ADMIN_KB_RAG_DIR）并重启后才能使用。
        <br />
        在这之前，政策类问题可以直接问智能助手。
      </div>
    </Card>

    <template v-else>
      <Card class="mb-4">
        <div class="flex flex-wrap items-center gap-2">
          <Input
            v-model:value="question"
            class="min-w-64 flex-1"
            :maxlength="500"
            placeholder="想查什么就输入什么，如：数电票开错了怎么处理"
            @press-enter="doSearch"
          />
          <Button :loading="searching" type="primary" @click="doSearch">
            搜索
          </Button>
          <Button :loading="asking" @click="doAsk">向 AI 提问</Button>
        </div>
        <div class="mt-2 text-xs text-gray-400">
          搜索=找出相关的制度与记录；提问=AI
          通读相关内容后给出带出处的回答（约需十几秒）。
        </div>
      </Card>

      <Card v-if="asking" class="mb-4">
        <Spin />
        <span class="ml-3 text-sm text-gray-500">
          正在查阅资料并组织回答，请稍等…
        </span>
      </Card>

      <Card v-if="answer !== ''" class="mb-4">
        <template #title>回答</template>
        <div v-if="notice !== ''" class="mb-2 text-xs text-orange-500">
          提示：知识库最近有新改动还没编入索引，本回答基于已编入的内容；最新口径以官方或最新文档为准。
        </div>
        <div class="whitespace-pre-wrap text-sm leading-6">{{ answer }}</div>
        <template v-if="sources.length > 0">
          <div class="mb-2 mt-4 text-sm font-medium text-gray-500">出处</div>
          <div
            v-for="s in sources"
            :key="s.index"
            class="mb-1 text-xs text-gray-500"
          >
            [{{ s.index }}] {{ fileName(s.path) }}
            <span v-if="s.heading !== ''">· {{ s.heading }}</span>
            <Tag
              v-if="s.path.includes('/.dsh/skills/')"
              class="ml-1"
              color="blue"
              >工作手册</Tag
            >
          </div>
        </template>
      </Card>

      <Card v-if="hits.length > 0 || raw !== ''" class="mb-4">
        <template #title>搜索结果（{{ hits.length }}）</template>
        <div
          v-for="(h, i) in hits"
          :key="h.path"
          class="border-b py-3 last:border-b-0"
        >
          <div class="mb-1 flex flex-wrap items-baseline gap-2">
            <span class="text-sm font-medium">
              {{ i + 1 }}. {{ h.heading !== '' ? h.heading : fileName(h.path) }}
            </span>
            <Tag v-if="h.path.includes('/.dsh/skills/')" color="blue"
              >工作手册</Tag
            >
            <span class="text-xs text-gray-400">{{ fileName(h.path) }}</span>
          </div>
          <div class="whitespace-pre-wrap text-xs leading-5 text-gray-600">
            {{ h.text }}
          </div>
        </div>
        <div
          v-if="raw !== ''"
          class="whitespace-pre-wrap text-xs text-gray-500"
        >
          {{ raw }}
        </div>
      </Card>

      <Card v-else-if="searched && !asking && answer === ''">
        <div class="py-6 text-center text-sm text-gray-500">
          知识库里没有找到相关内容。换个说法再试，或用「向 AI
          提问」让它综合多份资料回答。
        </div>
      </Card>
    </template>
  </div>
</template>

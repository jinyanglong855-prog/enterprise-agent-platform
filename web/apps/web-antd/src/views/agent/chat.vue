<script setup lang="ts">
/**
 * 财务台对话页（P1，2026-10-27 框架定版升级为双栏）：
 * 左栏=会话列表（ant-design-x-vue Conversations：切换/重命名/归档/删除），
 * 右栏=原有气泡流。会话与消息持久化在服务端（agent_sessions/agent_messages），
 * 刷新自动恢复上次会话并回看历史；服务重启后继续旧会话走 DSH session/resume 原生续聊。
 * 确认卡片流（2026-10-20）：agent 记账默认先 finance_propose 出提案；每轮结束后拉取
 * pending 提案渲染成卡片，老板点「确认入账」才落库（source=confirm，谁认的=老板）。
 */
import type { MenuProps } from 'ant-design-vue';
import type { Conversation } from 'ant-design-x-vue';

import type { AgentMessage, AgentSession, AgentStreamEvent } from '#/api/agent';
import type { ProposalRecord } from '#/api/finance';

import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
} from 'vue';

import { useAccess } from '@vben/access';

import {
  Button,
  Card,
  Input,
  message,
  Modal,
  Switch,
  Tag,
} from 'ant-design-vue';
import { Bubble, Conversations, Sender, Welcome } from 'ant-design-x-vue';

import {
  chatStreamApi,
  createAgentSessionApi,
  deleteAgentSessionApi,
  getAgentMessagesApi,
  listAgentSessionsApi,
  patchAgentSessionApi,
  stopAgentSessionApi,
  uploadWorkspaceFileApi,
} from '#/api/agent';
import { listProposalsApi } from '#/api/finance';
import { readFileText, safeFileName } from '#/utils/file-text';

import ProposalCard from './proposal-card.vue';
import { renderMessage } from './render';

interface ChatItem {
  content: string;
  key: string;
  loading: boolean;
  /** 本轮流经的工具名（展示在 AI 气泡头，便于老板知道它查了/记了什么）。 */
  tools: string[];
  role: 'ai' | 'user';
  /** 历史消息的落库状态（error/interrupted 时气泡头给标记）。 */
  status?: string;
}

const LAST_SESSION_KEY = 'admin-agent-last-session';

// 发消息/建会话/传文件走 agent:write；只读角色能看历史与卡片，不给会 403 的输入框
const { hasAccessByCodes } = useAccess();
const canChat = hasAccessByCodes(['agent:write']);

let nextKey = 1;
const messages = reactive<ChatItem[]>([]);
const inputValue = ref('');
const streaming = ref(false);
const sessionId = ref('');
const sessions = ref<AgentSession[]>([]);
const showArchived = ref(false);
const scrollBox = ref<HTMLElement>();
let controller: AbortController | undefined;
const pendingProposals = ref<ProposalRecord[]>([]);

// 重命名小弹窗
const renameOpen = ref(false);
const renameTitle = ref('');
let renameTarget = '';

const suggestions = [
  '帮我记一笔：今天收到王五货款 800 元，微信收的',
  '这个月收了多少、还欠多少？',
  '现在有哪些应收没回来？',
];

const convItems = computed<Conversation[]>(() =>
  sessions.value.map((s) => ({
    key: s.id,
    label: s.archived === 1 ? `${s.title}（已归档）` : s.title,
    // 不用 disabled：组件对禁用项不渲染"…"菜单，归档会话会失去取消归档/删除入口；
    // 归档项的只读语义在 onSwitch 里拦截
  })),
);

watch(
  messages,
  () => {
    nextTick(() => {
      scrollBox.value?.scrollTo({
        behavior: 'smooth',
        top: scrollBox.value.scrollHeight,
      });
    });
  },
  { deep: true },
);

async function refreshProposals() {
  try {
    const body = await listProposalsApi('pending');
    pendingProposals.value = body.proposals;
  } catch {
    pendingProposals.value = []; // 提示条失败不打断对话
  }
}

async function refreshSessions() {
  try {
    const body = await listAgentSessionsApi(showArchived.value);
    sessions.value = body.sessions;
  } catch {
    sessions.value = []; // 列表失败不打断对话（右侧还能聊）
  }
}

function messageToItem(m: AgentMessage): ChatItem {
  let tools: string[] = [];
  try {
    tools = JSON.parse(m.tools) as string[];
  } catch {
    // 坏数据当无工具
  }
  return {
    content: m.content,
    key: `h${m.id}`,
    loading: false,
    role: m.role === 'user' ? 'user' : 'ai',
    status: m.status,
    tools: m.role === 'assistant' ? tools : [],
  };
}

/** 切到某会话：拉历史渲染（服务端没有的消息不存在——没有"本地记忆"）。 */
async function loadSession(id: string) {
  sessionId.value = id;
  localStorage.setItem(LAST_SESSION_KEY, id);
  messages.length = 0;
  try {
    const body = await getAgentMessagesApi(id);
    messages.push(...body.messages.map(messageToItem));
  } catch {
    message.error('拉取历史消息失败');
  }
}

async function onSwitch(id: string) {
  if (id === sessionId.value) return;
  const target = sessions.value.find((s) => s.id === id);
  if (target?.archived === 1) {
    message.warning('该会话已归档，先在"…"菜单里取消归档再继续');
    return;
  }
  if (streaming.value) {
    message.warning('正在回答中，先停止再切换会话');
    return;
  }
  await loadSession(id);
}

function rememberCurrent() {
  if (sessionId.value) localStorage.setItem(LAST_SESSION_KEY, sessionId.value);
}

async function newSession() {
  if (streaming.value) return;
  try {
    const r = await createAgentSessionApi();
    await refreshSessions();
    await loadSession(r.session.id);
    message.success('已开新会话');
  } catch {
    message.error('开新会话失败，请重试');
  }
}

onMounted(() => {
  refreshProposals();
  refreshSessions().then(() => {
    // 恢复上次会话（刷新不丢对话）；已归档/找不到（删了/清了缓存）就停在空态
    const last = localStorage.getItem(LAST_SESSION_KEY);
    const target = sessions.value.find((s) => s.id === last);
    if (target && target.archived === 0) {
      loadSession(target.id);
    }
  });
  // 回合末刷新之外再兜一层：agent 在别处提案/老板在台账页处理卡片时，长挂页面也能跟上
  proposalTimer = window.setInterval(refreshProposals, 30_000);
});

let proposalTimer: number | undefined;
onBeforeUnmount(() => {
  if (proposalTimer !== undefined) window.clearInterval(proposalTimer);
});

async function send(text: string) {
  const content = (text ?? inputValue.value).trim();
  if (!content || streaming.value) return;
  inputValue.value = '';
  messages.push({
    content,
    key: `u${nextKey++}`,
    loading: false,
    role: 'user',
    tools: [],
  });
  const ai = reactive<ChatItem>({
    content: '',
    key: `a${nextKey++}`,
    loading: true,
    role: 'ai',
    tools: [],
  });
  messages.push(ai);
  streaming.value = true;
  controller = new AbortController();
  // 没有当前会话就先建一个再发（后端虽支持无 sessionId 自动建，但那样错误帧场景
  // 前端拿不到 sessionId，刷新后会与这个会话失联）
  if (!sessionId.value) {
    try {
      const created = await createAgentSessionApi();
      sessionId.value = created.session.id;
      rememberCurrent();
      refreshSessions();
    } catch {
      streaming.value = false;
      controller = undefined;
      ai.loading = false;
      ai.content = '⚠️ 建会话失败，请重试';
      return;
    }
  }
  const handle = (e: AgentStreamEvent) => {
    if (e.event === 'tool') {
      if (!ai.tools.includes(e.data.name)) ai.tools.push(e.data.name);
    } else if (e.event === 'assistant' || e.event === 'final') {
      ai.loading = false;
      ai.content = e.data.text;
      if (e.event === 'final') {
        sessionId.value = e.data.sessionId;
        rememberCurrent();
      }
    } else if (e.event === 'status' && e.data.phase === 'fresh-context') {
      message.info('原对话上下文没能完整恢复，财务台会按新上下文接着答');
    } else if (e.event === 'error') {
      ai.loading = false;
      ai.content = `⚠️ ${e.data.message}`;
    }
  };
  try {
    await chatStreamApi({
      sessionId: sessionId.value || undefined,
      message: content,
      onEvent: handle,
      signal: controller.signal,
    });
  } catch (error) {
    if (!ai.content) {
      ai.content =
        (error as Error).name === 'AbortError'
          ? '（已停止回答）'
          : `⚠️ 连不上对话服务：${(error as Error).message}`;
    }
  } finally {
    streaming.value = false;
    controller = undefined;
    if (ai.loading && !ai.content) {
      ai.loading = false;
      ai.content = '⚠️ 对话流中断，没有收到回答';
    }
    // 标题/排序可能变了；轮次里可能出了新提案
    refreshSessions();
    refreshProposals();
  }
}

/** 停止生成：优先让服务端中断（落库 interrupted + SSE 正常收尾），失败再本地断流兜底。 */
async function stopStream() {
  if (sessionId.value && streaming.value) {
    try {
      await stopAgentSessionApi(sessionId.value);
      return;
    } catch {
      // 服务端停不了（多半是连不上了），本地断流
    }
  }
  controller?.abort();
}

/** 老板丢文件进对话（§0.6 通道 b 入口）：文本先落工作区 inbox，再自动告知 agent 文件位置
 *  （大表内容不进消息体）；agent 用 file 工具看结构、出导入方案，等老板下指令。 */
const fileInput = ref<HTMLInputElement>();

async function onPickFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file || streaming.value) return;
  try {
    const content = await readFileText(file);
    const saved = await uploadWorkspaceFileApi(
      safeFileName(file.name),
      content,
    );
    messages.push({
      content: `📎 已上传 ${saved.name}（${saved.lines} 行）到财务台工作区 ${saved.relative}`,
      key: `u${nextKey++}`,
      loading: false,
      role: 'user',
      tools: [],
    });
    await send(
      `[系统] 负责人刚把文件 ${saved.relative}（共 ${saved.lines} 行）丢进工作区。先看一眼结构，` +
        `告诉负责人这张表你会怎么解读（哪列当什么、认不认得出），等负责人说怎么处理再动手。`,
    );
  } catch (error) {
    message.error(`上传失败：${(error as Error)?.message ?? error}`);
  }
}

// ----------------------------------------------------------- 会话管理（重命名/归档/删除）

function menuFor(item: Conversation): MenuProps {
  const session = sessions.value.find((s) => s.id === item.key);
  const archived = session?.archived === 1;
  const entries = archived
    ? [
        { key: 'unarchive', label: '取消归档' },
        { key: 'delete', danger: true, label: '删除' },
      ]
    : [
        { key: 'rename', label: '重命名' },
        { key: 'archive', label: '归档' },
        { key: 'delete', danger: true, label: '删除' },
      ];
  return {
    items: entries,
    onClick: ({ key }) => handleMenu(String(key), String(item.key)),
  };
}

async function handleMenu(action: string, id: string) {
  // 正在生成的会话不能归档/删除（后端同样有守卫）：否则轮次收尾落库会撞上会话消失
  if (
    streaming.value &&
    id === sessionId.value &&
    (action === 'archive' || action === 'unarchive' || action === 'delete')
  ) {
    message.warning('正在回答中，先停止再操作这个会话');
    return;
  }
  if (action === 'rename') {
    renameTarget = id;
    renameTitle.value = sessions.value.find((s) => s.id === id)?.title ?? '';
    renameOpen.value = true;
    return;
  }
  if (action === 'archive' || action === 'unarchive') {
    try {
      await patchAgentSessionApi(id, { archived: action === 'archive' });
      await refreshSessions();
      if (id === sessionId.value && action === 'archive') {
        sessionId.value = '';
        messages.length = 0;
        localStorage.removeItem(LAST_SESSION_KEY);
        const first = sessions.value.find((s) => s.archived === 0);
        if (first) await loadSession(first.id);
      }
    } catch {
      message.error('操作失败，请重试');
    }
    return;
  }
  if (action === 'delete') {
    Modal.confirm({
      content: '删除后这个会话和全部聊天记录都没了，账本数据不受影响。',
      okButtonProps: { danger: true },
      okText: '删除',
      onOk: async () => {
        try {
          await deleteAgentSessionApi(id);
          if (id === sessionId.value) {
            sessionId.value = '';
            messages.length = 0;
            localStorage.removeItem(LAST_SESSION_KEY);
            const first = sessions.value.find(
              (s) => s.id !== id && s.archived === 0,
            );
            if (first) await loadSession(first.id);
          }
          await refreshSessions();
          message.success('已删除');
        } catch {
          message.error('删除失败，请重试');
        }
      },
      title: '删除这个会话？',
    });
  }
}

async function confirmRename() {
  const title = renameTitle.value.trim();
  if (!title) {
    message.warning('标题不能为空');
    return;
  }
  try {
    await patchAgentSessionApi(renameTarget, { title });
    renameOpen.value = false;
    await refreshSessions();
  } catch {
    message.error('重命名失败，请重试');
  }
}

function onArchivedToggle(checked: unknown) {
  showArchived.value = checked === true;
  refreshSessions();
}

onBeforeUnmount(() => controller?.abort());
</script>

<template>
  <div class="chat-page">
    <aside class="chat-side">
      <div class="chat-side-head">
        <span class="chat-side-title">会话</span>
        <Button
          v-if="canChat"
          :disabled="streaming"
          size="small"
          type="primary"
          @click="newSession"
        >
          新会话
        </Button>
      </div>
      <Conversations
        :active-key="sessionId"
        :items="convItems"
        :menu="menuFor"
        class="chat-conv-list"
        @active-change="onSwitch"
      />
      <div class="chat-side-foot">
        <Switch
          :checked="showArchived"
          size="small"
          @change="onArchivedToggle"
        />
        <span class="chat-side-archived-hint">显示已归档（灰项只读）</span>
      </div>
    </aside>

    <Card :bordered="false" class="chat-card">
      <template #title>
        <span>财务台</span>
        <Tag v-if="sessionId" class="ml-2" color="default">
          {{ sessions.find((s) => s.id === sessionId)?.title ?? '会话' }}
        </Tag>
      </template>

      <div ref="scrollBox" class="chat-scroll">
        <template v-if="messages.length === 0">
          <Welcome
            class="chat-welcome"
            description="记一笔账、问收付欠款、提醒催收与申报节点。金额问题我会先查账本再回答，不凭印象报数。"
            title="负责人，我是财务台专员"
          />
          <div v-if="canChat" class="chat-suggestions">
            <Button
              v-for="s in suggestions"
              :key="s"
              :disabled="streaming"
              class="chat-suggestion"
              size="small"
              @click="send(s)"
            >
              {{ s }}
            </Button>
          </div>
        </template>

        <Bubble
          v-for="item in messages"
          :key="item.key"
          :content="item.role === 'user' ? item.content : ''"
          :loading="item.loading"
          :placement="item.role === 'user' ? 'end' : 'start'"
          :variant="item.role === 'user' ? 'filled' : 'outlined'"
          class="chat-bubble"
        >
          <template v-if="item.role === 'ai'" #header>
            <div class="chat-tools">
              <Tag v-if="item.status === 'interrupted'" color="orange">
                已停止
              </Tag>
              <Tag v-else-if="item.status === 'error'" color="red">出错</Tag>
              <template v-if="item.tools.length > 0">
                <span class="chat-tools-label">用了</span>
                <Tag v-for="t in item.tools" :key="t" color="blue">{{ t }}</Tag>
              </template>
            </div>
          </template>
          <template v-if="item.role === 'ai'" #message>
            <div class="chat-md" v-html="renderMessage(item.content)"></div>
          </template>
        </Bubble>
      </div>

      <div v-if="pendingProposals.length > 0" class="proposal-panel">
        <div class="proposal-panel-title">待确认记账（确认后才入账）</div>
        <ProposalCard
          v-for="p in pendingProposals"
          :key="p.id"
          :proposal="p"
          @resolved="refreshProposals"
        />
      </div>

      <div v-if="canChat" class="chat-upload-row">
        <input
          ref="fileInput"
          accept=".csv,.tsv,.txt,.md"
          style="display: none"
          type="file"
          @change="onPickFile"
        />
        <Button :disabled="streaming" size="small" @click="fileInput?.click()">
          📎 丢文件给财务台
        </Button>
        <span class="chat-upload-hint"
          >CSV / TSV / TXT，≤1MB；Excel 请先「另存为
          CSV」；截图或手搓表可直接粘贴文字</span
        >
      </div>

      <Sender
        v-if="canChat"
        v-model:value="inputValue"
        :loading="streaming"
        placeholder="给财务台发消息…（Enter 发送）"
        submit-type="enter"
        class="chat-sender"
        @cancel="stopStream"
        @submit="(t: string) => send(t)"
      />
      <div v-else class="chat-readonly-hint">
        你的账号只能查看对话记录，没有发消息权限（agent:write）。
      </div>
    </Card>

    <Modal
      v-model:open="renameOpen"
      ok-text="保存"
      title="重命名会话"
      @ok="confirmRename"
    >
      <Input
        v-model:value="renameTitle"
        :maxlength="50"
        placeholder="给这个会话起个名字"
        @press-enter="confirmRename"
      />
    </Modal>
  </div>
</template>

<style scoped>
.chat-page {
  display: flex;
  gap: 8px;
  height: 100%;
  padding: 8px;
}

.chat-side {
  display: flex;
  flex-shrink: 0;
  flex-direction: column;
  width: 236px;
  min-height: 0;
}

.chat-side-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 4px 8px;
}

.chat-side-title {
  font-size: 13px;
  font-weight: 600;
  color: hsl(var(--foreground) / 70%);
}

.chat-conv-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.chat-side-foot {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 8px 4px 0;
}

.chat-side-archived-hint {
  font-size: 12px;
  color: hsl(var(--foreground) / 45%);
}

.chat-card {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  height: 100%;
}

.chat-card :deep(.ant-card-body) {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}

.chat-scroll {
  flex: 1;
  min-height: 0;
  padding: 8px 4px;
  overflow-y: auto;
}

.chat-welcome {
  max-width: 480px;
  margin: 48px auto 16px;
}

.chat-suggestions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
  margin-bottom: 16px;
}

.chat-bubble {
  margin-bottom: 12px;
}

.chat-tools {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
}

.chat-tools-label {
  font-size: 12px;
  color: hsl(var(--foreground) / 60%);
}

.chat-md :deep(p) {
  margin: 0 0 6px;
}

.chat-md :deep(ul),
.chat-md :deep(ol) {
  padding-left: 20px;
  margin: 0 0 6px;
}

.chat-md :deep(code) {
  padding: 0 4px;
  background: hsl(var(--accent) / 60%);
  border-radius: 4px;
}

.chat-sender {
  padding-top: 8px;
}

.chat-upload-row {
  display: flex;
  gap: 8px;
  align-items: center;
  padding-top: 8px;
}

.chat-upload-hint {
  font-size: 12px;
  color: hsl(var(--foreground) / 45%);
}

.chat-readonly-hint {
  padding: 10px 0 2px;
  font-size: 12px;
  color: hsl(var(--foreground) / 45%);
}

.proposal-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 260px;
  padding: 8px;
  margin-bottom: 8px;
  overflow-y: auto;
}

.proposal-panel-title {
  font-size: 12px;
  color: hsl(var(--foreground) / 60%);
}
</style>

/**
 * 智能体对话网关前端 API（2026-10-27 框架定版：对话域完整化）。
 *
 * chat 是 POST SSE（EventSource 不支持 POST + 鉴权头），用 fetch 手读流：
 * 后端帧格式固定 `event: <名>\ndata: <JSON>\n\n`（见 server agent.controller.ts），
 * 按"空行分帧、首行取 event、其余行拼 data"解析即可，无需引 SSE 库。
 * 会话/消息持久化在服务端（agent_sessions/agent_messages），这里补齐其 CRUD 与中断。
 */
import { useAppConfig } from '@vben/hooks';
import { useAccessStore } from '@vben/stores';

import { requestClient } from './request';

const { apiURL } = useAppConfig(import.meta.env, import.meta.env.PROD);

/** 随消息带给网关的页面上下文（注入 agent 提示，帮它知道老板正在看哪页）。 */
export interface AgentChatContext {
  entryId?: string;
  page?: string;
}

export type AgentStreamEvent =
  | { event: 'assistant'; data: { text: string } }
  | { event: 'error'; data: { message: string } }
  | {
      event: 'final';
      data: { interrupted?: boolean; sessionId: string; text: string };
    }
  | { event: 'status'; data: { phase: 'fresh-context' | 'thinking' } }
  | { event: 'tool'; data: { name: string } };

// ----------------------------------------------------------- 会话与消息

export interface AgentSession {
  archived: number;
  created_at: string;
  created_by: string;
  dsh_session_id: string;
  id: string;
  title: string;
  updated_at: string;
}

export interface AgentMessage {
  content: string;
  created_at: string;
  id: number;
  role: 'assistant' | 'user';
  status: 'error' | 'interrupted' | 'ok';
  tools: string;
}

export function listAgentSessionsApi(
  includeArchived = false,
): Promise<{ sessions: AgentSession[] }> {
  return requestClient.get(
    `/agent/sessions${includeArchived ? '?includeArchived=1' : ''}`,
  );
}

export function createAgentSessionApi(): Promise<{ session: AgentSession }> {
  return requestClient.post('/agent/sessions');
}

export function getAgentMessagesApi(
  sessionId: string,
): Promise<{ messages: AgentMessage[] }> {
  return requestClient.get(`/agent/sessions/${sessionId}/messages`);
}

export function patchAgentSessionApi(
  sessionId: string,
  patch: { archived?: boolean; title?: string },
): Promise<{ session: AgentSession }> {
  // RequestClient 没封 patch 方法，走通用 request（axios 实例支持 PATCH）
  return requestClient.request(`/agent/sessions/${sessionId}`, {
    data: patch,
    method: 'PATCH',
  });
}

/** 删除会话：服务端应用层级联删消息；DSH 侧历史留日志（协议不提供删除）。 */
export function deleteAgentSessionApi(
  sessionId: string,
): Promise<{ ok: boolean }> {
  return requestClient.delete(`/agent/sessions/${sessionId}`);
}

/** 中断正在生成的轮次（进程级：协议无 cancel，后端 kill 子进程、下轮自动重建并 resume 续聊）。 */
export function stopAgentSessionApi(
  sessionId: string,
): Promise<{ stopped: boolean }> {
  return requestClient.post(`/agent/sessions/${sessionId}/stop`);
}

// ----------------------------------------------------------- 文件工作区（§0.6 对话入口）

export interface WorkspaceFile {
  bytes: number;
  name: string;
  updated_at: string;
}

/** 老板往对话丢文件：文本内容落到工作区 inbox，返回短摘要供消息里引用（大表不进消息体）。 */
export function uploadWorkspaceFileApi(
  name: string,
  content: string,
): Promise<{
  bytes: number;
  lines: number;
  name: string;
  overwritten: boolean;
  relative: string;
}> {
  return requestClient.post('/agent/files', { content, name });
}

export function listWorkspaceFilesApi(): Promise<{
  inbox: WorkspaceFile[];
  outbox: WorkspaceFile[];
}> {
  return requestClient.get('/agent/files');
}

export function readWorkspaceFileApi(
  dir: 'inbox' | 'outbox',
  name: string,
): Promise<{ content: string; name: string; relative: string }> {
  return requestClient.get(`/agent/files/${dir}/${encodeURIComponent(name)}`);
}

// ----------------------------------------------------------- 对话（SSE）

/**
 * 发一条消息并流式收事件。resolve = 服务端收尾（final/error/断流）；
 * abort signal 用于断开读取；生成中的中断应先调 stopAgentSessionApi（服务端收尾），
 * 这里的 abort 只兜"服务端失去响应"的场景。
 */
export async function chatStreamApi(options: {
  context?: AgentChatContext;
  message: string;
  onEvent: (e: AgentStreamEvent) => void;
  sessionId?: string;
  signal?: AbortSignal;
}): Promise<void> {
  const accessStore = useAccessStore();
  const token = accessStore.accessToken;
  const res = await fetch(`${apiURL}/agent/chat`, {
    body: JSON.stringify({
      context: options.context,
      message: options.message,
      sessionId: options.sessionId || undefined,
    }),
    headers: {
      authorization: token ? `Bearer ${token}` : '',
      'content-type': 'application/json',
    },
    method: 'POST',
    signal: options.signal,
  });
  if (!res.ok || !res.body) {
    let detail = '';
    try {
      detail = (await res.json())?.message ?? '';
    } catch {
      // 非 JSON 错误体，忽略
    }
    throw new Error(detail || `对话服务不可用（HTTP ${res.status}）`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE 以空行分帧；最后一段可能不完整，留在 buffer
    for (;;) {
      const sep = buffer.indexOf('\n\n');
      if (sep === -1) break;
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const parsed = parseFrame(frame);
      if (parsed) options.onEvent(parsed);
    }
  }
}

function parseFrame(frame: string): AgentStreamEvent | undefined {
  const lines = frame.split('\n');
  const eventLine = lines.find((l) => l.startsWith('event:'));
  const dataLines = lines.filter((l) => l.startsWith('data:'));
  if (!eventLine || dataLines.length === 0) return undefined;
  try {
    const data = JSON.parse(
      dataLines.map((l) => l.slice(5).trimStart()).join('\n'),
    );
    return { data, event: eventLine.slice(6).trim() } as AgentStreamEvent;
  } catch {
    return undefined;
  }
}

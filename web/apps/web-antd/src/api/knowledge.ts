/**
 * 知识库前端 API（2026-11-02 阶段 3 融合）：/api/knowledge 薄封装。读=knowledge:read（老板缺省持有）。
 * 搜索是纯检索（便宜、快），问一问走 kb-rag 侧 LLM 带来源回答（慢、有成本）——界面分开两个动作。
 */
import { requestClient } from './request';

export interface KnowledgeStatus {
  configured: boolean;
  running: boolean;
  caller: string;
  lastFailure?: string;
}

export interface KnowledgeHit {
  /** 库内相对路径（唯一事实源定位）。 */
  path: string;
  /** 命中的小节标题；''=整文件块。 */
  heading: string;
  score: number;
  /** 相关段落（kb-rag 侧已截到 600 字）。 */
  text: string;
}

export interface KnowledgeSource {
  index: number;
  label: string;
  path: string;
  heading: string;
}

export function knowledgeStatusApi(): Promise<KnowledgeStatus> {
  return requestClient.get('/knowledge/status');
}

/** 提问要过一遍大模型（约十几秒），搜索首次还要拉起知识库子进程——全局默认
 * 10 秒超时会掐断它们，这里按后端上限（ask 90s / search 45s）放宽。 */
const KB_TIMEOUT_SEARCH = 60_000;
const KB_TIMEOUT_ASK = 120_000;

export function knowledgeSearchApi(
  q: string,
  k = 8,
): Promise<{ hits: KnowledgeHit[]; raw?: string }> {
  return requestClient.get('/knowledge/search', {
    params: { q, k },
    timeout: KB_TIMEOUT_SEARCH,
  });
}

export function knowledgeAskApi(
  question: string,
  k = 5,
): Promise<{ answer: string; notice: string; sources: KnowledgeSource[] }> {
  return requestClient.post(
    '/knowledge/ask',
    { k, question },
    { timeout: KB_TIMEOUT_ASK },
  );
}

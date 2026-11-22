/**
 * 知识库服务（2026-11-02 阶段 3）：把 kb-rag 的两个 MCP 工具包成管理台 REST 面——
 * 搜索（kb_vector_search，按语义召回后每篇文档只留最优一段）与问答（kb_ask，检索后由 LLM 生成带来源的回答）。
 *
 * 搜索不用 kb_hybrid_search：实测（2026-11-02）BM25 融合会被 README「当前状态」那种一个标题切成几十块、
 * 关键词密度极高的长节霸榜，手册独有内容在 16 块内都召不回；纯向量对业务人员的自然语言问法排序正确，
 * 精确标题也能命中。按文档折叠是给界面用的（一行一篇、带最相关的一段），不改 kb-rag 的召回。
 *
 * kb-rag 工具返回的是给 agent 读的文本，不是结构化数据；这里按其稳定格式解析成界面能渲染的
 * 命中列表/来源列表，解析不出来时原文透传（raw），不让格式漂移把功能整个打死。
 * 读范围在 kb-rag 侧按 KB_CALLER 过滤（scopes.json），本服务不做二次过滤也不缓存结果。
 */
import type { AuditService } from '../audit/audit.service.js'
import { BadRequestError, ServiceUnavailableError } from '../errors.js'
import type { KbMcpClient } from './kb-mcp-client.js'

export interface KnowledgeHit {
  path: string
  heading: string
  score: number
  text: string
}

export interface KnowledgeSource {
  index: number
  label: string
  path: string
  heading: string
}

export interface KnowledgeStatus {
  configured: boolean
  running: boolean
  caller: string
  lastFailure?: string
}

export interface KnowledgeActor {
  username: string
  source: string
}

const QUESTION_MAX = 500
const K_MIN = 1
const K_MAX = 20
const SEARCH_TIMEOUT_MS = 45_000
/** 问答含精排 + LLM 生成，慢于检索；比 SDK 缺省 60s 再宽一点，给冷启动留余量。 */
const ASK_TIMEOUT_MS = 90_000

/** kb-rag `_fmt_hits` 的块头：`[<path> #<heading>]（score=<n>）`，正文在其后直到下一个块头。
 * score 是归一化点积的 round(…,4)，理论上可为负，允许负号。 */
const HIT_HEADER = /^\[(.+?) #(.*?)\]（score=(-?[\d.]+)）$/
/** kb_ask 的来源脚注行：`[n] <path> #<heading>`，可带「（父块）」「（分析卡命中→原文）」「（别名…）」尾注。 */
const SOURCE_LINE = /^\[(\d+)\]\s+(.+)$/
const SOURCES_SEPARATOR = '\n\n来源：\n'
/** kb-rag 在索引未建/错位时不走 LLM，直接返回带 CLI 指令的说明文本（无 ⚠ 前缀也无来源脚注），
 * 搜索侧则以工具错误抛出同类文案——这些是运维口径，管理台一律转成 503 人话。 */
const CLI_HINT = /kb-rag (index|add)\b/
const INDEX_NOT_READY = '知识库索引未就绪：请联系管理员重建索引后再试'

export class KnowledgeService {
  constructor(
    private readonly audit: AuditService,
    private readonly client: KbMcpClient | undefined,
    private readonly caller: string,
  ) {}

  status(): KnowledgeStatus {
    const out: KnowledgeStatus = {
      configured: this.client !== undefined,
      running: this.client?.running ?? false,
      caller: this.caller,
    }
    const failure = this.client?.lastFailure
    if (failure !== undefined) out.lastFailure = failure
    return out
  }

  async search(question: string, k: number | undefined, actor: KnowledgeActor): Promise<{ hits: KnowledgeHit[]; raw?: string }> {
    const q = normalizeQuestion(question)
    const kk = normalizeK(k, 8)
    // 多取一倍再按文档折叠：同一篇文档命中多段时只留最相关的一段，界面一行一篇
    const text = await this.call('kb_vector_search', { question: q, k: kk * 2 }, SEARCH_TIMEOUT_MS)
    const hits = collapseByPath(parseHits(text), kk)
    if (hits.length === 0 && CLI_HINT.test(text)) throw new ServiceUnavailableError(INDEX_NOT_READY)
    this.audit.log({
      username: actor.username,
      source: actor.source,
      action: 'knowledge.search',
      targetId: null,
      detail: { question: q.slice(0, 200), k: kk, hits: hits.length },
      ok: true,
    })
    if (hits.length === 0 && text.trim() !== '' && text.trim() !== '无结果') return { hits, raw: text }
    return { hits }
  }

  async ask(question: string, k: number | undefined, actor: KnowledgeActor): Promise<{ answer: string; notice: string; sources: KnowledgeSource[] }> {
    const q = normalizeQuestion(question)
    const kk = normalizeK(k, 5)
    const text = await this.call('kb_ask', { question: q, k: kk }, ASK_TIMEOUT_MS)
    const parsed = parseAnswer(text)
    // 没有来源又带 CLI 指令 = kb-rag 的"索引不存在/错位"说明文本，不是回答
    if (parsed.sources.length === 0 && CLI_HINT.test(parsed.answer)) throw new ServiceUnavailableError(INDEX_NOT_READY)
    this.audit.log({
      username: actor.username,
      source: actor.source,
      action: 'knowledge.ask',
      targetId: null,
      detail: {
        question: q.slice(0, 200),
        k: kk,
        sources: parsed.sources.length,
        ...(parsed.notice === '' ? {} : { indexNotice: parsed.notice }),
      },
      ok: true,
    })
    return parsed
  }

  async shutdown(): Promise<void> {
    await this.client?.close()
  }

  private async call(tool: string, args: Record<string, unknown>, timeoutMs: number): Promise<string> {
    if (this.client === undefined) {
      throw new ServiceUnavailableError('知识库还没接入：请在服务端设置 ADMIN_KB_RAG_DIR 指向 kb-rag 仓库目录后重启')
    }
    try {
      return await this.client.callTool(tool, args, timeoutMs)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      if (CLI_HINT.test(message)) throw new ServiceUnavailableError(INDEX_NOT_READY)
      throw new ServiceUnavailableError(`知识库暂时不可用：${message}`)
    }
  }
}

function normalizeQuestion(raw: unknown): string {
  const q = typeof raw === 'string' ? raw.trim() : ''
  if (q === '') throw new BadRequestError('请输入要查的问题')
  if (q.length > QUESTION_MAX) throw new BadRequestError(`问题太长（最多 ${QUESTION_MAX} 字）`)
  return q
}

function normalizeK(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < K_MIN || n > K_MAX) throw new BadRequestError(`条数须为 ${K_MIN}-${K_MAX} 的整数`)
  return n
}

/** 解析 kb_hybrid_search / kb_vector_search 文本：按块头切，块头之间的行是正文。 */
export function parseHits(text: string): KnowledgeHit[] {
  const hits: KnowledgeHit[] = []
  let current: KnowledgeHit | undefined
  const body: string[] = []
  const flush = (): void => {
    if (current !== undefined) {
      current.text = body.join('\n').trim()
      hits.push(current)
    }
    body.length = 0
  }
  for (const line of text.split('\n')) {
    const m = HIT_HEADER.exec(line)
    if (m !== null) {
      flush()
      current = { path: m[1] ?? '', heading: m[2] ?? '', score: Number(m[3]), text: '' }
      continue
    }
    if (current !== undefined) body.push(line)
  }
  flush()
  return hits
}

/** 按文档折叠：命中已按相关度排序，同一 path 只留首次出现（最相关的一段），凑满 limit 篇为止。 */
export function collapseByPath(hits: KnowledgeHit[], limit: number): KnowledgeHit[] {
  const out: KnowledgeHit[] = []
  const seen = new Set<string>()
  for (const h of hits) {
    if (seen.has(h.path)) continue
    seen.add(h.path)
    out.push(h)
    if (out.length >= limit) break
  }
  return out
}

/**
 * 解析 kb_ask 文本：正文与「来源：」脚注分离，脚注逐行解析成来源；没有脚注则整段当回答、来源为空。
 * 正文开头的 `⚠ …` 行是 kb-rag 侧的索引状态提示（过期/重建中等，运维口径，含 CLI 指令），
 * 拆出来单独返回，界面用人话转述，不把「跑 kb-rag add」这类指令露给管理台用户。
 */
export function parseAnswer(text: string): { answer: string; notice: string; sources: KnowledgeSource[] } {
  let body = text
  let notice = ''
  const warn = /^⚠([^\n]*)\n\n/.exec(body)
  if (warn !== null) {
    notice = `⚠${warn[1] ?? ''}`.trim()
    body = body.slice(warn[0].length)
  }
  const at = body.lastIndexOf(SOURCES_SEPARATOR)
  if (at < 0) return { answer: body.trim(), notice, sources: [] }
  const answer = body.slice(0, at).trim()
  const sources: KnowledgeSource[] = []
  for (const line of body.slice(at + SOURCES_SEPARATOR.length).split('\n')) {
    const m = SOURCE_LINE.exec(line.trim())
    if (m === null) continue
    const label = (m[2] ?? '').trim()
    const { path, heading } = splitLabel(label)
    sources.push({ index: Number(m[1]), label, path, heading })
  }
  return { answer, notice, sources }
}

/** `<path> #<heading>（尾注）` → path/heading。尾注只认 kb-rag 实际会加的三种（父块 / 分析卡命中→原文 /
 * 别名“x”→项目·状态页），标题自带的括号（如「…（v2）」）不剥。 */
const LABEL_TAIL = /（(?:父块|分析卡命中→原文|别名[^（）]*)）$/u
function splitLabel(label: string): { path: string; heading: string } {
  const noTail = label.replace(LABEL_TAIL, '').trim()
  const hash = noTail.indexOf(' #')
  if (hash < 0) return { path: noTail, heading: '' }
  return { path: noTail.slice(0, hash).trim(), heading: noTail.slice(hash + 2).trim() }
}

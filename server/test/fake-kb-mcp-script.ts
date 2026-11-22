/**
 * 测试用"假 kb-rag-mcp"（讲 MCP stdio 线协议：按换行分帧的 JSON-RPC 2.0），knowledge-api.test.ts 用。
 * 写进临时目录后以 `node <path>` 作为 ADMIN_KB_MCP_COMMAND/ARGS 拉起；客户端是真·官方 SDK，
 * 所以握手/工具调用的报文形状必须合规——这里只演三个工具：
 * - kb_vector_search：返回 kb-rag `_fmt_hits` 格式的三块（两块同一篇文档，验证按文档折叠），
 *   首块标题带本进程的 KB_CALLER（验证身份确实传进了子进程 env）
 * - kb_ask：返回"正文 + 来源脚注"（含父块/分析卡尾注，验证来源解析）
 * - kb_fail：isError 结果（验证错误透传）
 * 旗标文件（FAKE_FLAGS_FILE）含 crash 时，收到 tools/call 直接退出不回包（崩溃重拉剧本）。
 * 每次启动向 FAKE_SPAWN_LOG 追加一行（验证懒启动/重拉/空闲停后再拉）。stdin 关闭即退出（空闲自停）。
 */
export const FAKE_KB_MCP = String.raw`
import { createInterface } from 'node:readline'
import { appendFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 日志/旗标固定在脚本所在目录：客户端 env 只转发 KB_CALLER（生产口径），测试路径不过 env 传
const HERE = dirname(fileURLToPath(import.meta.url))
const SPAWN_LOG = join(HERE, 'spawns.log')
const FLAGS_FILE = join(HERE, 'flags')

appendFileSync(SPAWN_LOG, 'spawn\n')
const flags = () => {
  try { return readFileSync(FLAGS_FILE, 'utf8').trim().split(/\s+/) } catch { return [] }
}
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
const text = (t, extra = {}) => ({ content: [{ type: 'text', text: t }], ...extra })

const HITS = [
  '[公司智能体/项目文件/deepseek-harness/default-workspace/.dsh/skills/finance-ops/SKILL.md #参考节 C（caller=' + process.env.KB_CALLER + '）]（score=0.91）',
  '数电票没有"作废"，开错只能红冲。',
  '第二段',
  '',
  '[公司智能体/项目状态/参考资料/2026-10-15 - 财务台调研.md #三、宁波社保公积金]（score=0.80）',
  '基数每年 7 月随社平工资调整。',
  '',
  '[公司智能体/项目文件/deepseek-harness/default-workspace/.dsh/skills/finance-ops/SKILL.md #参考节 B]（score=0.70）',
  '同一篇文档的第二块，应被折叠掉。',
].join('\n')

const ANSWER = [
  // ⚠ 行是 kb-rag 侧索引状态提示的固定形状（⚠…行 + 空行 + 正文）——钉住 notice 拆分
  '⚠ 索引可能过期（受限角色不触发自动重建，请联系管理员跑 kb-rag add）。',
  '',
  '数电票开错不能作废，只能红冲 [1]。',
  '',
  '来源：',
  '[1] 公司智能体/项目文件/deepseek-harness/default-workspace/.dsh/skills/finance-ops/SKILL.md #参考节 C：三张备料清单（父块）',
  '[2] 公司智能体/项目状态/README.md #当前状态（分析卡命中→原文）',
  '[3] 公司智能体/项目状态/财务工作任务全图.md',
].join('\n')

const rl = createInterface({ input: process.stdin })
rl.on('close', () => process.exit(0))
rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: msg.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'fake-kb-rag', version: '0' },
    } })
    return
  }
  if (msg.method === 'notifications/initialized') return
  if (msg.method === 'ping') { send({ jsonrpc: '2.0', id: msg.id, result: {} }); return }
  if (msg.method === 'tools/list') { send({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } }); return }
  if (msg.method === 'tools/call') {
    if (flags().includes('crash')) process.exit(1)
    const name = msg.params.name
    const CLI_TEXT = '索引不存在：请先运行 uv run kb-rag index 建立索引（全量构建耗时较长，可断点续传）。'
    if (name === 'kb_vector_search') {
      // rawfmt：格式漂移（没有块头）→ 服务端应原文透传 raw；cli：索引未建时 kb-rag 以工具错误抛 CLI 文案
      if (flags().includes('rawfmt')) { send({ jsonrpc: '2.0', id: msg.id, result: text('随机文本没有块头\n第二行') }); return }
      if (flags().includes('cli')) { send({ jsonrpc: '2.0', id: msg.id, result: text(CLI_TEXT, { isError: true }) }); return }
      send({ jsonrpc: '2.0', id: msg.id, result: text(HITS) }); return
    }
    if (name === 'kb_ask') {
      // cli：索引未建时 kb_ask 不走 LLM，直接返回带 CLI 指令的说明（无 ⚠ 也无来源）；nonotice：索引新鲜时没有 ⚠ 行
      if (flags().includes('cli')) { send({ jsonrpc: '2.0', id: msg.id, result: text(CLI_TEXT) }); return }
      if (flags().includes('nonotice')) { send({ jsonrpc: '2.0', id: msg.id, result: text(ANSWER.split('\n').slice(2).join('\n')) }); return }
      send({ jsonrpc: '2.0', id: msg.id, result: text(ANSWER) }); return
    }
    if (name === 'kb_fail') { send({ jsonrpc: '2.0', id: msg.id, result: text(CLI_TEXT, { isError: true }) }); return }
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown tool ' + name } })
    return
  }
  if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown method ' + msg.method } })
})
`

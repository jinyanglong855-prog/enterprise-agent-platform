/**
 * 测试共享的"假 dsh"脚本（讲 0.2.1-rc.4 线协议），agent.test.ts（协议层）与
 * agent-sessions.test.ts（HTTP 全链路）共用。写入临时目录 chmod 后作为 ADMIN_DSH_BIN。
 *
 * 剧本开关走"旗标文件"而不是环境变量：子进程 env 在 spawn 时固化，HTTP 全链路里
 * AgentService 会复用活着的子进程，后设的 env 读不到；每次收到请求重读文件即可随时改剧本。
 * 旗标（空格分隔，写进 FAKE_FLAGS_FILE 指向的文件）：
 * - crash        第 2 次 prompt 回执后自杀（SIGKILL，崩溃自愈剧本）
 * - hang         prompt 回执后挂住不回 idle（供 stop 中断用例）
 * - batch        回执与轮次事件同一 tick 发完（真 runtime 实测行为回归）
 * - resume-fail  session/resume 一律拒绝（协议原文：missing or already owned sessions are rejected）
 * - turn-error   轮次以 turn/end kind=error 收场后 idle（无 assistant 消息；形状照抄 2026-10-29 真机 401 抓包）
 * 另两个 env 是输出落点：FAKE_ARGS_FILE（spawn argv 追加）、FAKE_RESUME_LOG（收到 resume 的 sessionId 追加）。
 */
export const FAKE_DSH = String.raw`#!/usr/bin/env node
import { createInterface } from 'node:readline'
import { appendFileSync, readFileSync } from 'node:fs'

const argsFile = process.env.FAKE_ARGS_FILE
appendFileSync(argsFile, process.argv.slice(2).join(' ') + '\n')

const flags = () => {
  try { return readFileSync(process.env.FAKE_FLAGS_FILE, 'utf8').trim().split(/\s+/) } catch { return [] }
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
let n = 0

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } } })
    return
  }
  if (msg.method === 'session/resume') {
    if (process.env.FAKE_RESUME_LOG) appendFileSync(process.env.FAKE_RESUME_LOG, msg.params.sessionId + '\n')
    if (flags().includes('resume-fail')) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'missing or already owned sessions are rejected' } })
    } else {
      send({ jsonrpc: '2.0', id: msg.id, result: {} })
    }
    return
  }
  if (msg.method === 'session/prompt') {
    n += 1
    const sessionId = msg.params.sessionId
    send({ jsonrpc: '2.0', id: msg.id, result: { messageId: 'm' + n } })
    const f = flags()
    if (f.includes('crash') && n >= 2) { process.kill(process.pid, 'SIGKILL'); return }
    if (f.includes('hang')) return
    const emit = () => {
      send({ jsonrpc: '2.0', method: 'session.status', params: { sessionId, status: 'running' } })
      if (f.includes('turn-error')) {
        send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: '401: {"code":"1000","message":"身份验证失败。"}', code: 'AUTH' } } } } } })
        send({ jsonrpc: '2.0', method: 'session.status', params: { sessionId, status: 'idle' } })
        return
      }
      send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'tool/call', data: { name: 'finance_summary', turn: 1, step: 1, callId: 'c1', arguments: '{}' } } } })
      send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type: 'assistant/message', data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: '第' + n + '轮回复：本月支出 380 元' }] } } } } })
      send({ jsonrpc: '2.0', method: 'session.status', params: { sessionId, status: 'idle' } })
    }
    if (f.includes('batch')) emit()
    else setTimeout(emit, 20)
    return
  }
  if (msg.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: msg.id, result: {} })
    setTimeout(() => process.exit(0), 30)
    return
  }
})
`

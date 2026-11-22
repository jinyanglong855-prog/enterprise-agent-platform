/**
 * 对话域按人隔离测试（2026-10-31 待办预警方案 P0-a，数据分割 §1.6）：
 * 对话是个人层资产——会话只属于创建人，其他账号（哪怕同持 agent:read/write）不可见、不可动，
 * 管理员也不例外；越权统一 404"不存在"，不泄露他人会话的存在性。
 * 覆盖：列表过滤、消息/改名/归档/删除/停止单项越权、跨账号 chat 拒绝且不落库、本人正面用例。
 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import bcrypt from 'bcryptjs'
import { NestFactory } from '@nestjs/core'
import type { INestApplication } from '@nestjs/common'

const FIXTURE = mkdtempSync(join(tmpdir(), 'agent-isolation-fixture-'))
const fakeBin = join(FIXTURE, 'fake-dsh.mjs')
writeFileSync(fakeBin, (await import('./fake-dsh-script.js')).FAKE_DSH)
chmodSync(fakeBin, 0o755)

process.env.ADMIN_DATA_DIR = mkdtempSync(join(tmpdir(), 'admin-isolation-test-'))
delete process.env.ADMIN_JWT_SECRET
process.env.ADMIN_DSH_BIN = fakeBin
process.env.ADMIN_AGENT_TURN_TIMEOUT_MS = '4000'

const { createRuntimeModule, registerAuthMiddleware } = await import('../src/app.module.js')
const { config } = await import('../src/config.js')

interface SseFrame {
  event: string
  data: Record<string, unknown>
}

async function readSse(res: globalThis.Response): Promise<SseFrame[]> {
  const text = await res.text()
  const frames: SseFrame[] = []
  for (const chunk of text.split('\n\n')) {
    const ev = chunk.split('\n').find((l) => l.startsWith('event: '))?.slice(7)
    const data = chunk.split('\n').find((l) => l.startsWith('data: '))?.slice(6)
    if (ev) frames.push({ event: ev, data: data ? (JSON.parse(data) as Record<string, unknown>) : {} })
  }
  return frames
}

describe('对话域按人隔离（数据分割 P0-a）', () => {
  let app: INestApplication
  let base: string
  let bossToken: string
  let operToken: string
  let bossSession = ''
  let db: ReturnType<typeof import('../src/db/database.js')['openDatabase']>
  let agentShutdown: () => Promise<void>

  async function login(username: string, password: string): Promise<string> {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    assert.equal(res.status, 201, `登录 ${username} 应成功`)
    const body = (await res.json()) as { token: string }
    return body.token
  }

  before(async () => {
    const { dynamicModule, services } = createRuntimeModule()
    db = services.db
    agentShutdown = () => services.agent.shutdown()
    app = await NestFactory.create(dynamicModule, { logger: false })
    registerAuthMiddleware(app, services.auth)
    await app.listen(0, '127.0.0.1')
    const address = app.getHttpServer().address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    base = `http://127.0.0.1:${port}`

    // operator：同持对话读写权限点（权限过关，只有归属不过关）
    const seed = db.transaction(() => {
      db.prepare('INSERT OR IGNORE INTO roles (name) VALUES (?)').run('agent-operator')
      const oper = db.prepare('SELECT id FROM roles WHERE name = ?').get('agent-operator') as { id: number }
      for (const code of ['agent:read', 'agent:write']) {
        const p = db.prepare('SELECT id FROM permissions WHERE code = ?').get(code) as { id: number }
        db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)').run(oper.id, p.id)
      }
      db.prepare(
        'INSERT INTO users (username, password_hash, display_name, is_service, created_at) VALUES (?, ?, ?, 0, ?)',
      ).run('operator', bcrypt.hashSync('test12345', 10), 'operator', new Date().toISOString())
      db.prepare(
        'INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES ((SELECT id FROM users WHERE username = ?), (SELECT id FROM roles WHERE name = ?))',
      ).run('operator', 'agent-operator')
    })
    seed()

    bossToken = await login('boss', config.bossInitialPassword)
    operToken = await login('operator', 'test12345')

    // 老板建会话并聊一轮（有消息可读，跨账号读消息才有东西可泄）
    const created = (await (
      await fetch(`${base}/api/agent/sessions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bossToken}` },
      })
    ).json()) as { session: { id: string } }
    bossSession = created.session.id
    const chatRes = await fetch(`${base}/api/agent/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bossToken}` },
      body: JSON.stringify({ sessionId: bossSession, message: '老板的私密对话' }),
    })
    assert.equal(chatRes.status, 200)
  })

  after(async () => {
    await agentShutdown()
    await app.close()
    rmSync(process.env.ADMIN_DATA_DIR!, { recursive: true, force: true })
    rmSync(FIXTURE, { recursive: true, force: true })
  })

  const hdr = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' })

  test('列表按人过滤：operator 看不到 boss 的会话', async () => {
    const list = (await (
      await fetch(`${base}/api/agent/sessions?includeArchived=1`, { headers: hdr(operToken) })
    ).json()) as { sessions: { id: string }[] }
    assert.ok(!list.sessions.some((s) => s.id === bossSession), '他人会话不得出现在列表里')
    const own = (await (
      await fetch(`${base}/api/agent/sessions?includeArchived=1`, { headers: hdr(bossToken) })
    ).json()) as { sessions: { id: string }[] }
    assert.ok(own.sessions.some((s) => s.id === bossSession), '本人应能看到自己的会话')
  })

  test('跨账号读消息 → 404"不存在"（不泄露存在性）', async () => {
    const res = await fetch(`${base}/api/agent/sessions/${bossSession}/messages`, { headers: hdr(operToken) })
    assert.equal(res.status, 404)
    const body = (await res.json()) as { message: string }
    assert.match(body.message, /不存在/)
    assert.ok(!body.message.includes('无权'), '报错不得提示"无权"（存在性泄露）')
  })

  test('跨账号改名/归档/删除/停止 → 全部 404，数据不动', async () => {
    const patch = await fetch(`${base}/api/agent/sessions/${bossSession}`, {
      method: 'PATCH',
      headers: hdr(operToken),
      body: JSON.stringify({ title: '改你的标题' }),
    })
    assert.equal(patch.status, 404)
    const arch = await fetch(`${base}/api/agent/sessions/${bossSession}`, {
      method: 'PATCH',
      headers: hdr(operToken),
      body: JSON.stringify({ archived: true }),
    })
    assert.equal(arch.status, 404)
    const stop = await fetch(`${base}/api/agent/sessions/${bossSession}/stop`, {
      method: 'POST',
      headers: hdr(operToken),
    })
    assert.equal(stop.status, 404)
    const del = await fetch(`${base}/api/agent/sessions/${bossSession}`, {
      method: 'DELETE',
      headers: hdr(operToken),
    })
    assert.equal(del.status, 404)
    const row = db.prepare('SELECT archived, title FROM agent_sessions WHERE id = ?').get(bossSession) as
      | { archived: number; title: string }
      | undefined
    assert.ok(row, '跨账号删除不得真删')
    assert.equal(row!.archived, 0)
    assert.equal(row!.title, '老板的私密对话')
  })

  test('跨账号 chat → SSE error 帧拒绝，且不往他人会话落任何消息', async () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM agent_messages WHERE session_id = ?').get(bossSession) as { n: number }
    const res = await fetch(`${base}/api/agent/chat`, {
      method: 'POST',
      headers: hdr(operToken),
      body: JSON.stringify({ sessionId: bossSession, message: '我是同事我要看' }),
    })
    assert.equal(res.status, 200, 'SSE 通道 HTTP 层仍 200，错误走 error 帧')
    const frames = await readSse(res)
    assert.ok(frames.some((f) => f.event === 'error' && /不存在/.test(String(f.data.message))))
    const after = db.prepare('SELECT COUNT(*) AS n FROM agent_messages WHERE session_id = ?').get(bossSession) as { n: number }
    assert.equal(after.n, before.n, '越权消息不得落库')
  })

  test('本人正面用例：boss 自己的会话消息/改名照常可用', async () => {
    const msgs = await fetch(`${base}/api/agent/sessions/${bossSession}/messages`, { headers: hdr(bossToken) })
    assert.equal(msgs.status, 200)
    const body = (await msgs.json()) as { messages: { content: string }[] }
    assert.ok(body.messages.some((m) => m.content === '老板的私密对话'))
    const patch = await fetch(`${base}/api/agent/sessions/${bossSession}`, {
      method: 'PATCH',
      headers: hdr(bossToken),
      body: JSON.stringify({ title: '我自己的会话' }),
    })
    assert.equal(patch.status, 200)
  })
})

/**
 * 对话域 HTTP 全链路测试（2026-10-27 框架定版）：真实 Nest 路由 + 假 dsh 子进程 + 临时库。
 * 覆盖：会话 CRUD 与级联删除、消息落库与历史回看、标题自动取首条消息、chat 独立权限点
 * （agent:read/agent:write）、审计行、子进程崩溃后换新进程先 resume 再续聊（rc.2 时代
 * 崩溃雷的修复回归）、生成中 stop 中断（interrupted 落库 + SSE final）。
 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import bcrypt from 'bcryptjs'
import { NestFactory } from '@nestjs/core'
import type { INestApplication } from '@nestjs/common'

const FIXTURE = mkdtempSync(join(tmpdir(), 'agent-sessions-fixture-'))
const fakeBin = join(FIXTURE, 'fake-dsh.mjs')
writeFileSync(fakeBin, (await import('./fake-dsh-script.js')).FAKE_DSH)
chmodSync(fakeBin, 0o755)

process.env.ADMIN_DATA_DIR = mkdtempSync(join(tmpdir(), 'admin-sessions-test-'))
delete process.env.ADMIN_JWT_SECRET
process.env.ADMIN_DSH_BIN = fakeBin
// 轮次超时调短（4s）：供"超时回收僵尸 runtime"用例，普通轮次 fake 20ms 完成不受影响
process.env.ADMIN_AGENT_TURN_TIMEOUT_MS = '4000'
process.env.FAKE_ARGS_FILE = join(FIXTURE, 'args.log')
process.env.FAKE_RESUME_LOG = join(FIXTURE, 'resume.log')
process.env.FAKE_FLAGS_FILE = join(FIXTURE, 'flags')
writeFileSync(process.env.FAKE_FLAGS_FILE, '')

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('对话域 HTTP 全链路（假 dsh）', () => {
  let app: INestApplication
  let base: string
  let bossToken: string
  let clerkToken: string // 只有 finance:read：不应能碰对话域
  let agentToken: string // agent:read + agent:write：对话全能，财务不能写
  let db: ReturnType<typeof import('../src/db/database.js')['openDatabase']>
  let agentShutdown: () => Promise<void>

  /** 登录拿 token。 */
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

  async function chat(token: string, sessionId: string | null, message: string): Promise<SseFrame[]> {
    const res = await fetch(`${base}/api/agent/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ sessionId: sessionId ?? undefined, message }),
    })
    assert.equal(res.status, 200)
    return readSse(res)
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

    // 辅助账号：clerk 只看财务；clerk2 只有对话权限（对话域独立权限点的正面用例）
    const seed = db.transaction(() => {
      db.prepare('INSERT OR IGNORE INTO roles (name) VALUES (?)').run('clerk')
      const clerk = db.prepare('SELECT id FROM roles WHERE name = ?').get('clerk') as { id: number }
      for (const code of ['finance:read']) {
        const p = db.prepare('SELECT id FROM permissions WHERE code = ?').get(code) as { id: number }
        db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)').run(clerk.id, p.id)
      }
      db.prepare('INSERT OR IGNORE INTO roles (name) VALUES (?)').run('agent-operator')
      const oper = db.prepare('SELECT id FROM roles WHERE name = ?').get('agent-operator') as { id: number }
      for (const code of ['agent:read', 'agent:write']) {
        const p = db.prepare('SELECT id FROM permissions WHERE code = ?').get(code) as { id: number }
        db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)').run(oper.id, p.id)
      }
      for (const [name, role] of [
        ['clerk', 'clerk'],
        ['operator', 'agent-operator'],
      ] as const) {
        db.prepare(
          'INSERT INTO users (username, password_hash, display_name, is_service, created_at) VALUES (?, ?, ?, 0, ?)',
        ).run(name, bcrypt.hashSync('test12345', 10), name, new Date().toISOString())
        db.prepare(
          'INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES ((SELECT id FROM users WHERE username = ?), (SELECT id FROM roles WHERE name = ?))',
        ).run(name, role)
      }
    })
    seed()

    bossToken = await login('boss', config.bossInitialPassword)
    clerkToken = await login('clerk', 'test12345')
    agentToken = await login('operator', 'test12345')
  })

  after(async () => {
    // 泄漏的 fake-dsh 子进程会让事件循环不空、测试进程挂住不退：显式关停网关 runtime
    await agentShutdown()
    await app.close()
    rmSync(process.env.ADMIN_DATA_DIR!, { recursive: true, force: true })
    rmSync(FIXTURE, { recursive: true, force: true })
  })

  let s1 = '' // 主流程会话（operator 用）

  test('未登录读会话列表 → 401', async () => {
    const res = await fetch(`${base}/api/agent/sessions`)
    assert.equal(res.status, 401)
  })

  test('只有 finance:read 的用户：对话域读写全被拒（权限点独立）', async () => {
    const list = await fetch(`${base}/api/agent/sessions`, {
      headers: { authorization: `Bearer ${clerkToken}` },
    })
    assert.equal(list.status, 403)
    const chatRes = await fetch(`${base}/api/agent/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${clerkToken}` },
      body: JSON.stringify({ message: '你好' }),
    })
    assert.equal(chatRes.status, 403)
  })

  test('建会话 → 列表可见，标题初始"新会话"', async () => {
    const res = await fetch(`${base}/api/agent/sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${agentToken}` },
    })
    assert.equal(res.status, 201)
    const body = (await res.json()) as { session: { id: string; title: string; dsh_session_id: string } }
    s1 = body.session.id
    assert.ok(s1.length > 10)
    assert.equal(body.session.title, '新会话')
    assert.ok(body.session.dsh_session_id.length > 10, '应有独立 DSH 会话 id')

    const list = (await (
      await fetch(`${base}/api/agent/sessions`, { headers: { authorization: `Bearer ${agentToken}` } })
    ).json()) as { sessions: { id: string }[] }
    assert.ok(list.sessions.some((s) => s.id === s1))
  })

  test('两轮对话：SSE final、消息落库、标题=首条消息前 24 字、工具名入库', async () => {
    const frames = await chat(agentToken, s1, '帮我看看这个月的支出情况')
    const final = frames.find((f) => f.event === 'final')
    assert.ok(final, '应有 final 帧')
    assert.equal(final!.data.sessionId, s1)
    assert.match(String(final!.data.text), /第1轮回复/)
    assert.ok(frames.some((f) => f.event === 'tool' && f.data.name === 'finance_summary'))

    await chat(agentToken, s1, '那收入呢')
    const msgs = (await (
      await fetch(`${base}/api/agent/sessions/${s1}/messages`, {
        headers: { authorization: `Bearer ${agentToken}` },
      })
    ).json()) as { messages: { role: string; content: string; status: string; tools: string }[] }
    assert.equal(msgs.messages.length, 4)
    assert.equal(msgs.messages[0]?.role, 'user')
    assert.equal(msgs.messages[0]?.content, '帮我看看这个月的支出情况')
    assert.equal(msgs.messages[1]?.role, 'assistant')
    assert.equal(msgs.messages[1]?.status, 'ok')
    assert.deepEqual(JSON.parse(msgs.messages[1]?.tools ?? '[]'), ['finance_summary'])

    const sess = (await (
      await fetch(`${base}/api/agent/sessions?includeArchived=1`, {
        headers: { authorization: `Bearer ${agentToken}` },
      })
    ).json()) as { sessions: { id: string; title: string }[] }
    assert.equal(sess.sessions.find((s) => s.id === s1)?.title, '帮我看看这个月的支出情况')
  })

  test('子进程崩溃：本轮 error 落库；下一轮换新进程先 resume 原会话再续聊（rc.2 崩溃雷修复回归）', async () => {
    writeFileSync(process.env.FAKE_FLAGS_FILE!, 'crash')
    const frames = await chat(agentToken, s1, '这一轮会让子进程崩掉')
    assert.ok(frames.some((f) => f.event === 'error'), '崩溃轮应流出 error 帧')
    let msgs = (await (
      await fetch(`${base}/api/agent/sessions/${s1}/messages`, {
        headers: { authorization: `Bearer ${agentToken}` },
      })
    ).json()) as { messages: { status: string }[] }
    assert.equal(msgs.messages.at(-1)?.status, 'error', '崩溃轮 assistant 应按 error 落库')

    // 新进程起手：resume log 此前必须为空（新会话直接 prompt，不 resume——文件还不存在=从未 resume）
    assert.equal(existsSync(process.env.FAKE_RESUME_LOG!), false, '崩溃前不应有任何 resume')
    writeFileSync(process.env.FAKE_FLAGS_FILE!, '')
    const ok = await chat(agentToken, s1, '崩溃后再问一句')
    const final = ok.find((f) => f.event === 'final')
    assert.ok(final && /第1轮回复/.test(String(final.data.text)), '新进程轮次应正常完成')
    const resumed = readFileSync(process.env.FAKE_RESUME_LOG!, 'utf8')
    const dshId = (
      db.prepare('SELECT dsh_session_id AS d FROM agent_sessions WHERE id = ?').get(s1) as { d: string }
    ).d
    assert.equal(resumed, `${dshId}\n`, '换新进程后续聊必须先对该会话发 session/resume')
    msgs = (await (
      await fetch(`${base}/api/agent/sessions/${s1}/messages`, {
        headers: { authorization: `Bearer ${agentToken}` },
      })
    ).json()) as { messages: { status: string }[] }
    assert.equal(msgs.messages.at(-1)?.status, 'ok')
  })

  test('生成中 stop：轮次立止、SSE final 带 interrupted、半截回答按 interrupted 落库', async () => {
    const created = (await (
      await fetch(`${base}/api/agent/sessions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${agentToken}` },
      })
    ).json()) as { session: { id: string } }
    const s2 = created.session.id

    writeFileSync(process.env.FAKE_FLAGS_FILE!, 'hang')
    const streamPromise = fetch(`${base}/api/agent/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ sessionId: s2, message: '慢慢回答别急' }),
    })
    await sleep(600) // 等 prompt 发出并挂住
    const stopRes = await fetch(`${base}/api/agent/sessions/${s2}/stop`, {
      method: 'POST',
      headers: { authorization: `Bearer ${agentToken}` },
    })
    assert.equal(stopRes.status, 201)
    assert.deepEqual((await stopRes.json()) as unknown, { stopped: true })

    const frames = await readSse(await streamPromise)
    const final = frames.find((f) => f.event === 'final')
    assert.ok(final, '被停的轮次也应有 final 帧')
    assert.equal(final!.data.interrupted, true)

    const msgs = (await (
      await fetch(`${base}/api/agent/sessions/${s2}/messages`, {
        headers: { authorization: `Bearer ${agentToken}` },
      })
    ).json()) as { messages: { role: string; status: string; content: string }[] }
    assert.equal(msgs.messages.length, 2)
    assert.equal(msgs.messages[1]?.status, 'interrupted')
    assert.match(msgs.messages[1]?.content ?? '', /已停止/)

    // 轮次已结束：再 stop 是无可停止
    const stop2 = await fetch(`${base}/api/agent/sessions/${s2}/stop`, {
      method: 'POST',
      headers: { authorization: `Bearer ${agentToken}` },
    })
    assert.deepEqual((await stop2.json()) as unknown, { stopped: false })
    writeFileSync(process.env.FAKE_FLAGS_FILE!, '')
  })

  test('不带 sessionId 的 chat 自动开新会话（final 带回会话 id）', async () => {
    const frames = await chat(agentToken, null, '自动开一个新会话')
    const final = frames.find((f) => f.event === 'final')!
    const autoId = String(final.data.sessionId)
    assert.notEqual(autoId, s1)
    const list = (await (
      await fetch(`${base}/api/agent/sessions`, { headers: { authorization: `Bearer ${agentToken}` } })
    ).json()) as { sessions: { id: string }[] }
    assert.ok(list.sessions.some((s) => s.id === autoId))
  })

  test('超时回收僵尸 runtime：超时轮 error 落库、互斥与生成中守卫生效、下一轮换新进程 resume 续聊', async () => {
    const created = (await (
      await fetch(`${base}/api/agent/sessions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${agentToken}` },
      })
    ).json()) as { session: { id: string } }
    const s3 = created.session.id

    writeFileSync(process.env.FAKE_FLAGS_FILE!, 'hang')
    const streamPromise = fetch(`${base}/api/agent/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ sessionId: s3, message: '这轮会超时' }),
    })
    await sleep(600)

    // 互斥：同会话第二轮被拒（SSE error 帧，不落库）
    const busy = await chat(agentToken, s3, '撞互斥的一句')
    assert.ok(
      busy.some((f) => f.event === 'error' && /处理中/.test(String(f.data.message))),
      '进行中再发消息应被互斥拒绝',
    )

    // 生成中守卫：删除/归档当前会话 400（后端拒绝，不管前端有没有拦）
    const delRes = await fetch(`${base}/api/agent/sessions/${s3}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${agentToken}` },
    })
    assert.equal(delRes.status, 400, '生成中删除当前会话应 400')
    const archRes = await fetch(`${base}/api/agent/sessions/${s3}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ archived: true }),
    })
    assert.equal(archRes.status, 400, '生成中归档当前会话应 400')

    // 4s 轮次超时：SSE error 帧 + error 落库
    const frames = await readSse(await streamPromise)
    assert.ok(frames.some((f) => f.event === 'error' && /超时/.test(String(f.data.message))))
    const msgs = (await (
      await fetch(`${base}/api/agent/sessions/${s3}/messages`, {
        headers: { authorization: `Bearer ${agentToken}` },
      })
    ).json()) as { messages: { status: string; content: string }[] }
    assert.equal(msgs.messages.length, 2, '互斥那条不该落库')
    assert.match(msgs.messages[1]?.content ?? '', /超时/)

    // 超时后 runtime 已被回收：下一轮换新进程并 resume 原会话（already-owned 死结的出路）
    writeFileSync(process.env.FAKE_FLAGS_FILE!, '')
    const resumeBefore = readFileSync(process.env.FAKE_RESUME_LOG!, 'utf8').split('\n').filter(Boolean).length
    const ok = await chat(agentToken, s3, '超时后再问一句')
    assert.ok(ok.some((f) => f.event === 'final'))
    const resumeAfter = readFileSync(process.env.FAKE_RESUME_LOG!, 'utf8').split('\n').filter(Boolean).length
    assert.equal(resumeAfter, resumeBefore + 1, '超时回收后下一轮应 resume 原会话')
  })

  test('resume 被拒降级：fresh-context 状态帧 + 按新上下文正常完成', async () => {
    const created = (await (
      await fetch(`${base}/api/agent/sessions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${agentToken}` },
      })
    ).json()) as { session: { id: string } }
    const s4 = created.session.id
    // 先正常聊一轮（建立历史与 runtime 持有）
    const first = await chat(agentToken, s4, '先正常聊一句')
    assert.ok(first.some((f) => f.event === 'final'))

    // 杀掉 runtime 逼出 resume 路径，同时让 resume 必拒
    writeFileSync(process.env.FAKE_FLAGS_FILE!, 'hang')
    const streamPromise = fetch(`${base}/api/agent/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ sessionId: s4, message: '这轮用来超时换进程' }),
    })
    await sleep(6500) // 等 4s 轮次超时把 runtime 回收
    await readSse(await streamPromise)
    writeFileSync(process.env.FAKE_FLAGS_FILE!, 'resume-fail')
    const frames = await chat(agentToken, s4, 'resume 被拒也要能聊')
    assert.ok(
      frames.some((f) => f.event === 'status' && f.data.phase === 'fresh-context'),
      'resume 被拒应发 fresh-context 状态帧',
    )
    assert.ok(frames.some((f) => f.event === 'final'), '降级后轮次应正常完成')
    writeFileSync(process.env.FAKE_FLAGS_FILE!, '')
  })

  test('空消息与超长消息 → HTTP 400（校验在 SSE 头之前）', async () => {
    const empty = await fetch(`${base}/api/agent/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ message: '   ' }),
    })
    assert.equal(empty.status, 400)
    const long = await fetch(`${base}/api/agent/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ message: 'a'.repeat(4001) }),
    })
    assert.equal(long.status, 400)
  })

  test('重命名 / 归档拦截 / 取消归档 / 删除级联', async () => {
    const patch = await fetch(`${base}/api/agent/sessions/${s1}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ title: '支出分析' }),
    })
    assert.equal(patch.status, 200)
    const patched = (await patch.json()) as { session: { title: string } }
    assert.equal(patched.session.title, '支出分析')

    const arch = await fetch(`${base}/api/agent/sessions/${s1}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ archived: true }),
    })
    assert.equal(arch.status, 200)
    const blocked = await chat(agentToken, s1, '归档了还能聊吗')
    assert.ok(blocked.some((f) => f.event === 'error' && /归档/.test(String(f.data.message))))

    await fetch(`${base}/api/agent/sessions/${s1}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ archived: false }),
    })
    const ok = await chat(agentToken, s1, '取消归档后继续')
    assert.ok(ok.some((f) => f.event === 'final'))

    const del = await fetch(`${base}/api/agent/sessions/${s1}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${agentToken}` },
    })
    assert.equal(del.status, 200)
    const msgs = await fetch(`${base}/api/agent/sessions/${s1}/messages`, {
      headers: { authorization: `Bearer ${agentToken}` },
    })
    assert.equal(msgs.status, 404)
    const rowMsg = db.prepare('SELECT COUNT(*) AS n FROM agent_messages WHERE session_id = ?').get(s1) as { n: number }
    const rowSess = db.prepare('SELECT COUNT(*) AS n FROM agent_sessions WHERE id = ?').get(s1) as { n: number }
    assert.equal(rowMsg.n, 0, '级联删除应清掉消息')
    assert.equal(rowSess.n, 0)
  })

  test('会话动作与对话都进审计（不含消息正文）；系统审计端点可筛选', async () => {
    const rows = db
      .prepare(
        "SELECT DISTINCT action FROM audit_log WHERE action LIKE 'agent.%' ORDER BY action",
      )
      .all() as { action: string }[]
    const actions = new Set(rows.map((r) => r.action))
    for (const a of ['agent.session.create', 'agent.session.rename', 'agent.session.archive', 'agent.session.delete', 'agent.chat', 'agent.session.stop']) {
      assert.ok(actions.has(a), `审计缺 ${a}`)
    }
    // 消息正文不进审计：detail 里不出现任何对话内容
    const details = db.prepare("SELECT detail FROM audit_log WHERE action = 'agent.chat'").all() as { detail: string }[]
    for (const d of details) assert.ok(!d.detail.includes('支出情况'), '审计不得记消息正文')

    const res = await fetch(`${base}/api/audit?action=agent.chat&username=operator&limit=50`, {
      headers: { authorization: `Bearer ${bossToken}` },
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { items: { action: string; username: string }[] }
    assert.ok(body.items.length >= 1)
    for (const item of body.items) {
      assert.equal(item.action, 'agent.chat')
      assert.equal(item.username, 'operator')
    }
    const denied = await fetch(`${base}/api/audit`, {
      headers: { authorization: `Bearer ${agentToken}` },
    })
    assert.equal(denied.status, 403, '审计端点要 admin:manage')
  })
})

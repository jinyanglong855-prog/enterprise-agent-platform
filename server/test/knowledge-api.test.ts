/** 知识库域（2026-11-02 阶段 3）HTTP 全链路 + 解析器单测：
 *  未接入 503 人话提示 / 权限门（401/403/仅老板缺省持有）/ kb_vector_search 解析+按文档折叠 /
 *  kb_ask 正文与来源分离（父块/分析卡尾注剥掉）/ KB_CALLER 传进子进程 / 崩溃 503 后自动重拉 /
 *  空闲自停后再拉 / 审计留痕。客户端走真·官方 MCP SDK，子进程是 test/fake-kb-mcp-script.ts 的协议假件。 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import bcrypt from 'bcryptjs'

const FIXTURE = mkdtempSync(join(tmpdir(), 'knowledge-fixture-'))
const fakeBin = join(FIXTURE, 'fake-kb-mcp.mjs')
writeFileSync(fakeBin, (await import('./fake-kb-mcp-script.js')).FAKE_KB_MCP)
chmodSync(fakeBin, 0o755)

process.env.ADMIN_DATA_DIR = mkdtempSync(join(tmpdir(), 'admin-knowledge-test-'))
delete process.env.ADMIN_JWT_SECRET
process.env.ADMIN_KB_MCP_COMMAND = process.execPath
process.env.ADMIN_KB_MCP_ARGS = fakeBin
process.env.ADMIN_KB_IDLE_MS = '400'

const appModule = await import('../src/app.module.js')
const { buildServices, createRuntimeModule, registerAuthMiddleware } = appModule
const { config } = await import('../src/config.js')
const { KnowledgeService, parseHits, parseAnswer, collapseByPath } = await import('../src/knowledge/knowledge.service.js')

const SPAWN_LOG = join(FIXTURE, 'spawns.log')
const FLAGS = join(FIXTURE, 'flags')

describe('知识库解析器（kb-rag 文本格式 → 结构化）', () => {
  test('parseHits：块头切分、score、正文归组', () => {
    const hits = parseHits(
      [
        '[a/b.md #标题一]（score=0.91）',
        '正文一',
        '第二行',
        '',
        '[a/b.md #标题二]（score=0.5）',
        '正文二',
      ].join('\n'),
    )
    assert.equal(hits.length, 2)
    assert.deepEqual(hits[0], { path: 'a/b.md', heading: '标题一', score: 0.91, text: '正文一\n第二行' })
    assert.equal(hits[1]!.text, '正文二')
  })

  test('parseHits：空结果与不可解析原文', () => {
    assert.deepEqual(parseHits('无结果'), [])
    assert.deepEqual(parseHits(''), [])
    // 完全不认识的格式 → 零块（调用方用 raw 兜底透传）
    assert.deepEqual(parseHits('随机文本没有块头'), [])
  })

  test('parseAnswer：正文与来源脚注分离，尾注剥掉、无脚注兜底', () => {
    const { answer, sources } = parseAnswer(
      [
        '结论一段',
        '',
        '来源：',
        '[1] 公司智能体/a.md #某标题（父块）',
        '[2] Shared/b.md #分析卡（AI 生成）（分析卡命中→原文）',
        '[3] Shared/c.md',
      ].join('\n'),
    )
    assert.equal(answer, '结论一段')
    assert.deepEqual(sources, [
      { index: 1, label: '公司智能体/a.md #某标题（父块）', path: '公司智能体/a.md', heading: '某标题' },
      { index: 2, label: 'Shared/b.md #分析卡（AI 生成）（分析卡命中→原文）', path: 'Shared/b.md', heading: '分析卡（AI 生成）' },
      { index: 3, label: 'Shared/c.md', path: 'Shared/c.md', heading: '' },
    ])
    const bare = parseAnswer('只有一句话')
    assert.equal(bare.answer, '只有一句话')
    assert.deepEqual(bare.sources, [])
    // kb-rag 侧索引状态提示（⚠ 行 + 空行）拆成 notice，不混进正文——管理台界面按人话转述
    const warned = parseAnswer(
      [
        '⚠ 索引可能过期（受限角色不触发自动重建，请联系管理员跑 kb-rag add）。',
        '',
        '结论一段',
        '',
        '来源：',
        '[1] 公司智能体/a.md #某标题',
      ].join('\n'),
    )
    assert.equal(warned.notice, '⚠ 索引可能过期（受限角色不触发自动重建，请联系管理员跑 kb-rag add）。')
    assert.equal(warned.answer, '结论一段')
    assert.equal(warned.sources.length, 1)
    // 尾注只剥 kb-rag 真会加的三种；标题自带括号不动（审查 P3-2）
    const tails = parseAnswer('x\n\n来源：\n[1] Shared/d.md #标题（v2）\n[2] 公司智能体/项目状态/README.md（别名“公司台”→公司智能体·状态页）')
    assert.equal(tails.sources[0]!.heading, '标题（v2）')
    assert.equal(tails.sources[1]!.path, '公司智能体/项目状态/README.md')
    assert.equal(tails.sources[1]!.heading, '')
  })

  test('collapseByPath：每篇文档只留首块（最相关）', () => {
    const hits = [
      { path: 'a', heading: '1', score: 3, text: '' },
      { path: 'a', heading: '2', score: 2, text: '' },
      { path: 'b', heading: '3', score: 1, text: '' },
    ]
    const out = collapseByPath(hits, 2)
    assert.deepEqual(out.map((h) => h.heading), ['1', '3'])
  })
})

describe('知识库 REST（假 MCP 子进程全链路）', () => {
  let app: import('@nestjs/common').INestApplication
  let base: string
  let bossToken: string
  let noPermToken: string

  const send = (method: string, path: string, body?: unknown, token = bossToken) =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

  const spawnCount = (): number => {
    try {
      return readFileSync(SPAWN_LOG, 'utf8').trim().split('\n').filter(Boolean).length
    } catch {
      return 0 // 假件还没被拉起过
    }
  }

  before(async () => {
    const services = buildServices()
    const { dynamicModule } = createRuntimeModule(services)
    const { NestFactory } = await import('@nestjs/core')
    app = await NestFactory.create(dynamicModule, { logger: false })
    registerAuthMiddleware(app, services.auth)
    await app.listen(0, '127.0.0.1')
    const address = app.getHttpServer().address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    base = `http://127.0.0.1:${port}`

    const db = services.db
    db.prepare('INSERT OR IGNORE INTO roles (name) VALUES (?)').run('knoperm-role')
    const role = db.prepare('SELECT id FROM roles WHERE name = ?').get('knoperm-role') as { id: number }
    db.prepare('INSERT INTO users (username, password_hash, display_name, is_service, created_at) VALUES (?, ?, ?, 0, ?)').run(
      'kuser',
      bcrypt.hashSync('test12345', 10),
      'kuser',
      new Date().toISOString(),
    )
    db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES ((SELECT id FROM users WHERE username = ?), ?)').run('kuser', role.id)

    const login = async (username: string, password: string): Promise<string> => {
      const res = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      assert.equal(res.status, 201, `登录 ${username} 应成功`)
      return ((await res.json()) as { token: string }).token
    }
    bossToken = await login('boss', config.bossInitialPassword)
    noPermToken = await login('kuser', 'test12345')
  })

  after(async () => {
    await app.close()
    rmSync(process.env.ADMIN_DATA_DIR!, { recursive: true, force: true })
    rmSync(FIXTURE, { recursive: true, force: true })
  })

  test('boss 缺省持有 knowledge:read；无权限用户 403；未登录 401', async () => {
    assert.equal((await send('GET', '/api/knowledge/status')).status, 200)
    const res = await send('GET', '/api/knowledge/status', undefined, noPermToken)
    assert.equal(res.status, 403)
    assert.equal((await send('GET', '/api/knowledge/status', undefined, '')).status, 401)
  })

  test('status：懒启动（未调用时子进程不在跑）', async () => {
    const body = (await (await send('GET', '/api/knowledge/status')).json()) as { configured: boolean; running: boolean; caller: string }
    assert.equal(body.configured, true)
    assert.equal(body.running, false, '首次调用前 MCP 子进程不应被拉起')
    assert.equal(body.caller, 'company-console')
  })

  test('search：解析+按文档折叠；KB_CALLER 传进子进程；审计留痕', async () => {
    const res = await send('GET', '/api/knowledge/search?q=数电票红冲')
    assert.equal(res.status, 200)
    const body = (await res.json()) as { hits: { path: string; heading: string; score: number; text: string }[]; raw?: string }
    assert.equal(body.hits.length, 2, '三块里两块同篇 → 折叠成两篇')
    assert.ok(body.hits[0]!.path.includes('.dsh/skills/finance-ops'), '手册排第一')
    assert.ok(body.hits[0]!.heading.includes('caller=company-console'), '缺省调用者身份 company-console 到达子进程')
    assert.equal(body.hits[0]!.text, '数电票没有"作废"，开错只能红冲。\n第二段')
    assert.equal(body.raw, undefined)
    const rows = (await (await send('GET', '/api/audit?limit=50')).json()) as { items: { action: string; username: string }[] }
    assert.ok(rows.items.some((r) => r.action === 'knowledge.search' && r.username === 'boss'))
    const status = (await (await send('GET', '/api/knowledge/status')).json()) as { running: boolean }
    assert.equal(status.running, true, '调用后子进程应在线')
  })

  test('ask：正文/来源分离、notice 拆出、尾注剥掉；审计留痕', async () => {
    const res = await send('POST', '/api/knowledge/ask', { question: '数电票开错怎么办' })
    assert.equal(res.status, 201, 'Nest @Post 缺省 201')
    const body = (await res.json()) as { answer: string; notice: string; sources: { index: number; path: string; heading: string }[] }
    assert.equal(body.answer, '数电票开错不能作废，只能红冲 [1]。')
    assert.ok(body.notice.startsWith('⚠'), 'kb-rag 的 ⚠ 索引提示应拆进 notice 字段而非混进正文')
    assert.ok(!body.answer.includes('kb-rag add'), 'CLI 指令不得出现在回答正文')
    assert.equal(body.sources.length, 3)
    assert.equal(body.sources[0]!.heading, '参考节 C：三张备料清单', '「（父块）」尾注剥掉')
    assert.equal(body.sources[1]!.heading, '当前状态', '「（分析卡命中→原文）」尾注剥掉')
    assert.equal(body.sources[2]!.heading, '')
    const rows = (await (await send('GET', '/api/audit?limit=50')).json()) as { items: { action: string }[] }
    assert.ok(rows.items.some((r) => r.action === 'knowledge.ask'))
  })

  test('ask 无 notice 分支：索引新鲜时 notice 为空、正文完整', async () => {
    writeFileSync(FLAGS, 'nonotice')
    try {
      const res = await send('POST', '/api/knowledge/ask', { question: '数电票开错怎么办' })
      assert.equal(res.status, 201)
      const body = (await res.json()) as { answer: string; notice: string; sources: unknown[] }
      assert.equal(body.notice, '')
      assert.equal(body.answer, '数电票开错不能作废，只能红冲 [1]。')
      assert.equal(body.sources.length, 3)
    } finally {
      writeFileSync(FLAGS, '')
    }
  })

  test('索引未建/错位：kb-rag 的 CLI 说明文本转 503 人话，不把运维指令透给界面', async () => {
    writeFileSync(FLAGS, 'cli')
    try {
      const askRes = await send('POST', '/api/knowledge/ask', { question: '问点东西' })
      assert.equal(askRes.status, 503)
      const askBody = (await askRes.json()) as { message: string }
      assert.ok(askBody.message.includes('索引未就绪'), `人话提示，实际：${askBody.message}`)
      assert.ok(!askBody.message.includes('uv run'), 'CLI 指令不得出现在接口文案里')
      const searchRes = await send('GET', '/api/knowledge/search?q=什么')
      assert.equal(searchRes.status, 503)
      const searchBody = (await searchRes.json()) as { message: string }
      assert.ok(searchBody.message.includes('索引未就绪'))
    } finally {
      writeFileSync(FLAGS, '')
    }
    assert.equal((await send('GET', '/api/knowledge/search?q=恢复')).status, 200)
  })

  test('搜索格式漂移：解析不出块头时原文透传 raw，不 500', async () => {
    writeFileSync(FLAGS, 'rawfmt')
    try {
      const res = await send('GET', '/api/knowledge/search?q=格式漂移')
      assert.equal(res.status, 200)
      const body = (await res.json()) as { hits: unknown[]; raw?: string }
      assert.equal(body.hits.length, 0)
      assert.ok(body.raw?.includes('随机文本没有块头'), '原文应放进 raw 字段')
    } finally {
      writeFileSync(FLAGS, '')
    }
  })

  test('参数校验：空问题 400、条数越界 400、`?k=` 空串回退缺省', async () => {
    assert.equal((await send('GET', '/api/knowledge/search?q=')).status, 400)
    assert.equal((await send('POST', '/api/knowledge/ask', { question: 'x', k: 99 })).status, 400)
    assert.equal((await send('POST', '/api/knowledge/ask', { question: '' })).status, 400)
    assert.equal((await send('GET', '/api/knowledge/search?q=x&k=')).status, 200, '`?k=` 按没传处理')
  })

  test('崩溃后 503（人话提示），下一次调用自动重拉', async () => {
    assert.equal((await send('GET', '/api/knowledge/search?q=正常')).status, 200)
    const before = spawnCount()
    writeFileSync(FLAGS, 'crash')
    const res = await send('GET', '/api/knowledge/search?q=会崩')
    assert.equal(res.status, 503)
    const body = (await res.json()) as { message: string }
    assert.ok(body.message.includes('知识库暂时不可用'), `人话提示，实际：${body.message}`)
    writeFileSync(FLAGS, '')
    assert.equal((await send('GET', '/api/knowledge/search?q=恢复')).status, 200)
    // 旗标按请求重读：崩的是正在服务的进程（不新拉），只有恢复那次新拉一个
    assert.equal(spawnCount(), before + 1)
  })

  test('空闲自停，之后自动重拉', async () => {
    await send('GET', '/api/knowledge/search?q=再问一次')
    const before = spawnCount()
    await new Promise((r) => setTimeout(r, 700)) // > ADMIN_KB_IDLE_MS=400
    const status = (await (await send('GET', '/api/knowledge/status')).json()) as { running: boolean }
    assert.equal(status.running, false, '空闲超时后子进程应收掉')
    assert.equal((await send('GET', '/api/knowledge/search?q=停后再问')).status, 200)
    assert.equal(spawnCount(), before + 1)
  })

  test('未配置知识库的服务：configured=false、调用 503 人话提示（服务直连，不经过 HTTP）', async () => {
    const { AuditService } = await import('../src/audit/audit.service.js')
    const audit = new AuditService((await import('../src/db/database.js')).openDatabase(':memory:'))
    const bare = new KnowledgeService(audit, undefined, 'company-console')
    assert.deepEqual(bare.status(), { configured: false, running: false, caller: 'company-console' })
    await assert.rejects(
      () => bare.search('任何问题', undefined, { username: 'boss', source: 'ui' }),
      /ADMIN_KB_RAG_DIR/,
    )
  })
})

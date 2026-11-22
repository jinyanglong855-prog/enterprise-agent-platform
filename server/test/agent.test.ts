/**
 * DSH 协议客户端单测：起一个"假 dsh"子进程（Node 脚本按 0.2.1-rc.4 线协议应答），
 * 验证握手、轮次收集、事件透传、进程复用、会话 resume 与持有表、崩溃报错与关闭阶梯——不碰真模型。
 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ADMIN_DATA_DIR = mkdtempSync(join(tmpdir(), 'admin-agent-test-'))

const { DshRuntime, RuntimeDiedError, TurnFailedError } = await import('../src/agent/dsh-runtime.js')
const { FAKE_DSH } = await import('./fake-dsh-script.js')

describe('DshRuntime 协议客户端', () => {
  let dir: string
  let fakeBin: string
  let patchA: string
  let patchB: string
  let flagsFile: string

  /** 改剧本：crash / hang / batch / resume-fail（旗标文件驱动，活着的子进程下次请求即读到）。 */
  function setFlags(...names: string[]): void {
    writeFileSync(flagsFile, names.join(' '))
  }

  function makeRuntime(extraEnv: Record<string, string> = {}): InstanceType<typeof DshRuntime> {
    return new DshRuntime({
      dshBin: fakeBin,
      patches: [patchA, patchB],
      cwd: dir,
      provider: 'zai-coding-cn',
      model: 'glm-5.3',
      env: {
        ...process.env,
        ...extraEnv,
        FAKE_ARGS_FILE: join(dir, 'args.log'),
        FAKE_FLAGS_FILE: flagsFile,
      },
      logFile: join(dir, 'runtime.log'),
    })
  }

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-runtime-test-'))
    fakeBin = join(dir, 'fake-dsh.mjs')
    writeFileSync(fakeBin, FAKE_DSH)
    chmodSync(fakeBin, 0o755)
    writeFileSync(join(dir, 'args.log'), '')
    flagsFile = join(dir, 'flags')
    setFlags()
    patchA = join(dir, 'glm-route.patch.yml')
    patchB = join(dir, 'finance-desk-rest.patch.yml')
    writeFileSync(patchA, '# test\n')
    writeFileSync(patchB, '# test\n')
  })

  after(async () => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(process.env.ADMIN_DATA_DIR!, { recursive: true, force: true })
  })

  test('握手 + 单轮：返回 finalText、透传 assistant 事件、argv 带 profile 与补丁', async () => {
    const rt = makeRuntime()
    try {
      const events: Array<{ kind: string; text?: string; name?: string }> = []
      const r = await rt.run('sess-1', '查本月汇总', (e) => events.push(e as never))
      assert.equal(r.finalText, '第1轮回复：本月支出 380 元')
      assert.ok(events.some((e) => e.kind === 'assistant' && e.text === '第1轮回复：本月支出 380 元'))
      assert.ok(events.some((e) => e.kind === 'tool' && e.name === 'finance_summary'))
      const argv = (await import('node:fs')).readFileSync(join(dir, 'args.log'), 'utf8')
      assert.ok(argv.includes('--profile sdk'), 'spawn 参数应含 --profile sdk')
      assert.ok(argv.includes('--patch') && argv.includes(patchA) && argv.includes(patchB), 'spawn 参数应含两个补丁')
    } finally {
      await rt.close()
    }
  })

  test('多轮复用同一子进程、按 sessionId 续会话', async () => {
    const rt = makeRuntime()
    try {
      const r1 = await rt.run('sess-9', '第一问', () => {})
      const r2 = await rt.run('sess-9', '第二问', () => {})
      assert.equal(r2.finalText, '第2轮回复：本月支出 380 元')
      assert.ok(r1.sessionId === r2.sessionId)
    } finally {
      await rt.close()
    }
  })

  test('回执与轮次事件同一批次到达也能完成轮次（真 runtime 实测行为回归）', async () => {
    const rt = makeRuntime()
    setFlags('batch')
    try {
      const events: Array<{ kind: string; text?: string; name?: string }> = []
      // 轮次超时给 5s：若回归（同批事件被丢、等不到 idle），测试 5 秒即失败而非挂 3 分钟
      const r = await rt.run('sess-batch', '同批剧本', (e) => events.push(e as never), 5000)
      assert.equal(r.finalText, '第1轮回复：本月支出 380 元')
      assert.ok(events.some((e) => e.kind === 'assistant' && e.text === '第1轮回复：本月支出 380 元'))
      assert.ok(events.some((e) => e.kind === 'tool' && e.name === 'finance_summary'))
    } finally {
      await rt.close()
    }
  })

  test('turn/end 报错要大声失败：拒绝轮次并带可读原因，runtime 保持健康可复用（401 空回复回归）', async () => {
    const rt = makeRuntime()
    try {
      setFlags('turn-error')
      await assert.rejects(
        () => rt.run('sess-auth', '会失败的一问', () => {}),
        (e: Error) => {
          assert.ok(e instanceof TurnFailedError, `应是 TurnFailedError，实际 ${e.name}`)
          assert.ok(/模型调用失败（AUTH）/.test(e.message), `消息应含错误码与原因，实际：${e.message}`)
          assert.ok(/身份验证失败/.test(e.message))
          return true
        },
      )
      assert.equal(rt.alive, true, '模型侧失败不弃进程')
      // 下一轮复用同一子进程照常工作（失败那轮也计了一次数 → 回复"第2轮"）
      setFlags()
      const r = await rt.run('sess-auth', '再问一次', () => {})
      assert.equal(r.finalText, '第2轮回复：本月支出 380 元')
    } finally {
      await rt.close()
    }
  })

  test('子进程中途被杀：本轮报错，下一轮自动换新进程恢复（P1 崩溃自愈验收）', async () => {
    const rt = makeRuntime()
    try {
      await rt.run('sess-c', '第一问', () => {}) // 第1轮正常
      setFlags('crash')
      await assert.rejects(
        () => rt.run('sess-c', '第二问', () => {}), // 第2轮假 dsh 自杀
        (e: Error) => e instanceof RuntimeDiedError || /退出/.test(e.message),
      )
      assert.equal(rt.alive, false)
      // 下一轮：客户端透明重建子进程（假 dsh 轮次计数归零 → 回复"第1轮"）
      setFlags()
      const r3 = await rt.run('sess-c', '第三问', () => {})
      assert.equal(r3.finalText, '第1轮回复：本月支出 380 元')
    } finally {
      await rt.close()
    }
  })

  test('resume 成功后本进程视为持有该会话；被拒则不视为持有且报可读错误', async () => {
    const rt = makeRuntime({ FAKE_RESUME_LOG: join(dir, 'resume-ok.log') })
    try {
      await rt.resume('sess-r')
      assert.equal(rt.hasSession('sess-r'), true)
      // 已持有：再 run 不需要 resume（resume log 只有第一次那条）
      await rt.run('sess-r', '续聊', () => {})
    } finally {
      await rt.close()
    }
    const resumed = (await import('node:fs')).readFileSync(join(dir, 'resume-ok.log'), 'utf8')
    assert.equal(resumed, 'sess-r\n')

    const rt2 = makeRuntime()
    setFlags('resume-fail')
    try {
      await assert.rejects(() => rt2.resume('sess-bad'), /runtime 拒绝 resume/)
      assert.equal(rt2.hasSession('sess-bad'), false)
    } finally {
      await rt2.close()
    }
  })

  test('子进程崩溃重建后持有表清空（对旧会话将走 resume 路径——rc.2 时代崩溃雷的修复判据）', async () => {
    const rt = makeRuntime()
    try {
      await rt.run('sess-own', '第一问', () => {})
      assert.equal(rt.hasSession('sess-own'), true)
      setFlags('crash')
      await assert.rejects(() => rt.run('sess-own', '第二问', () => {}))
      assert.equal(rt.alive, false)
      assert.equal(rt.hasSession('sess-own'), false, '换新进程后不得再视为持有旧会话')
    } finally {
      await rt.close()
    }
  })

  test('close 后拒绝复用；close 幂等', async () => {
    const rt = makeRuntime()
    await rt.run('sess-x', '你好', () => {})
    await rt.close()
    await rt.close()
    assert.equal(rt.alive, false)
    await assert.rejects(() => rt.run('sess-x', '再问', () => {}))
  })
})

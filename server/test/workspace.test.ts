/** 文件工作区测试：路径封口（../、绝对路径、点开头）/ 扩展名白名单 / 大小与行数上限 / 同名覆盖。 */
import assert from 'node:assert/strict'
import { test, beforeEach } from 'node:test'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listTextFiles, safeResolve, saveTextFile, inboxDir, outboxDir, WORKSPACE_LIMITS } from '../src/agent/workspace.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'admin-workspace-test-'))
})

test('safeResolve：目录封口——../ 上跳、点开头、空名全部拒绝；合法名解析落在目录内', () => {
  // 文件名白名单里没有 / 和 \，路径分隔符根本进不来；containment 检查是纵深防御
  assert.throws(() => safeResolve(dir, '../escape.csv'), /不合法|越出工作区/)
  assert.throws(() => safeResolve(dir, '/etc/passwd.csv'), /不合法/)
  assert.throws(() => safeResolve(dir, '.hidden.csv'), /不合法/)
  assert.throws(() => safeResolve(dir, ''), /不合法/)
  assert.throws(() => safeResolve(dir, 'x'.repeat(81) + '.csv'), /不合法/)
  const full = safeResolve(dir, '流水10月.csv')
  assert.ok(full.startsWith(dir + '/'))
})

test('safeResolve：扩展名白名单（csv/tsv/txt/md），xlsx 二进制不进来', () => {
  assert.throws(() => safeResolve(dir, '报表.xlsx'), /xlsx 请先在前端转成/)
  assert.throws(() => safeResolve(dir, 'README'), /只认/)
  assert.equal(safeResolve(dir, 'a.CSV').endsWith('a.CSV'), true)
})

test('saveTextFile：大小/行数上限；同名覆盖（overwritten=true）；保存后可列出', () => {
  assert.throws(() => saveTextFile(dir, '空.csv', '  '), /内容为空/)
  assert.throws(() => saveTextFile(dir, '大.csv', 'x'.repeat(WORKSPACE_LIMITS.maxBytes + 1)), /MB 上限/)
  const many = Array.from({ length: WORKSPACE_LIMITS.maxLines + 1 }, () => '行').join('\n')
  assert.throws(() => saveTextFile(dir, '多.csv', many), /行上限/)

  const first = saveTextFile(dir, '流水.csv', 'a,b\n1,2\n')
  assert.equal(first.overwritten, false)
  assert.equal(first.lines, 2)
  const again = saveTextFile(dir, '流水.csv', 'a,b\n1,2\n3,4\n')
  assert.equal(again.overwritten, true)
  const list = listTextFiles(dir)
  assert.deepEqual(list.map((f) => f.name), ['流水.csv'])
  assert.equal(existsSync(join(dir, '流水.csv')), true)
})

test('inbox/outbox：路径跟随 ADMIN_DATA_DIR，自动创建且互相独立', () => {
  const inb = inboxDir()
  const out = outboxDir()
  assert.ok(inb.includes('workspace') && inb.endsWith('inbox'))
  assert.ok(out.includes('workspace') && out.endsWith('outbox'))
  saveTextFile(inb, '进.csv', 'a\n')
  saveTextFile(out, '出.csv', 'b\n')
  assert.deepEqual(listTextFiles(inb).map((f) => f.name), ['进.csv'])
  assert.deepEqual(listTextFiles(out).map((f) => f.name), ['出.csv'])
})

test('listTextFiles：跳过目录与非白名单文件；按更新时间倒序', () => {
  writeFileSync(join(dir, 'ignore.xlsx'), 'x')
  const older = saveTextFile(dir, '旧.csv', 'a')
  const newer = saveTextFile(dir, '新.csv', 'b')
  assert.ok(newer.lines === 1 && older.lines === 1)
  const names = listTextFiles(dir).map((f) => f.name)
  assert.deepEqual(names.sort(), ['新.csv', '旧.csv'])
})

/** 样例系统数据初始化脚本（2026-10-30 执行计划 P2 分离约定落地）。
 *
 * ⚠️ 样例系统数据，非框架交付物，其他企业不继承——底层 seed 只建 boss/agent-runtime 两个技术角色；
 * 这个脚本给「我们企业的样例库」补上审批进场的 employee 默认角色（对话+看账），
 * 供飞书部门映射（技术部→employee 等）使用。企业要别的口径：用拼装台面自建角色再配映射。
 *
 * 幂等：重复跑只补缺失的角色/权限点，不动任何已有绑定。
 * 用法：node dist/scripts/sample/seed-sample.js [--db 文件]（缺省用生产数据目录）
 */
import { openDatabase, type DB } from '../../src/db/database.js'
import { PERMISSIONS, type Permission } from '../../src/rbac/rbac.service.js'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const SAMPLE_EMPLOYEE_ROLE = 'employee'
export const SAMPLE_EMPLOYEE_PERMISSIONS: readonly Permission[] = [
  'finance:read',
  'agent:read',
  'agent:write',
  // 2026-10-31 用户指示：员工的待办中心默认全部打开（可见性谓词保证只看到自己的与岗位池的）
  'todo:read',
  'todo:write',
]

/** 幂等补样例角色：employee + 其权限点（角色在则跳过，权限点缺则补）。测试与 CLI 共用。 */
export function seedSampleRoles(db: DB): void {
  const run = db.transaction(() => {
    for (const code of PERMISSIONS) {
      db.prepare('INSERT OR IGNORE INTO permissions (code) VALUES (?)').run(code)
    }
    db.prepare('INSERT OR IGNORE INTO roles (name) VALUES (?)').run(SAMPLE_EMPLOYEE_ROLE)
    const role = db.prepare('SELECT id FROM roles WHERE name = ?').get(SAMPLE_EMPLOYEE_ROLE) as { id: number }
    for (const code of SAMPLE_EMPLOYEE_PERMISSIONS) {
      const pid = db.prepare('SELECT id FROM permissions WHERE code = ?').get(code) as { id: number }
      db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)').run(role.id, pid.id)
    }
  })
  run()
}

function main(): void {
  const i = process.argv.indexOf('--db')
  const dbPath =
    i >= 0 && process.argv[i + 1] !== undefined
      ? process.argv[i + 1]!
      : join(homedir(), '.dsh', 'company-data', 'admin', 'ledger.db')
  const db = openDatabase(dbPath)
  seedSampleRoles(db)
  const row = db
    .prepare(
      `SELECT GROUP_CONCAT(p.code) AS perms FROM roles r
       JOIN role_permissions rp ON rp.role_id = r.id
       JOIN permissions p ON p.id = rp.permission_id
       WHERE r.name = ?`,
    )
    .get(SAMPLE_EMPLOYEE_ROLE) as { perms: string | null }
  console.log(`样例角色就绪：${SAMPLE_EMPLOYEE_ROLE}（${row.perms ?? '无权限点'}）@ ${dbPath}`)
  db.close()
}

// CLI 入口：被测试 import 时不执行（import 侧只拿 seedSampleRoles）
if (process.argv[1]?.endsWith('seed-sample.js') === true) {
  main()
}

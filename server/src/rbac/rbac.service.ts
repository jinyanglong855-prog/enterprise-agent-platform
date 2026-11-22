/** RBAC：用户-角色-权限点三表。v1 只 seed 老板岗（boss=全部权限）；P2 开岗只加数据不改代码。 */
import bcrypt from 'bcryptjs'
import { randomBytes } from 'node:crypto'
import type { DB } from '../db/database.js'
import { nowIso } from '../db/database.js'
import { config } from '../config.js'
import { BadRequestError, ForbiddenError, NotFoundError } from '../errors.js'
import type { AuditEntry, AuditService } from '../audit/audit.service.js'

// agent:read/agent:write（2026-10-27 框架定版）：对话域独立权限点——对话框不再借财务写权限，
// 给别的公司复制框架时对话可单独开/关。seed 幂等自动补插并绑 boss，零迁移。
// audit:read（2026-10-28 融合方案 §6 风险1 最小权限服务账号）：审计查询独立权限点——
// audit_query 工具是 /api/audit 唯一消费方，服务号凭它读审计而无需 admin:manage。
// todo:read/todo:write（2026-10-31 待办预警方案 §三）：义务域独立权限点——待办/预警
// 与财务读写解耦（只看待办不碰账本的岗位存在）。服务号不加：agent 替人建待办走确认提案
// 落账、扫描器自己走服务内调用，都不经 todo 权限面；boss 由 seed 全量回填，存量库重启即生效。
// platform:read（2026-11-01 融合 P1 数据通道）：只读平台数据（通讯录/审批）的独立权限点——
// 没接平台的企业永不授予即可；服务号恰含它（agent 替老板查审批/通讯录），不含任何平台写权限。
// supply:read/supply:write（2026-11-01 生产任务全图 v0）：生产供应链域独立权限点——
// 与财务读写解耦（只看库存/采购不碰账本的岗位存在）。服务号只加 read（agent 替老板查库存/
// 采购是只读问数；导入落库是界面写路径，agent 无批量直落入口）。
// payroll:read/payroll:write（2026-11-01 财务残余 A3）：工资域独立权限点——谁看得见谁挣多少
// 与"能记账"是两件事，财务读写不解锁工资页。服务号不加：工资无 agent 工具面。
// knowledge:read（2026-11-02 阶段 3 知识库融合）：管理台搜知识库/问一问；只有老板角色缺省持有。
// 服务号不加：agent 走自己的 mcp-kb 插件直连 kb-rag（身份 company-agent），不经管理台 REST。
export const PERMISSIONS = [
  'finance:read',
  'finance:write',
  'agent:read',
  'agent:write',
  'audit:read',
  'todo:read',
  'todo:write',
  'platform:read',
  'supply:read',
  'supply:write',
  'payroll:read',
  'payroll:write',
  'knowledge:read',
  'admin:manage',
] as const
export type Permission = (typeof PERMISSIONS)[number]

/** agent 运行时服务号（2026-10-28 融合方案）：网关子进程以此身份调后端 REST，
 *  权限=工具门面所需的最小集（无 admin:manage）——平台侧消息若被提示注入，
 *  爆炸半径收在工具门面内，碰不到审计之外的任何管理面。 */
export const AGENT_SERVICE_USERNAME = 'agent'
export const AGENT_RUNTIME_ROLE = 'agent-runtime'
export const AGENT_RUNTIME_PERMISSIONS: readonly Permission[] = [
  'finance:read',
  'finance:write',
  'agent:read',
  'agent:write',
  'audit:read',
  'platform:read',
  'supply:read',
]

/** 内置技术角色（2026-10-30 执行计划 P1 拼装台面）：框架自用，企业不可删、不可改权限。
 *  boss=老板岗全权（bossUsername 按角色找、网关直签令牌都依赖它），
 *  agent-runtime=服务号最小权限集（提示注入的爆炸半径控制）。
 *  （样例的 employee 角色 2026-10-30 P2 起迁出底层：见 server/scripts/sample/seed-sample.ts。） */
export const TECHNICAL_ROLES: readonly string[] = ['boss', AGENT_RUNTIME_ROLE]

/** 拼装台面的角色视图：technical=true 的角色界面置灰、REST 拒绝改删。 */
export interface RoleView {
  name: string
  permissions: Permission[]
  technical: boolean
  users: number
}

export interface UserWithRolesView {
  username: string
  displayName: string
  isService: boolean
  disabled: boolean
  roles: string[]
}

/** REST 管理动作的操作者（谁/从哪来），审计三要素之二，第三要素在动作里。 */
export interface RbacActor {
  username: string
  source: string
}

/** 角色-用户绑定的来源（执行计划 P4）：mapping=随部门映射走（调岗重算会动），
 *  manual=管理员界面绑定/P3 审批落（重算不碰）。 */
export type RoleSource = 'mapping' | 'manual'

export interface UserRow {
  id: number
  username: string
  display_name: string
  is_service: number
}

export class RbacService {
  constructor(
    private readonly db: DB,
    private readonly audit?: AuditService,
  ) {}

  private auditLog(entry: AuditEntry): void {
    this.audit?.log(entry)
  }

  /** 幂等 seed：权限点、boss 角色、老板账号（仅当不存在时创建）。 */
  seed(): void {
    const seedAll = this.db.transaction(() => {
      for (const code of PERMISSIONS) {
        this.db.prepare('INSERT OR IGNORE INTO permissions (code) VALUES (?)').run(code)
      }
      this.db.prepare('INSERT OR IGNORE INTO roles (name) VALUES (?)').run('boss')
      const boss = this.db.prepare('SELECT id FROM roles WHERE name = ?').get('boss') as { id: number }
      const allPerms = this.db.prepare('SELECT id FROM permissions').all() as { id: number }[]
      for (const p of allPerms) {
        this.db
          .prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)')
          .run(boss.id, p.id)
      }
      // 只在"还没有任何真人账号"时种首个老板号：老板账号改名后重启，不得重新种出一个初始密码的 boss（安全洞）
      const hasOwner =
        this.db.prepare('SELECT 1 FROM users WHERE is_service = 0 LIMIT 1').get() !== undefined
      if (!hasOwner) {
        const hash = bcrypt.hashSync(config.bossInitialPassword, 10)
        this.db
          .prepare(
            'INSERT INTO users (username, password_hash, display_name, is_service, created_at) VALUES (?, ?, ?, 0, ?)',
          )
          .run('boss', hash, '老板', nowIso())
        this.assignRole('boss', 'boss')
      }
      // agent 运行时服务号（幂等）：随机密码哈希（无人知道、不可登录），只有角色授权的权限点；
      // 已存在则不动（管理员停用即生效——agentServiceUsername 会返回 undefined，网关拒启）
      this.db.prepare('INSERT OR IGNORE INTO roles (name) VALUES (?)').run(AGENT_RUNTIME_ROLE)
      const runtimeRole = this.db.prepare('SELECT id FROM roles WHERE name = ?').get(AGENT_RUNTIME_ROLE) as { id: number }
      for (const code of AGENT_RUNTIME_PERMISSIONS) {
        const pid = this.db.prepare('SELECT id FROM permissions WHERE code = ?').get(code) as { id: number }
        this.db
          .prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)')
          .run(runtimeRole.id, pid.id)
      }
      // 员工默认角色（P2 迁出说明）：底层 seed 不再建 employee——样例库由 scripts/sample/seed-sample.ts 初始化，
      // 其他企业复制框架时只带 boss/agent-runtime 两个技术角色，拼装台面建自己的岗位角色。
      // 不分 is_service 先查：若有人类同名用户占住 'agent'，INSERT 撞 UNIQUE 会让整个服务起不来
      // （对抗审查 P3-3）——大声告警并跳过，此时 agentServiceUsername()=undefined，runtime 拒启（fail-safe）
      const anyAgent = this.db.prepare('SELECT is_service FROM users WHERE username = ?').get(AGENT_SERVICE_USERNAME) as
        | { is_service: number }
        | undefined
      if (anyAgent !== undefined && anyAgent.is_service !== 1) {
        console.warn(
          `[rbac] 用户名 "${AGENT_SERVICE_USERNAME}" 已被人类账号占用：agent 服务号建不了，` +
            `agent 运行时将拒绝启动。请改名该账号或手工处理。`,
        )
      } else {
        if (anyAgent === undefined) {
          const randomHash = bcrypt.hashSync(randomBytes(24).toString('hex'), 10)
          this.db
            .prepare(
              'INSERT INTO users (username, password_hash, display_name, is_service, created_at) VALUES (?, ?, ?, 1, ?)',
            )
            .run(AGENT_SERVICE_USERNAME, randomHash, '智能体运行时', nowIso())
        }
        this.assignRole(AGENT_SERVICE_USERNAME, AGENT_RUNTIME_ROLE)
      }
    })
    seedAll()
  }

  userExists(username: string): boolean {
    return this.db.prepare('SELECT id FROM users WHERE username = ?').get(username) !== undefined
  }

  /** 老板用户名（v1 单账号）：按角色找而非写死 'boss'——账号改名后，网关直签令牌与初始密码提示不断链。 */
  bossUsername(): string | undefined {
    const row = this.db
      .prepare(
        `SELECT u.username AS username
         FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN roles r ON r.id = ur.role_id
         WHERE r.name = 'boss' AND u.disabled_at IS NULL
         ORDER BY u.id LIMIT 1`,
      )
      .get() as { username: string } | undefined
    return row?.username
  }

  /** agent 运行时服务号用户名（seed 幂等保证存在；管理员手动停用后返回 undefined——网关拒启，不回退 boss）。 */
  agentServiceUsername(): string | undefined {
    const row = this.db
      .prepare('SELECT username FROM users WHERE username = ? AND is_service = 1 AND disabled_at IS NULL')
      .get(AGENT_SERVICE_USERNAME) as { username: string } | undefined
    return row?.username
  }

  /**
   * 绑定角色（幂等：已有绑定不动，含来源列——重刷来源走 setRoleSource，混在 insert 里
   * 会把 P3 审批"已有角色 no-op"的 mapping 绑定悄悄翻成 manual）。
   * 来源约定（执行计划 P4）：mapping=随部门映射走（开通/映射补配落，调岗重算会动）；
   * manual=管理员界面绑定/P3 审批落（个体的单独决定，重算不碰）。
   */
  assignRole(username: string, roleName: string, source: RoleSource = 'manual'): void {
    // 显式查 id 再插（对抗审查 P2-2）：原 INSERT...SELECT 子查询在角色不存在时得 NULL，
    // 撞 NOT NULL 被 INSERT OR IGNORE 静默跳行——绑定无声丢失而审计还记着"已配"。悬挂引用大声失败。
    const user = this.db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number } | undefined
    const role = this.db.prepare('SELECT id FROM roles WHERE name = ?').get(roleName) as { id: number } | undefined
    if (user === undefined || role === undefined) {
      throw new NotFoundError(`绑定失败：用户 "${username}" 或角色 "${roleName}" 不存在。`)
    }
    this.db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id, source) VALUES (?, ?, ?)').run(user.id, role.id, source)
  }

  /** 改既有绑定的来源标记（P4 存量迁移：applyOrgRules 把映射落的存量绑定重刷成 mapping，
   *  纳入调岗重算；绑定本身不变，只换标签）。绑定不存在时无声跳过（applyOrgRules 先
   *  assignRole 保证存在，这里只是补标）。 */
  setRoleSource(username: string, roleName: string, source: RoleSource): void {
    this.db
      .prepare(
        `UPDATE user_roles SET source = ?
         WHERE user_id = (SELECT id FROM users WHERE username = ?)
           AND role_id = (SELECT id FROM roles WHERE name = ?)`,
      )
      .run(source, username, roleName)
  }

  findUser(username: string): (UserRow & { password_hash: string; disabled_at: string | null }) | undefined {
    return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as
      | (UserRow & { password_hash: string; disabled_at: string | null })
      | undefined
  }

  /** 改密专用：调用方负责旧密码校验与审计。 */
  setPasswordHash(username: string, passwordHash: string): void {
    this.db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(passwordHash, username)
  }

  /** 用户实际生效的权限点集合（经角色展开）。 */
  permissionsOf(username: string): Set<Permission> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT p.code AS code
         FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN role_permissions rp ON rp.role_id = ur.role_id
         JOIN permissions p ON p.id = rp.permission_id
         WHERE u.username = ? AND u.disabled_at IS NULL`,
      )
      .all(username) as { code: Permission }[]
    return new Set(rows.map((r) => r.code))
  }

  hasPermission(username: string, needed: Permission): boolean {
    return this.permissionsOf(username).has(needed)
  }

  displayName(username: string): string {
    const row = this.db.prepare('SELECT display_name FROM users WHERE username = ?').get(username) as
      | { display_name: string }
      | undefined
    return row?.display_name ?? username
  }

  /** 角色名 → 绑定它的用户名列表（不含停用账号，权限校验本来就跳过停用）。 */
  private usersOfRole(roleId: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT u.username AS username FROM user_roles ur
         JOIN users u ON u.id = ur.user_id WHERE ur.role_id = ? AND u.disabled_at IS NULL`,
      )
      .all(roleId) as { username: string }[]
    return rows.map((r) => r.username)
  }

  private roleIdOf(name: string): { id: number } | undefined {
    return this.db.prepare('SELECT id FROM roles WHERE name = ?').get(name) as { id: number } | undefined
  }

  private permissionIdOf(code: Permission): number {
    const row = this.db.prepare('SELECT id FROM permissions WHERE code = ?').get(code) as { id: number }
    return row.id
  }

  private permissionsOfRole(roleId: number): Permission[] {
    const rows = this.db
      .prepare(
        `SELECT p.code AS code FROM role_permissions rp
         JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ? ORDER BY p.id`,
      )
      .all(roleId) as { code: Permission }[]
    return rows.map((r) => r.code)
  }

  /** 除指定范围外，还持有 admin:manage 的活跃用户——最后管理员守卫的判据：
   *  任何改动后若这个集合为空 = 全系统再无人能进管理面（锁死门外），必须拒绝。
   *  两种排除形状（语义不同，混用会误判）：只给 roleId=整个角色的授权都不算（改权/删角色用）；
   *  username+roleId=只排除那一条绑定，同角色其他持有者仍然算数（解绑用）。 */
  private adminHoldersExcluding(except: { username?: string; roleId?: number } = {}): Set<string> {
    const cond =
      except.username !== undefined
        ? 'NOT (u.username = @username AND ur.role_id = @roleId)'
        : except.roleId !== undefined
          ? 'ur.role_id != @roleId'
          : '1=1'
    const rows = this.db
      .prepare(
        `SELECT DISTINCT u.username AS username
         FROM users u
         JOIN user_roles ur ON ur.user_id = u.id
         JOIN role_permissions rp ON rp.role_id = ur.role_id
         JOIN permissions p ON p.id = rp.permission_id
         WHERE p.code = 'admin:manage' AND u.disabled_at IS NULL AND (${cond})`,
      )
      .all({ username: except.username ?? '', roleId: except.roleId ?? -1 }) as { username: string }[]
    return new Set(rows.map((r) => r.username))
  }

  /** 守卫拒绝统一留痕（对抗审查 P3-2 采纳）：试图摘最后管理员/改自己权限是内部威胁最强信号，
   *  与 auth.login 失败留审计同理；动作统一 rbac.guard.rejected，detail.rule 区分哪条守卫。 */
  private guardRejected(actor: RbacActor | undefined, targetId: string, rule: string, note: string): void {
    if (actor === undefined) return
    this.auditLog({
      username: actor.username,
      source: actor.source,
      action: 'rbac.guard.rejected',
      targetId,
      detail: { rule, note },
      ok: false,
    })
  }

  private assertLastAdminSurvives(actor: RbacActor, detail: string, except: { username?: string; roleId?: number }): void {
    if (this.adminHoldersExcluding(except).size === 0) {
      this.guardRejected(actor, detail, 'last-admin-manage', '会摘掉全系统最后一个 admin:manage 持有人')
      throw new ForbiddenError(`${detail}会让全系统不再有人持有 admin:manage（所有管理员被锁在门外），已拒绝。`)
    }
  }

  private parseRoleName(input: unknown): string {
    if (typeof input !== 'string') throw new BadRequestError('角色名需要字符串。')
    const name = input.trim()
    if (name === '' || name.length > 32) throw new BadRequestError('角色名要 1-32 个字符。')
    return name
  }

  private parsePermissionCodes(input: unknown): Permission[] {
    if (!Array.isArray(input)) throw new BadRequestError('permissions 需要字符串数组。')
    const seen = new Set<string>()
    for (const code of input) {
      if (typeof code !== 'string' || !(PERMISSIONS as readonly string[]).includes(code)) {
        throw new BadRequestError(`未知权限点：${String(code)}。权限点清单固定，加权限点=底层系统发版。`)
      }
      seen.add(code)
    }
    return PERMISSIONS.filter((p) => seen.has(p))
  }

  private requireMutableRole(name: string, actor?: RbacActor): { id: number } {
    const role = this.roleIdOf(name)
    if (role === undefined) throw new NotFoundError(`角色 "${name}" 不存在。`)
    if ((TECHNICAL_ROLES as readonly string[]).includes(name)) {
      this.guardRejected(actor, name, 'technical-role', '技术角色不可删除、不可改权限')
      throw new ForbiddenError(`技术角色 "${name}" 框架自用，不可删除、不可改权限。`)
    }
    // 自己改自己的权限（提权防套利+防误删）：操作者持有的角色，改权限/删除都影响自己的有效权限——一律拒
    if (
      actor !== undefined &&
      this.db
        .prepare(
          `SELECT 1 FROM user_roles ur JOIN users u ON u.id = ur.user_id
           WHERE ur.role_id = ? AND u.username = ?`,
        )
        .get(role.id, actor.username) !== undefined
    ) {
      this.guardRejected(actor, name, 'self-held-role', '修改/删除自己持有的角色')
      throw new ForbiddenError(`不能修改自己持有的角色 "${name}"；自己的权限找其他管理员操作。`)
    }
    return role
  }

  // ---------- 拼装台面（2026-10-30 执行计划 P1）：角色 CRUD + 用户绑定，护栏全在服务层 ----------

  /** 权限点清单只读：第一层固定六个，界面不提供加权限点（加=底层系统发版）。 */
  listPermissions(): readonly Permission[] {
    return PERMISSIONS
  }

  listRoles(): RoleView[] {
    const roles = this.db.prepare('SELECT id, name FROM roles ORDER BY id').all() as { id: number; name: string }[]
    return roles.map((r) => ({
      name: r.name,
      permissions: this.permissionsOfRole(r.id),
      technical: (TECHNICAL_ROLES as readonly string[]).includes(r.name),
      users: this.usersOfRole(r.id).length,
    }))
  }

  createRole(actor: RbacActor, nameInput: unknown, permissionsInput: unknown): RoleView {
    const name = this.parseRoleName(nameInput)
    if ((TECHNICAL_ROLES as readonly string[]).includes(name)) {
      throw new BadRequestError(`角色名 "${name}" 与内置技术角色同名，换个名字（企业角色自定，如「会计」）。`)
    }
    const permissions = this.parsePermissionCodes(permissionsInput)
    if (this.roleIdOf(name) !== undefined) throw new BadRequestError(`角色 "${name}" 已存在。`)
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO roles (name) VALUES (?)').run(name)
      const role = this.roleIdOf(name)!
      for (const code of permissions) {
        this.db.prepare('INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)').run(role.id, this.permissionIdOf(code))
      }
    })()
    this.auditLog({
      username: actor.username,
      source: actor.source,
      action: 'rbac.role.created',
      targetId: name,
      detail: { permissions },
    })
    return { name, permissions, technical: false, users: 0 }
  }

  updateRolePermissions(actor: RbacActor, nameInput: unknown, permissionsInput: unknown): RoleView {
    const name = this.parseRoleName(nameInput)
    const permissions = this.parsePermissionCodes(permissionsInput)
    const role = this.requireMutableRole(name, actor)
    const before = this.permissionsOfRole(role.id)
    if (before.includes('admin:manage') && !permissions.includes('admin:manage')) {
      this.assertLastAdminSurvives(actor, `把角色 "${name}" 的 admin:manage 摘掉`, { roleId: role.id })
    }
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(role.id)
      for (const code of permissions) {
        this.db.prepare('INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)').run(role.id, this.permissionIdOf(code))
      }
    })()
    this.auditLog({
      username: actor.username,
      source: actor.source,
      action: 'rbac.role.permissions.updated',
      targetId: name,
      detail: { before, after: permissions },
    })
    return { name, permissions, technical: false, users: this.usersOfRole(role.id).length }
  }

  deleteRole(actor: RbacActor, nameInput: unknown): void {
    const name = this.parseRoleName(nameInput)
    const role = this.requireMutableRole(name, actor)
    if (this.permissionsOfRole(role.id).includes('admin:manage')) {
      this.assertLastAdminSurvives(actor, `删除角色 "${name}"`, { roleId: role.id })
    }
    // 还被部门映射引用的角色不许删（对抗审查 P2-2）：审批进场/补配按映射落角色，删了会出现
    // "规则在、角色无"的悬挂映射——落角色大声失败会卡住开通，静默吞掉则审计与事实不符。先删映射再删角色。
    const refs = this.db.prepare('SELECT COUNT(*) AS n FROM feishu_org_rules WHERE role = ?').get(name) as { n: number }
    if (refs.n > 0) {
      throw new BadRequestError(`角色 "${name}" 还被 ${refs.n} 条飞书部门映射引用（先到「组织映射」删掉映射，再删角色）。`)
    }
    const bound = this.usersOfRole(role.id).length
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(role.id)
      this.db.prepare('DELETE FROM user_roles WHERE role_id = ?').run(role.id)
      this.db.prepare('DELETE FROM roles WHERE id = ?').run(role.id)
    })()
    this.auditLog({
      username: actor.username,
      source: actor.source,
      action: 'rbac.role.deleted',
      targetId: name,
      detail: { revokedBindings: bound },
    })
  }

  listUsersWithRoles(): UserWithRolesView[] {
    const users = this.db
      .prepare('SELECT username, display_name, is_service, disabled_at FROM users ORDER BY id')
      .all() as { username: string; display_name: string; is_service: number; disabled_at: string | null }[]
    const byUser = new Map<string, string[]>()
    for (const row of this.db
      .prepare(
        `SELECT u.username AS username, r.name AS role FROM user_roles ur
         JOIN users u ON u.id = ur.user_id JOIN roles r ON r.id = ur.role_id ORDER BY r.id`,
      )
      .all() as { username: string; role: string }[]) {
      const list = byUser.get(row.username) ?? []
      list.push(row.role)
      byUser.set(row.username, list)
    }
    return users.map((u) => ({
      username: u.username,
      displayName: u.display_name,
      isService: u.is_service === 1,
      disabled: u.disabled_at !== null,
      roles: byUser.get(u.username) ?? [],
    }))
  }

  rolesOf(username: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT r.name AS name FROM user_roles ur
         JOIN users u ON u.id = ur.user_id JOIN roles r ON r.id = ur.role_id
         WHERE u.username = ? ORDER BY r.id`,
      )
      .all(username) as { name: string }[]
    return rows.map((r) => r.name)
  }

  assignUserRole(actor: RbacActor, username: string, roleName: string): { username: string; roles: string[]; alreadyBound: boolean } {
    if (!this.userExists(username)) throw new NotFoundError(`用户 "${username}" 不存在。`)
    const role = this.roleIdOf(roleName)
    if (role === undefined) throw new NotFoundError(`角色 "${roleName}" 不存在。`)
    // 技术角色不经界面绑定/解绑（对抗审查 P3-4 采纳）：绑出去=制造 bossUsername()/网关直签候选，
    // 摘掉 agent-runtime=服务号静默失能。框架自用角色只随 seed 与老板账号走。
    if ((TECHNICAL_ROLES as readonly string[]).includes(roleName)) {
      this.guardRejected(actor, `${username}/${roleName}`, 'technical-role', '技术角色不可经界面绑定')
      throw new ForbiddenError(`技术角色 "${roleName}" 不能通过界面绑定（框架自用角色）。`)
    }
    // 自己改自己的权限（提权防套利）：语义最简=自己的绑定谁都不能自己动（含加），测试好钉
    if (username === actor.username) {
      this.guardRejected(actor, `${username}/${roleName}`, 'self-change', '给自己绑角色')
      throw new ForbiddenError('不能修改自己的角色；找其他管理员操作。')
    }
    const alreadyBound =
      this.db
        .prepare('SELECT 1 FROM user_roles WHERE user_id = (SELECT id FROM users WHERE username = ?) AND role_id = ?')
        .get(username, role.id) !== undefined
    if (!alreadyBound) {
      this.assignRole(username, roleName)
      this.auditLog({
        username: actor.username,
        source: actor.source,
        action: 'rbac.user.role.assigned',
        targetId: username,
        detail: { role: roleName },
      })
    }
    return { username, roles: this.rolesOf(username), alreadyBound }
  }

  removeUserRole(actor: RbacActor, username: string, roleName: string): { username: string; roles: string[] } {
    if (!this.userExists(username)) throw new NotFoundError(`用户 "${username}" 不存在。`)
    const role = this.roleIdOf(roleName)
    if (role === undefined) throw new NotFoundError(`角色 "${roleName}" 不存在。`)
    if ((TECHNICAL_ROLES as readonly string[]).includes(roleName)) {
      this.guardRejected(actor, `${username}/${roleName}`, 'technical-role', '技术角色不可经界面解绑')
      throw new ForbiddenError(`技术角色 "${roleName}" 不能通过界面解绑（框架自用角色）。`)
    }
    if (username === actor.username) {
      this.guardRejected(actor, `${username}/${roleName}`, 'self-change', '摘自己的角色')
      throw new ForbiddenError('不能修改自己的角色；找其他管理员操作。')
    }
    const bound = this.db
      .prepare('SELECT 1 FROM user_roles WHERE user_id = (SELECT id FROM users WHERE username = ?) AND role_id = ?')
      .get(username, role.id)
    if (bound === undefined) throw new BadRequestError(`用户 "${username}" 未绑定角色 "${roleName}"。`)
    if (this.permissionsOfRole(role.id).includes('admin:manage')) {
      this.assertLastAdminSurvives(actor, `摘掉 "${username}" 的角色 "${roleName}"`, { username, roleId: role.id })
    }
    this.db.prepare('DELETE FROM user_roles WHERE user_id = (SELECT id FROM users WHERE username = ?) AND role_id = ?').run(username, role.id)
    this.auditLog({
      username: actor.username,
      source: actor.source,
      action: 'rbac.user.role.removed',
      targetId: username,
      detail: { role: roleName },
    })
    return { username, roles: this.rolesOf(username) }
  }
}

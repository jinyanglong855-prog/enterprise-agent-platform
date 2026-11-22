/** 运行配置：全部可环境变量覆盖，缺省值只适用于本机单机部署（方案 P1）。 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const ADMIN_DATA_DIR = process.env.ADMIN_DATA_DIR ?? join(homedir(), '.dsh', 'company-data', 'admin')

export const config = {
  port: Number(process.env.ADMIN_PORT ?? 3210),
  dataDir: ADMIN_DATA_DIR,
  dbPath: process.env.ADMIN_DB_PATH ?? join(ADMIN_DATA_DIR, 'ledger.db'),
  /** JWT 有效期（秒）。 */
  jwtTtlSeconds: 30 * 24 * 3600,
  /** 首个老板账号的初始密码（仅 seed 时用；env 覆盖）。 */
  bossInitialPassword: process.env.ADMIN_BOSS_PASSWORD ?? 'boss-2026-ningbo',
  jwtSecret: loadOrCreateJwtSecret(),
  /** 融合层（2026-10-28 方案 P0）：默认关——没有平台凭据时不连。enabled 后按 adapter 名启动。 */
  bridgeEnabled: process.env.ADMIN_BRIDGE_ENABLED === '1',
  bridgeAdapter: process.env.ADMIN_BRIDGE_ADAPTER ?? 'mock',
  /** 飞书凭据（融合方案 P1 第一个真实平台）：只走环境变量，不进任何文档/代码仓。 */
  feishuAppId: process.env.ADMIN_FEISHU_APP_ID ?? '',
  feishuAppSecret: process.env.ADMIN_FEISHU_APP_SECRET ?? '',
  /** 知识库（2026-11-02 阶段 3）：kb-rag 仓库目录，空=未接入（接口 503 人话提示，界面照常装配）。
   *  MCP 子进程命令/参数可整体覆盖（测试接假服务；其他部署方式）；调用者身份决定 kb-rag 侧读范围
   *  （规则表 kb-rag/scopes.json），管理台缺省 company-console——只读公司项目与 Shared，不碰私人区。 */
  kbRagDir: process.env.ADMIN_KB_RAG_DIR ?? '',
  kbMcpCommand: process.env.ADMIN_KB_MCP_COMMAND ?? 'uv',
  kbMcpArgs: splitArgs(process.env.ADMIN_KB_MCP_ARGS),
  kbCaller: process.env.ADMIN_KB_CALLER ?? 'company-console',
  /** MCP 子进程空闲多久自动停（毫秒）：嵌入模型常驻内存不便宜，没人问就放掉。 */
  kbIdleMs: Number(process.env.ADMIN_KB_IDLE_MS ?? 10 * 60_000),
}

function splitArgs(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  return raw.trim().split(/\s+/)
}

/** JWT 密钥：优先 env；否则生成随机密钥存数据目录（重启不失效）。 */
function loadOrCreateJwtSecret(): string {
  if (process.env.ADMIN_JWT_SECRET !== undefined && process.env.ADMIN_JWT_SECRET !== '') {
    return process.env.ADMIN_JWT_SECRET
  }
  const file = join(ADMIN_DATA_DIR, 'jwt-secret')
  if (existsSync(file)) return readFileSync(file, 'utf8').trim()
  // Node 24 实测：目录已存在（如 mktemp 预建）时 recursive mkdir 仍抛 EEXIST，先判存在
  if (!existsSync(ADMIN_DATA_DIR)) mkdirSync(ADMIN_DATA_DIR, { recursive: true })
  const secret = randomBytes(48).toString('base64url')
  writeFileSync(file, secret, { mode: 0o600 })
  chmodSync(file, 0o600)
  return secret
}

export function ensureDataDir(): void {
  if (!existsSync(ADMIN_DATA_DIR)) mkdirSync(ADMIN_DATA_DIR, { recursive: true })
}

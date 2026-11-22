/** 账本唯一事实源 schema（SQLite DDL）。金额一律存"分"（INTEGER），边界层换算元。
 *  表结构预留 RBAC（用户-角色-权限点），v1 只 seed 老板岗。
 *  数据模型地基（2026-10-20，任务全图 §0.4）：账户实体化 / 票实体化 / 出数只许冲销 /
 *  确认卡片提案（"谁认的"授权维）。老库升级见 migrate()：加列走 ALTER，幂等。 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL DEFAULT '',
  is_service    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  disabled_at   TEXT
);

CREATE TABLE IF NOT EXISTS roles (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS permissions (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id INTEGER NOT NULL REFERENCES users(id),
  role_id INTEGER NOT NULL REFERENCES roles(id),
  -- 绑定来源（P4 调岗自动同步）：mapping=随部门映射重算（开通/映射补配落），
  -- manual=管理员界面绑定/P3 审批落，重算不动
  source  TEXT NOT NULL DEFAULT 'manual',
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id       INTEGER NOT NULL REFERENCES roles(id),
  permission_id INTEGER NOT NULL REFERENCES permissions(id),
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL,
  username   TEXT NOT NULL,
  source     TEXT NOT NULL,
  action     TEXT NOT NULL,
  target_id  TEXT,
  detail     TEXT NOT NULL DEFAULT '{}',
  ok         INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);

CREATE TABLE IF NOT EXISTS finance_entries (
  id               TEXT PRIMARY KEY,
  date             TEXT NOT NULL,
  type             TEXT NOT NULL,
  amount_cents     INTEGER NOT NULL,
  status           TEXT NOT NULL,
  counterparty     TEXT NOT NULL DEFAULT '',
  category         TEXT NOT NULL DEFAULT '',
  account          TEXT NOT NULL DEFAULT '',
  invoice_no       TEXT NOT NULL DEFAULT '',
  due_date         TEXT NOT NULL DEFAULT '',
  paid_amount_cents INTEGER NOT NULL DEFAULT 0,
  note             TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL,
  created_by       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  updated_by       TEXT NOT NULL,
  deleted_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_entries_date ON finance_entries(date);
CREATE INDEX IF NOT EXISTS idx_entries_type ON finance_entries(type);
CREATE INDEX IF NOT EXISTS idx_entries_status ON finance_entries(status);

CREATE TABLE IF NOT EXISTS finance_followups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id   TEXT NOT NULL REFERENCES finance_entries(id),
  date       TEXT NOT NULL,
  note       TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_followups_entry ON finance_followups(entry_id);

CREATE TABLE IF NOT EXISTS finance_profile (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  updated_at TEXT,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS finance_accounts (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  name                 TEXT NOT NULL UNIQUE,
  kind                 TEXT NOT NULL DEFAULT 'other',
  opening_balance_cents INTEGER NOT NULL DEFAULT 0,
  note                 TEXT NOT NULL DEFAULT '',
  archived_at          TEXT,
  created_at           TEXT NOT NULL,
  created_by           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS finance_invoices (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  number       TEXT NOT NULL DEFAULT '',
  date         TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  counterparty TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'held',
  red_date     TEXT NOT NULL DEFAULT '',
  note         TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  updated_by   TEXT NOT NULL,
  deleted_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_invoices_kind ON finance_invoices(kind);

CREATE TABLE IF NOT EXISTS finance_invoice_links (
  invoice_id TEXT NOT NULL REFERENCES finance_invoices(id),
  entry_id   TEXT NOT NULL REFERENCES finance_entries(id),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  PRIMARY KEY (invoice_id, entry_id)
);
CREATE INDEX IF NOT EXISTS idx_invoice_links_entry ON finance_invoice_links(entry_id);

CREATE TABLE IF NOT EXISTS finance_proposals (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL DEFAULT 'single',
  payload     TEXT NOT NULL,
  summary     TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  entry_id    TEXT,
  reason      TEXT NOT NULL DEFAULT '',
  origin      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON finance_proposals(status);

CREATE TABLE IF NOT EXISTS finance_reported_months (
  month       TEXT PRIMARY KEY,
  reported_at TEXT NOT NULL,
  reported_by TEXT NOT NULL
);

-- 工资域（2026-11-01 财务残余 A3，融合方案 §3 回流形态=财务域最小增量两张表）。
-- 名册管"人 + 算工资的参数"：身份三件（姓名/部门/open_id）从平台通讯录同步，工资参数
-- （默认应发/个人社保/专项附加月扣）永远本地维护——同步只动身份字段，不许把人的钱数
-- 冲掉。open_id 空=手工登记（没接平台或不在飞书里的人照样进工资域）。
CREATE TABLE IF NOT EXISTS finance_employees (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT NOT NULL,
  open_id            TEXT NOT NULL DEFAULT '',
  department         TEXT NOT NULL DEFAULT '',
  hire_date          TEXT NOT NULL DEFAULT '',
  leave_date         TEXT NOT NULL DEFAULT '',
  base_salary_cents  INTEGER NOT NULL DEFAULT 0,
  social_cents       INTEGER NOT NULL DEFAULT 0,
  extra_deduct_cents INTEGER NOT NULL DEFAULT 0,
  note               TEXT NOT NULL DEFAULT '',
  created_at         TEXT NOT NULL,
  created_by         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  updated_by         TEXT NOT NULL,
  archived_at        TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_open_id ON finance_employees(open_id) WHERE open_id <> '';

-- 工资单=某月某人一张单：本月数（应发/个人社保/专项附加/减免）+ 累计预扣快照
-- （此前累计从同年此前工资单求和而来，快照落库=事后可查当时的算数依据）。
-- 月份×人唯一；账本侧登记工资仍走提案卡/台账，工资单不自动落账。
CREATE TABLE IF NOT EXISTS finance_payslips (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id         INTEGER NOT NULL REFERENCES finance_employees(id),
  month               TEXT NOT NULL,
  gross_cents         INTEGER NOT NULL,
  social_cents        INTEGER NOT NULL DEFAULT 0,
  extra_deduct_cents  INTEGER NOT NULL DEFAULT 0,
  relief_cents        INTEGER NOT NULL DEFAULT 0,
  months_count        INTEGER NOT NULL,
  gross_prev_cents    INTEGER NOT NULL DEFAULT 0,
  social_prev_cents   INTEGER NOT NULL DEFAULT 0,
  extra_prev_cents    INTEGER NOT NULL DEFAULT 0,
  relief_prev_cents   INTEGER NOT NULL DEFAULT 0,
  withheld_prev_cents INTEGER NOT NULL DEFAULT 0,
  taxable_cum_cents   INTEGER NOT NULL DEFAULT 0,
  tax_cents           INTEGER NOT NULL,
  net_cents           INTEGER NOT NULL,
  negative_diff_cents INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'draft',
  note                TEXT NOT NULL DEFAULT '',
  created_at          TEXT NOT NULL,
  created_by          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  updated_by          TEXT NOT NULL,
  UNIQUE(employee_id, month)
);
CREATE INDEX IF NOT EXISTS idx_payslips_month ON finance_payslips(month);
CREATE INDEX IF NOT EXISTS idx_payslips_employee ON finance_payslips(employee_id);

-- 期初累计（2026-11-01 用户拍板：年中启用，前面月份没在系统里的按 0 登记，有数的填这里）。
-- 一人一年一条：截至 through_month 月末的累计应发/个人社保公积金/专项附加/减免/已预扣个税，
-- 算工资单时并入"此前累计"入参；through_month 及之前的月份不再出单（否则双计）。
CREATE TABLE IF NOT EXISTS finance_payroll_openings (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id    INTEGER NOT NULL REFERENCES finance_employees(id),
  year           TEXT NOT NULL,
  through_month  TEXT NOT NULL,
  gross_cents    INTEGER NOT NULL DEFAULT 0,
  social_cents   INTEGER NOT NULL DEFAULT 0,
  extra_cents    INTEGER NOT NULL DEFAULT 0,
  relief_cents   INTEGER NOT NULL DEFAULT 0,
  withheld_cents INTEGER NOT NULL DEFAULT 0,
  note           TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL,
  created_by     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  updated_by     TEXT NOT NULL,
  UNIQUE(employee_id, year)
);

-- 附件归档（2026-10-26，任务全图 B3 回单/单据归集）：文件落磁盘、DB 只存索引与哈希。
-- 删除=软删（摘除引用），文件留在盘上——档案维的证据不物理消灭。
CREATE TABLE IF NOT EXISTS finance_attachments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id    TEXT NOT NULL REFERENCES finance_entries(id),
  file_name   TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  ext         TEXT NOT NULL DEFAULT '',
  mime        TEXT NOT NULL DEFAULT '',
  size        INTEGER NOT NULL,
  sha256      TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  deleted_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_attachments_entry ON finance_attachments(entry_id);

-- 银行流水行（2026-10-26，任务全图 B1 逐笔比对）：对账单明细的落点，不是账本——
-- 账本事实源仍只有 finance_entries；这里只存"银行侧说了什么"和"人对上了哪笔"。
-- (account, fp) 唯一：同一份流水重复导入幂等。matched_entry_id 只代表人工/自动比对结论，不调平。
CREATE TABLE IF NOT EXISTS finance_bank_lines (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  account          TEXT NOT NULL,
  date             TEXT NOT NULL,
  direction        TEXT NOT NULL,
  amount_cents     INTEGER NOT NULL,
  counterparty     TEXT NOT NULL DEFAULT '',
  ref              TEXT NOT NULL DEFAULT '',
  note             TEXT NOT NULL DEFAULT '',
  fp               TEXT NOT NULL,
  matched_entry_id TEXT NOT NULL DEFAULT '',
  batch            TEXT NOT NULL DEFAULT '',
  created_by       TEXT NOT NULL,
  created_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_lines_fp ON finance_bank_lines(account, fp);
CREATE INDEX IF NOT EXISTS idx_bank_lines_account_date ON finance_bank_lines(account, date);

-- 现金/账户盘点（2026-10-26，任务全图 B2）：只记录"某刻实盘多少 vs 账面多少"，差异出清单不调平——
-- 差异要调，走记账/冲销的正常写路径，盘点记录不碰余额。
CREATE TABLE IF NOT EXISTS finance_cash_counts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account      TEXT NOT NULL,
  as_of        TEXT NOT NULL,
  counted_cents INTEGER NOT NULL,
  book_cents   INTEGER NOT NULL,
  diff_cents   INTEGER NOT NULL,
  note         TEXT NOT NULL DEFAULT '',
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cash_counts_account ON finance_cash_counts(account);

-- 智能体会话（2026-10-27，框架定版：对话域完整化）。应用层会话 id 与 DSH SDK 会话 id
-- 分开设：应用 id 给前端/REST 用，dsh_session_id 才是 runtime 子进程协议里的 sessionId；
-- 删除=应用层级联删两张表（事务，AgentService 负责），不靠外键级联。
CREATE TABLE IF NOT EXISTS agent_sessions (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL DEFAULT '新会话',
  dsh_session_id TEXT NOT NULL,
  created_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  archived       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_updated ON agent_sessions(updated_at);

-- 会话消息：user 原文与 assistant 终文都落库（刷新/重启后历史可回看）。
-- tools=本轮工具名 JSON 数组；status: ok 正常 | interrupted 用户中断 | error 轮次失败。
CREATE TABLE IF NOT EXISTS agent_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id),
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  tools      TEXT NOT NULL DEFAULT '[]',
  status     TEXT NOT NULL DEFAULT 'ok',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_messages_session ON agent_messages(session_id, id);

-- 融合层（2026-10-28，融合架构方案 P0）：平台身份白名单（默认拒绝——没有 allowed=1
-- 条目的平台用户一律不响应）+ 平台会话到应用会话的映射。平台数据只读拉取不建影子库，
-- 这两张表只存"谁在平台侧、聊到了哪个会话"，不存业务数据。
CREATE TABLE IF NOT EXISTS bridge_identities (
  platform        TEXT NOT NULL,
  platform_userid TEXT NOT NULL,
  username        TEXT NOT NULL,
  display_name    TEXT NOT NULL DEFAULT '',
  allowed         INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT,
  PRIMARY KEY (platform, platform_userid)
);

CREATE TABLE IF NOT EXISTS bridge_sessions (
  platform        TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (platform, conversation_id)
);

-- 运行期键值（2026-10-29 飞书 OA 审批进场）：审批定义 approval_code、已处理的审批实例码
-- （事件重推幂等）。运行期状态不进审计也不进文档，重启即取回。
CREATE TABLE IF NOT EXISTS app_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT
);

-- 飞书部门 → 系统角色映射（2026-10-29 用户拍板第一期：职能型组织，部门=角色）。
-- scope 是数据地盘占位（小组型组织二期启用）：一期恒 '*' 不参与任何判定，映射落角色时原样带过。
CREATE TABLE IF NOT EXISTS feishu_org_rules (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  department_id   TEXT NOT NULL UNIQUE,
  department_name TEXT NOT NULL DEFAULT '',
  role            TEXT NOT NULL,
  scope           TEXT NOT NULL DEFAULT '*',
  created_at      TEXT NOT NULL,
  updated_at      TEXT
);

-- 飞书组织架构镜像（2026-10-29 用户拍板第二步：部门树同步，映射配置从"手填 od-xxx"
-- 变成"选部门"）。表=最近一次同步的快照（全量替换，不追增量），映射规则是配置不随镜像删。
CREATE TABLE IF NOT EXISTS feishu_departments (
  department_id TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  parent_id     TEXT NOT NULL DEFAULT '',
  member_count  INTEGER NOT NULL DEFAULT 0,
  synced_at     TEXT NOT NULL
);

-- 义务/待办统一表（2026-10-31 待办预警方案 §四）：预警/待办/晨报是同一实体的三种投影。
-- 推导型义务（origin=scan）的真相源在原表（账本/票夹/提案/用户表），这里只是投影+处置层：
-- 「已完成」=先用扫描器核实源头（消失→resolved；仍在→告知并恢复提醒；无法核实如申报→要备注），
-- 强制确认完成=必填备注落 dismissed（永久，源头重现不再建）；源头消失=自动闭合。
-- 推导型可改到期/严重度/责任人（user_edited=1 后扫描刷新不覆盖这三项）；标题/说明由扫描器维护。
-- dedupe_key 唯一：同源同事只一条，重复扫描幂等；due_date 变化=换 key（旧的自动闭合）。
CREATE TABLE IF NOT EXISTS obligations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type      TEXT NOT NULL,
  source_ref       TEXT NOT NULL DEFAULT '{}',
  dedupe_key       TEXT NOT NULL UNIQUE,
  title            TEXT NOT NULL,
  detail           TEXT NOT NULL DEFAULT '',
  owner_type       TEXT NOT NULL,
  owner_id         TEXT NOT NULL,
  due_date         TEXT NOT NULL DEFAULT '',
  severity         TEXT NOT NULL DEFAULT 'info',
  status           TEXT NOT NULL DEFAULT 'open',
  origin           TEXT NOT NULL DEFAULT 'scan',
  first_seen_at    TEXT NOT NULL,
  escalated_at     TEXT,
  last_notified    TEXT NOT NULL DEFAULT '',
  resolved_at      TEXT,
  dismissed_by     TEXT NOT NULL DEFAULT '',
  dismissed_reason TEXT NOT NULL DEFAULT '',
  dismissed_at     TEXT,
  done_by          TEXT NOT NULL DEFAULT '',
  done_at          TEXT,
  done_note        TEXT NOT NULL DEFAULT '',
  user_edited      INTEGER NOT NULL DEFAULT 0,
  created_by       TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_obligations_owner ON obligations(owner_type, owner_id, status);
CREATE INDEX IF NOT EXISTS idx_obligations_source ON obligations(source_type, status);
CREATE INDEX IF NOT EXISTS idx_obligations_due ON obligations(due_date);

-- 扫描运行记录：每轮每扫描器跑了多少/新建多少/去重多少/自动闭合多少/失败原因。
-- 是 scan_runs 不是审计——它是机器动作的对账层，审计表只记人的动作。
CREATE TABLE IF NOT EXISTS scan_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  scanner       TEXT NOT NULL,
  ran_at        TEXT NOT NULL,
  found         INTEGER NOT NULL DEFAULT 0,
  created       INTEGER NOT NULL DEFAULT 0,
  deduped       INTEGER NOT NULL DEFAULT 0,
  auto_resolved INTEGER NOT NULL DEFAULT 0,
  errors        TEXT NOT NULL DEFAULT '',
  duration_ms   INTEGER NOT NULL DEFAULT 0
);

-- 义务路由（source_type → 默认责任归属）：机制=底层系统，这份配置=企业落地数据；
-- 没配的 source_type 兜底给 boss。enabled=0 时该扫描器停扫（只停新建，存量照常视图可见）。
CREATE TABLE IF NOT EXISTS obligation_routes (
  source_type TEXT PRIMARY KEY,
  owner_type  TEXT NOT NULL DEFAULT 'user',
  owner_id    TEXT NOT NULL DEFAULT 'boss',
  enabled     INTEGER NOT NULL DEFAULT 1
);

-- 生产供应链域（2026-11-01 生产任务全图 v0，通道A=文件导入起步）。结构级守门：全域无金额/价格列——
-- "值多少钱"是财务域的事，这里只有数量与日期；非标文件里的金额列在导入解析时剥除并在预览里披露。
-- 数量一律存"毫单位"（INTEGER，×1000），边界层换算——与账本"分"同一思路，小数不漂。

-- 物料主数据：编码唯一事实源。safety_milli 可空=未设安全线（不参与安全线预警）；
-- 删除=归档（archived_at），不物理删——快照/采购单都引用它。
CREATE TABLE IF NOT EXISTS supply_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  unit         TEXT NOT NULL DEFAULT '',
  category     TEXT NOT NULL DEFAULT '',
  safety_milli INTEGER,
  note         TEXT NOT NULL DEFAULT '',
  archived_at  TEXT,
  created_at   TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  updated_by   TEXT NOT NULL
);

-- 物料别名（编码映射地基）：外部系统/导出表里的别的叫法 → 主编码。一个别名只挂一个物料；
-- 导入解析按 编码→别名 两级落 identity。
CREATE TABLE IF NOT EXISTS supply_item_aliases (
  alias      TEXT PRIMARY KEY,
  item_id    INTEGER NOT NULL REFERENCES supply_items(id),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_supply_aliases_item ON supply_item_aliases(item_id);

-- 库存快照：观察流水，不调平——"某刻某仓某个物料有多少"的读数。同键（物料+仓库+批次+日期+来源）
-- 唯一（下面的 UNIQUE 索引是硬护栏，导入层先查后写只是让它走覆盖而不是撞错）：重复导入同一份
-- 文件幂等跳过；同键数量变了=最新读数覆盖（人重新报数）。
-- 批次（2026-11-01 S5 批次/效期）：''=总量行（老口径，不报批次照常导）；非空=该仓该批次读数，
-- 效期跟着批次走。同仓同日混报总量与批次在导入层整批拒（"最新读数"算不清哪行算数）。
-- "最新库存"查询=每键取 snapshot_date 最大（同日同键多来源取 id 最大）的那条；同仓同日批次行
-- 优先于总量行（批次行更细，总量行只是它的合计）。
CREATE TABLE IF NOT EXISTS supply_inventory_snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id       INTEGER NOT NULL REFERENCES supply_items(id),
  warehouse     TEXT NOT NULL DEFAULT '主仓',
  batch_no      TEXT NOT NULL DEFAULT '',
  expiry_date   TEXT NOT NULL DEFAULT '',
  qty_milli     INTEGER NOT NULL,
  snapshot_date TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT 'import',
  fp            TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_supply_snap_key ON supply_inventory_snapshots(item_id, warehouse, batch_no, snapshot_date, source);

-- 采购单行（一行=一张单的一个物料；同单多物料=多行共享 po_no）。状态 open/received/cancelled；
-- 收货/取消改状态不删行。同键（po_no+物料）唯一（UNIQUE 索引硬护栏）：重复导入幂等，内容变了=最新口径覆盖。
CREATE TABLE IF NOT EXISTS supply_purchase_orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  po_no         TEXT NOT NULL,
  item_id       INTEGER NOT NULL REFERENCES supply_items(id),
  supplier      TEXT NOT NULL DEFAULT '',
  qty_milli     INTEGER NOT NULL,
  ordered_date  TEXT NOT NULL DEFAULT '',
  promised_date TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'open',
  received_date TEXT NOT NULL DEFAULT '',
  note          TEXT NOT NULL DEFAULT '',
  fp            TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  updated_at    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_supply_po_key ON supply_purchase_orders(po_no, item_id);
CREATE INDEX IF NOT EXISTS idx_supply_po_status ON supply_purchase_orders(status, promised_date);
`

/** 老库加列（CREATE TABLE IF NOT EXISTS 覆盖不到已存在的表）。按表、按序幂等。 */
const ADDED_COLUMNS: { table: string; name: string; ddl: string }[] = [
  { table: 'finance_entries', name: 'approved_by', ddl: "ALTER TABLE finance_entries ADD COLUMN approved_by TEXT NOT NULL DEFAULT ''" },
  { table: 'finance_entries', name: 'reverses', ddl: "ALTER TABLE finance_entries ADD COLUMN reverses TEXT NOT NULL DEFAULT ''" },
  { table: 'finance_entries', name: 'reversed_by', ddl: "ALTER TABLE finance_entries ADD COLUMN reversed_by TEXT NOT NULL DEFAULT ''" },
  // 批量导入提案（2026-10-21）：single=单笔记账卡片，import=批量导入卡片（payload={rows}）
  { table: 'finance_proposals', name: 'kind', ddl: "ALTER TABLE finance_proposals ADD COLUMN kind TEXT NOT NULL DEFAULT 'single'" },
  // P4 调岗自动同步（2026-10-30）：绑定来源列——重算只动 mapping 来源，manual 保留；
  // 存量行默认 manual（不动最安全），映射落的存量角色上线时对库跑一次 applyOrgRules 重刷成 mapping
  { table: 'user_roles', name: 'source', ddl: "ALTER TABLE user_roles ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'" },
  // 待办完善（2026-10-31 二批）：完成备注；推导项用户改过到期/严重度/责任人后扫描刷新不覆盖
  { table: 'obligations', name: 'done_note', ddl: "ALTER TABLE obligations ADD COLUMN done_note TEXT NOT NULL DEFAULT ''" },
  { table: 'obligations', name: 'user_edited', ddl: 'ALTER TABLE obligations ADD COLUMN user_edited INTEGER NOT NULL DEFAULT 0' },
  // 票夹义务维（2026-11-01 财务残余 A1/A2）：红冲执行日——销项计税聚合按"红冲冲减执行当月"口径归月
  // （申报口径），票期归月会算错跨月红冲；老红票（列空）按票期归月并在响应里如实披露
  { table: 'finance_invoices', name: 'red_date', ddl: "ALTER TABLE finance_invoices ADD COLUMN red_date TEXT NOT NULL DEFAULT ''" },
  // S5 批次/效期（2026-11-01）：批次号与到期日挂在快照行上；''=总量行（老口径）。效期必须有批次。
  { table: 'supply_inventory_snapshots', name: 'batch_no', ddl: "ALTER TABLE supply_inventory_snapshots ADD COLUMN batch_no TEXT NOT NULL DEFAULT ''" },
  { table: 'supply_inventory_snapshots', name: 'expiry_date', ddl: "ALTER TABLE supply_inventory_snapshots ADD COLUMN expiry_date TEXT NOT NULL DEFAULT ''" },
  // 审批落账（2026-11-01 融合方案 §5 P2）：提案来源标识 `feishu-approval:<instance_code>`——占坑键崩溃
  // 后被 30 分钟清理重跑时，靠它查重不建第二笔；手工/agent 提案留空
  { table: 'finance_proposals', name: 'origin', ddl: "ALTER TABLE finance_proposals ADD COLUMN origin TEXT NOT NULL DEFAULT ''" },
]

export function migrate(db: import('better-sqlite3').Database): void {
  const byTable = new Map<string, Set<string>>()
  for (const col of ADDED_COLUMNS) {
    let cols = byTable.get(col.table)
    if (cols === undefined) {
      cols = new Set((db.prepare(`PRAGMA table_info(${col.table})`).all() as { name: string }[]).map((c) => c.name))
      byTable.set(col.table, cols)
    }
    if (cols.size === 0) continue // 表不存在：SCHEMA_SQL 会带新列建出来
    if (!cols.has(col.name)) {
      db.exec(col.ddl)
      cols.add(col.name)
    }
  }
  // 加列后才能建的索引（SCHEMA_SQL 先于本函数跑，老库此时列才刚补上）
  db.exec('CREATE INDEX IF NOT EXISTS idx_proposals_origin ON finance_proposals(origin)')
  rebuildSnapshotUniqueIndex(db)
}

/** 唯一索引变形重建（2026-11-01 S5）：老库的 uq_supply_snap_key 是四列（物料+仓库+日期+来源），
 *  同仓同日多批次行会被它压死——列形不含 batch_no 就删了按五列重建。幂等；老键唯一蕴含新键唯一
 *  （新键只多了列），存量数据重建不会撞。 */
function rebuildSnapshotUniqueIndex(db: import('better-sqlite3').Database): void {
  const cols = (db.prepare('PRAGMA index_info(uq_supply_snap_key)').all() as { name: string }[]).map((c) => c.name)
  if (cols.includes('batch_no')) return
  db.exec('DROP INDEX IF EXISTS uq_supply_snap_key')
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_supply_snap_key ON supply_inventory_snapshots(item_id, warehouse, batch_no, snapshot_date, source)')
}

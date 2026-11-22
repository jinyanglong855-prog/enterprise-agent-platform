# 生产供应链域（supply）—— v0 / v0.5 / v0.5.1

> 立项与范围权威：`公司智能体/项目状态/生产供应链任务全图.md`（§4-1 v0、§4-2 v0.5）。本 README 是模块边界、口径与诚实偏离清单的权威；状态页只放指针。
> v0 落地：2026-11-01（分支 supply-v0 三提交的净差异以 ac8158c 一次干净提交进 main；已部署 3210）。
> v0.5 落地：2026-11-01 晚（安全线改**按物料合计比**〔用户拍板〕、S5 批次/效期、通道 B 多维表格只读同步、R1 月报+晨报生产切片；同日真机交付，曾部署 3210——收口时曾被财务线审批落账激活部署顶掉，**11-02 00:13 随其合并重建部署恢复在线、两线同上**，详见「测试」节末尾）。
> v0.5.1 落地：2026-11-02 凌晨（第一批加固，用户拍板"就按建议的走"+"全部完成再收口"：临期窗口参数化〔30→90 缺省，域设置〕、扫描前自动同步多维表格、导入两类非阻断提示〔首见仓库名/总量行顶批次行〕、仓库名归一；同日部署 3210 真机验证在线）。

## 职责

- 物料编码地基：物料主数据 + 别名映射（外部系统/供应商对同一物料的别的叫法），导入与问数都按"先编码后别名"两级解析。
- 两张事实表：库存快照（观察流水，不调账——最新一次报数就是当前库存；v0.5 起每行可带**批次号/效期**，两列都空=老口径"总量行"）、采购单行（一行=一张单的一个物料，状态 open/received/cancelled，收货/取消改状态不删行）。
- 数据通道 A=文件导入（CSV/TSV 粘贴或上传，固定中文模板，三种 kind：items / inventory / pos），预览不落库、提交事务原子。
- 数据通道 B=飞书多维表格只读同步（v0.5）：运行时对飞书**零写**（拿 tenant_access_token 的 POST 除外），拉记录→列感知归一→复用通道 A 同一解析器与守门落库，`source='bitable'`、批次号前缀 `SUPB-`；快照 UNIQUE 键含来源，两通道互不踩。
- 五件事：库存查询、安全线预警（v0.5 起**按物料合计比**）、采购台账、到货逾期预警、批次临期/过期预警——预警走义务域扫描器（`scan.supply.below_safety` / `scan.supply.po_overdue` / `scan.supply.expiry_near`）进待办中心与晨报。
- 生产月报（R1）：`GET /api/supply/report/monthly` 数量口径四块（库存变动/采购到货/批次效期/预警进出）+ 前端月报页 + 老板晨报【生产切片】一行（全零或没物料时整行不出现）。
- 对话侧只读问数：`deepseek-harness/default-workspace/plugins/dsh-supply-tools.mjs`（`supply_inventory` / `supply_purchase_orders` / `supply_monthly_report`），经 `finance-desk-rest.patch.yml` 注册。

## 非职责（结构级红线）

- **不碰钱**：四张表没有任何金额/单价/价格列（`supply-api.test.ts` 用 PRAGMA 钉死）；导入解析把金额类列头（`MONEY_COLUMN_RE`：金额/单价/价格/总价/总额/合计/含税/不含税/税额/货款/折后/折扣/amount/price/cost）一律剥除并在预览 `strippedMoneyColumns` 披露；月报也是纯数量口径，"这个月花了多少钱"归财务域。"值多少钱"属于财务域，插件描述里明说让 agent 转问财务。
- 不做进销存操作界面、不做报工排产、不做质量追溯（红海禁建，全图 §2）。
- 不做 MES/ERP 直连：`mes.*` 扫描器槽仍预留给外部系统（见 `todos/README.md`「扫描器契约与 MES 预留槽」）；本域扫描器用 `scan.supply.*` 前缀，是框架内第一个按 ScannerDef SPI 挂进来的非财务域。
- **通道 B 只读纪律**（v0.5 新增）：同步服务对飞书只有 GET 记录 + POST 换 token 两种调用，测试里用假飞书钉死（除 token 外出现任何写调用即报错并断言失败）；登记册改配置、写库都发生在本侧。`mes.*` 槽启用时同此审。

## 目录

| 文件 | 内容 |
| --- | --- |
| `supply.types.ts` | 数量换算（毫单位 ×1000：`qtyToMilli` 上限 1e12、≤3 位小数用最短往返字符串判；`milliToQty`/`fmtQty`）、采购单状态集与标签、`MONEY_COLUMN_RE`、`DEFAULT_EXPIRY_WARN_DAYS=90`（临期窗口缺省，真值在域设置）+ `SUPPLY_SETTINGS_KEY` 与可设范围 1–365、行类型 |
| `supply.service.ts` | 物料 CRUD/归档/别名（别名不得与任何编码撞名）、`resolveItemRef` 两级解析、`ensureItem` 陌生编码建档、读口径（`latestStockRows` 当前最新读数=日期最大同日 id 最大；`latestStockRowsAsOf(asOf)` 截止日回看〔月报用〕；同仓同日**批次行优先于总量行**；`belowSafetyRows` 按物料合计比；`expiringRows(today, warnDays, asOf)` 临期名单〔warnDays 缺省取域设置〕；`listPos`+`countPos` 同一筛选）、`updatePo` 状态机、`summary`、`briefingSlice` 晨报切片〔读数早于今天时尾注"库存数据截至 X"〕、`monthlyReport`〔临期窗口取设置〕、域设置 get/set（app_meta `supply.settings`，改=admin:manage、审计留前后值；坏存储回缺省不让扫描失明）；`FP_SEP`（指纹分隔符用控制字符，不用 `\|`） |
| `supply-imports.service.ts` | 三种导入的解析/预览/提交；v0.5：库存模板多"批次/效期"两可选列（效期必须跟着批次走）、同仓同日混报总量与批次**整批拒**（键按解析后的物料算，别名与主编码混写绕不过）、进键文本剥控制字符；仓库名 `normalizeWarehouse`（控制字符/全角空格/连续空白归一，不做同义词字典）+ `inventoryHints` 两类**非阻断提示**（首次出现的仓库名〔只提示不拦〕、总量行顶掉批次行〔说出"批次与效期将从临期名单消失"的后果〕，预览/提交/审计 detail 都带）；`commit(source)` 支持通道 B；幂等口径与披露清单见下 |
| `supply-bitable.service.ts` | 通道 B 全部：登记册（app_meta 单键 `supply.bitable.registry`）、翻页拉记录（page_size 500 × ≤20 页）、列感知归一（仅日期列把毫秒时间戳转 YYYY-MM-DD，批次等文本列的长数字原样保留）、dryRun 试跑、类隔离、unchanged、`configuredKinds()`（已登记 table_id 的类，扫描前自动同步只拉这些）、导入层 hints 透传（试跑与真同步都带）、`supply.bitable.sync` 审计 |
| `supply.controller.ts` | REST `/api/supply/*`，读=`supply:read`、写=`supply:write`；登记册与域设置改=`admin:manage` |

表在 `db/schema.ts` 末段：`supply_items` / `supply_item_aliases` / `supply_inventory_snapshots`（v0.5 起含 `batch_no`/`expiry_date` 两列，UNIQUE item+仓库+**批次**+日期+来源；老库迁移自动补列并把旧四列索引重建成五列——旧键唯一蕴含新键唯一，存量数据不会撞，迁移幂等可重开）/ `supply_purchase_orders`（UNIQUE po_no+item）。

## REST 面

| 端点 | 权限 | 说明 |
| --- | --- | --- |
| `GET /api/supply/summary` | supply:read | 物料数/归档数/低于安线数/未到货单数/逾期数/临期与过期批次数/最近快照日 |
| `GET /api/supply/items?query=&archived=1` | supply:read | 列表（默认不含归档；query 搜编码/名称/分类/别名，`%_` 已转义） |
| `GET /api/supply/items/:id` | supply:read | 单物料：各仓最新读数（含批次/效期）/合计/安全线判定/别名 |
| `GET /api/supply/below-safety` | supply:read | 安全线名单（v0.5 按物料合计比：`quantity`=各仓最新读数合计、`warehouses`=分仓明细人话；前端预警条与插件 summary 共用） |
| `GET /api/supply/expiring` | supply:read | 临期/过期批次名单（S5；`warnDays`=域设置窗口〔缺省 90〕，`daysLeft`<0=已过期） |
| `GET /api/supply/settings` | supply:read | 域设置（临期窗口）+ 可设范围；没设过=`updatedAt:null` 用缺省 |
| `PUT /api/supply/settings` | admin:manage | 改域设置：只认 1–365 整数天（数字字符串接受）；审计 `supply.settings.set` 留前后值 |
| `GET /api/supply/report/monthly?month=YYYY-MM` | supply:read | 生产月报（R1；缺省当月、未来月 400；`partial`=当月未过完；notes 带口径说明） |
| `GET /api/supply/bitable` | supply:read | 通道 B 登记册（配没配/每类上次同步留痕） |
| `POST /api/supply/items` · `PATCH /api/supply/items/:id` | supply:write | 建档/改档（`safetyStock: null` 显式撤安全线；布尔/对象等非数字类型拒，数字字符串接受） |
| `POST /api/supply/items/:id/archive` · `/unarchive` | supply:write | 归档=不进默认列表与安全线名单，不物理删（快照/采购单引用它） |
| `PUT /api/supply/items/:id/aliases` | supply:write | 覆盖式设别名集 |
| `GET /api/supply/pos?status=&itemId=&overdue=1` | supply:read | 采购单行列表，响应 `{pos, total, limit}`——列表有页长 200，`total` 是同一筛选的真实总数，前端/插件据此说"共 N 张只列前 M 张" |
| `PATCH /api/supply/pos/:id` | supply:write | 收货（到货日缺省今天）/取消/重开（非 received 清到货日） |
| `GET /api/supply/imports/template?kind=` | supply:read | 模板列头+示例+CSV |
| `POST /api/supply/imports/preview` | supply:read | 解析不落库：逐行结果/错误行号/批内重复/剥除的金额列 |
| `POST /api/supply/imports/commit` | supply:write | 事务原子提交，返回 `{created, updated, skipped, itemsCreated, archivedTargets, protectedClosed, strippedMoneyColumns, hints}`（hints=库存类非阻断提示） |
| `PUT /api/supply/bitable` | admin:manage | 设置 appToken 与三类 table_id（留空=该类不同步；改 appToken 会重置 lastSync） |
| `POST /api/supply/bitable/sync` | supply:write | 同步（`dryRun:true` 只预览不落库；各类隔离，一类失败不影响其他类；表没变=unchanged 不算错；试跑也审计——拉表花平台配额） |

服务号 `agent-runtime` 恰持 `supply:read`（HTTP 钉子覆盖十条 GET 里的九条+preview 201〔`GET /items/:id` 未单独钉，与列表同权限点〕、十个写端点全 403——含 bitable 登记与同步、域设置）。所有写动作审计：`supply.item.created/updated/archived/unarchived`、`supply.aliases.set`、`supply.po.updated`、`supply.import`（通道 A 批次号 `SUP-…`、通道 B `SUPB-…`，detail 带 `channel` 与 `hints`）、`supply.bitable.registry.set`、`supply.bitable.sync`、`supply.settings.set`。

## 导入口径（通道 A；通道 B 复用同一解析与守门）

- 模板列头固定中文，必需列缺任一 400 指路模板；多余列里命中 `MONEY_COLUMN_RE` 的剥除并披露，其他多余列静默忽略（结构上任何多余列都进不了库）。
- 行数 ≤500、体积 ≤1MB，与账本导入同一守门。
- **快照**：v0.5 起模板多"批次/效期"两可选列（老模板不带照常导）——批次留空=总量行；填了效期必须有批次（效期跟批次走，按总量报数请把效期留空）；批次 ≤64 字；进键文本（批次/仓库/单号）剥控制字符（`FP_SEP` 是 `\u001F`，透进来会撞 dedupe 键）。**同一物料同一仓同一天混报总量行与批次行整批拒**（预览标错、提交 400；键按解析后的物料算——别名与主编码混写绕不过，有测试钉住）。同键（物料+仓库+批次+日期+来源）同 fp→跳过、fp 变→最新读数覆盖（效期改判也算覆盖）；批内同键后行赢。
- **采购单**：同键（单号+物料）同 fp→跳过、变→覆盖；**库里已收货/已取消的单不被文件倒翻**——旧文件重贴时文件里的"未到货"不会把人点过的收货改回 open、不会重开逾期预警；该行状态与到货日按库里的算、其余字段照常更新，单号进 `protectedClosed` 披露；若整批只有这种差异则 400 并在人话里点名（要重开去采购台账点「重开」）。
- **物料**：已存在只补空缺字段（名称仍等于编码时才补名称）、别名只增不删；批内同编码先行建档、后行只补空缺。
- **仓库名归一与非阻断提示（v0.5.1）**：仓库值过 `normalizeWarehouse`（剥控制字符、全角空格转半角、连续空白并一、去首尾）——只抹"看不见的差异"，"主仓"与"主仓库"仍是两个仓。库里已有仓时，本批出现**首次见到的仓库名**→ 预览与提交结果带提示（列出库里已有仓名，提醒统一写法：安线按各仓合计比，拼法不同会把同一批货算两遍）；首次导入（库为空）不提示。**总量行顶掉批次行**：同物料同仓此前按批次报（库里最新读数或本批更早行有批次），本次按总量报（或同日总量行落库后不参与读数）→ 提示说明"批次与效期将从临期名单消失；货仍分批请按批次报"。两类都只提示不拦——仓是不是同一个、货是不是真合并了，只有报数的人知道；提示按物料+仓库去重、最多 10 条，同步结果（试跑/真同步）原样透传。
- 陌生编码自动建档（名称取行内或编码本身）进 `itemsCreated`，老板回头补全称/安全线；库存/采购单两种导入命中**已归档**物料照常落库（历史补录合法）但进 `archivedTargets` 披露——默认列表与安全线名单看不见它；物料主数据导入命中归档物料只补空缺字段、不自动启用、不披露（要启用去页面点「启用」）。
- 全部行与库里相同（无新增无更新）→ 400「没有新数据可导」，避免"导了但什么都没变"的假成功；通道 B 同步把这种情况识别为 `unchanged:true` 正常返回。

## 扫描器（义务域 `scan.supply.*`）

| key | 触发 | dedupe_key | 到期日 | 严重度 | closeOnAbsence |
| --- | --- | --- | --- | --- | --- |
| `scan.supply.below_safety` | 启用物料、设了安全线、**各仓最新读数合计** < 安全线（v0.5 用户拍板"按物料合计比"——分仓调拨不误报） | `:itemId`（数量/仓库变化**不换键**，标题刷最新合计+分仓明细） | 无 | 合计 ≤0 critical，否则 warn | true（补货过线即自动闭合） |
| `scan.supply.po_overdue` | open 单且承诺日 ≤ 今天+3（与应收应付同窗） | `:poId:promised_date`（**改期换键**：旧键闭合新键进场） | 承诺日 | 已过 critical，未到 warn | true（收货/取消即闭合） |
| `scan.supply.expiry_near`（v0.5 S5） | 有批次号的最新读数、数量>0、效期 ≤ 今天+窗口（域设置，缺省 90 天） | `:itemId:warehouse:batch_no`（效期改判不换键，刷标题） | 效期 | 已过期 critical，未到 warn | true（批次清零/处置即闭合） |

核实式完成（待办中心「已完成」先核实源头）对本域的同源判定：**采购单只认 poId**——同一物料常有多张单，itemId 在 PO 的 sourceRef 里是父级属性不是身份，否则 A 单改期会被排在前面的 B 单候选冒认（并进 B 的键、拿 B 的标题对人说）；**批次条目认物料+仓库+批次三元组**（v0.5，同物料其他批次冒认不了，安线条目 ref 无 batchNo 与之互不冒认）；安线行按 itemId 同源（合计比下跨仓合并是有意设计）。`SOURCE_IDENTITY_KEYS` 增 `itemId/poId/batchNo` 对财务来源零影响（财务 sourceRef 不含这三键）。

到货逾期扫描有单轮行数上限（`PO_SCAN_LIMIT=500`）：超限**整轮报错**（scan_runs 留痕）而不是截断——截断会让没进候选的在场行被 closeOnAbsence 假闭合。

**扫描前自动同步（v0.5.1）**：三轮扫描（启动对账/每日 08:30/手动）跑扫描器之前，先自动同步一次多维表格（通道 B 登记了才跑，只拉登记了 table_id 的类；对飞书只读、真落库不是试跑；操作者 `username='-'`——机器动作不进晨报「昨日全员」人工统计）。扫描基于旧数是全图 §0.5「拉」列的失败模式：拉到旧数/静默失败都要大声——同步失败**不打断扫描**（用库里现有读数总比不扫强），但写 `scan_runs` 一行（scanner=`supply.bitable.presync`，errors 非空），晨报【扫描告警】近 3 天汇总会按「多维表格预同步」标签亮出；成功也留行（found=拉到行数、created=落库变化数）供对账。已收货/已取消的采购单不被表格倒翻（protectedClosed 护住——真机已验证：表里 PO-T001 仍是"未到货"，同步不会把系统里已取消的单翻回 open 重响逾期）。

## 通道 B（飞书多维表格只读同步，v0.5）

- **登记册**：app_meta 单键 `supply.bitable.registry`——appToken + 三类 table_id（items/inventory/pos，留空=该类不同步）+ 每类 lastSync；设置走 `PUT /api/supply/bitable`（admin:manage），前端在库存物料页「多维表格」菜单里也有设置弹窗。
- **同步语义**：拉记录（分页 page_size 500、最多 20 页）→ `cellText/dateText` 列感知归一（只有日期列把毫秒时间戳转 YYYY-MM-DD；批次等文本列的长数字原样保留，不会把 `6920000000001` 变科学计数法）→ 拼成与通道 A 同构的文本 → 复用同一解析器与守门提交（`source='bitable'`，批次前缀 `SUPB-`，快照键含来源）。
- **幂等与隔离**：各类独立同步、独立报成败；表没变=`unchanged:true` 不算错；混报/精度等错误沿用通道 A 同一人话文案。
- **只读纪律**：运行时对飞书仅 GET 记录 + POST 换 token；测试以假飞书钉死。appToken/table_id 校验有格式门；飞书侧错误码给过人话映射（如 1254302/91403=没把 base 共享给本应用）。

## 生产月报与晨报切片（R1，v0.5）

- `monthlyReport(month)`：asOf=月末与今天取早者——当月看"到今天为止"（`partial=true`），历史月整月口径；未来月 400。四块：库存（月末库存+进出台账、变动榜）、采购（下单/到货/逾期）、批次效期（临期/过期，asOf 隔离：10 月月报混不进 11 月才导的批次行）、预警（进出与净变化，按来源分列）。notes 带口径说明，插件与月报页原样展示。
- 晨报【企业总览】下新增【生产切片】一行：`低于安线 N · 到货逾期 N · 临期批次 N（含过期 M） · 今日应到 N`；没建物料或全零时整行不出现（少发不打扰，与待办晨报同口径）。读数日期早于今天时行尾注`（库存数据截至 X）`（v0.5.1）——切片有事而数据是旧账时，老板得知道看的是几号的数；全零整行不发时也不单发截止日（陈旧与否由扫描前自动同步在源头管）。

## 前端

`web/apps/web-antd/src/views/supply/`：库存物料页（概览行+安线预警条〔v0.5 合计比口径：合计数+分仓明细，只列前 5 项〕+**临期批次条**〔S5，含过期时红色〕+表格〔批次号/效期随读数展示，悬停见明细〕+建档/编辑/归档+导入下拉两 kind+**多维表格下拉**〔试跑/同步/设置，设置弹窗 admin:manage；v0.5.1 起同步/试跑结果弹窗带导入层提示行〕）、采购台账页（状态/只看逾期筛选+`共 N 张`+截断提示+收货/取消/重开+导入）、**生产月报页**（R1：月份选择+库存变动/采购/批次效期〔超 20 条按 `rowsTotal` 披露〕/预警四块+口径说明+partial 提示）、共享导入弹窗（粘贴/选文件→解析预览→导入；**有错误行即禁用导入按钮**〔后端任一行非法整批回滚〕；批内重复文案按 kind；预览 hints 提示条〔v0.5.1〕；成功提示带 itemsCreated/archivedTargets/protectedClosed 三披露+hints）；**临期窗口设置按钮**（v0.5.1，admin:manage：数字输入 1–365+改后即时重载名单）。路由 `生产供应`（库存物料/采购台账/生产月报）带 `authority: ['supply:read']`（没权限的账号菜单不出现、直达走 404 兜底页）；页内写入口按 `supply:write` 显隐（只读账号看到「只读」字样而不是点了才 403）。

## 诚实偏离与已知限制（v0 对抗审查 1P0+2P1+9P2+11P3 与收口文档审查 1P1+4P2+3P3 已处置；v0.5 对抗审查 1P1+4P2+7P3 处置后仍在案的）

1. **仓库名自由文本**（v0 审查 P3-21；v0.5.1 缓解）：加了 `normalizeWarehouse`（抹控制字符/全角空格/空白差异）与首次出现仓库名的预览提示，但**不做同义词字典**——"主仓"/"主仓库"仍是两个键，合计仍会把两份读数相加；提示只能让人发现，拦不住坚持。仓库字典仍留到物料量上来后。
2. **快照覆盖更新不刷新 created_by/created_at**（v0 审查 P3-20）：同键改数时"最后报数人"只能翻审计（`supply.import`/`supply.bitable.sync` detail 有 batch 与行数，无逐行）。
3. **归档物料的未到货单照样进到货逾期预警**：归档只影响安全线名单与默认列表，不影响采购单事实；若要静默请在台账取消该单。
4. **仓库/物料编码里含 `%`/`_` 的搜索**已转义，但 `code` 本身不限制字符集（除长度 64）。
5. **插件 render 的逾期判定用本地日历日**（v0 审查 P2-8 已修），服务端 `localDate()` 同口径；两端机器时区不一致时以服务端为准（插件只做文字标注，筛选在服务端）。
6. **前端采购单客户端分页在 200 页长内**：超过时顶部信息条如实说"共 N 张只列前 200"，缩小筛选即可；没有做服务端翻页（v0 规模不需要）。
7. **提交信息漂移**（v0 审查 P3-23）：e761dc6 写"概览四格"，实际页面是一行文字概览；本 README 口径为准。
8. **历史归属**（v0 审查 P2-12a）：分支 supply-v0 曾以财务线脏提交 9314cd7 为底（该提交误带了本域早期未提交文件）；合并时改为"净差异一次干净提交 ac8158c 落 main"并删除分支，main 历史不含 9314cd7。三个分支提交的信息已折入 ac8158c 的提交说明。
9. **全图 §6「每加一个能力回图打标记」**：S1（编码地基）/S2（通道 A）/P1（库存查询+安线）/P2（采购台账+到货逾期）随 v0 落地打 ✅；S5（批次效期）/通道 B/R1（月报+晨报切片）随 v0.5 落地打 ✅。
10. **生产库两个孤儿索引**（v0 收口审查 P2-4）：`idx_supply_snap_item`/`idx_supply_po_no` 是 9314cd7 时代早期 DDL 建的非唯一索引，现行 schema.ts 已改为两个 UNIQUE 索引，但 `CREATE INDEX IF NOT EXISTS` 不会清理旧的；无害冗余。**已清（2026-11-01 晚，用户同意）**：改动前账本一致快照在框架备份 `~/.dsh/company-data/backups/framework/company-agent-framework-20261101.tar.gz` 的 `ledger-online/`；`DROP INDEX` 后重启 3210 复验两孤儿索引不再出现、两 UNIQUE 索引在，DDL 无重建语句。
11. **安线换键升级的一次性重推**（v0.5 审查 P3-1）：v0 的按仓 key 活跃条目在升级后首轮扫描被 closeOnAbsence 正常闭合（不悬挂），代价是同物料同天"旧行闭合+新 key 再进场推一次"，warn/critical 物料重响一轮——**已发生**（2026-11-01 部署当日真机观察：WL-T03 旧行自动闭合、新合计 key 进场），一次性成本。
12. **临期窗口**：~~30 天是代码常量~~ **已了结（2026-11-02 v0.5.1）**：改为域设置（app_meta `supply.settings`，GET/PUT /api/supply/settings，缺省 30→90 天，范围 1–365，admin:manage，审计留前后值），名单/扫描器/晨报/月报同一来源；按物料差异化窗口仍未做（物料表加字段，留给真实数据说话）。
13. **通道 B 单次同步沿用导入上限 500 行**：表格超限报人话错（"把历史行移走/归档，只留当前有效读数"），不做自动分批落库（fetch 侧 1 万行上限兜底）。
14. **base 加协作者缺权限域**：多维表格由应用身份创建，加协作者要 `docs:permission.member:create`。2026-11-02 用户在开放平台开了该权限后重试仍 `99991672 应用尚未开通所需的应用身份权限`（三次含等待后）——按卡壳升级停手：多半还要在「版本管理与发布」新建版本并发布才生效；加协作者脚本保留在 `/tmp/supply-bitable/mk-supply-bitable.mjs`（临时目录会清，重试时照抄步骤 5）；或在飞书 UI 直接把 base 分享给老板，代码侧无阻塞。
15. **晨报切片不构成 bossSignal**（v0.5 审查 P3-8）：路由被停用+老板无待办+全员无活跃义务的边缘配置下，切片有内容也不发整卡——接受。
16. **月报批次明细只列前 20 条**（按效期先后）：超出在页面与插件按 `rowsTotal` 如实说"共 N 条"。

## 测试

`server/test/supply-api.test.ts`（20 用例）：权限门 401/403/只读、服务号令牌 HTTP 钉子（九个 GET+preview 201、十个写 403 含 bitable 与域设置）、模板、物料 CRUD/别名撞名/归档+归档物料导入披露+LIKE 转义、库存导入（金额列剥除披露含税额/预览不落库/错误行号/幂等/改数覆盖/别名解析）、采购单导入+状态流转+`total`/`limit`+**已收货不被倒翻两路（400 点名 / 201 带 protectedClosed）**、扫描器进出场（数量变化不换键/补货闭合/零库存 critical/收货闭合/改期换键）、**合计比安线**（两仓一条不拆行/不换键刷标题/合计过线闭合/零库存 critical）、**S5 批次效期**（可选列/效期必须有批次/同仓同日混报整批拒/**别名与主编码混写绕不过**/批次行优先于总量行/总量行顶掉批次行又可回来〔顶掉那步预览与提交都带 hints 提示〕/临期端点+summary/控制字符剥除）、**临期扫描**（过期 critical/批次三元组身份不被冒认/清零闭合/效期改判刷标题）、**R1 月报**（partial 口径/四块结构/未来月 400/缺省当月/历史月整月/**批次块 asOf 隔离**）、**老库迁移**（补列+五列索引重建+数据保留+幂等重开）、核实式完成 pending→resolved、**同源判定只认 poId（突变验证：去掉修复该用例精确变红）**、summary、不碰钱 PRAGMA。`server/test/supply-bitable.test.ts`（7 用例，假飞书）：登记册校验/lastSync、真同步三类落库（SUPB 前缀/毫秒日期/缺可选列/审计 channel）、**零写钉子**、幂等 unchanged、dryRun 不落库、类隔离与部分登记报错、**扫描前自动同步**（没接通道 B 不跑/只拉已登记的类/系统身份 `username='-'`/扫描基于刚拉到的读数/scan_runs 成功失败都留行/**失败不打断九扫描器**/晨报切片尾注截止日两态）、同步结果透传 hints。全套 362 绿（2026-11-02 合并财务线审批落账 12 例后 358，本批 +4）；插件 e2e `plugins/dsh-supply-tools.test.mjs`（41 检查，起真实后端子进程，含 `supply_monthly_report` 工具与合计比/批次渲染）。

**真机验证（2026-11-01 部署后）**：多维表格「生产供应链数据」（三表 6+8+5 条测试数据，库存表镜像生产当时最新读数、WL-T03 主仓拆两条批次行）登记进生产 → 试跑 19 行全 valid → 真同步（物料/采购单 unchanged、库存 8 行 `SUPB-…` 入库）→ WL-T03 变两条批次行合计 50 过线、安线预警自动闭合 → 手动扫描：below_safety autoResolved 1、expiry_near 进场 B-2025A（warn，效期 2026-11-20）、PO-T001 逾期条目保留。**在线状态如实披露**：该部署随后（同晚 23:32）被财务线「审批落账」激活的 dist 覆盖部署顶掉——其产物自 `finance-posting` 分支构建、不含当时未提交的 v0.5；收口核实时生产 3210 为 v0 供应链口径（v0.5 三端点 404、安线逐仓比），磁盘 dist 经例行重建已回到 main（含 v0.5、不含审批落账），下次重启反向翻转。**已了结（11-02 00:13）**：财务线把 finance-posting rebase 到本线提交之上合 main（`bf1018f`+`5be16cb`）、重建、重启 3210——v0.5 三端点与审批落账同时 200，合并后全套 358/358 绿（本域 346+财务线 12）；中间未经过 08:30 日扫，义务行无翻转。

**v0.5.1 真机验证（2026-11-02 01:43 从 main `f3a1ca1` 重建部署）**：`GET /api/supply/settings` 缺省 90（没设过 `updatedAt:null`）→ 启动对账即触发扫描前自动同步：scan_runs 出现 `supply.bitable.presync` 一行（found 19、errors 空；其 `pos updated 1` 正是把表里 PO-T001 的"未到货"按护住规则不倒翻库里 cancelled 的实证）→ 手动扫描 `presync:{fetched:19,changed:0}`、九扫描器零错误、PO-T001 逾期条目保持 resolved、`GET /expiring` `warnDays:90` 且 B-2025A（效期 11-20，18 天）在场。库表 16 行快照=两通道各 8（UNIQUE 含来源，符合设计）。

下次审查条件：仓库字典落地时；`mes.*` 槽启用或通道 B 要加写路径时（应被拒，只读纪律）；临期窗口按物料差异化（物料表加字段）提上日程时；自动同步想把失败升级成"停止发晨报切片"之类的更强语义时；物料量 >500 需要服务端翻页、bitable 表 >500 行常态化时；任何要在本域加"金额"字段的提议（应被拒，去财务域）。

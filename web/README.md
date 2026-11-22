---
type: module
updated: 2026-10-27
status: active
lifecycle: active
project: 公司智能体
tags: [admin-system, frontend, vben, vue]
---

# admin-system/web（管理系统前端）

> 上游 Vue Vben Admin 的原版 README 保留在 `README.zh-CN.md` / `README.md` 已被本文件取代；框架文档见 https://doc.vben.pro

## 职责

管理系统的"脸"：登录、财务看板、流水台账、内嵌智能体对话框、账户页、票夹页（均已交付；最新为 **智能体框架定版增量**，2026-10-27——对话框升级双栏多会话（左侧会话列表+右键菜单：重命名/归档/删除，历史回看、刷新与重启恢复上次会话、中断停止）、改密页接真接口；**系统审计页同日已建即撤**（用户拍板：审计不进前端，唯一查询通道=智能体对话框的 audit_query 工具，三文件已删）；此前 2026-10-27 财务任务图扫尾（报表与归档菜单/附件挂账/双 tab 对账/现金盘点）、2026-10-26 演示残留裁剪、2026-10-21 银行对账+票夹与财务 BI 看板轻量版）。

底座 = [Vue Vben Admin](https://github.com/vbenjs/vue-vben-admin) v5 monorepo（`apps/web-antd`，Vue3 + TS + Ant Design Vue）。2026-10-17 spike 裁决：**裁得动，保留 Vben**（实测成本见下）；降级路径（Soybean/裸 Vue）不再启用，除非后续发现隐藏成本。

## 来源与版本

- 上游：`vbenjs/vue-vben-admin` main 分支 tarball（2026-10-17 下载，无 .git——升级靠重新对照上游，改动全集中在下列自有文件，不散改框架）。
- 裁剪：删除 `apps/{web-ele,web-naive,web-tdesign,web-antdv-next,backend-mock}`、`playground/`、`docs/`，`pnpm-workspace.yaml` 移除对应条目；删除根 `prepare` 脚本（lefthook 需要 .git，tarball 解包没有）。
- 原 `README.zh-CN.md` 保留作上游文档入口；`README.ja-JP.md` 与原英文版 README 已删（减少语料噪声）。

## 运行

```bash
# 前置：管理后端已在 3210（../server：npm run build && npm start）
pnpm install                              # 已装过则秒级；node_modules 可随时删掉重装（1.4GB，走全局 store 很快）
pnpm --filter @vben/web-antd run dev      # http://localhost:5666，/api 代理 → 127.0.0.1:3210
```

环境要求：Node ≥22.18（本机 24 ✓）、pnpm ≥11（本机 12 ✓，会按 packageManager 钉的 11.16 执行）。npm 源走的 npmmirror，@iconify/json 大包偶发下载超时，重跑 `pnpm install` 即续传。

## 相对上游的全部自有改动（改齐这 26 处=接上我们的后端+对话框+地基+导入三通道+BI 看板+对账与票夹+去演示残留+报表打包与附件）

| 文件 | 改动 |
| --- | --- |
| `apps/web-antd/vite.config.ts` | 代理 `/api` → `127.0.0.1:3210`（原指 mock 5320，去 rewrite）；`host: 'localhost'` 收紧绑定（上游共享配置 `host: true` 会把 dev 页面暴露到局域网） |
| `apps/web-antd/.env.development` | `VITE_NITRO_MOCK=false` |
| `apps/web-antd/src/api/request.ts` | `responseReturn: 'body'`（后端裸 REST JSON，无 code/data 信封）；删 refresh 逻辑（后端无 refresh 端点，401 直接回登录） |
| `apps/web-antd/src/api/core/auth.ts` | login 映射 `{token}`→`{accessToken}`；权限码复用 `/auth/me`；logout 纯前端（JWT 无状态）；删未使用的 `baseRequestClient` import（typecheck 修复） |
| `apps/web-antd/src/api/core/user.ts` | `/auth/me` → Vben UserInfo（homePath='/finance'）；2026-10-27 框架定版追修：**权限码并入 roles**（`['boss', ...me.permissions]`）——Vben 前端模式的菜单过滤 `meta.authority` 只对照 roles 数组，不并进去挂了 authority 的菜单永远被滤掉（实况抓的运行时 bug，见工作日志追记） |
| `apps/web-antd/src/views/_core/authentication/login.vue` | 去掉 mock 账号下拉与滑块验证码；2026-10-26 增量关掉手机号/扫码登录、注册、忘记密码、第三方登录五个演示入口（AuthenticationLogin 开关 props） |
| `apps/web-antd/src/router/routes/modules/` | 2026-10-26 裁剪：删上游演示路由 `dashboard.ts`/`demos.ts`/`vben.ts`（概览/演示/项目/关于菜单随之消失）；`Profile`（/profile，头像下拉在用）从 vben.ts 拆出保留为 `profile.ts`；modules 目录自动扫描，删文件即删菜单 |
| `apps/web-antd/.env` | 2026-10-26：`VITE_APP_TITLE` → 「公司智能体」（登录页/侧栏/浏览器标题品牌） |
| `apps/web-antd/src/preferences.ts` | 2026-10-26：`app.defaultHomePath: '/finance'`（登录直达月度看板，上游默认首页分析页已删）；`copyright: { enable: false }`（上游 Vben 公司名+闽ICP备案号链接不适用）；删 `appCopyrightPreferences` import |
| `apps/web-antd/src/locales/langs/{zh-CN,en-US}/authentication.json` | 新增（2026-10-26）：覆写上游登录页演示文案——pageTitle/pageDesc 换「公司钱账与智能体工作台 / 记账·问数·对账·票夹·申报备料」，loginSubtitle 换「请登录公司管理台」（应用语言包按目录合并覆写 @vben/locales 同名键） |
| `apps/web-antd/src/api/finance.ts` | 新增：财务 REST 客户端（列表/详情/记账/更新/软删除 + 类型/状态中文标签映射；2026-10-21 增量补 imports 三端点与 kind=import 提案类型；同日 BI 增量补 `EntryFilter.due_before` 透传与 `getSummaryApi`/`FinanceSummary` 汇总类型；同日对账+票夹增量补票夹 CRUD/挂联解挂/缺票清单（`total` 真实总数）/对账预览 API 与类型、方向与状态中文标签；2026-10-27 增量补附件四端点（上传 base64/列表/下载/摘除）、银行流水导入/清单/配对/删除、现金盘点、票-账猜挂、报表四端点（凭证对照/往来对账单/检查应答包/年度归档）） |
| `apps/web-antd/src/views/finance/summary.vue` + `src/router/routes/modules/finance.ts` | 新增：月度看板页与路由（modules 目录自动扫描）；2026-10-21 BI 增量整页重写——原三卡+分类型表原样保留，加环比条 4 卡（收入/流出/利润参考/逾期未结，含较上月与较上月末）与四图编排：6 次 summary（以服务端 month 为锚倒推）+ 2 次 entries（due_before 今天/当月 1 日）；allSettled 降级（失败月按 0 计并标注、逾期失败态、本月失败错误态替代骨架）；账龄按本地零点严格 ISO 解析分桶、脏日期剔除；同日对账+票夹增量路由模块加 `invoices`（票夹，`lucide:receipt`） |
| `apps/web-antd/src/views/finance/bi/` | 新增（2026-10-21）：四个 ECharts 图表组件（走 `@vben/plugins/echarts` 的 `EchartsUI`+`useEcharts`，零新依赖）——`flow-trend.vue` 近 6 月收支双柱+利润趋势线、`category-pie.vue` 支出分类环形、`receivable-payable.vue` 已收未收/已付未付横向堆叠、`overdue-aging.vue` 账龄四桶分应收/应付双条；全 0 时各显一句人话空态不画假坐标轴；渲染后 400ms 补一次 `resize()`（硬刷新进场动画期的瞬态挤压补偿） |
| `apps/web-antd/src/views/finance/accounts/` | 新增（2026-10-20）：账户页——建档/改期初余额/停用，余额=期初+Σ已收−Σ已付（10-20 地基增量；此前漏记于本清单，10-21 补录）；2026-10-21 对账+票夹增量加操作列「对账」按钮 + `reconcile-modal.vue`（截止日+抄入对账单余额 → 三卡"账面/对账单/差额"+人话提示+截止日后流水表，超 20 条分页；清空守卫按 `== null` 写因 ant InputNumber 清空值为 null）；2026-10-27 扫尾增量——`reconcile-modal.vue` 升级双 tab（Tab1 余额对照原样；**Tab2 银行逐笔比对**：粘贴/导入流水 CSV→指纹幂等→自动配对→人工配对→三清单「对上/银行有账本没有/账本有银行没有」，粘贴区提示流水号别空防配错）+ `cashcount-modal.vue` 现金盘点（实点/账面/差额，只记差不调平） |
| `apps/web-antd/src/views/finance/invoices/` | 新增（2026-10-21）：票夹页三件——`index.vue` 两 tab（票夹列表：方向/状态/对方/月份筛选+登记票；缺票清单：按月筛选、"共 N 笔"真实总数、超上限橙字提示只显最早 N 笔，挂联/解挂后两 tab 自动刷新）、`invoice-form-modal.vue`（登记/编辑双模式，编辑态票面金额与方向冻结只开放票号/日期/对方/状态/备注）、`invoice-detail-drawer.vue`（Descriptions 票信息+挂联账目表+挂联/解挂，宽 640；`fetchSeq` 守卫丢弃过期响应）；失败 toast 由拦截器单点负责，页面 catch 只记日志 |
| `apps/web-antd/src/views/finance/ledger/index.vue` | 新增：流水台账页——筛选栏（类型/状态/月份/对方）、表格、记一笔/编辑弹窗、详情抽屉、作废与删除确认；列表一次性取 100 条前端分页（后端暂无 offset 分页，月账量够用）；2026-10-20 增量补出数管理/冲销；2026-10-21 增量补「导入流水」按钮+弹窗挂载、行选择与批量条（多选改状态/分类/账户，冲销对/cancelled 禁选，load 后清勾选）；2026-10-27 增量补「报表与归档」工具栏菜单（Dropdown **trigger=['click']**，点击处理器必须挂在 overlay 内 `<Menu @click>`——ant-design-vue 的 Dropdown 自身不发 click 事件，挂 Dropdown 上菜单项永远没反应，真浏览器验收抓到）挂载报表三弹窗 |
| `apps/web-antd/src/views/finance/ledger/statement-modal.vue` + `pack-modal.vue` + `archive-modal.vue` | 新增（2026-10-27）：报表三弹窗——`statement-modal` 往来对账单（按对方：期初未结→期间明细→期末未结，txt 复制/下载）、`pack-modal` 检查应答包（按期间：账目汇总+票清单+银行流水+人话口径说明，复制/下载）、`archive-modal` 年度归档（下载不可变 JSON 包，展示 bundle 哈希与逐节 sha256、银行流水截断标志） |
| `apps/web-antd/src/views/finance/ledger/entry-form-modal.vue` + `entry-detail-drawer.vue` | 新增：记账/编辑双模式弹窗（类型带默认状态、编辑态追加跟进记录）与详情抽屉（字段全览 + 跟进时间线）；`onTypeChange` 入参类型收窄（typecheck 修复）；2026-10-27 增量补详情抽屉**附件挂账**（上传 base64/列表/下载/摘除，白名单+单件 ≤8MB 由后端守门；摘除文案明示"记录与文件仍留档，界面上不再显示，恢复需管理员操作数据库"——软删如实声明） |
| `apps/web-antd/src/api/agent.ts` | 新增：财务台对话 API 客户端——`chatStreamApi` 用 fetch 读 SSE 并手工解析 `event:`/`data:` 帧并手工解析（requestClient 无流式能力）；2026-10-27 框架定版重写为多会话：会话 CRUD（list/create/getMessages/patch〔requestClient 无 `.patch()`，走通用 request〕/delete/stop）+ chatStream 带 sessionId + fresh-context/interrupted 帧类型；旧 session/reset API 已删 |
| `apps/web-antd/src/views/agent/chat.vue` + `render.ts` | 新增：财务台对话框页——ant-design-x-vue 的 Bubble/Sender/Welcome，工具调用聚成标签、回答走轻量 md 渲染（`render.ts` 先整体 HTML 转义再注入标签，防 XSS）；2026-10-21 增量补「📎 丢文件给财务台」上传入口（`readFileText` GBK 兜底解码、文件名空白归一）；2026-10-27 框架定版整页重写为**双栏**：左 aside 会话列表（Conversations 组件+「新会话」+已归档开关；组件的 disabled 项不渲染菜单 icon——归档项改 label「（已归档）」后缀+onSwitch 拦截）+右 Card 气泡流；每项「…」菜单（重命名/归档/删除，生成中拦当前会话的归档与删除）；切换会话拉历史渲染、localStorage 记 lastSession（恢复时跳过已归档）；停止=先调服务端 stop 成功再 abort 流（服务端收尾优先，失败再断流兜底）；空会话先建后发（错误帧场景前端不失联）；fresh-context 弹提示告知降级 |
| ~~`apps/web-antd/src/api/system.ts`~~、~~`src/views/system/audit.vue`~~、~~`src/router/routes/modules/system.ts`~~ | **已建即撤**（2026-10-27 同日）：系统审计页（只读 Table+筛选）上线数小时后，用户拍板审计不进前端——唯一查询通道=智能体对话框的 audit_query 工具（`dsh-audit-tools` 插件 → `GET /api/audit`）；三文件已删、无悬挂引用（vue-tsc 过）。教训已吸收：菜单/页面类改动必须真浏览器复验菜单本身；同日 roles 并权限码修复（`api/core/user.ts`）即此页联动暴露 |
| `apps/web-antd/src/views/agent/proposal-card.vue` | 新增：确认卡片（2026-10-20 提案流；2026-10-21 增量支持 kind=import 批量卡——前 5 行表格+汇总、「确认导入」按钮与成功消息分支） |
| `apps/web-antd/src/views/finance/ledger/import-modal.vue` | 新增（2026-10-21）：导入流水弹窗——粘贴/选文件双 tab、调 imports/preview 出预览表（错误行禁选、疑似重复默认不勾）、skip_duplicates 开关、下载 11 列中文模板（带 BOM） |
| `apps/web-antd/src/utils/file-text.ts` | 新增（2026-10-21）：导入文件读取工具——UTF-8 优先、解不动回落 GBK（中文 Excel「另存为 CSV」默认 GBK）；`safeFileName` 文件名空白归一 |
| `apps/web-antd/src/router/routes/modules/agent.ts` | 新增：`/agent` 财务台对话路由（modules 目录自动扫描）；2026-10-27 框架定版组级 `meta.authority: ['agent:read']`（无权限不显菜单） |
| `apps/web-antd/src/views/_core/profile/password-setting.vue` | 修改（2026-10-27 框架定版）：改密页从"只弹提示的假页面"接通真接口——handleSubmit 调 `PUT /auth/password`（旧密码验证+新密码 ≥8 位，错误旧密码 401 由拦截器如实弹「旧密码不对」），成功清表单 |
| `apps/web-antd/package.json` | 新增依赖 `ant-design-x-vue@1.6.0`（对话框组件库） |
| `internal/tailwind-config/src/theme.css` | 修改（2026-10-21，环境修复非功能）：显式 `@source` 四行之后加 `@source not '../../../**/node_modules'` 与 `**/dist` 两行负向源。本仓库不是 git checkout，tailwind oxide 扫描器不按 `.gitignore` 剪枝，显式源目录下的 node_modules 沿 pnpm 符号链接环展开 173 万文件/27GB → dev server 4GB 堆 OOM 不应答。实测（oxide 4.3.3 Scanner.files）：不排除 1,736,245 / 只排 dist 515,767 / 只排 node_modules 1,284 / 都排 1,032，起作用的是 node_modules 那行 |

注意：Vben 的 `requestClient` 只封装 get/post/put/delete，**没有 `.patch()`**——更新走 `requestClient.request(url, { method: 'PATCH', data })`（见 `api/finance.ts`）。

## 已知未裁项（按需再做）

- ~~侧边栏上游演示菜单~~、~~登录页手机号/扫码/注册/忘记密码入口~~、~~品牌名~~：2026-10-26 已裁剪（见改动清单），真浏览器验收：菜单只剩财务+智能体两组、登录页无演示入口无备案号、登录直达 /finance、vue-tsc 0 错。
- 语言/主题/偏好设置等框架能力未按老板单人场景精简；语言包里 demos.json/page.json 还留着已删路由的文案键（无引用、惰性无害，下次动语言包时顺手清）。
- 上游演示视图死文件仍在树：`src/views/dashboard/analytics/`、`src/views/dashboard/workspace/`（路由已删、全库零引用，UI 无残留；审查 F-6 登记，择机删目录）。
- node_modules（1.4GB）在本目录：kb-rag 索引已排除（loader SKIP_DIRS），但占磁盘；长期不用可删后 `pnpm install` 重装。

## 非职责 / 边界

- 不持任何 DSH 凭据；对话网关（SDK 子进程）属后端职责，本前端只连管理后端 REST。
- 生产部署形态（静态托管+反代同一域名，免 CORS）P3 定；当前仅 dev 代理模式。

## 生命周期状态

`active`（财务台对话框已交付 2026-10-19，真实浏览器三轮对话验收：记账、问数、工具标签展示全链路；登录+看板+台账 2026-10-17/18 验收；财务 BI 看板轻量版 2026-10-21 验收：临时库造数真浏览器核数、空态/降级态/硬刷新三态复验；演示残留裁剪 2026-10-26 验收；**财务任务图扫尾增量 2026-10-26/27 真浏览器验收**：往来对账单期末数对上真实账、检查应答包/年度归档下载与哈希清单、逐笔比对导入→自动配对→人工配对→"共 2 笔全部逐笔对上"、附件上传摘除、Dropdown click 真 bug 现场抓出修复）。测试位置：暂无前端自动化测试（全部以真实浏览器全操作验收；附件文件选择器无法自动化，上传路径走页面 fetch+base64 验证）；对话框的并发互斥/崩溃自愈/错误路径由后端测试覆盖（`../server/test/agent.test.ts`）。无上下文子智能体对抗审查：对话框+网关文件族 2026-10-19 已审并修复，复验通过；BI 看板文件族 2026-10-21 已审（3 P2+5 P3 全修，复验"可以收口"，复验新增 4 P3 当场修完，结论见 交付记录（见项目内部交付记录））；对账+票夹文件族 2026-10-21 已审（1 P1+3 P2+6 P3，8 项修、2 项有意不改如实上报——票改期/改状态守门扩展已于 2026-10-27 按默认从严收口、存量页双弹为前债——复验"可以收口"且收回其对 theme.css 的误判，见 交付记录（见项目内部交付记录））；扫尾前端文件族 2026-10-27 随实现轮对抗审查修复（Dropdown click 事件真 bug 即验收抓出），收口产出另有无上下文终审（见 交付记录（见项目内部交付记录））；**框架定版前端文件族 2026-10-27 真浏览器全项验收**：双栏会话建/切/重命名/归档/删除、历史回看、刷新恢复上次会话、审计页筛选、改密全流程（错误旧密码如实拒→改密→新密码登录→改回）、**重启 3210 后同会话续聊模型原样引用上文（resume 实证）**；vue-tsc/eslint 0 错；无上下文对抗审查含本文件族（P2 前端守卫项已随修复落地，见 框架定版交付记录（见项目内部交付记录））。

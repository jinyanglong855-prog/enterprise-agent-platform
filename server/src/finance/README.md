---
type: module
updated: 2026-10-27
status: active
lifecycle: active
project: 公司智能体
tags: [finance, ledger, accounts, invoices, proposals, reversal, import, filing, reconciliation, payroll, attachments, banklines, cashcount, matching, reports, archive]
---

# server/src/finance（账本域）

## 职责

公司账本的领域层：记账条目（finance_entries，金额存分、编号 FIN-YYYYMMDD-NNN）、
账户实体（finance_accounts）、票实体（finance_invoices + 多对多挂联）、确认卡片提案
（finance_proposals，kind=single|import）、批量导入（finance-imports，预览/事务提交/模板）、
出数冻结（finance_reported_months）、冲销语义、月度汇总、征期数据包（filing，申报备料清单）、
银行对账预览（reconciliation，账面 vs 抄入的对账单余额，即时算不落库）、缺票清单（花了钱没票的账）、
工资个税计算（payroll，累计预扣法无状态计算器，任务全图 §4-6）、
员工名册与工资单（roster/payslips，财务残余 A3 2026-11-01：名册=平台身份三件+本地工资参数，工资单=月×人+累计预扣快照+期初累计开账，独立 payroll 权限面）、
附件归档（attachments，任务全图 B3）、银行逐笔比对（bank-lines，任务全图 B1）、
现金盘点（cash-counts，任务全图 B2）、票-账猜挂（matches，任务全图 A5/A6，只建议不自动挂）、
报表与打包（reports：凭证对照/往来对账单/检查应答包/年度归档，任务全图 C4/A8/F5/E5）。
REST API 语义是 md 版工具（`dsh-finance-tools.mjs`）的超集：四件对齐 + 七件 REST 新增。

## 非职责

- 不做 HTTP 路由（controller 只做分发与鉴权标注）、不做前端展示、不做报税申报。
- 票夹是证据维：不进月度汇总、不受出数冻结（新票补录允许——纸质票可能后到）；
  销项=计税依据的义务维聚合已落地（2026-11-01 `outputSummary`，**备料非核算**：申报以电子税务局为准）。
- 数电票额度在电子税务局侧（不接），系统侧只有手工抄入的参考跟踪（`quota`，A5 残余最小形态）。

## 文件

| 文件 | 职责 |
| --- | --- |
| `finance.service.ts` | 条目 CRUD/查询/汇总/出数标记/冲销。**领域硬规则都在这**：出数月禁改禁删禁补录（含改期搬入出数月）、冲销对冻结、冲销复制原 status/paid_amount 保证各口径精确相抵、作废账不许冲销 |
| `finance-accounts.service.ts` | 账户实体：余额=期初+Σ已收−Σ已付（未收付不动余额），流量算法走 `finance-flow.ts` 单源；禁改名（账目按名引用） |
| `finance-flow.ts` | 按账户的流量单源（2026-10-21）：`flowByAccountCents(db, asOf?)`——未删/非作废/有账户/可选 `date <= asOf`；发票不算；paid 全额、partial 或 paid_amount>0 按已付额；流出类负/收入正；冲销条目取反。账户余额与对账账面数都从这一段算，两边永远一致 |
| `finance-invoices.service.ts` | 票实体：kind/amount 不可改（记错作废重录）；改期不落已出数月份；不许挂已作废账目；`listMissing` 缺票清单（规则 8）；**义务维三件（2026-11-01 A7/A1/A2）**：list 带 total（截断真实总数）；`outputSummary`（GET output-summary?year=）销项按月计税参考——开票=在手销项按票期、**红冲按执行日（red_date 列：红冲落当天/复活清空，老红票空=按票期归月+legacy_red 标注）冲减执行当月**、作废/进项/内部不计、空年不凑零行；`getQuota/setQuota`（GET/PUT quota）数电票额度手工抄入（app_meta 单键；已用 0 合法、已用>总额拒、坏日期拒；剩余<20% warn；month_sales=票夹当月销项按票期自动算供对照；PUT 进审计 invoice.quota.set）。**额度/净额都是参考数，权威在电子税务局** |
| `finance-reconciliation.service.ts` | 银行对账预览（任务全图 §4-5，口袋维）：account + as_of（缺省今天）+ statement_balance → 截止日账面/今天账面/差额/截止日后动钱流水/人话提示（规则 7）；停用账户也能对；即时算不写任何表 |
| `finance-reconciliation.controller.ts` | `POST /api/finance/reconciliation/preview`（finance:read） |
| `finance-proposals.service.ts` | 确认卡片：提案复用 create 校验（出数月 fail-closed 留 pending）；确认入账 source=confirm、approved_by=确认人、回绑 entry_id；kind=import 批量卡走导入域事务，卡面 summary 带「与库重复 N 笔」知情数 |
| `finance-posting.service.ts` | **审批→落账通用插槽**（2026-11-01 融合方案 §5 P2，样板=报销）：飞书审批 APPROVED → 按规则映射成私有提案（默认 type=reimburse/分类 报销）→ 提案卡直发老板单聊 → 老板点确认走 proposals.confirm 落账。规则集 app_meta `finance.approval_posting_rules`（JSON 数组，code=企业自建审批定义的 approval_code，唯一；type 须账本类型；account 填了须已建档未停用；field_map 可指定金额/事由 widget 的 custom_id）；金额解析=映射优先、否则表单**顶层**首个 amount/number/formula 型字段（**2026-11-02**：明细表子行不算——摊平会错拿首条明细金额，真机报销模板总额是公式控件；顶层无候选=金额缺失分支）；事由=映射优先、否则名字含"事由/原因/说明/用途"的首个文本；申请人=名册 open_id→平台绑定 username→原样 open_id；记账日=实例 end_time 本地日。**不假成功**：金额读不出不建提案（老板收文本手工登记、审计 unresolved）；提案被 create 校验挡下（账户未建档/该月已出数）审计 failed ok=0 + 老板通知；卡片发不出不回滚提案（网页「提案」页/24h 后待办中心兜底）。幂等双保险：事件占坑键 + 提案 `origin=feishu-approval:<instance_code>` 查重。规则保存即订阅各定义事件（契约坑 20），补抓扫描也含规则里的定义；预览接口不落库。**2026-11-02 抽出 `postProposal(src, draft, auditDetail)` 来源无关公共体**（origin 查重排除 rejected / 建提案+写 origin 同事务 / 失败审计+老板通知 / 卡片降级），审批落账与工资单落账共用，审批链路行为与审计主体不变 |
| `finance-posting.controller.ts` | `GET|PUT /api/finance/posting-rules`（整表覆盖；PUT 响应带 `subscribed` 条数〔=规则条数，含停用——停用=登记待激活〕与 `subscription_healthy`）、`GET /api/finance/posting-rules/preview?instance_code=`（回查飞书实例按当前规则解析，不落库）——全部 admin:manage（规则是管理面；落账授权仍在提案确认 finance:write）。规则对象：`{code, name, type?=reimburse, category?=报销, account?='', enabled?=true, field_map?: {amount?, reason?}}` |
| `finance-imports.service.ts` | 批量导入（任务全图 §0.6）：RFC4180 解析/分隔符 auto/日期金额归一/映射规则（type_map、sign_decides_type、default_account 等）→ 逐行过 create 守门预览 → `db.transaction` 原子提交（任一行失败整批回滚）；批次号 IMP-YYYYMMDD-HHMMSS-xxxx |
| `finance-filing.service.ts` | 征期数据包（任务全图 §4-3，义务维"提醒→备好料"）：期间解析（YYYY-MM/YYYY-Qn，缺省=当前征期上一期）/聚合（口径与 summary 一致）/小规模免征与 1% 预估/征期节点/档案回显；**备料非核算**——税额只预估、社保参数原文回显、小规模默认按季（单月包不下增值税结论）、政策有效期哨兵 |
| `finance-filing.controller.ts` | `GET /api/finance/filing?period=`（finance:read） |
| `finance-payroll.service.ts` | 工资个税计算器（任务全图 §4-6，A7/C2 算数件）：累计预扣法（61 号公告公式+按月换算 7 档税率表，整数分运算、四舍五入到分）；负差按 0 留抵（negative_diff）；年中入职按 start_month 算减除费用月数；**无状态**——应发/个人社保/此前累计全是入参（规则 9）；社保参数原文回显不代算；模型传字符串数字照收（toNumber 归一） |
| `finance-payroll.controller.ts` | `POST /api/finance/payroll/calc`（finance:read，纯计算不落库不进审计） |
| `finance-roster.service.ts` | 员工名册（2026-11-01 财务残余 A3，融合方案 §3 回流形态=财务域最小增量）：身份三件（open_id/姓名/部门）从平台通讯录同步，工资参数（默认应发/个人社保/专项附加月扣）**永远本地维护——同步只动身份字段**；open_id 部分唯一索引（空=手工登记兜底）；删除=归档（工资单引用不悬空）；同步按 open_id 幂等 upsert、平台查无此人只报告不自动标离职、归档不复活（可显式「恢复」unarchive，恢复时校验 open_id 未被占用）；**审查修复（2026-11-01 无上下文审查 P1/P2）**：①根部门直属成员也拉（department_id '0'），平台拒绝时 `root_members='unavailable'` 并提示手工登记（不再是静默缺口）；②成员级分页截断并入 `truncated`；③平台新 open_id 与名册里**同名的手工行**不建重复，进 `pending_bind: [{name, open_id}]` 交人把 open_id 填进去再同步；④已归档员工只读（PATCH 400，提示先恢复）；⑤改**入职日期**守门——涉及的年份（新/旧入职年、原为空则所有出过单的年份）已有工资单一律 400（入职月决定减除费用起算，改了等于改税基）；改**离职日期**守门——任何工资单月份晚于新离职月一律 400；审计 detail 落 `hire_date_changed/open_id_changed` |
| `finance-roster.controller.ts` | `GET|POST /api/finance/employees`、`PATCH|DELETE /api/finance/employees/:id`（DELETE=归档）、`POST /api/finance/employees/:id/unarchive`（恢复）、`POST /api/finance/employees/sync`——读 payroll:read / 写 payroll:write |
| `finance-payslips.service.ts` | 工资单（A3）：月×人唯一；**算数全走无状态计算器 calc，这里不重写税法**——"此前累计"=同年此前工资单求和并落成快照（事后可查当时算数依据）、start_month=本年入职月否则 1、离职当月仍在册、跨年清零；一致性规则=后面月份挂着不许改前面 / 只许删同年最后一月的草稿 / 确认锁定可撤回（全有审计）；默认应发为 0 的人不出单、按名字报出（0 元单是误导）；**乱序生成守门（审查 P1-1）**：同年已有更晚月份工资单的人本月不出单，进 `skipped_out_of_order: [{name, later_month}]`——否则后出的早月单累计口径是错的而更晚的单又不会重算；**期初累计覆盖月守门**：某人该年有期初累计且 through_month ≥ 本月 → 不出单进 `skipped_in_opening`（再出就双计）；入职日期为空的人照出但进 `no_hire_date` 点名（按 1 月起算减除费用，年中入职的要补日期删单重出）；**默认不落账**；2026-11-02 起该月最后一张草稿确认落地即自动触发工资落账提案（规则 16，守卫由 payroll-posting 回注） |
| `finance-payslips.controller.ts` | `GET /api/finance/payslips?month=`（月度工资表+合计）/ `?employee_id=&year=`（个人全年）、`POST /api/finance/payslips/generate`、`GET|PATCH|DELETE /api/finance/payslips/:id`、`POST /api/finance/payslips/:id/confirm|unconfirm`、`GET|PUT|DELETE /api/finance/payslips/opening?employee_id=&year=`（期初累计，静态路由声明在 :id 之前）——读 payroll:read / 写 payroll:write。**确认接口（2026-11-02）**：最后一张草稿确认落地后顺手跑自动落账，响应 `{...record, posting}`（skipped/created/duplicate/failed） |
| `finance-payroll-posting.service.ts` | **工资单接落账 + 工资条 + 导出**（2026-11-02 财务线残余②）：某月工资单**全部确认**后自动一笔 `type=payroll` 提案（金额=实发合计，分类 工资，备注带应发/个人社保公积金/个税/实发；个税社保缴纳时另记），origin=`payroll:<YYYY-MM>`，老板单聊卡 → 既有确认链路落账；`status(month)` 给前端状态条（计数/合计/提案/能否生成+人话原因）；`postMonth` 手动兜底（auto 时不可落账返回 skipped，手动 400 说人话）。**一致性守卫 `guard()` 回注工资单服务**：已落账月锁死（撤回确认/再生成 400）；pending 提案随撤回确认/新生成作废（reject + 审计 `payroll.posting.invalidated`）。工资条 `pushPayslips`：按名册 open_id 私聊本人，只发已确认的单，无 open_id 点名跳过，逐人审计 `payroll.payslip.push` 不记金额明细。`exportCsv`：UTF-8 BOM + 表头 + 一人一行 + 合计行 |
| `finance-payroll-posting.controller.ts` | `GET /api/finance/payroll-posting?month=`（状态）、`POST /api/finance/payroll-posting {month}`（手动生成提案）、`POST …/push {month}`（工资条推送）、`GET …/export?month=`（CSV，Content-Disposition 带文件名）——读 payroll:read / 写 payroll:write |
| `finance-attachments.service.ts` | 附件归档（任务全图 B3，证据维）：扩展名白名单+单件 ≤8MB（ATTACH_MAX_BYTES，超限 400），文件落盘+元数据入库；**摘除=软删**——记录与文件都留档、界面不再显示，恢复需管理员操作数据库（上传处文案已声明） |
| `finance-attachments.controller.ts` | `POST /api/finance/entries/:id/attachments`（上传）/`GET …/attachments`（列表）/`GET /api/finance/attachments/:id/download`/`DELETE /api/finance/attachments/:id`（摘除，软删） |
| `finance-banklines.service.ts` | 银行逐笔比对（任务全图 B1，口袋维）：CSV 导入（指纹=账户+日期+方向+金额+流水号+对方 sha1，幂等防重）→ 人工确认配对优先 → 自动建议（金额相等+方向相同+日期差 ≤3 天**贪心取最近**；同额多笔也会自动配上、不唯一不拦，配错人工改；流水号不参与撮合，只进指纹与展示）→ 三清单（全部对上/账无流水/流水无账）；**只出清单不调平**（§0.5 守门），不接网银 API |
| `finance-banklines.controller.ts` | `GET /api/finance/bank-lines/template`（CSV 模板）/`POST …/import`/`GET …/report`（三清单）/`GET ?account=`/`PATCH :id`（人工配对）/`DELETE :id` |
| `finance-cashcounts.service.ts` | 现金盘点（任务全图 B2）：实点金额+账面金额（盘点时点按 `finance-flow.ts` 口径算 cash 账户）+差额+备注；**只记差不调平**，差额原因人填 |
| `finance-cashcounts.controller.ts` | `POST/GET /api/finance/cash-counts`（finance:write/read） |
| `finance-matches.service.ts` | 票-账猜挂（任务全图 A5/A6，证据维）：双向建议——给票猜账（`forInvoice`，在账账目候选）/给账猜票（`forEntry`，在手票候选）；打分=金额 4+日期 2/1（日期差 ≤7 天 2/≤31 天 1）+对方 2/1，≥2 分取 top 8；**只建议不自动挂**（挂联永远人确认）；冲销对两边既不当候选也不当猜挂源（requireEntry 排除 reverses/reversed_by，与缺票清单口径对齐） |
| `finance-matches.controller.ts` | `GET /api/finance/invoices/:id/matches`/`GET /api/finance/entries/:id/matches`（finance:read） |
| `finance-reports.service.ts` | 报表与打包（任务全图 C4/A8/F5/E5）：凭证对照（当月每笔账的票/附件/银行流水三路证据+齐/缺）、往来对账单（按对方：期初未结→期间明细→期末未结；含开票登记账已在 hint 披露，以明细为准）、检查应答包（期间打包：账目汇总+票清单+银行流水+人话口径说明）、年度归档（不可变 JSON 包按年限策略分节+逐节 sha256+bundle 哈希；`bank_lines_meta` 截断标志〔>5000 行只带元数据〕；notes 声明金额恒正+冲销对字段、accounts.balance 为导出时点全期快照） |
| `finance-reports.controller.ts` | `GET /api/finance/reports/evidence-checklist?month=`/`counterparty-statement?counterparty=`/`inspection-pack?from=&to=`/`archive/:year`（finance:read） |
| `finance.types.ts` | 常量与类型（对齐 `dsh-finance-tools.mjs`） |
| `finance.util.ts` | 金额/日期解析（元↔分、两位小数、真实日期校验）；`parseSignedAmount` 可负金额（对账单余额，去逗号/¥） |

## 领域规则速查

1. **出数冻结**：月份标记 reported 后，该月条目禁 update/softDelete/补录（改期搬入同样拦）；
   唯一修正路径=冲销（原账保留 + 反向条目相抵，两边留痕）。撤销标记需 admin:manage。
2. **冲销对**：reverses/reversed_by 双向标记；两边都冻结（不可改/删/再冲销）；
   反向条目复制原 status 与 paid_amount——总额/已收付/未收付/账户余额四个口径都精确归零。
3. **应收应付**：summary 里是"截至月底累计"口径（`date <= 月底`），跨月冲销对自然相抵，
   已出数的历史报数不被追溯改动。
4. **谁认的**：直通 create 的 approved_by=操作者；确认卡片路径 approved_by=确认人，
   审计双来源（finance.create source=confirm + proposal.confirm）。
5. **导入防重**：指纹=date+type+amount_cents+counterparty；冲销对两边、作废账都不参与查重
   （幽灵不挡道）；批内重复不算库内重复（两行一样就是两笔，skip_duplicates 只跳库里已有的）；
   agent 没有批量直落入口——commit 按 X-Actor-Source=agent 返回 403，批量只能走 kind=import 提案卡确认。
6. **征期口径**（2026-10-21）：税额判断只对小规模且给"预估"标签，有效期哨兵过期必提示；小规模默认按季申报，
   单月包不下增值税结论（档案「纳税期限=按月申报」才按月线，季包结论对其标注"仅供对照"）；销售额含未收款、
   冲销相抵、发票不计；应收应付复用 summary"截至期末累计"口径。政策数字的当年值与来源在宁波调研档，
   每年初随政策更新过一遍（重点：2027-12-31 优惠到期）。
7. **对账口径**（2026-10-21）：账面余额（截止日）=期初+截止日含当天之前的动钱流水净额（规则同 `finance-flow.ts`）；
   差额=账面−对账单，差 0 "对上了"否则"账面比银行多/少 N 元"；截止日之后的动钱流水单独列出并给净影响，
   不混进对比。**只出清单不调平**（§0.5 守门）——系统不改任何账，差在哪由人判断（账本漏记/记错，或银行手续费/利息/在途）。
   对账单余额可负、可带逗号/¥；不接网银 API。
8. **缺票口径**（2026-10-21）：只盯 expense/reimburse（工资税费本无发票）；排除作废、冲销对两边、已填 invoice_no 的；
   **挂联只认"在手"（held）且未删的票为证据**——挂着作废/红冲票照样算缺票（废票不是证据，但历史挂联保留可查）。
   `total` 是不受 limit 影响的真实总数，`count` 是本页条数，两者 SQL 共用同一 WHERE。
9. **个税预扣口径**（2026-10-26）：工资薪金累计预扣法（个人所得税法 2019 + 61 号公告），税率表内置代码；
   **无状态计算器**——本月应发、个人社保公积金、此前累计全是入参（账本推不出 per-员工 YTD，名册属人事台）；
   个人社保不代定（按员工各自基数×比例，工具只回显建档参数原文）；本月应预扣为负按 0、差额留待下期继续抵减
   （累计预扣法不多退）；纯计算不落库不进审计，登记工资走提案卡，正式申报在自然人电子税务局（扣缴端）。
10. **票守门口径**（2026-10-27 收口，**可改的默认**）：改期守门只看票自身原月/新月（不含挂联账月——搬票不动账）；
    状态守门（作废/红冲/复活）用票期月∪挂联账月（有效性牵连所有挂联月）。已出数月份默认**禁作废/禁复活/禁改期出去、红冲放行**
    （红冲本身就是纠错动作，拦它等于堵死数电票唯一修正路径）。2026-10-21 审查 P2-1"留用户拍板"按此默认从严收口，要放宽改守门代码即可。
11. **附件口径**（2026-10-26）：扩展名白名单（pdf/jpg/png/webp/heic 等）+单件 ≤8MB；摘除=软删留档（见文件表）。
    HTTP 层 body 上限 16MB（`BODY_LIMIT` 共享常量，main 与测试共用）——express 默认 100kb 会把 base64 附件挡成 413，
    真正的门是服务层自己的大小校验，这层只保证请求能到门。
12. **银行逐笔口径**（2026-10-26）：导入指纹=账户+日期+方向+金额+流水号+对方（sha1，幂等，重复导入不翻倍）；
    **人工确认配对优先**；自动建议=金额相等+方向相同+日期差 ≤3 天贪心取最近（同额多笔也会自动配上、不唯一不拦，
    配错人工改；流水号不参与撮合，只进指纹与展示）；产出三清单，**系统不写任何账**。
13. **猜挂与打包口径**（2026-10-26）：猜挂只建议不自动挂、冲销对退出候选（见文件表）；凭证对照三路证据=票挂联+附件+银行配对，
    缺哪路列哪路；年度归档包不可变（不压缩不加密，JSON 可直接机读），银行流水 >5000 行只入元数据并声明截断。
14. **工资域口径**（2026-11-01 财务残余 A3）：规则 9 的"名册属人事台"随融合方案 §3 作废——名册回流为财务域最小增量，
    per-员工 YTD 由工资单表接管，**计算器仍无状态**（payslips 服务从同年此前工资单求和喂累计入参，不在服务里重写税法）。
    快照不可变：一张单的"此前累计"永远等于同年此前各月之和，所以后面月份挂着不许改前面、只许删同年最后一月的草稿；
    确认=锁定（可撤回，撤回有审计）；默认应发为 0 不出单按名字报出；**工资单默认不落账，全部确认后自动出一笔落账提案**（2026-11-02，见规则 16）；
    名册不存身份证号/银行卡（正式申报在扣缴端完成，需要时再议）；工资是敏感面，独立 payroll:read/write，财务读写不解锁。
    **链子不许从两头破**（2026-11-01 审查后补）：生成端——同年已有更晚月份的人不出早月单（乱序守门，点名报出）；名册端——已出单年份的入职日期、
    晚于任一工资单月份的离职日期都改不动（先删单再改）；归档员工只读可恢复。同步端——同名手工行不自动合并（pending_bind 交人确认），
    根部门直属成员尝试拉取、平台拒绝时如实标注；12 月仍有负差=当年多扣，提示次年汇算清缴可退（界面文案，不在服务里算）。
    **期初累计（开账，2026-11-01 用户拍板："前面没有就按 0 登记，把期初累计加进去"）**：`finance_payroll_openings` 一人一年一条
    （截至 through_month 月末的累计应发/个人社保公积金/专项附加/减免/已预扣个税），算工资单时并入"此前累计"入参（计算器仍不动）；
    全 0 合法=前面按 0 登记。守门：①该年已有工资单时改/删期初拒绝（已出的单是按旧期初算的快照，先从最后一月起逐张删）；
    ②through_month ≥ 出单月的人该月不再出单（双计守门，进 skipped_in_opening）；③through_month 必须在该年内、不早于本年入职月。
    归档员工不可开账。审计 payroll.opening.set/delete，不落 note 正文。
15. **审批落账口径**（2026-11-01 融合方案 §5 P2，用户拍板"你就做报销啊什么的"）：审批通过**不直接写账**，只生成一笔 pending 提案——
    落账的授权动作仍是老板点「确认入账」（飞书卡片或网页「提案」页），落库 source=confirm、approved_by=确认人，与 agent 提案同一条路。
    提案创建人如实=`system:feishu-approval`（不冒充 agent 服务号）。一套代码多类审批：报销/付款/采购/借款只是规则不同（type/分类/默认账户/字段映射）。
    规则是管理面（admin:manage，与平台登记册同权限面）：`GET/PUT /api/finance/posting-rules`（整表覆盖）、`GET …/preview?instance_code=`
    （按当前规则解析一张真实实例，不落库，配 field_map 前后各看一次）。**field_map.amount 指名的字段不在表单里=规则失效**：按金额缺失
    处置（不建提案不静默退回启发式——启发式可能错拿定金/单价，产出金额错误的提案比不建更糟）；reason 映射落空只退启发式（事由是备注，不为它拦落账）。
    停用的规则：事件侧 ignored+落坑（补抓把停用定义也扫，不落坑的话 checkpoint 卡住时这些实例每轮重吃处理额度，审查 P2-1）；完全无关的 code
    不落坑（app_meta 不按全公司审批量膨胀）。origin 查重放过 rejected：老板拒过的单允许重跑重建——代价是占坑键意外丢失时同一单会再出一笔
    （接受的取舍，占坑键正常在 ISO 时间就不会重跑）。记账日=实例 end_time 按服务器本地时区取日（部署机 UTC+8），缺失回退今天且审计标
    end_time_missing。明细行求和、多币种、超过一个金额字段的歧义表单**不做**——启发式只认"表单顶层首个 amount/number/formula 字段"（明细表子行不算，2026-11-02 真机定义结构核出的坑），拿不准就配 field_map
    或等真模板出现再加。前端「财务 › 审批落账规则」页（2026-11-02，admin:manage）：页面攒改动整表保存、默认账户下拉、预览解析弹窗。
16. **工资单接落账口径**（2026-11-02 财务线残余②）：某月工资单**全部确认**才落账，一笔 `type=payroll` 提案、金额=**实发合计**（个税与社保公积金在实际缴纳时另记，不在此拆三笔）；
    提案创建人=确认最后一张的人（手动兜底=按钮的人），审计前缀 `payroll.posting`，与审批落账共用 `postProposal` 公共体。老板不点确认账本不变；自动那步失败
    （卡片发不出/该月已出数；工资提案不指定账户，老板确认时补）工资页状态条给手动「生成落账提案」兜底。**已落账月锁死**：撤回确认/再生成 400（账本已有数，工资单不许再动）；
    **解锁=在台账冲销那笔工资**（审查 P1-1）：`findByOrigin` 把"已确认但账本那笔已冲销"的提案视为不在场，冲销后状态条回到可生成、撤回确认放行、重新确认建新提案不撞 origin；被冲销的旧提案仍是 confirmed（历史不改）；
    pending 提案随撤回确认或新生成作废（reject，审计 invalidated）——提案与工资单口径永远一致。工资条推送是显式动作（前端二次确认），只发已确认的单、只发名册有 open_id 的人，
    文本含应发/个人社保公积金/专项附加/个税/实发，逐人审计不记金额；CSV 导出走同一权限面（payroll:read）。

## 与 md 工具的已知差异（权威清单，有意接受，勿当 bug 修）

语义对齐以 `dsh-finance-tools.mjs` 为黄金标准，错误文案逐字一致；以下为审查确认的可接受差异：

1. **profile set 值错误尾句**：md 版指路"改 PROFILE.md 文件"；REST 无文件，改为"如需覆盖请直接 set 新值"。
2. **profile get**：返回结构化键值，插件合成 md 全文时缺 PROFILE.md 模板注释两行（agent 读到的键值信息完整）。
3. **counterparty 过滤大小写**：SQLite LIKE 对 ASCII 不分大小写；md `includes` 分。中文场景无感。
4. **limit=0/非整数**：md 宽松（按 1 截断）；REST 报 400。
5. **create 成功返回**多一个 `paid_amount` 字段（输出 schema 本就允许）。
6. **同时给多个非法参数时的报错顺序**可能与 md 版不同（哪个先校验先报哪个）。
7. **REST 新增七件**（finance_account/finance_invoice/finance_propose/finance_reverse/finance_filing/finance_payroll_calc/finance_match）是 md 版
   没有的能力，不属于"差异"：账户与票是任务全图 §0.4 地基，提案与冲销是对话流与出数修正的闭环，
   征期包是 §4-3 义务维升级，工资个税是 §4-6 算数件，猜挂是 §2 证据维核对件（只建议不自动挂）。

## 依赖与数据边界

只依赖 `../db/database.js`（DB 连接）、`../audit/audit.service.js`（审计）、`../errors.js`；
表归 schema.ts 权威 DDL 所有；数据只在 SQLite（`~/.dsh/company-data/admin/ledger.db`）。

## 测试位置

`server/test/foundation.test.ts`（领域语义 18 用例）+ `finance.test.ts`（域核心 14 用例）+ `api.test.ts`（HTTP 7 用例）+
`foundation-api.test.ts`（HTTP 6 用例）+
`finance-imports.test.ts`（导入域 18 用例：解析/归一/预览/防重/事务/批量提案）+
`imports-api.test.ts`（HTTP 4 用例）+ `filing.test.ts`（征期包 12 用例：期间/边界/降级/过期/口径）+
`reconciliation.test.ts`（对账 5 + 缺票 3 用例：截止日含当天/partial 按已付/未收付不动/冲销反向/停用账户与负余额/五种 400；
缺票基本口径/废票不算证据/截断 count 与 total；日期全用 `dayOffset(n)` 相对今天，不埋时间炸弹）+
`payroll.test.ts`（工资个税 12 用例）+
`payroll-domain-api.test.ts`（工资域 HTTP 9 用例：payroll 权限分离/名册校验与归档/平台同步三态〔幂等·参数不被冲·归档不复活〕/累计链逐单核对〔入职月起算·离职当月仍在·此前累计=同年此前之和〕/一致性规则〔跳改拒·只删最后一月·确认锁定可撤回〕/跨年清零+没填参数不出单+九类审计/**审查修复两条**〔乱序生成被挡点名·入职空照出点名·改入职/离职日期守门·归档只读可恢复〕〔同名手工行→pending_bind 不建重复·根部门成员并入与平台拒绝时标注·成员级截断并入 truncated〕/期初累计〔并入此前累计·覆盖月不再出单·改删守门·校验权限审计〕）+
`approval-posting.test.ts`（审批落账 13 用例：规则校验与 admin:manage 权限面+保存即订阅/启发式解析→提案+老板单聊卡+审计/全链路卡片确认→账本 reimburse·approved_by·记账日=end_time/幂等双保险〔撞坑·清坑后 origin 查重〕/拒绝终态落坑/金额缺失不假成功/已出数月被挡如实报老板/字段映射优先于启发式+申请人三级解析/**映射失效 fail-loud 不静默退启发式〔审查 P2-2〕·reason 落空退启发式**/分流不串线与停用规则落坑〔审查 P2-1〕/补抓扫到规则定义并分计 posted/预览不落库/**顶层公式命中·只有明细表不假成功〔2026-11-02〕**）+
`payroll-posting.test.ts`（工资单接落账 8 用例：状态与门槛〔没单/有草稿手动 400 说人话·确认到最后一张才自动生成〕/自动一笔 type=payroll 提案〔金额=实发合计·备注四项合计〕+老板单聊卡+审计/一致性〔撤回一张→pending 提案作废 rejected+审计·重新确认→新提案·旧卡不重发〕/老板卡确认→账本 payroll→该月锁死〔撤回 400·再生成 400·status 显示已落账〕/工资条推送〔有 open_id 私聊含实发个税·无 open_id 点名跳过·逐人审计不记金额〕/CSV〔BOM+表头+两人+合计行+文件名带月份〕/权限面〔只有 finance 权限读不了落账状态与导出〕/**冲销解锁〔账本冲销→提案不在场·撤回放行·重确认新提案不撞 origin·generate 新草稿作废 pending·CSV 防公式注入与合计六列〕**）+
`payroll-obligations.test.ts`（工资域义务扫描 3 用例，口径见 `../todos/README.md`：名册 vs 通讯录三类进场·info 不推卡·平台出错整轮报错不闭合·源头消失逐条闭合/社保增减员窗口与截止·窗口外归档未来入职不进场·归档不自动闭合·「已完成」无备注 unverifiable·force+备注 dismissed·dismissed 不重开/建档参数首轮基线·改了出一条隔轮不消失·同键当日再改并进同行·四项之外不报）+
2026-10-26/27 扫尾新增：`attachments.test.ts`（附件 5：白名单/超限/软删）/`banklines.test.ts`（逐笔比对 9：指纹幂等/自动配对/三清单）/
`cashcount-approve.test.ts`（盘点 4 + 确认卡片即审批口径）/`evidence-api.test.ts`（对照清单+大请求 HTTP 7：200KB base64 过 body 上限、
9MB 到服务层 400、500 行 CSV 导入）/`invoice-guard.test.ts`（票守门 5：改期两向/禁作废/禁复活/红冲放行）/
`matches.test.ts`（猜挂 8：打分/top8/冲销对退出候选）/`reports.test.ts`（6：对账单/应答包/归档——sha256 稳定/金额转元/坏年份与应答包截断字段；
**归档 >5000 行截断分支暂无断言**，功能在 service `bank_lines_meta`，待补用例）；2026-10-27 框架定版新增
`agent-sessions.test.ts`（对话域 HTTP 全链路 12 用例，口径见 `../agent/README.md`）——
二十个测试文件合计 **179**，`npm test`（= tsc + node --test dist/test/*.js；**用 tsx 直跑 TS 不生成装饰器元数据，
Nest 注入会全线 500/401，别用**）全跑。
REST 工具端到端 `plugins/dsh-finance-tools-rest.test.mjs`（82，含 finance_match 猜挂）+ `dsh-file-tools.test.mjs`（45，含文件工作区六工具全链路）。
改动本目录必须重跑 `npm test` 与插件测试。

## 生命周期状态

`active`（数据模型地基 2026-10-20 定版；批量导入+文件工作区 2026-10-21、征期数据包 2026-10-21、银行对账+票夹 2026-10-21、
工资个税计算器 2026-10-26、断裂带与小缺口扫尾〔附件/逐笔比对/盘点/猜挂/报表打包/票守门〕2026-10-26/27 相继交付、
**票夹义务维三件〔A7 total/A2 销项汇总/A1 额度抄入〕2026-11-01 交付、工资域〔名册+工资单，财务残余 A3〕2026-11-01 交付——无上下文对抗审查 FAIL〔2 P1+3 P2+5 P3〕→当日全修复验 322 绿，P3-1〔同名员工无身份证号靠 #id 区分〕为接受的取舍记录在案；审批→落账通用插槽〔样板=报销，融合方案 §5 P2〕2026-11-01 交付）**。
下次审查条件：~~票夹义务维聚合（销项合计）落地时~~（已触发，2026-11-01 交付时无上下文审查）、~~人事台（员工名册/工资表，会接管 payroll 的参数来源）落地时~~（已触发，2026-11-01 工资域交付时无上下文审查）、
~~审批→落账插槽落地时~~（已触发，2026-11-01 报销落账交付时无上下文审查）、工资单接自动落账/工资条推送/导出时、社保增减员提醒（A4）接名册时、
政策年度更新（2027 年初或 2028-01 优惠到期、个税参数调整）时，或新增第三个领域服务时；
票守门默认口径若用户要求放宽（允许改期出已出数月/作废），改 `finance-invoices.service.ts` 守门分支并在 `invoice-guard.test.ts` 补用例。

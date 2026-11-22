---
type: module
updated: 2026-11-01
status: active
lifecycle: active
project: 公司智能体
tags: [todos, obligations, scanner, digest, escalation, routes, mes-slot]
---

# server/src/todos（义务/待办域）

## 职责

企业"该做而未做的事"的领域层：**预警、待办、晨报是同一个实体（obligation）的三种投影**，不是三套数据。

- **推导型义务（origin=scan）**：每日定时（默认 08:30，`ADMIN_DAILY_SCAN_AT` 可改）+ 启动补跑 + REST 手动触发，
  全量扫描后端系统状态，把"时间驱动的义务"投影成 obligations 行。真相源永远在原表（账本/票夹/提案/用户表），
  本表只是对账层：源头处理掉 → 下轮扫描自动闭合（resolved）；源头重现 → 自动重开。
- **人工待办（origin=manual）**：有 todo:write 的人手建，可改可完成（完成可带备注）；责任人可以是具体账号（user）或岗位（role）。
- **核实式完成（2026-10-31 二批，用户口述定版）**：推导型点「已完成」不是直接关——先现跑一遍所属扫描器核实源头：
  消失→resolved（记谁按的+备注）；还在→不关、解除静音恢复提醒并把现状告诉人（pending）；
  同源换了口径（典型=账目改期）→并进新口径继续跟；系统无法核实（征期）→告知要备注。
  人坚持已完成=必填备注「强制确认完成」→dismissed（永久，源头重现不再建）。
- **逾期升级（1/3/7 阶梯）**：到期未闭合 open→escalated 当天推一次，第 3/7 天再推；「暂不处理」静音
  （核实发现源头仍在时静音解除，提醒恢复）。
- **晨报双通道**：每人一张（我的 + 岗位池的 warn/critical 活跃项，没有就不打扰）；老板那张额外带
  【企业总览】全员未闭合数/逾期数 + 【生产切片】供应链一句话（2026-11-01 R1：低于安线/到货逾期/临期批次/今日应到，没建物料或全零整行不出）+ 【昨日全员】动作切片（审计按动作计数的人话短语）。
- **卡片回写**：飞书卡片「暂不处理/已完成」按钮（已完成只在人工待办卡上）→ bridge → `todoCardAction` → 应答终态卡（点击即改脸）。

## 非职责

- 不做申报、不做核算、不改任何账（扫描器只提醒）；征期日不是权威征期表（见规则 6）。
- 不做菜单角标计数（方案有意不做：角标是骚扰源，首页摘要替代）。
- 不做飞书任务（Task）单向投影（方案 §十 ④ 缓）。
- 事件驱动的即时进场（审批到达等）仍走原实时链路，本域只做日对账层。

## 文件

| 文件 | 职责 |
| --- | --- |
| `todos.types.ts` | 常量与类型：状态五态 `open/escalated/resolved/dismissed/done`（活跃=前两态）、严重度 `info/warn/critical`、`ObligationRow`、`ObligationCandidate`（扫描器产出）、**`ScannerDef` 扫描器契约**、`TodoCardView`（卡片视图，bridge 侧渲染）、`TodoCardActionPort`（bridge→本域的回写端口，避免循环依赖） |
| `todos.service.ts` | **obligations 表的唯一写入口**：可见性谓词、人工待办 CRUD、done/dismiss/ack、三视角列表（mine/pool/enterprise）、摘要、责任路由读写、扫描记录查询。审计只记义务 id+动作（义务标题是经营内容，不进审计） |
| `obligation-scanner.service.ts` | 扫描框架 + 十二个扫描器（财务六 + 生产供应三 `scan.supply.*`〔2026-11-01 v0 两个 + v0.5 批次临期〕+ 工资/建档三 `scan.payroll.roster`/`scan.payroll.social`/`scan.finance.profile`〔2026-11-02〕）+ **扫描前多维表格自动同步**（2026-11-02：登记了通道 B 才跑，失败写 scan_runs 由【扫描告警】亮出，不打断扫描）+ 逾期升级 + 晨报 + 推送通道。`SOURCE_LABELS`（source_type→人话标签）在这里，卡片 note 与前端分组共用 |
| `todos.controller.ts` | `/api/todos` REST（见下表）。**注意**：`ObligationScannerService` 必须是值导入——`import type` 会让 `design:paramtypes` 发射成 `Function`，Nest 注入静默失败且测试跑器只报 bare "test failed"（2026-10-31 踩坑，文件内有注释） |

REST 一览（权限点全集以 `rbac.service.ts` 的 `PERMISSIONS` 为准——随域增长，这里不重复列数；本域用 todo:read/write）：

| 路由 | 权限 | 说明 |
| --- | --- | --- |
| `GET /api/todos?scope=mine\|pool\|enterprise&status=&limit=` | todo:read（enterprise 另需 admin:manage，否则 403） | 三视角列表；status 缺省 active；排序=无到期日垫底、到期日升序、严重度、首次发现倒序；limit 默认 200 上限 500 |
| `GET /api/todos/summary` | todo:read | 我的+岗位池活跃项四格：overdue / today / upcoming7 / undated |
| `GET /api/todos/owners` | todo:write | 建待办时可选的责任人：启用的非服务账号 + 非技术角色 |
| `GET /api/todos/recurring?month=YYYY-MM` | todo:read | **全月历投影（2026-11-01 用户定稿）**：某月到期的全部常规征期整月预列，不做临期窗口过滤——`phase`=early（提示）/today（预警）/overdue（预警）；与 scanFiling 共用 `filingDeadlinesOfMonth` 单一事实源（逐类枚举面：社保仅当月、按月类当月+次月、季度类今明两年季度月——**枚举面必须逐类给，合并成月份集合会让过去月重推/同键重复撞 UNIQUE**，scanFiling 增量已修）；已有同 dedupe_key 义务行的不重复列（任意状态——活跃项日历另有真待办，闭合=人确认办过，跨年键自然失效重现）；`today` 可注入（测试拨钟）。**权限裁决**：挂 todo:read——条目构成可反推财务档案（纳税人身份/上月有无工资），属企业层事实；默认部署 employee 同时持 finance:read 无实害，"有 todo:read 无 finance:read"的角色组合出现前不收紧，出现后应加挂 finance:read；路由 enabled=0（停扫）时投影照常返回但不生成正式待办 |
| `POST /api/todos` | todo:write | 建人工待办（title 1–120、detail ≤2000、ownerType user\|role 且存在、dueDate YYYY-MM-DD、severity 三选一） |
| `PATCH /api/todos/:id` | todo:write | 改待办：人工=全部字段；**推导型只认到期日/严重度/责任人**（标题/说明 400，由扫描器从源头维护），改过落 `user_edited=1` |
| `POST /api/todos/:id/done` | todo:write | 「已完成」。人工=直接落 done（note 可选 ≤200 字）；**推导型走核实式完成**：返回 `CompleteResult{outcome,message,item}`——`resolved`（源头消失，闭合）/`pending`（还在，不关+解除静音）/`unverifiable`（征期等，要备注）/`forced`（`{force:true}`+必填 note→dismissed 永久）；body 可空（人工空体=无备注完成） |
| `POST /api/todos/:id/dismiss` | todo:write | 静默/强制确认（备注 1–200 字必填），永久；界面上推导型不走这里而走 done+force，dismiss 保留给直接关的场景 |
| `POST /api/todos/:id/ack` | todo:write | 暂不处理：`last_notified=ack:日期`，静音阶梯重推；核实发现源头仍在时会清掉静音 |
| `GET /api/todos/routes` · `PUT /api/todos/routes/:sourceType` | admin:manage | 责任路由：每种来源默认落到谁（user/role）+ 开关；没配置默认老板；关掉=该扫描器整轮不跑。**改绑即移交**：该来源仍活跃（open/escalated）的推导项一并改到新责任人（审计 detail 记 `migrated` 条数）；已闭合/已静默的留原人名下可追溯 |
| `GET /api/todos/scan-runs` | admin:manage | 最近扫描记录（每扫描器每轮一行：found/created/deduped/auto_resolved/errors/duration） |
| `POST /api/todos/scan` | admin:manage | 立即扫一轮（trigger=manual，**不发晨报**，digest='skipped'） |

## 领域规则速查

1. **核实式完成（二批定版）**：人工待办 done 直接关（备注可选）；推导型「已完成」由 `completeDerived` 先核实——
   现跑所属扫描器，先按 dedupe_key 找候选，键不在再按**身份字段**（sourceRef 的 entryId/proposalId/username/month/itemId/poId/batchNo）找同源——**任一方带 poId 时只认 poId 相等**，itemId 不参与（同一物料常有多张采购单，itemId 是父级属性不是身份，否则 A 单改期会被排在前面的 B 单冒认）；**其次任一方带 batchNo 时只认 itemId+warehouse+batchNo 三元组相等**（2026-11-01 v0.5：同物料别的批次冒认不了，安线行 ref 无 batchNo 与批次行互不冒认）；安全线行按 itemId 同源（v0.5 合计比下跨仓合并是有意设计）：
   同键在=源头还在（pending，顺手刷新口径）；同源换键=**并进新口径**（换 dedupe_key 继续跟，不闭合——账期改了不等于钱收回来了）；
   同源也没有=真处理完（resolved，话术仍注明"或改期到了以后"）；新键已有别的行在跟=本条闭合并入（resolved，如实说明不是处理完）。
   人坚持已完成（force）=必填备注→dismissed **永久**：同一 dedupe_key 再出现不翻案、不重开。
   **dismissed 无界面恢复入口（2026-11-01 审查 P2-3 裁决：不把"永久"做软）**——真误关由管理员改库：
   `UPDATE obligations SET status='open', dismissed_by='', dismissed_reason='', dismissed_at=NULL WHERE id=?`。
   系统无法得知"税已申报"这类外部动作，**申报完成后点「已完成」填"已申报"强制确认闭合是预期用法，不是 bug**。
   推导型可改到期/严重度/责任人（`user_edited=1`）：扫描刷新与**路由批量移交都不覆盖**（手动改派不被洗掉）；
   重开（resolved/done 源头重现）时 user_edited/done_note 清零，回到扫描器口径。
2. **幂等与自动闭合**：`dedupe_key` 唯一；重复扫描命中活跃行只刷新 title/detail/source_ref——
   **`user_edited=1` 的行不覆盖 severity/due_date**（人改过的不拨回去）；本轮没再看到的活跃行 → resolved；
   resolved/done 行源头重现 → 重开为 open（算 created，warn/critical 再推一次，user_edited/done_note 清零）。
   到期日进键（应收/应付）：账期改动=旧键消失新键进场（核实式完成靠身份字段兜住这种情况，见规则 1）。
   **`closeOnAbsence`（ScannerDef，2026-10-31 审查新增）**：缺省 true=缺席即闭合（应收付掉了、提案确认掉了）；
   `false`=缺席不等于办完（征期）——行不会随日期窗口滑出被标成"已处理"，只能人静默关闭（该来源的行 auto_resolved 恒 0）。
   扫描器抛错时整段 upsert 与 auto-resolve 都跳过：候选为空是异常不是"源头消失"。
3. **可见性谓词（数据分割 §1.6）**：admin ∨ created_by=我 ∨ (owner=user ∧ 是我) ∨ (owner=role ∧ 我持有该岗)。
   不可见一律 404"不存在"（与对话域同口径，不泄露存在性）；enterprise 视角是控制器层 admin:manage 门（403，诚实的权限级拒绝）。
   `mine` = 责任人是我 **或** 我建的人工待办（建给别人的也能在"我的"里追踪）。
4. **升级 1/3/7（升级链 责任人→老板）**：open 且 `due_date < 今天` → escalated，推送标记 `esc:1:日期`；已升级项按 escalated_at 起算第 3/7 天各推一次
   （标记 `esc:s3:`/`esc:s7:`，已推过的阶段不重推）。`last_notified` 以 `ack:` 开头 → 阶梯重推静音（「暂不处理」；核实发现源头仍在时清除）。
   **边界**：对尚未到期的项点「暂不处理」，到期当天升级仍会推一次（升级是新事实，标记被 `esc:1:` 覆盖），之后再点一次即静音。
   升级与阶梯重推**抄送老板**（方案 §1.5 第二层；老板本身就是责任人时不重复）。已知限制：ack 需要 todo:write，
   只有 todo:read 的岗位无法自己静音——有需要时管理员可把该行路由到能操作的人或岗位。
   （路由改绑不迁移被手动改过责任人的行。）
5. **晨报防骚扰优先**：每天一轮，`app_meta.todos.last_digest_date` **先落标再推**（半途崩了少发不重发）；只含 warn/critical 活跃项，
   每张 ≤10 行；桥未启用/未连接 → 'no-bridge' 不落标（下轮补发）；只发给有 todo:read 且在 `bridge_identities` 允许的账号。
   info 级（如缺票）只进待办中心，永不推送。**老板卡=个人卡+企业信号**（方案 §六"另推"的合并实现）：个人盘子干净但全员还有未闭合项、
   或扫描出过错时老板卡照发；带【企业总览】未闭合/逾期数、【生产切片】（供应链一句话，全零或没物料时整行隐藏；读数早于今天时行尾注"库存数据截至 X"〔2026-11-02〕；切片有内容本身不构成发卡信号——路由停用+老板无待办+全员无活跃义务的边缘配置下不单独发卡，v0.5 审查 P3-8 接受）、【昨日全员】动作切片（**只数经营动作**——登录/桥接/审批事件/会话管理不进切片）、
   【扫描告警】（近 3 天扫描器失败汇总一行，置顶——失败纪律的落地口径，连续失败的扫描器每天都出现在卡上直到恢复）；
   普通卡带【昨日回顾】（本人昨日动作一行）。
6. **征期口径**：15 日规则推算；**窗口=提前 7 天预告、到期后 60 天内持续刷新"已逾期"**；滑出窗口不闭合（closeOnAbsence=false），只是停止刷新。
   严重度：≤3 天或已过期 critical，7 天内 warn（方案 §五 lead 7/3/1/0 折成两档）。小规模增值税默认按季，
   **档案「纳税期限=按月申报」才按月**（口径与 finance-filing 一致）；一般纳税人按月；公司企业所得税季预缴；
   个体户经营所得季预缴（定期定额除外）；个税代扣代缴次月 15 日（上月账里有工资才生成）；社保公积金当月 15 日。
   **遇法定节假日顺延，以当年官方通知为准**——detail 里逐条声明。主体类型/纳税人身份没填不猜（该线不生成）。
   未覆盖（后续增量）：工商年报、汇算清缴、社保调基节点。
7. **应收/应付口径**：income/expense、status unpaid/partial、非冲销对、剩余>0、**到期日 ≤ 今天+3（无下限）**——
   仍未结清就一直在场（逾期 40 天照样 critical 进场）；候选缺席才真的等于付掉/作废/冲销了。
   与账本"截至期末累计"口径无关——这里只看单笔到期。
8. **其余扫描器**：提案积压=pending 超 24 小时（warn，无到期日不升级）；零角色账号=启用的非服务账号且无任何角色（warn）；
   月度缺票=当月缺票数>0 一条（info，按月去重，**标题/detail 用 listMissing 的 total 真实总数**，limit 只裁返回行）。
9. **新指派即时卡**（§六"派活要吭声"）：人工待办建给别人（user 或 role）时立即给责任人/全体持岗人推一张 item 卡（含「完成」按钮），
   severity 不做门槛——派活不能静默；建给自己不推。推送失败只告警不影响建待办。
10. **审计**：`todo.created/updated/done/dismissed/acked/route.set` 只记 id+动作元信息（created 记 owner/dueDate/severity，
    done 记 `hasNote`/`verified`，dismissed 记 `forced`，route.set 记新责任人+移交条数 migrated），**不记 title/detail/备注正文**
    （备注正文落在 obligations 行的 done_note/dismissed_reason，属于经营数据不进审计）。桥接回写审计 `bridge.card.action` 带 `kind:'todo'`。
11. **本地日历口径**：所有 due_date/today 用 `localDate()`（本地时区），不用 UTC——跨午夜不串天；扫描器一律吃注入的 now，
    `escalated_at`、itemCard 的"已逾期"判断同样用注入时钟（测试可拨钟）。

## 扫描器契约与 MES 预留槽

```ts
// todos.types.ts
export interface ScannerDef {
  key: string            // source_type，形如 'scan.xxx'；MES 预留前缀 'mes.*'
  label: string          // 人话标签（SOURCE_LABELS）
  scan(now: Date): ObligationCandidate[]   // 同步纯函数、不写库、不自取时间（now 注入，测试可拨钟）；抛错=本轮该扫描器记 errors，不中断其他扫描器
  closeOnAbsence?: boolean // 缺省 true=源头消失自动闭合；false=只能人静默关闭（申报/缴费这类系统无法得知完成与否的来源必设）
}
export interface ObligationCandidate {
  sourceType: string; dedupeKey: string; title: string; detail: string
  sourceRef: Record<string, unknown>   // 深链信息（原表 id 等），没有就给 {}
  dueDate?: string /* YYYY-MM-DD */; severity: 'info' | 'warn' | 'critical'
}
```

**首个非财务域接入（2026-11-01）**：生产供应链域的 `scan.supply.below_safety`（库存低于安全线，状态驱动、补货到线自动闭合；**v0.5 改按物料合计比**——各仓最新读数合计 < 安线才响，dedupe `:itemId` 不含仓库与数量，分仓调拨不误报）、`scan.supply.po_overdue`（采购到货逾期，承诺日 ≤ 今天+3 与应收应付同窗、改期换键、收货/取消闭合；单轮上限 500 行，**超限整轮报错不截断**——截断会让没进候选的在场行被 closeOnAbsence 假闭合）与 `scan.supply.expiry_near`（v0.5 S5 批次临期：有批次号的最新读数、数量>0、效期 ≤ 今天+临期窗口〔2026-11-02 v0.5.1 起为域设置，缺省 90 天，`GET/PUT /api/supply/settings`〕，dedupe 物料+仓库+批次三元组、过期 critical、批次清零闭合）按本契约注册；源数据在 `supply_*` 表，口径权威 `server/src/supply/README.md`；`SOURCE_LABELS` 增三标签+`supply.bitable.presync`（多维表格预同步，不是扫描器，只用于 scan_runs/【扫描告警】的人话标签）、`SOURCE_IDENTITY_KEYS` 增 itemId/poId/batchNo（财务来源的 sourceRef 不含这三键，零影响）。**扫描前自动同步（v0.5.1）**：`runAll` 三路触发（启动/日扫/手动）都先拉一次多维表格（通道 B 登记了才跑、只拉已登记的类、`username='-'` 不进【昨日全员】人工统计），扫描器随后读到的就是刚落库的最新读数；同步失败不打断扫描，scan_runs 留 errors 行、晨报【扫描告警】近 3 天汇总亮出。`mes.*` 槽仍空着，专留给外部 MES/ERP 直连——`scan.supply.*` 是本系统内部域的数据，不占那个槽。

**契约已放宽为可异步（2026-11-02）**：`scan(now)` 可返回 `ObligationCandidate[] | Promise<ObligationCandidate[]>`，`runScanner` 与核实式完成的 `verifyRow` 都 `await`（`completeDerived` 随之 async，controller 返回 Promise 由 Nest 解）。
首个走网络的扫描器是名册 vs 通讯录（读飞书通讯录）；通道 B 多维表格同步仍是导入路径不是扫描器。MES 接口照此接：网络失败抛错=整轮 error、不闭合旧行。

**工资/建档三扫描器（2026-11-02 财务线残余 A4/A5/A6）**：
- `scan.payroll.roster`（名册与通讯录，**缺席即闭合**）：每轮读一遍飞书部门树+各部门成员（含根部门直属），与 `finance_employees` 比对出三类——平台查无此人（warn：核实离职/换号/权限不可见；源头=在册有 open_id 但平台没有）、新面孔未进名册（warn：指路「从飞书同步」建档）、与在册**同名手工行**待绑定（info 只进待办中心：填 open_id 即绑定）。dedupe `scan.payroll.roster:missing|new|bind:<open_id>`；sourceRef `employeeId/openId` 入身份键。**凭据未配（ADMIN_FEISHU_APP_ID/SECRET）直接抛错不撞网**；平台任一接口出错整轮 error——出错当"没了"会假闭合；**视图不完整也整轮 error**（翻页/容量截断、根部门直属成员拉不到〔应用缺通讯录权限是常见态〕——否则根部门的人会天天被误判离职，审查 P2-1；长期如此请补权限或在待办路由关掉本扫描器）。平台读每轮留审计（username `system:scan`）。
- `scan.payroll.social`（社保增减员，**closeOnAbsence=false**）：名册离职日期进 [今天-90d, 今天+31d] → "离职次月 15 日前减员 + 出最后一月工资单"（过期 critical；15 日是常规推算，以社保局/公积金中心通知为准）；入职日期进 [今天-60d, 今天] → "入职 30 日内增员"（due=入职+30d）。已归档的人不进场也**不自动闭合**（办没办只有人知道）——与征期同款：「已完成」无备注=unverifiable、force+备注=dismissed，dismissed 不因源头重现重开。dedupe `scan.payroll.social:leave|hire:<employeeId>`。
- `scan.finance.profile`（建档参数，**closeOnAbsence=false**）：主体类型/纳税人身份/征收方式/纳税期限（征期扫描器排日历用的四项）与 app_meta `finance.profile_snapshot` 比对，**首轮只记基线不报**（快照损坏同样按首轮重建基线不报，审查 P3-3）；变了出 warn（标题带前后值，detail 带税务含义提示+"本期已按旧口径申报的要不要更正问会计"），比对完即更新快照——同一处改动只报一次；dedupe 含当日 `scan.finance.profile:<key>:<YYYY-MM-DD>`：同键当日多改并进同行刷新口径，隔日再改另起一行；四项之外的参数不报。改动即时性=下一轮扫描（每日 08:30 / 手动），不是改完立刻。

**dedupe_key 设计原则**：源头主键 + 影响到期口径的字段（到期日变了就该是新义务）；severity 自己定（info 不推送）。
**生产预警的 closeOnAbsence 怎么选**：MES 里"订单延期"这种事实一旦出现就该一直在场直到人处理——多半是 `false`；
而"工单完工"系统查得到（工单状态变化）——这种来源应该让 scan() 在事实消失时不再产出候选并用缺省 true。接的时候按每个来源想清楚，别整线一刀切。

接一个新来源（例：MES 生产预警 `mes.order_overdue`）四步，**框架一行不改**：

1. 在 `obligation-scanner.service.ts` 写 `scanXxx(now)` 返回候选；dedupe_key 设计原则=**源头主键 + 影响到期口径的字段**
   （到期日变了就该是新义务）；severity 自己定（info 不推送）。
2. `SOURCE_LABELS` 加 `'mes.order_overdue': '生产预警'`；`this.scanners` 数组加一行 `{ key, label, scan }`。
3. 前端 `web/apps/web-antd/src/views/todos/todo-item.vue` 的 `SOURCE_LABELS` 同步加标签（缺了显示原始 key，不报错）。
4. 责任路由自动有默认（老板），企业页「责任路由」里可改到 `role:生产主管` 并可整线关掉。

数据来源若在外部系统（MES 数据库/接口），在 `scan()` 里读；读失败抛错即可——`scan_runs.errors` 留痕、其他扫描器照跑、
已有活跃行**不会**被误闭合（候选为空是异常不是"源头消失"：本轮 error 时跳过 upsert 与 auto-resolve 整段）。

## 与方案的诚实偏离与未做项（2026-10-31 审查后收口定版）

1. **菜单角标未做**（方案 §七提过"逾期+今日数"）：角标要接全局计数、每页刷新都算一遍，一期不接——
   待办中心的摘要标签 + 晨报已覆盖"知道有多少事"。要做再开增量（Vben meta.badge）。
2. **来源 deep link 未做**（方案 §七"行动作第一项"）：卡片与前端都没有"跳到源头账目/票夹"的按钮——
   系统无对外可达 URL 配置（局域网 host 因部署而异）；source_ref 已落库，做的时候只是加按钮。
3. **卡片「暂不处理」= ack（静音）而非方案 §六字面的 dismiss**：按错按钮直接永久静默太重，静音+到期日当天升级还会再提一次更稳；
   核实式完成上线后（二批），推导型卡只有「暂不处理」——「已完成」要填备注/看核实结果，在待办中心做（人工待办卡仍有「已完成」）。
4. **老板晨报=个人卡+企业信号合一张**，不是 §六 字面的"另推"：内容项（总览/昨日全员/告警）全在，只是不做两张卡。
5. **失败纪律落地为"近 3 天失败汇总进老板晨报"**，不是 §五 字面的"连续 ≥3 天→告警"：效果等价且不需要额外计数器。
6. **个人晨报的"昨日回顾"一行**为 2026-10-31 补齐（§六原文，审查发现漏做）。
7. **对话文件工作区（inbox/outbox）是全局共享目录**——任何持 agent:read 的账号可列出/读回全部工作区文件
   （`GET /api/agent/files*` 无按人归属）。这不在方案 §1.6 数据分割裁决表内（审查补的洞）：流水表这类经营文件
   放进对话就可能被其他有 agent 权限的账号看到。**待用户拍板**：按上传人隔离（改动面=共享 dsh runtime 的
   ADMIN_WORKSPACE_DIR 契约+文件工具插件），或先接受"工作区=企业共享区"口径并写进使用守则。
8. **scanRunsApi 已定义未接界面**（`web/src/api/todos.ts`）：扫描记录只有 REST 没有 UI，管理员排查看 `GET /api/todos/scan-runs`。

## 依赖与数据边界

依赖 `../db`（表 `obligations/scan_runs/obligation_routes` 归 `schema.ts` 权威 DDL，纯增量 `CREATE IF NOT EXISTS`）、
`../rbac`（权限/角色/老板账号）、`../audit`、`../finance`（账本/票夹/提案读口径）、`../bridge`（推送与回写端口）。
bridge 反向只认 `TodoCardActionPort` 接口（构造时注入 TodosService），不 import 本域实现。
数据只在 SQLite（经营内容，不出域、不进知识库语料）。

## 测试位置

`server/test/todos.test.ts`（28 用例，含扫描器计数钉子十二个：生产供应 v0 两扫描器+v0.5 批次临期+工资/建档三〔2026-11-02〕；RBAC 门含 403 反例/建待办/可见性与 enterprise 403/岗位池与摘要/**推导型核实流程（源头不存在/仍在+解除静音/征期无法核实/强制确认必填备注且不翻案）**/**人工 done 带备注+空体+审计不落正文**/
路由 PUT/手动扫描幂等（月初 1–8 号征期未进 +7 天窗口的口径分支）/扫描器进出场+升级+去重+闭合+重开+**推导型卡 canDone=false**/路由改绑移交活跃项/**改绑不动 user_edited 行**/晨报+第 3 天重推+ack 静音到第 7 天/卡片回写/
**窗口滑出不假闭合**/**核实不假闭合（账目改期换键→并进口径；改期出窗口→如实说明）**/缺票真实总数/**新指派即时卡**/**升级抄送老板**/**老板空盘也收总览+真实审计键+扫描告警+个人昨日回顾**/重入锁/scan-at 解析）+
`agent-isolation.test.ts`（5：对话域按人隔离，同方案 P0-a）。全套 `npm test` 2026-11-02 为 **362/362**（346 之上：财务线审批落账 +12=358，生产线 v0.5.1 域设置/仓库名提示/扫描前自动同步/同步结果提示 +4；全月历投影落地当时为 300/300；含全月历投影 4 用例：窗口外预列/身份分支与跨年季度标签/让位与个税代扣门控/phase 三档注入 today 钉死/**小规模按季 runAll 不重复枚举**〔对抗审查 P0 回归〕）。
（同日修掉三处日期踩死的既有测试：attachments 目录写死 2026/10、filing 口径冲销跨月、社保月初窗口——改为相对真实时钟。）
改动本目录必须重跑 `npm test`；**`--test-force-exit` 会吞掉 before() 钩子里的异常**（整文件只报 "test failed"），
排查时用 `node --input-type=module -e` 复现 before 步骤并给 Nest `logger: ['error']`。

## 生命周期状态

`active`（2026-10-31 待办预警方案 P0–P3 一次交付；同日二批=按钮/核实式完成/详情抽屉按用户口述定版，2026-11-01 对抗审查修复收口）。
下次审查条件：MES/生产数据接入时（启用 `mes.*` 槽）；征期政策年度更新时（与 finance 征期口径同步）；
飞书任务投影（§十 ④）被要求时；dismissed 需要界面级恢复入口时（当前口径=管理员改库，见规则 1）。

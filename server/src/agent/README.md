---
type: module
updated: 2026-10-27
status: active
lifecycle: active
project: 公司智能体
tags: [agent-gateway, dsh-sdk, sessions, resume, sse, audit, rbac, workspace]
---

# server/src/agent（对话域网关）

## 职责

管理网页内嵌智能体对话框的后端全链路（2026-10-27 框架定版：对话域完整化）：
会话与消息持久化（`agent_sessions`/`agent_messages` 两表，与账本同库）、多会话 CRUD、
历史回看、跨进程重启续聊（DSH `session/resume` 原生续聊）、中断生成（进程级）、
轮次互斥与超时回收、文件工作区（inbox/outbox）。
管理一个专属 DSH SDK runtime 子进程（与 3080 常驻服务解耦），把对话框消息转成 agent 轮次
流式吐回（SSE）。**账本只在 SQLite**：agent 落账走管理后端 REST 工具，模型 key 只在服务端。

## 非职责

- 不做 agent 运行时本体（DSH 的事，本模块只 spawn 与说线协议）、不做知识检索（kb-rag 的事）。
- 线协议没有 cancel：不做协议级中断（中断=kill 子进程，下一轮重建+resume，见规则 3）。
- 不做多会话并发轮次（一个 runtime 同时只跑一轮，全局互斥；单人场景的明确取舍）。
- 消息编辑/fork/排队、逐会话模型切换、多租户：占位不做。

## 文件

| 文件 | 职责 |
| --- | --- |
| `dsh-runtime.ts` | dsh 子进程 JSON-RPC 客户端（线协议 **0.2.1-rc.4**）：initialize 握手 / prompt 轮次 / session/resume 续聊 / shutdown；`owned` 持有表（run/resume 成功 add、exit/close 清空）驱动"要不要 resume"的判断；`RuntimeDiedError`（子进程死）/`TurnTimeoutError`（网关放弃等待）两种可恢复失败；崩溃自愈=下一轮自动换新进程。**DSH 源码一行不改**，依赖=`@deepseek-ai/dsh-sdk-protocol`（0.2.1-rc.4，显式声明） |
| `agent.service.ts` | 对话网关服务：会话 CRUD（标题=首条消息前 24 字、重命名 ≤50、归档、删除=应用层级联两表）、消息落库（user 先落、assistant 按 ok/interrupted/error 三态）、chat 主流程（互斥单槽 → resume 判断 → runtime.run → 落库+审计 → 三类失败路径）、stop（kill 子进程 → 轮次按 interrupted 收尾）、超时回收（弃 runtime 解 already-owned 死结）、给子进程直签 boss JWT（`ADMIN_AGENT_TOKEN`，TTL 3650d 豁免见代码注释） |
| `agent.controller.ts` | REST+SSE 面：会话 CRUD/messages、`POST /api/agent/chat`（SSE：status/tool/assistant/final/error 五种帧）、stop、文件工作区三端点；权限读=agent:read、写=agent:write；chat 空/超长校验前移到 SSE 头之前（400 JSON，不让 HTTP 层永远 200） |
| `workspace.ts` | 文件工作区：inbox/outbox 白名单+`safeResolve` 路径封口+1MB/5000 行上限；只收文本（csv/tsv/txt/md） |

## 领域规则速查

1. **会话与消息持久化**：`agent_sessions`（id/title/dsh_session_id/created_by/archived）+
   `agent_messages`（role user|assistant、content、tools JSON、status ok|interrupted|error）。
   CREATE TABLE IF NOT EXISTS 幂等，老库自动补建。删除会话=应用层事务级联删两表（不依赖外键 PRAGMA）；
   **DSH 侧会话库记录不动**（协议不提供删除，历史留日志）。
2. **resume 判据**：`!runtime.hasSession(dshId) && 消息表有 assistant 行` 才发 `session/resume`
   （服务重启/进程重建/崩溃自愈后）。resume 被拒（DSH 会话库缺失或 already-owned）→ **降级新上下文继续**：
   SSE 发 `status: fresh-context` 帧如实告知前端，原因留服务端日志（会话库缺失与 already-owned 僵尸是两种不同的病）。
3. **中断=进程级**：线协议任何版本无 cancel。stop=kill 子进程 → pending 轮次立刻失败 →
   已生成的半截回答按 `interrupted` 落库 + SSE `final{interrupted:true}`；下一轮重建 runtime 后先 resume 原会话。
4. **超时回收**（对抗审查 P1-1）：轮次超时（缺省 180s，`ADMIN_AGENT_TURN_TIMEOUT_MS` 可调）=
   网关放弃等待并**关闭弃掉整个 runtime**——子进程那一轮可能还在跑，留着就是僵尸（持有表已 owned，
   后续 resume 会被 already-owned 拒绝，死结）；弃掉后下一轮新进程 resume 原会话，无损续聊。
5. **互斥与生成中守卫**：一个 runtime 同时只跑一轮（同步占住互斥槽，检查与占用之间无 await）；
   进行中再发消息 → 400「上一条消息还在处理中」；删除/归档正在生成的会话 → 400（后端守门，前端另有拦截）。
6. **审计口径**：会话动作 `agent.session.create/rename/archive/delete/stop` 轻量几条；
   `agent.chat` 只记 chars/tools（失败记 failed+error 截 200 字）；`agent.file.save` 只记元信息。
   **消息正文不进审计**（正文在消息表，审计不重复持敏感内容）。
   **审计查询通道=智能体**（2026-10-27 用户拍板：前端审计页已建即撤）：插件 `dsh-audit-tools.mjs`
   注册 audit_query 工具查 `GET /api/audit`（经 finance-desk-rest.patch.yml 挂载）；
   注意 DSH 插件契约——工具 output 声明必须 `{schema, render}`（runtime register() 硬校验，
   缺 render 整个 preset 装配被拒、prompt 直接报错），改插件先跑 `dsh-audit-tools.test.mjs`。
7. **身份与密钥**：子进程环境走白名单（PATH 按位置拼、HOME、ADMIN_API_BASE、ADMIN_AGENT_TOKEN、
   ZAI key 等）；网关自己的 `ADMIN_JWT_SECRET`/`ADMIN_BOSS_PASSWORD` **明确不传给 dsh 子进程**。
   `ADMIN_AGENT_TOKEN`=网关直签的 boss JWT，TTL 3650d——常驻 runtime 可能活几个月，常规 30 天过期会让
   财务工具批量 401 静默坏死；随进程重启换新、不落盘不外发（本机单人部署的明确取舍）。
8. **模型缺省**：`glm-5.3-flash`（rc.4 起 pi-ai 对模型目录外模型严格拒绝；`glm-route.patch.yml`
   目录只声明 flash/highspeed，rc.2 时代 `glm-5.3` 能混过去、rc.4 会拒）。目录单一事实源，
   改模型先改补丁文件再同步。

## API 面（/api/agent 前缀，Bearer 鉴权）

- `GET|POST /api/agent/sessions`（列表 includeArchived=1 / 新建）、`GET …/:id/messages`（历史）
- `PATCH …/:id`（title/archived）、`DELETE …/:id`（级联删）、`POST …/:id/stop`（中断当前轮次）
- `POST /api/agent/chat`（SSE 流式；body: sessionId 可选〔缺省自动开新会话，final 帧带回〕+ message ≤4000 字
  + context{page,entryId} 白名单注入提示词；final 带 interrupted 表示被停）
- `POST /api/agent/files`（传文件进 inbox/outbox）、`GET /api/agent/files`（列表）、
  `GET /api/agent/files/:dir/:name`（读回）

## 测试位置

- runtime 协议层：`server/test/agent.test.ts`（假 dsh 进程：握手/轮次/崩溃自愈/resume 成功与被拒/持有表清空）
- HTTP 全链路：`server/test/agent-sessions.test.ts`（12 用例：权限独立/CRUD 级联/两轮落库/标题/
  崩溃 error 落库+换进程 resume 回归/stop interrupted/自动开新会话/**超时回收+互斥+生成中守卫+
  弃 runtime 后新进程 resume**/**resume 被拒降级 fresh-context**/空与超长 400/审计不含正文+系统审计端点筛选）
- 假 dsh 脚本 `test/fake-dsh-script.ts` 旗标文件驱动（crash/hang/batch/resume-fail 可热改；
  **不能用 env 传旗标**——子进程 env 在 spawn 时固化，文件每次请求重读）；轮次超时用例依赖
  `ADMIN_AGENT_TURN_TIMEOUT_MS=4000`（测试自设，普通轮次 fake 20ms 不受影响）。
- 改动本目录必须重跑 `npm test`（tsx 直跑 TS 不生成装饰器元数据，Nest 注入全线挂）。

## 已知边界（有意接受）

- resume 降级后对话丢历史上下文（模型侧），消息表记录仍在、界面可回看——DSH 会话库缺失时的最优解。
- 超时后原轮次在子进程侧可能实际仍在跑（已弃掉的僵尸进程随 close() 被杀，不再持有表内）。
- 全局单轮互斥：老板开两个浏览器标签同时发消息，后发的会收到"处理中"。

## 生命周期状态

`active`（2026-10-27 框架定版交付：依赖 rc.2→rc.4 解锁原生续聊、两表持久化、多会话 CRUD、
stop 中断、超时回收、resume 降级、审计查询走智能体工具（前端审计页同日已建即撤）、文件工作区并入；
2026-10-27 晚审计退后台增量：dsh-audit-tools 插件+真模型端到端验证过）。
下次审查条件：DSH 升级 stable（线协议变更时）、开多岗位（agent:write 之外或需按会话分权）、
或新增第三种失败路径时。

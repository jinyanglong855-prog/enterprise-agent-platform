---
type: instructions
scope: 任何以本目录为工作区的 AI 编码会话
---

# 企业智能体平台 · AI 协作开发公约

以本目录为工作区的 AI 会话，先读完本文件再动手；多会话并行时本文件是同一份行为公约。

## 项目定位与边界

- 本仓库 = 企业智能体平台的"脸和账本"：SQLite 账本=唯一事实源；业务 REST API（RBAC+审计护住所有写路径）；Vben Admin v5 前端；DSH SDK 子进程对话网关；飞书融合层（`server/src/bridge/`）。
- **Agent 运行时（DeepSeek Harness）源码一行不改**：平台只通过自建工具插件与 REST 双通道接入。
- 非职责：agent 运行时本身、知识检索（kb-rag 仓库）、报税申报（企业侧在电子税务局办理）。
- 底层框架与样例数据分离：样例角色数据只进 `server/scripts/sample/`，不进底层 seed；权限点做全、拼装下放企业。

## 权威文件（改哪块先读哪块，不凭记忆）

| 主题 | 权威位置 |
| --- | --- |
| 财务域规则、口径、模块边界 | `server/src/finance/README.md` |
| 对话域协议、网关边界 | `server/src/agent/README.md` |
| 待办/义务域口径 | `server/src/todos/README.md` |
| 供应链域口径 | `server/src/supply/README.md` |
| 知识库域接入 | `server/src/knowledge/README.md` |
| 前端自有改动清单 | `web/README.md` |
| API 面/环境变量/已知限制 | 根 `README.md` |

## 开发纪律

- 测试：`cd server && npm test`，**必须走 tsc 构建**（tsx 直跑 TS 不生成装饰器元数据，会全线 500/401 假报错）；交付前测试全绿才算完成，不拿"能跑"冒充"交付"。
- better-sqlite3 原生绑定：pnpm 环境先 `pnpm approve-builds`；npm 12 先 `npm install-scripts approve better-sqlite3 && npm rebuild better-sqlite3`。
- 金额一律存分（整数）；账户余额与对账账面数共用 `finance-flow.ts` 单源，不另算第二份。
- 所有写路径必须进审计（`X-Actor-Source` 区分 ui/agent/confirm/bridge）；agent 来源禁止直接落库，只能走提案卡确认。
- 凭据只走环境变量（App Secret、JWT secret、初始密码），不进任何文档、代码、提交。
- 出数月份账目禁改只许冲销；票守门默认从严（改动须同步 `invoice-guard` 用例）。
- 语义改动同步更新对应模块 README；"与既有口径的已知差异"清单是**有意接受**，勿当 bug 修。
- 语义改动交付前跑无上下文对抗审查（让没有本会话上下文的 AI 专挑毛病），P0/P1 当场修。

## 运行与端口

- 后端缺省 `http://127.0.0.1:3210`（`ADMIN_PORT` 可覆盖）；账本数据与凭据在数据目录（缺省 `~/.dsh/company-data/admin/`），**永不进仓**。
- 开发/测试用 `ADMIN_DATA_DIR`/`ADMIN_DB_PATH` 指到临时目录，不碰部署实例的库；日常开发错开端口。
- 多线并行用 git 分支/worktree：main 保持"测试全绿、可部署"；分支上的构建产物不得覆盖部署实例的 dist。

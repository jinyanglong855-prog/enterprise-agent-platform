# knowledge 模块（2026-11-02 阶段 3 知识库融合）

把本机 kb-rag 知识库（检索/问答）包成管理台 REST 面。职责边界：本模块只做 **子进程生命周期 + 文本格式解析 + 权限与审计**；检索质量、读范围、索引新鲜度的权威都在 kb-rag 仓库（`项目文件/kb-rag/项目文件`）。

## 文件

| 文件 | 职责 |
|---|---|
| `kb-mcp-client.ts` | 官方 `@modelcontextprotocol/sdk` 的 stdio 客户端封装：首次调用才拉起 `kb-rag-mcp` 子进程（嵌入模型冷启动数秒，不白白常驻）；握手、分帧、请求超时、结果校验交给 SDK 不自写；空闲 `kbIdleMs`（缺省 10 分钟）自动关；子进程崩溃/被杀后丢弃连接、下次调用重拉；stderr 进诊断日志；`close()` 供 main.ts 关停阶梯调用 |
| `knowledge.service.ts` | `search`=`kb_vector_search` 语义召回 + **按文档折叠**（多取一倍、每篇只留最相关一段，界面一行一篇）；`ask`=`kb_ask`（kb-rag 侧检索+LLM 带来源回答），正文与「来源：」脚注分离、父块/分析卡尾注剥掉、正文开头的 `⚠` 索引状态行拆进 `notice` 字段（运维口径含 CLI 指令，界面人话转述、审计记 `indexNotice`）；kb-rag 返回的是给 agent 读的文本，按稳定格式解析，解析不出时原文透传 `raw` 不硬死；问题长度/条数校验；审计 `knowledge.search`/`knowledge.ask` |
| `knowledge.controller.ts` | `GET /api/knowledge/status`（configured/running/caller/lastFailure）、`GET /api/knowledge/search?q=&k=`、`POST /api/knowledge/ask {question,k}`——全部 `knowledge:read`（权限点第 14 项，老板角色缺省持有；员工要开放在角色权限页勾） |

## 配置（全走环境变量，缺省=未接入，接口 503 人话提示不拒服务）

| env | 缺省 | 说明 |
|---|---|---|
| `ADMIN_KB_RAG_DIR` | 空 | kb-rag 仓库目录（含 `pyproject.toml` 的那层）；空=知识库未接入 |
| `ADMIN_KB_MCP_COMMAND` | `uv` | MCP 子进程命令（测试接 `node <假件>` 用） |
| `ADMIN_KB_MCP_ARGS` | `--directory <ADMIN_KB_RAG_DIR> run kb-rag-mcp` | 空格分隔；整体覆盖时 RAG_DIR 可以不配 |
| `ADMIN_KB_CALLER` | `company-console` | 子进程 `KB_CALLER`——**读范围事实源在 kb-rag `scopes.json`**：company-console 只读 `公司智能体`+`Shared`，私人项目（个人画像等）不可检索、全库零写 |
| `ADMIN_KB_IDLE_MS` | 600000 | 子进程空闲自动停毫秒数；0=不自动停 |

## 决策记录（含实测依据，2026-11-02）

- **搜索选 `kb_vector_search` 不选 `kb_hybrid_search`**：同一批政策问法实测，hybrid（BM25 融合）16 块内召不回 `.dsh/skills` 财务手册独有内容（红冲规则等），而 `公司智能体/项目状态/README.md` 的「当前状态」一节被切成 39 块同标题高密度文本霸榜（最多占 16 席中 6 席）；纯向量对手册排 1/1/2/4，精确标题也第 1 命中。README 过长是知识库结构问题，根治应把逐批历史挪去工作日志（待用户拍板，不在本模块修）。
- **读范围不在本模块做二次过滤**：kb-rag `_scoped` 在召回后按 scope 过滤再截断，受限调用者超量召回避免 top-k 被越权内容挤占——两套过滤会互相打架，一套事实源。
- **不缓存结果**：知识库增量入库后立即可检索（kb-rag `add` 语义），缓存会给出陈旧答案。
- **kb-rag 的 CLI 说明文本不上界面**：索引未建/错位时 kb_ask 不走 LLM 直接返回「请先运行 uv run kb-rag index…」（无 ⚠ 无来源），搜索侧以工具错误抛同类文案；服务端按 `kb-rag (index|add)` 识别统一转 503「知识库索引未就绪：请联系管理员重建索引后再试」（对抗审查 P2-1）。
- **空闲计时器看飞行中计数**：并发请求下先完成的不能把后完成的连子进程一起关掉，inflight>0 不装计时器（对抗审查 P3-1）。
- **MCP 文本解析带兜底**：`_fmt_hits`/`来源：` 脚注格式变了不会 500——返回 `raw` 原文，界面仍可读。

## 测试

`test/knowledge-api.test.ts` 15 用例（2026-11-02，含对抗审查后补的 3 条）：解析器单测（块头切分/空结果/脚注尾注白名单剥离/⚠ notice 拆分/按文档折叠）+ 假 MCP 子进程全链路（客户端走真·官方 SDK，假件 `test/fake-kb-mcp-script.ts` 讲线协议：懒启动、KB_CALLER 透传、401/403、审计留痕、崩溃 503 人话提示+自动重拉、空闲自停再拉、未配置 503、索引未建/错位的 CLI 说明文本转 503 人话〔搜索与问答两路〕、搜索格式漂移 raw 透传、无 notice 分支、`?k=` 空串回退缺省）。假件的 spawn 日志/旗标固定在脚本所在目录——客户端 env 只转发 `KB_CALLER` 是生产口径，不为测试开口子。

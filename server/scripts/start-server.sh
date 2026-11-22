#!/bin/bash
# start-server.sh — 管理后端常驻启动脚本（launchd 用）。
#
# 为什么不直接在 plist 里写 node：launchd 环境没有 shell profile，
# 对话网关 spawn dsh 子进程要用的 ZAI_CODING_CN_API_KEY 只在 ~/.zshrc。
# 密钥唯一事实源仍是 ~/.zshrc，这里运行时提取，不复制到第二个文件
# （换 key 只改 zshrc，unload/load 即生效）。
set -euo pipefail

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

key_line="$(grep -E '^export ZAI_CODING_CN_API_KEY=' "$HOME/.zshrc" | tail -1 || true)"
if [ -n "$key_line" ]; then
  key="${key_line#*=}"
  key="${key%\"}"; key="${key#\"}"
  key="${key%\'}"; key="${key#\'}"
  export ZAI_CODING_CN_API_KEY="$key"
else
  echo "$(date '+%F %T') WARN: ~/.zshrc 里没找到 ZAI_CODING_CN_API_KEY，服务照起但对话网关调不了模型" >&2
fi

# 飞书凭据与桥开关（融合层，2026-10-29）：同款提取模式，唯一事实源 ~/.zshrc。
# 缺失不算错——桥不开/适配器没被选中时用不上；开了桥且凭据缺失时 bridge 闸会大声拒绝。
# 注意 ADMIN_BRIDGE_ENABLED/ADMIN_BRIDGE_ADAPTER 也走这里：只改脚本不导出，
# unload/load 后桥会静默不开（日志仅一行"未启用"），生产开桥这两个变量必须在 zshrc。
# 知识库接入（2026-11-02 阶段 3）：ADMIN_KB_RAG_DIR 空=未接入（接口 503 人话提示）；
# launchd 的 PATH 只有系统目录，`uv` 在 ~/.local/bin 找不到，所以 ADMIN_KB_MCP_COMMAND
# 在 zshrc 里写绝对路径，不在这里改 PATH（改了会连带影响子进程找别的命令）。
# 联网搜索（2026-11-03）：DEEPSEEK_API_KEY 是网关 spawn 的 dsh 子进程里 web_search
# 工具 deepseek 搜索源的凭据（凭据层 refs 为空时回退读进程环境）；缺失=搜索明说不可用并绕行抓取，不算错。
for opt_var in ADMIN_FEISHU_APP_ID ADMIN_FEISHU_APP_SECRET ADMIN_BRIDGE_ENABLED ADMIN_BRIDGE_ADAPTER \
  ADMIN_KB_RAG_DIR ADMIN_KB_MCP_COMMAND ADMIN_KB_MCP_ARGS ADMIN_KB_CALLER ADMIN_KB_IDLE_MS \
  DEEPSEEK_API_KEY; do
  opt_line="$(grep -E "^export ${opt_var}=" "$HOME/.zshrc" | tail -1 || true)"
  if [ -n "$opt_line" ]; then
    opt_val="${opt_line#*=}"
    opt_val="${opt_val%\"}"; opt_val="${opt_val#\"}"
    opt_val="${opt_val%\'}"; opt_val="${opt_val#\'}"
    export "$opt_var=$opt_val"
  fi
done

cd "$SERVER_DIR"
exec /usr/local/bin/node dist/src/main.js

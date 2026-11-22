#!/bin/bash
# 账本 SQLite 每日备份（方案 §8：P1 随上线走，账本不可重建）。
# 用 sqlite3 .backup（对 WAL 安全），保留最近 30 份，超出的自动清理。
# 安装见 ../launchd/README.md；手动执行：backup-db.sh [--db 路径] [--to 目录] [--keep N]

set -euo pipefail

DB="${ADMIN_DB_PATH:-$HOME/.dsh/company-data/admin/ledger.db}"
TO_DIR="${ADMIN_BACKUP_DIR:-$HOME/.dsh/company-data/admin/backups}"
KEEP=30

while [[ $# -gt 0 ]]; do
  case "$1" in
    --db) DB="$2"; shift 2 ;;
    --to) TO_DIR="$2"; shift 2 ;;
    --keep) KEEP="$2"; shift 2 ;;
    *) echo "未知参数：$1"; exit 1 ;;
  esac
done

if [[ ! -f "${DB}" ]]; then
  echo "账本不存在：${DB}（尚未初始化？先启动一次管理后端）" >&2
  exit 1
fi

mkdir -p "${TO_DIR}"
STAMP="$(date +%Y%m%d-%H%M%S)"
TARGET="${TO_DIR}/ledger-${STAMP}.db"

# .backup 在线备份：不锁库、对 WAL 一致
sqlite3 "${DB}" ".backup '${TARGET}'"
# 副本转为独立文件（脱离 WAL 模式）并清掉边车，归档干净
sqlite3 "${TARGET}" "PRAGMA journal_mode=delete;" >/dev/null
rm -f "${TARGET}-wal" "${TARGET}-shm"

# 校验备份可读且完整（quick_check + 条目数非零才认）
CHECK="$(sqlite3 "${TARGET}" 'PRAGMA quick_check;')"
COUNT="$(sqlite3 "${TARGET}" 'SELECT COUNT(*) FROM finance_entries;' 2>/dev/null || echo 0)"
if [[ "${CHECK}" != "ok" ]]; then
  echo "备份校验失败（quick_check=${CHECK}）：${TARGET}" >&2
  rm -f "${TARGET}"
  exit 1
fi
echo "已备份：${TARGET}（账目 ${COUNT} 笔）"

# 清理过期备份（保留最近 KEEP 份）；首跑目录只有本次备份，ls 无匹配也不能让 set -e 误杀
ALL_BACKUPS="$(ls -t "${TO_DIR}"/ledger-*.db 2>/dev/null || true)"
if [[ -n "${ALL_BACKUPS}" ]]; then
  echo "${ALL_BACKUPS}" | tail -n +$((KEEP + 1)) | while IFS= read -r old; do
    rm -f "${old}"
    echo "已清理过期备份：${old}"
  done
fi

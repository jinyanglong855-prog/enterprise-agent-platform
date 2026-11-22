# launchd 定时任务与常驻服务（账本备份 + 管理后端）

## 重要：为什么脚本要拷到 ~/.dsh/bin

macOS 不给 launchd 拉起的后台进程「文稿」（~/Documents）文件夹访问权——plist 直接指向
仓库里的脚本会 `Operation not permitted`（2026-10-26 实测，两个任务都中招）。
所以安装时把脚本拷到 `~/.dsh/bin/`；**仓库 `../server/scripts/` 仍是唯一事实源**，
改完脚本要重新拷贝（plist 里的注释也写了同一步骤）。

## 一、账本每日备份（P1 上线必装，方案 §8：账本不可重建）

- 脚本：`../server/scripts/backup-db.sh`（sqlite3 在线备份 → 校验 → 保留最近 30 份）
- 备份位置：`~/.dsh/company-data/admin/backups/ledger-YYYYMMDD-HHMMSS.db`
- 每天 21:30 跑；日志 `~/.dsh/logs/admin-backup.log`

```bash
mkdir -p ~/.dsh/bin
cp ../server/scripts/backup-db.sh ~/.dsh/bin/backup-admin-ledger.sh
cp com.company.admin-ledger-backup.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.company.admin-ledger-backup.plist
bash ~/.dsh/bin/backup-admin-ledger.sh   # 手动先跑一次验证
```

验证：`launchctl list | grep admin-ledger`；`ls ~/.dsh/company-data/admin/backups/`。

## 二、管理后端常驻服务（切换检查单第③步的运行前提）

- 脚本：`../server/scripts/start-server.sh`（提取 ~/.zshrc 里的模型 key → cd server → node dist/src/main.js）
- 崩溃自动拉起（KeepAlive）、开机自启（RunAtLoad）；日志 `~/.dsh/logs/admin-server.log`

```bash
mkdir -p ~/.dsh/bin
cp ../server/scripts/start-server.sh ~/.dsh/bin/start-admin-server.sh
cp com.company.admin-server.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.company.admin-server.plist
```

维护（KeepAlive 会自动拉起进程，改代码重发布时先 unload 再 load）：

```bash
launchctl unload ~/Library/LaunchAgents/com.company.admin-server.plist
# … 重新 build / 拷贝脚本 …
launchctl load ~/Library/LaunchAgents/com.company.admin-server.plist
```

## 恢复（应急）

1. 关管理后端进程（launchd 的先 unload）；
2. `cp backups/ledger-<日期>.db ~/.dsh/company-data/admin/ledger.db`（同目录 `ledger.db-wal`/`-shm` 一并删除）；
3. 重启后端，台账页抽查最近几笔与当天账目核对。

#!/bin/bash

# 這是專為 macOS/Linux 設計的雙擊啟動捷徑 (Mac 使用者可直接雙擊此 .command 檔)
# Version: 9.1.4
cd "$(dirname "$0")"

if [ ! -f "./setup.sh" ]; then
    echo "❌ 找不到 setup.sh，請確認檔案解壓縮完整且您在正確的目錄下執行。"
    sleep 3
    exit 1
fi

chmod +x ./setup.sh

# 啟動魔法模式，確保後續操作無痛且自動排除 Port 佔用
export GOLEM_MAGIC_MODE=true

# 🚨 強制啟動深度清理與全自動部署流程 (確保每次啟動環境皆為 100% 正確)
echo "✨ 正在準備 Project Golem 執行環境 (強制深度清理與自動安裝)..."
# 這裡會觸發 installer.sh 中的 step_sanitize_environment
./setup.sh --magic

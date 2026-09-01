#!/bin/bash

# 顏色定義
GREEN="\033[0;32m"
YELLOW="\033[1;33m"
RED="\033[0;31m"
NC="\033[0m" # No Color

# 自動定位專案根目錄
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo -e "${YELLOW}進入專案根目錄: ${PROJECT_ROOT}${NC}"
cd "$PROJECT_ROOT"

echo -e "${YELLOW}正在生成/刷新 package-lock.json 狀態...${NC}"

# 刷新函數
refresh_lock() {
    local dir=$1
    echo -e "${YELLOW}正在處理目錄: ${dir}${NC}"
    
    if [ -d "${dir}" ]; then
        (cd "${dir}" && npm install --package-lock-only || npm install)
        if [ $? -eq 0 ]; then
            echo -e "${GREEN}[V] ${dir}/package-lock.json 已生成/更新成功。${NC}"
        else
            echo -e "${RED}[X] ${dir} npm install 失敗，請檢查網路或 package.json 配置。${NC}"
            exit 1
        fi
    else
        echo -e "${YELLOW}[!] 目錄 ${dir} 不存在，跳過。${NC}"
    fi
}

# 1. 處理根目錄
refresh_lock "."

# 2. 處理 web-dashboard 目錄
if [ -d "web-dashboard" ]; then
    refresh_lock "web-dashboard"
fi

echo -e "${GREEN}所有 package-lock.json 刷新完畢！${NC}"

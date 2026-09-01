#!/bin/bash

# ==========================================
# Project Golem - Developer Toolkit (dev.sh)
# ==========================================

readonly SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
readonly LIB_DIR="$SCRIPT_DIR/scripts/lib"

# Load colors and utils
[ -f "$LIB_DIR/colors.sh" ] && source "$LIB_DIR/colors.sh"
[ -f "$LIB_DIR/utils.sh" ] && source "$LIB_DIR/utils.sh"
[ -f "$LIB_DIR/ui_components.sh" ] && source "$LIB_DIR/ui_components.sh"
[ -f "$LIB_DIR/system_check.sh" ] && source "$LIB_DIR/system_check.sh"
[ -f "$LIB_DIR/installer.sh" ] && source "$LIB_DIR/installer.sh"
[ -f "$LIB_DIR/docker_manager.sh" ] && source "$LIB_DIR/docker_manager.sh"

ensure_test_env() {
    if [ ! -f "$SCRIPT_DIR/node_modules/.bin/jest" ]; then
        echo -e "${YELLOW}⚠️  偵測到測試環境不完整 (找不到 Jest)${NC}"
        local os=$(os_detect)
        echo -e "   作業系統環境: ${CYAN}${os}${NC}"
        echo ""
        if confirm_action "是否要執行一鍵安裝以修復測試環境？(npm install)"; then
            run_full_install
        else
            echo -e "   ${RED}✖ 測試已取消。請先安裝依賴項。${NC}"
            return 1
        fi
    fi
    return 0
}

get_git_info() {
    if ! command -v git &>/dev/null; then return; fi
    local branch; branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
    local status; status=""
    if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
        status=" ${YELLOW}(Dirty)${NC}"
    else
        status=" ${GREEN}(Clean)${NC}"
    fi
    echo -e "${DIM}Git:${NC} ${CYAN}${branch}${NC}${status}"
}

check_api_keys() {
    [ -f "$DOT_ENV_PATH" ] && source "$DOT_ENV_PATH" 2>/dev/null
    if [ -z "${GEMINI_API_KEYS:-}" ] || [ "$GEMINI_API_KEYS" == "你的Key1,你的Key2,你的Key3" ]; then
        ui_warn "偵測到未設定 GEMINI_API_KEYS，AI 核心可能無法運作。"
        return 1
    fi
    return 0
}

run_the_reaper() {
    echo -e "${RED}💀 正在啟動「靈魂收割者」程序 (The Reaper)...${NC}"
    log "Running The Reaper - Browser Cleanup"
    
    # 找出所有與 chromium / chrome / playwright 相關的行程
    local pids=$(pgrep -f "chromium|chrome|playwright" 2>/dev/null)
    
    if [ -z "$pids" ]; then
        echo -e "   ${GREEN}✔ 掃描完成：目前系統中沒有遺留的殭屍瀏覽器程序。${NC}"
    else
        echo -e "   ${YELLOW}偵測到以下可能遺留的程序詳情:${NC}"
        echo -e "${DIM}   PID    COMMAND${NC}"
        # 使用 ps 顯示 PID 與指令路徑，並縮短過長的參數
        ps -p $pids -o pid=,args= 2>/dev/null | while read -r line; do
            echo -e "   ${CYAN}• ${line:0:100}${NC}..."
        done
        echo ""
        if confirm_action "是否要強制收割 (Kill) 這些程序？"; then
            echo "$pids" | xargs kill -9 2>/dev/null
            echo -e "   ${GREEN}✅ 收割完成！系統資源已釋放。${NC}"
        fi
    fi
}

inspect_memory() {
    local db_path="${SCRIPT_DIR}/data/golem.db"
    # 防呆：檢查常見的記憶體路徑
    [ ! -f "$db_path" ] && db_path="${SCRIPT_DIR}/golem_memory/golem.db"
    
    if [ ! -f "$db_path" ]; then
        ui_error "找不到記憶體數據庫: $db_path"
        return 1
    fi

    if ! command -v sqlite3 &>/dev/null; then
        ui_warn "系統未安裝 sqlite3 指令，無法進行深度檢索。"
        return 1
    fi

    echo -ne "${CYAN}🧠 請輸入搜尋關鍵字 (Search Memory): ${NC}"
    read -r keyword
    if [ -z "$keyword" ]; then return; fi

    echo -e "${DIM}正在檢索神經網絡與歷史日誌...${NC}"
    
    # 1. 檢索 SQLite (如果存在)
    local db_results=""
    if [ -f "$db_path" ]; then
        db_results=$(sqlite3 "$db_path" "SELECT content FROM memories WHERE content LIKE '%$keyword%' LIMIT 3; 2>/dev/null")
        [ -z "$db_results" ] && db_results=$(sqlite3 "$db_path" "SELECT message FROM chat_logs WHERE message LIKE '%$keyword%' LIMIT 3; 2>/dev/null")
    fi

    # 2. 檢索 文本日誌 (logs/single/*.log)
    local log_results=""
    local log_dir="${SCRIPT_DIR}/logs/single"
    if [ -d "$log_dir" ]; then
        log_results=$(grep -h "$keyword" "$log_dir"/*.log 2>/dev/null | head -n 3)
    fi

    if [ -z "$db_results" ] && [ -z "$log_results" ]; then
        echo -e "   ${YELLOW}∅ 找不到相關記憶片段。${NC}"
    else
        echo -e "   ${GREEN}✨ 找到以下記憶片段:${NC}"
        echo -e "${DIM}----------------------------------------${NC}"
        [ -n "$db_results" ] && echo "$db_results" | sed 's/^/   [DB] • /'
        [ -n "$log_results" ] && echo "$log_results" | sed 's/^/   [LOG] • /'
        echo -e "${DIM}----------------------------------------${NC}"
    fi
}

show_help() {
    echo -e "${BOLD}Project Golem Developer Toolkit${NC}"
    echo "Usage: ./dev.sh [OPTIONS]"
    echo ""
    echo "OPTIONS:"
    echo "  --test        執行所有單元測試 (Jest)"
    echo "  --test-sec    僅執行安全性過濾測試"
    echo "  --dev         啟動開發者重載模式 (Nodemon)"
    echo "  --build       建置 Web Dashboard (Next.js)"
    echo "  --setup       一鍵部署開發環境 (Complete Setup)"
    echo "  --logs        即時監控系統日誌"
    echo "  --reaper      清理遺留的瀏覽器殭屍程序"
    echo "  --doctor      執行系統診斷工具"
    echo "  --clean       清理所有 node_modules 與建置快取"
    echo "  --help, -h    顯示此說明"
    echo ""
}

show_dev_menu() {
    check_status
    clear; echo ""
    box_header_dashboard
    echo -ne "  ${BOLD}${MAGENTA}🛠  開發者工具箱${NC} ${DIM}•${NC} "
    get_git_info
    echo ""
    
    local options=(
        "Dev|🚀 啟動開發者重載模式 (Nodemon Dev)"
        "Test|🧪 執行全系統單元測試 (Run All Tests)"
        "TestSec|🛡️  僅執行安全性過濾測試 (Security Scan Only)"
        "Build|🏗️  建置 Web Dashboard (Next.js Build)"
        "Logs|📜 查看系統即時日誌 (Tail Logs)"
        "Inspect|🧠 神經記憶檢索器 (Memory Inspector)"
        "Setup|⚙️  一鍵部署開發環境 (Complete Setup)"
        "Doctor|🏥 執行系統深度診斷 (Run Doctor)"
        "Docker|🐳 Docker 容器管理介面 (Docker Manager)"
        "Reaper|💀 啟動靈魂收割者 (Cleanup Zombies)"
        "Clean|🧹 執行深度清理 (Deep Clean - node_modules)"
        "Quit|🚪 退出介面 (Exit)"
    )

    prompt_singleselect "請選擇開發操作：" "${options[@]}"
    local choice="$SINGLESELECT_RESULT"

    case "$choice" in
        "Dev")
            check_api_keys
            echo -e "${CYAN}🚀 正在以開發模式啟動 Golem...${NC}"
            npm run dev ;;
        "Test")    
            if ensure_test_env; then
                echo -e "${CYAN}🧪 執行測試中...${NC}"; npm test
            fi
            echo ""; read -r -p "  按 Enter 返回選單..."; show_dev_menu ;;
        "TestSec") 
            if ensure_test_env; then
                echo -e "${CYAN}🛡️  安全性掃描中...${NC}"; npm run test:security
            fi
            echo ""; read -r -p "  按 Enter 返回選單..."; show_dev_menu ;;
        "Build")   echo -e "${CYAN}🏗️  建置 Dashboard 中...${NC}"; npm run build; echo ""; read -r -p "  按 Enter 返回選單..."; show_dev_menu ;;
        "Logs")
            echo -e "${CYAN}📜 正在監控日誌 (Ctrl+C 退出)...${NC}"
            mkdir -p logs
            touch logs/setup.log
            tail -f logs/*.log 2>/dev/null ;;
        "Inspect") inspect_memory; echo ""; read -r -p "  按 Enter 返回選單..."; show_dev_menu ;;
        "Setup")   run_full_install; echo ""; read -r -p "  按 Enter 返回選單..."; show_dev_menu ;;
        "Doctor")  npm run doctor; echo ""; read -r -p "  按 Enter 返回選單..."; show_dev_menu ;;
        "Docker")  launch_docker; echo ""; read -r -p "  按 Enter 返回選單..."; show_dev_menu ;;
        "Reaper")  run_the_reaper; echo ""; read -r -p "  按 Enter 返回選單..."; show_dev_menu ;;
        "Clean")
            if confirm_action "確定要進行深度清理嗎？這將刪除所有依賴包。"; then
                echo -e "${YELLOW}🧹 執行中...${NC}"
                rm -rf node_modules package-lock.json
                rm -rf web-dashboard/node_modules web-dashboard/.next web-dashboard/out
                echo -e "${GREEN}✅ 清理完成。${NC}"
            fi
            sleep 1; show_dev_menu ;;
        "Quit")    echo -e "  ${GREEN}👋 關閉開發模式，再見！${NC}"; exit 0 ;;
        *)         show_dev_menu ;;
    esac
}

case "${1:-}" in
    --test)
        if ensure_test_env; then
            echo -e "${CYAN}🧪 正在執行全系統單元測試...${NC}"
            npm test
        fi ;;
    --test-sec)
        if ensure_test_env; then
            echo -e "${CYAN}🛡️  正在執行安全性巡檢測試...${NC}"
            npm run test:security
        fi ;;
    --dev)
        check_api_keys
        npm run dev ;;
    --build)
        echo -e "${CYAN}🏗️  正在建置 Web Dashboard...${NC}"
        npm run build ;;
    --setup)
        run_full_install ;;
    --logs)
        tail -f logs/*.log ;;
    --reaper)
        run_the_reaper ;;
    --doctor)
        npm run doctor ;;
    --clean)
        echo -e "${YELLOW}🧹 執行深度清理...${NC}"
        rm -rf node_modules package-lock.json
        rm -rf web-dashboard/node_modules web-dashboard/.next web-dashboard/out
        echo -e "${GREEN}✅ 清理完成。${NC}" ;;
    --help|-h)
        show_help ;;
    "")
        show_dev_menu ;;
    *)
        echo -e "${RED}錯誤: 未知的選項 $1${NC}"
        show_help
        exit 1 ;;
esac

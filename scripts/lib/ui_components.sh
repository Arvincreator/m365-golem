#!/bin/bash

# ─── Spinner Animation ──────────────────────────────────
SPINNER_PID=""
spinner_start() {
    local msg="${1:-處理中}"
    local frames=("⠋" "⠙" "⠹" "⠸" "⠼" "⠴" "⠦" "⠧" "⠇" "⠏")
    tput civis 2>/dev/null  # 隱藏游標
    (
        local i=0
        while true; do
            printf "\r  ${CYAN}${frames[$((i % ${#frames[@]}))]}${NC} ${msg}...  "
            i=$((i + 1))
            sleep 0.1
        done
    ) &
    SPINNER_PID=$!
    register_pid "$SPINNER_PID"
}

spinner_stop() {
    local success=${1:-true}
    if [ -n "${SPINNER_PID:-}" ] && kill -0 "$SPINNER_PID" 2>/dev/null; then
        kill "$SPINNER_PID" 2>/dev/null
        wait "$SPINNER_PID" 2>/dev/null || true
    fi
    SPINNER_PID=""
    tput cnorm 2>/dev/null  # 恢復游標
    if [ "$success" = true ]; then
        printf "\r  ${GREEN}✔${NC} 完成                              \n"
    else
        printf "\r  ${RED}✖${NC} 失敗                              \n"
    fi
}

# ─── Progress Bar ────────────────────────────────────────
progress_bar() {
    local current=$1
    local total=$2
    local label="${3:-}"
    local width=30
    local filled=$((current * width / total))
    local empty=$((width - filled))
    local bar=""

    for ((i = 0; i < filled; i++)); do bar+="█"; done
    for ((i = 0; i < empty; i++)); do bar+="░"; done

    printf "\r  ${CYAN}[${bar}]${NC} ${BOLD}${current}/${total}${NC} ${DIM}${label}${NC}  "
}

# ─── ASCII Art & Logos ──────────────────────────────
show_golem_logo() {
    # 旗艦級 3D 蜂巢結構 G 標誌
    echo -e "           ${CYAN}◢${BLUE}■■■■■■■■■■■${CYAN}◣${NC}"
    echo -e "        ${CYAN}◢${BLUE}■■■◤         ◥${BLUE}■■■${CYAN}◣${NC}"
    echo -e "      ${CYAN}◢${BLUE}■■◤    ${NC}◢${YELLOW}━━━━${NC}◣    ${BLUE}◥■■${CYAN}◣${NC}"
    echo -e "      ${BLUE}■■▌    ${NC}┃ ${YELLOW}● ◡ ●${NC} ┃    ${BLUE}▐■■${NC}"
    echo -e "      ${CYAN}◥${BLUE}■■◣    ${NC}◥${YELLOW}━━━━${NC}◤    ${CYAN}◢${BLUE}■■◤${NC}"
    echo -e "        ${CYAN}◥${BLUE}■■■◣         ${CYAN}◢${BLUE}■■■◤${NC}"
    echo -e "           ${CYAN}◥${BLUE}■■■■■■■■■■■◤${NC}"
    echo -e "        ${BOLD}${WHITE}   GOLEM PROJECT   ${NC}"
}

# ─── Visual Indicators ────────────────────────────────
get_mini_bar() {
    local percent=$1
    # Convert potential float to integer for bash arithmetic
    local int_percent
    if [[ "$percent" =~ \. ]]; then
        int_percent=$(printf "%.0f" "$percent" 2>/dev/null || echo "${percent%.*}")
    else
        int_percent=$percent
    fi
    [ -z "$int_percent" ] && int_percent=0

    local width=10
    local filled=$(( int_percent * width / 10 )) # int_percent * 10 / 100
    [ $filled -gt $width ] && filled=$width
    local empty=$(( width - filled ))
    
    local bar=""
    local color="${GREEN}"
    [ $int_percent -gt 50 ] && color="${YELLOW}"
    [ $int_percent -gt 85 ] && color="${RED}"
    
    for ((i=0; i<filled; i++)); do bar+="■"; done
    for ((i=0; i<empty; i++)); do bar+="□"; done
    echo -en "${color}${bar}${NC}"
}

# ─── Box Printing Helpers ───────────────────────────────
readonly BOX_WIDTH=60

box_top()    { echo -e "${CYAN}┌$(printf '─%.0s' $(seq 1 $BOX_WIDTH))┐${NC}"; }
box_bottom() { echo -e "${CYAN}└$(printf '─%.0s' $(seq 1 $BOX_WIDTH))┘${NC}"; }
box_sep()    { echo -e "${CYAN}├$(printf '─%.0s' $(seq 1 $BOX_WIDTH))┤${NC}"; }

# Calculate visible length of string (ignoring escape codes)
get_visible_len() {
    local str=$1
    # Remove ANSI escape sequences
    local clean=$(echo -e "$str" | sed $'s/\033\[[0-9;]*[mK]//g')
    echo ${#clean}
}

box_line_colored() {
    local text="$1"
    local vlen=$(get_visible_len "$text")
    local padding=$((BOX_WIDTH - vlen))
    [ $padding -lt 0 ] && padding=0
printf "${CYAN}│${NC}%b%*s${CYAN}│${NC}\n" "$text" "$padding" ""
}

box_line_dual() {
    local left="$1"
    local right="$2"
    local vlen_l=$(get_visible_len "$left")
    local vlen_r=$(get_visible_len "$right")
    
    local half_width=$((BOX_WIDTH / 2))
    local pad_l=$((half_width - vlen_l - 2))
    local pad_r=$((BOX_WIDTH - half_width - vlen_r - 2))
    
    [ $pad_l -lt 0 ] && pad_l=0
    [ $pad_r -lt 0 ] && pad_r=0
    
    printf "${CYAN}│${NC} %b%*s ${DIM}│${NC} %b%*s ${CYAN}│${NC}\n" "$left" "$pad_l" "" "$right" "$pad_r" ""
}

box_header_dashboard() {
    local logo_lines=()
    logo_lines+=("${CYAN} ◢${BLUE}■■■■■■■■${CYAN}◣ ${NC}")
    logo_lines+=("${BLUE} ■■◤    ◥■■${NC} ")
    logo_lines+=("${BLUE} ■■  ${YELLOW}◢◣  ${BLUE}■■${NC} ")
    logo_lines+=("${BLUE} ■■  ${YELLOW}◥◤  ${BLUE}■■${NC} ")
    logo_lines+=("${CYAN} ◥${BLUE}■■■■■■■■${CYAN}◤ ${NC}")
    logo_lines+=("${BOLD}${WHITE} GOLEM PROJECT ${NC}")

    # 準備視覺化指標
    local cpu_bar=$(get_mini_bar "$SYS_CPU")
    local mem_percent=0
    # 簡單估算記憶體百分比 (假設 8G 總量做為展示)
    if [[ "$SYS_MEM" =~ ([0-9.]+)GB ]]; then
        local free_gb=${BASH_REMATCH[1]}
        mem_percent=$(node -e "console.log(Math.round((1 - $free_gb / 8) * 100))" 2>/dev/null || echo "0")
    fi
    local mem_bar=$(get_mini_bar "$mem_percent")

    local data_lines=()
    data_lines+=("${BOLD}狀態: $STATUS_RUNNING${NC} ${DIM}•${NC} 位置: ${BOLD}${WHITE}$SYS_IP${NC}")
    data_lines+=("硬體: ${NC}CPU ${cpu_bar} ${YELLOW}${SYS_CPU}%${NC}")
    data_lines+=("      ${NC}MEM ${mem_bar} ${CYAN}${SYS_MEM}${NC} free")
    data_lines+=("執行: ${NC}${SYS_UPTIME} ${DIM}•${NC} 配置: $STATUS_ENV")
    data_lines+=("實體: ${CYAN}${GOLEMS_ACTIVE_COUNT}${NC} Golems ${DIM}•${NC} 網頁: $STATUS_DASH")
    
    if [ "$ENV_OK" = false ] || [ ! -d "$SCRIPT_DIR/node_modules" ]; then
        data_lines+=("${YELLOW}👉 一鍵安裝: ${NC}${BOLD}./setup.sh --install${NC}")
    else
        data_lines+=("控制台: ${DIM}http://${SYS_IP}:${DASHBOARD_PORT:-3000}${NC}")
    fi

    box_top
    for i in {0..5}; do
        local logo="${logo_lines[$i]}"
        local data="${data_lines[$i]}"
        local vlen_l=$(get_visible_len "$logo")
        local vlen_r=$(get_visible_len "$data")
        
        local pad_mid=4
        local total_vlen=$((vlen_l + pad_mid + vlen_r))
        local pad_end=$((BOX_WIDTH - total_vlen - 2))
        [ $pad_end -lt 0 ] && pad_end=0
        
        printf "${CYAN}│${NC} %b%*s%b%*s ${CYAN}│${NC}\n" "$logo" "$pad_mid" "" "$data" "$pad_end" ""
    done
    box_bottom
}

# ─── Semantic UI Indicators ──────────────────────────────
ui_info()    { echo -e "  ${DIM}·${NC} $*"; }
ui_success() { echo -e "  ${GREEN}✔${NC} $*"; }
ui_warn()    { echo -e "  ${YELLOW}!${NC} $*"; }
ui_error()   { echo -e "  ${RED}✗${NC} $*"; }

# ─── Robust Command Wrapper ──────────────────────────────
# Executes a command silently, showing a spinner. If it fails, dumps stderr.
# Usage: run_quiet_step "Task Description" command arg1 arg2 ...
run_quiet_step() {
    local title="$1"
    shift
    
    spinner_start "$title"
    
    local log_tmp
    log_tmp=$(mktemp)
    
    if "$@" >"$log_tmp" 2>&1; then
        spinner_stop true
        rm -f "$log_tmp"
        return 0
    else
        spinner_stop false
        echo -e "  ${RED}${BOLD}❌ ${title} 失敗${NC}"
        echo -e "  ${DIM}最後 50 行日誌：${NC}"
        tail -n 50 "$log_tmp" | while read -r line; do
            echo -e "    ${DIM}$line${NC}"
        done
        rm -f "$log_tmp"
        return 1
    fi
}

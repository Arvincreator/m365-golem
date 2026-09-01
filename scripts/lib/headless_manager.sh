#!/bin/bash

readonly HEADLESS_PID_DIR="$SCRIPT_DIR/logs/headless-desktop"
readonly HEADLESS_XVFB_PID_FILE="$HEADLESS_PID_DIR/xvfb.pid"
readonly HEADLESS_FLUXBOX_PID_FILE="$HEADLESS_PID_DIR/fluxbox.pid"
readonly HEADLESS_X11VNC_PID_FILE="$HEADLESS_PID_DIR/x11vnc.pid"
readonly HEADLESS_WEBSOCKIFY_PID_FILE="$HEADLESS_PID_DIR/websockify.pid"
readonly HEADLESS_VNC_PASS_FILE="$HEADLESS_PID_DIR/.vnc.passwd"

headless_bool_true() {
    case "${1:-}" in
        1|true|TRUE|yes|YES|on|ON) return 0 ;;
        *) return 1 ;;
    esac
}

headless_is_linux_like() {
    local os
    os="$(os_detect)"
    [[ "$os" == "linux" || "$os" == "wsl" ]]
}

headless_run_root() {
    if [ "$(id -u)" -eq 0 ]; then
        "$@"
    elif command -v sudo >/dev/null 2>&1; then
        sudo "$@"
    else
        "$@"
    fi
}

headless_resolve_novnc_web_dir() {
    local candidate
    for candidate in \
        "${GOLEM_NOVNC_WEB_DIR:-}" \
        "/usr/share/novnc" \
        "/usr/share/novnc/" \
        "/usr/share/novnc/www"; do
        [ -n "$candidate" ] || continue
        if [ -d "$candidate" ] && [ -f "$candidate/vnc.html" ]; then
            echo "$candidate"
            return 0
        fi
    done
    return 1
}

headless_compose_available() {
    if docker compose version >/dev/null 2>&1; then
        return 0
    fi
    command -v docker-compose >/dev/null 2>&1
}

headless_compose_cmd() {
    if docker compose version >/dev/null 2>&1; then
        docker compose "$@"
    else
        docker-compose "$@"
    fi
}

headless_kill_pidfile() {
    local pid_file="$1"
    if [ ! -f "$pid_file" ]; then
        return 0
    fi

    local pid
    pid="$(cat "$pid_file" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
        sleep 0.3
        kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$pid_file"
}

headless_install_local_desktop_deps() {
    local missing=()
    local cmd
    for cmd in Xvfb fluxbox x11vnc websockify; do
        if ! command -v "$cmd" >/dev/null 2>&1; then
            missing+=("$cmd")
        fi
    done

    if [ ${#missing[@]} -eq 0 ]; then
        ui_success "虛擬桌面依賴已就緒"
        return 0
    fi

    ui_warn "缺少虛擬桌面依賴: ${missing[*]}"
    ui_info "正在自動安裝 Xvfb/Fluxbox/x11vnc/noVNC..."

    if command -v apt-get >/dev/null 2>&1; then
        headless_run_root apt-get update
        headless_run_root apt-get install -y xvfb fluxbox x11vnc novnc websockify
    elif command -v dnf >/dev/null 2>&1; then
        headless_run_root dnf install -y xorg-x11-server-Xvfb fluxbox x11vnc novnc python3-websockify
    elif command -v yum >/dev/null 2>&1; then
        headless_run_root yum install -y xorg-x11-server-Xvfb fluxbox x11vnc novnc python3-websockify
    else
        ui_error "找不到支援的套件管理器 (apt-get/dnf/yum)"
        return 1
    fi

    for cmd in Xvfb fluxbox x11vnc websockify; do
        if ! command -v "$cmd" >/dev/null 2>&1; then
            ui_error "依賴安裝不完整，仍缺少: $cmd"
            return 1
        fi
    done
    ui_success "虛擬桌面依賴安裝完成"
}

headless_start_local_desktop() {
    if ! headless_is_linux_like; then
        ui_error "虛擬桌面模式僅支援 Linux/WSL。"
        return 1
    fi

    if ! headless_install_local_desktop_deps; then
        return 1
    fi

    local display="${GOLEM_DISPLAY:-:99}"
    local screen_size="${GOLEM_SCREEN_SIZE:-1280x720x24}"
    local vnc_port="${GOLEM_VNC_PORT:-5900}"
    local novnc_port="${GOLEM_NOVNC_PORT:-6080}"
    local novnc_bind="${GOLEM_NOVNC_BIND:-0.0.0.0}"
    local novnc_web_dir

    if ! novnc_web_dir="$(headless_resolve_novnc_web_dir)"; then
        ui_error "找不到 noVNC 網頁目錄 (vnc.html)。請檢查 novnc 套件是否完整。"
        return 1
    fi

    mkdir -p "$HEADLESS_PID_DIR" "$SCRIPT_DIR/logs"
    export DISPLAY="$display"

    if ! pgrep -f "Xvfb ${display}" >/dev/null 2>&1; then
        nohup Xvfb "$display" -screen 0 "$screen_size" -nolisten tcp -ac > "$SCRIPT_DIR/logs/xvfb.log" 2>&1 &
        echo $! > "$HEADLESS_XVFB_PID_FILE"
        sleep 1
        ui_success "Xvfb 已啟動 (DISPLAY=${display})"
    else
        ui_info "Xvfb 已在執行"
    fi

    if ! pgrep -x "fluxbox" >/dev/null 2>&1; then
        nohup env DISPLAY="$display" fluxbox > "$SCRIPT_DIR/logs/fluxbox.log" 2>&1 &
        echo $! > "$HEADLESS_FLUXBOX_PID_FILE"
        sleep 1
        ui_success "Fluxbox 已啟動"
    else
        ui_info "Fluxbox 已在執行"
    fi

    if ! pgrep -f "x11vnc.*-rfbport ${vnc_port}" >/dev/null 2>&1; then
        local x11vnc_args=(
            -display "$display"
            -forever
            -shared
            -listen 127.0.0.1
            -rfbport "$vnc_port"
            -xkb
        )

        if [ -n "${GOLEM_VNC_PASSWORD:-}" ]; then
            x11vnc -storepasswd "${GOLEM_VNC_PASSWORD}" "$HEADLESS_VNC_PASS_FILE" > /dev/null 2>&1
            x11vnc_args+=(-rfbauth "$HEADLESS_VNC_PASS_FILE")
            ui_info "已啟用 VNC 密碼驗證。"
        else
            x11vnc_args+=(-nopw)
            ui_warn "未設定 GOLEM_VNC_PASSWORD，VNC 無密碼。建議搭配反向代理或 VPN。"
        fi

        nohup x11vnc "${x11vnc_args[@]}" > "$SCRIPT_DIR/logs/x11vnc.log" 2>&1 &
        echo $! > "$HEADLESS_X11VNC_PID_FILE"
        sleep 1
        ui_success "x11vnc 已啟動 (127.0.0.1:${vnc_port})"
    else
        ui_info "x11vnc 已在執行"
    fi

    if ! pgrep -f "websockify.*${novnc_port}" >/dev/null 2>&1; then
        nohup websockify --web "$novnc_web_dir" "${novnc_bind}:${novnc_port}" "127.0.0.1:${vnc_port}" > "$SCRIPT_DIR/logs/novnc.log" 2>&1 &
        echo $! > "$HEADLESS_WEBSOCKIFY_PID_FILE"
        sleep 1
        ui_success "noVNC 已啟動 (${novnc_bind}:${novnc_port})"
    else
        ui_info "websockify/noVNC 已在執行"
    fi

    echo ""
    echo -e "  ${GREEN}${BOLD}✅ 虛擬桌面就緒${NC}"
    echo -e "  ${CYAN}URL:${NC} http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo 'SERVER-IP'):${novnc_port}/vnc.html"
    echo -e "  ${DIM}提示: 若走反向代理，請轉發 /vnc/ 到 noVNC 入口。${NC}"
}

headless_stop_local_desktop() {
    local display="${GOLEM_DISPLAY:-:99}"
    local vnc_port="${GOLEM_VNC_PORT:-5900}"
    local novnc_port="${GOLEM_NOVNC_PORT:-6080}"

    echo -e "  ${YELLOW}🛑 正在停止虛擬桌面服務...${NC}"

    # 停止順序：Window Manager -> websockify/x11vnc -> Xvfb
    headless_kill_pidfile "$HEADLESS_FLUXBOX_PID_FILE"
    headless_kill_pidfile "$HEADLESS_WEBSOCKIFY_PID_FILE"
    headless_kill_pidfile "$HEADLESS_X11VNC_PID_FILE"
    headless_kill_pidfile "$HEADLESS_XVFB_PID_FILE"

    # Fallback：若 pidfile 遺失，依特徵停止
    pkill -f "websockify.*${novnc_port}" >/dev/null 2>&1 || true
    pkill -f "x11vnc.*-rfbport ${vnc_port}" >/dev/null 2>&1 || true
    pkill -f "Xvfb ${display}" >/dev/null 2>&1 || true

    rm -f "$HEADLESS_XVFB_PID_FILE" \
          "$HEADLESS_FLUXBOX_PID_FILE" \
          "$HEADLESS_X11VNC_PID_FILE" \
          "$HEADLESS_WEBSOCKIFY_PID_FILE" \
          "$HEADLESS_VNC_PASS_FILE"

    ui_success "虛擬桌面服務已停止"
}

headless_status_local_desktop() {
    local display="${GOLEM_DISPLAY:-:99}"
    local vnc_port="${GOLEM_VNC_PORT:-5900}"
    local novnc_port="${GOLEM_NOVNC_PORT:-6080}"

    echo ""
    echo -e "${BOLD}Headless Desktop Status${NC}"
    echo "─────────────────────────────────────────"
    echo -e "  Xvfb (${display}):    $(pgrep -f "Xvfb ${display}" >/dev/null 2>&1 && echo "Running" || echo "Stopped")"
    echo -e "  Fluxbox:       $(pgrep -x "fluxbox" >/dev/null 2>&1 && echo "Running" || echo "Stopped")"
    echo -e "  x11vnc (${vnc_port}):  $(pgrep -f "x11vnc.*-rfbport ${vnc_port}" >/dev/null 2>&1 && echo "Running" || echo "Stopped")"
    echo -e "  noVNC (${novnc_port}):  $(pgrep -f "websockify.*${novnc_port}" >/dev/null 2>&1 && echo "Running" || echo "Stopped")"
    echo ""
}

headless_bootstrap_local_app() {
    ui_info "開始本機 Headless 一鍵部署 (Node + Dashboard + VNC)..."

    local prev_magic="${GOLEM_MAGIC_MODE:-false}"
    export GOLEM_MAGIC_MODE=true

    step_stop_running_system
    step_prepare_node_version
    step_check_files
    step_check_env
    step_install_core
    step_install_dashboard
    source "$DOT_ENV_PATH" 2>/dev/null || true

    if ! headless_start_local_desktop; then
        export GOLEM_MAGIC_MODE="$prev_magic"
        return 1
    fi

    export PLAYWRIGHT_HEADLESS=false
    launch_system --bg

    export GOLEM_MAGIC_MODE="$prev_magic"
    ui_success "本機 Headless 部署完成 (背景執行)"
    echo -e "  ${CYAN}Dashboard:${NC} http://localhost:${DASHBOARD_PORT:-3000}"
}

headless_bootstrap_docker_app() {
    if ! command -v docker >/dev/null 2>&1; then
        ui_error "找不到 docker，無法執行容器化部署。"
        return 1
    fi
    if ! headless_compose_available; then
        ui_error "找不到 docker compose / docker-compose。"
        return 1
    fi
    if [ ! -f "$SCRIPT_DIR/docker-compose.yml" ] || [ ! -f "$SCRIPT_DIR/docker-compose.desktop.yml" ]; then
        ui_error "缺少 docker-compose 組態檔，無法啟動容器化桌面模式。"
        return 1
    fi

    mkdir -p "$SCRIPT_DIR/golem_memory" "$SCRIPT_DIR/logs"
    [ -f "$DOT_ENV_PATH" ] || step_check_env
    source "$DOT_ENV_PATH" 2>/dev/null || true

    ui_info "開始容器化 Headless 一鍵部署 (Docker + noVNC)..."
    if GOLEM_DESKTOP_MODE=true PLAYWRIGHT_HEADLESS=false headless_compose_cmd \
        -f "$SCRIPT_DIR/docker-compose.yml" \
        -f "$SCRIPT_DIR/docker-compose.desktop.yml" \
        up -d --build; then
        ui_success "容器化部署完成"
    else
        ui_error "Docker 部署失敗，請執行 docker compose logs --tail 80 檢查。"
        return 1
    fi

    local novnc_port="${GOLEM_NOVNC_PORT:-6080}"
    echo -e "  ${CYAN}Dashboard:${NC} http://localhost:${DASHBOARD_PORT:-3000}"
    echo -e "  ${CYAN}noVNC:${NC}     http://localhost:${novnc_port}/vnc.html"
    echo -e "  ${DIM}停止指令: ./setup.sh --headless-stop${NC}"
}

headless_one_click_deploy() {
    local mode="${1:-auto}"
    case "$mode" in
        docker)
            headless_bootstrap_docker_app
            ;;
        local)
            headless_bootstrap_local_app
            ;;
        auto|*)
            if command -v docker >/dev/null 2>&1 && \
                [ -f "$SCRIPT_DIR/docker-compose.yml" ] && \
                [ -f "$SCRIPT_DIR/docker-compose.desktop.yml" ]; then
                headless_bootstrap_docker_app
            else
                headless_bootstrap_local_app
            fi
            ;;
    esac
}

headless_one_click_stop() {
    if command -v docker >/dev/null 2>&1 && headless_compose_available && [ -f "$SCRIPT_DIR/docker-compose.desktop.yml" ]; then
        headless_compose_cmd -f "$SCRIPT_DIR/docker-compose.yml" -f "$SCRIPT_DIR/docker-compose.desktop.yml" down >/dev/null 2>&1 || true
    fi
    headless_stop_local_desktop >/dev/null 2>&1 || true
    stop_system false >/dev/null 2>&1 || true
    ui_success "Headless 服務與 Golem 已停止"
}

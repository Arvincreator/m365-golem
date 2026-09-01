#!/bin/bash
set -euo pipefail

log() {
    echo "[golem-entrypoint] $*"
}

is_true() {
    case "${1:-}" in
        1|true|TRUE|yes|YES|on|ON) return 0 ;;
        *) return 1 ;;
    esac
}

resolve_novnc_web_dir() {
    local candidate
    for candidate in \
        "${GOLEM_NOVNC_WEB_DIR:-}" \
        "/usr/share/novnc" \
        "/usr/share/novnc/" \
        "/usr/share/novnc/utils/../"; do
        [ -n "$candidate" ] || continue
        if [ -d "$candidate" ] && [ -f "$candidate/vnc.html" ]; then
            echo "$candidate"
            return 0
        fi
    done
    return 1
}

start_desktop_stack() {
    local display="${GOLEM_DISPLAY:-:99}"
    local screen_size="${GOLEM_SCREEN_SIZE:-1280x720x24}"
    local vnc_port="${GOLEM_VNC_PORT:-5900}"
    local novnc_port="${GOLEM_NOVNC_PORT:-6080}"
    local novnc_bind="${GOLEM_NOVNC_BIND:-0.0.0.0}"
    local novnc_web_dir

    if ! novnc_web_dir="$(resolve_novnc_web_dir)"; then
        log "ERROR: noVNC web root not found (expected vnc.html)."
        exit 1
    fi

    mkdir -p /app/logs
    export DISPLAY="$display"

    if is_true "${GOLEM_DESKTOP_FORCE_HEADFUL:-true}"; then
        export PLAYWRIGHT_HEADLESS=false
    fi

    log "Starting virtual desktop on DISPLAY=${display} (screen=${screen_size})"
    Xvfb "$display" -screen 0 "$screen_size" -nolisten tcp -ac > /app/logs/xvfb.log 2>&1 &
    sleep 1
    fluxbox > /app/logs/fluxbox.log 2>&1 &
    sleep 1

    local x11vnc_args=(
        -display "$display"
        -forever
        -shared
        -listen 127.0.0.1
        -rfbport "$vnc_port"
        -xkb
    )
    if [ -n "${GOLEM_VNC_PASSWORD:-}" ]; then
        x11vnc -storepasswd "${GOLEM_VNC_PASSWORD}" /tmp/.golem_vnc_passwd > /dev/null 2>&1
        x11vnc_args+=(-rfbauth /tmp/.golem_vnc_passwd)
        log "x11vnc password auth enabled."
    else
        x11vnc_args+=(-nopw)
        log "WARNING: x11vnc running without password (consider GOLEM_VNC_PASSWORD)."
    fi

    x11vnc "${x11vnc_args[@]}" > /app/logs/x11vnc.log 2>&1 &
    sleep 1

    websockify --web "$novnc_web_dir" "${novnc_bind}:${novnc_port}" "127.0.0.1:$vnc_port" > /app/logs/novnc.log 2>&1 &

    log "Desktop stack ready."
    log "noVNC URL: http://<host>:${novnc_port}/vnc.html"
}

if is_true "${GOLEM_DESKTOP_MODE:-false}"; then
    start_desktop_stack
fi

exec "$@"

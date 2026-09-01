#!/bin/bash

# ─── System Tools Installer (Linux/WSL/Universal) ───

install_system_pkg() {
    local pkg_name=$1
    local os=$(os_detect)
    local cmd=""

    if [[ "$os" == "macos" ]]; then
        if command -v brew &>/dev/null; then
            if confirm_action "是否要透過 Homebrew 安裝 $pkg_name？"; then
                run_quiet_step "嘗試使用 Homebrew 安裝 $pkg_name" brew install "$pkg_name"
                return $?
            fi
        else
            ui_error "缺少 Homebrew，無法安裝 $pkg_name。"
            return 1
        fi
    elif [[ "$os" == "linux" ]] || [[ "$os" == "wsl" ]]; then
        if command -v apt-get &>/dev/null; then cmd="sudo apt-get install -y $pkg_name"
        elif command -v dnf &>/dev/null; then cmd="sudo dnf install -y $pkg_name"
        elif command -v yum &>/dev/null; then cmd="sudo yum install -y $pkg_name"
        elif command -v apk &>/dev/null; then cmd="sudo apk add $pkg_name"
        fi

        if [ -n "$cmd" ]; then
            if confirm_action "是否要執行系統安裝指令: $cmd？"; then
                run_quiet_step "嘗試執行 $cmd" $cmd
                return $?
            fi
        fi
    elif [[ "$os" == "windows" ]]; then
        ui_warn "Windows 環境建議使用 winget 或從官網手動下載 $pkg_name。"
        echo -e "  指令範例: ${CYAN}winget install $pkg_name${NC}"
    fi

    return 1
}

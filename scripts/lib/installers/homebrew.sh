#!/bin/bash

# ─── Homebrew Installer (macOS) ───

install_homebrew() {
    ui_warn "偵測到 macOS 但未安裝 Homebrew (brew)。"
    if confirm_action "是否要自動安裝 Homebrew？"; then
        if ! /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"; then
            ui_error "Homebrew 安裝失敗，請手動安裝: https://brew.sh/"
            return 1
        fi
        # Load brew for current session
        eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null || eval "$(/usr/local/bin/brew shellenv)" 2>/dev/null
        ui_success "Homebrew 安裝完成！"
        return 0
    else
        return 1
    fi
}

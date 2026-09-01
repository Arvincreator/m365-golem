@echo off
:: 一鍵啟動 Golem (適合非技術使用者單擊/雙擊執行)
cd /d "%~dp0"

:: 檢查是否為初次執行
if not exist ".env" (
    echo [INFO] 偵測到首次執行，導向自動安裝流程...
    call setup.bat
) else if not exist "node_modules" (
    echo [INFO] 偵測到依賴未安裝，導向自動安裝流程...
    call setup.bat
) else (
    :: 已經安裝過，直接略過選單啟動系統
    call setup.bat --start
)

@echo off
setlocal
cd /d "%~dp0"

if /I "%~1"=="--check" (
    powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-m365-golem.ps1" -CheckOnly
    exit /b %ERRORLEVEL%
)

if not exist "%~dp0Start-M365-Golem.vbs" (
    echo [STOP] Start-M365-Golem.vbs is missing. Run Install-M365-Golem.bat to repair the installation.
    exit /b 1
)

start "" /b wscript.exe "%~dp0Start-M365-Golem.vbs"
exit /b 0

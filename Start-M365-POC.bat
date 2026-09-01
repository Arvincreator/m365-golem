@echo off
setlocal
cd /d "%~dp0"

if not exist ".env" (
    copy /Y "M365-POC.env.example" ".env" >nul
)

findstr /B /C:"GOLEM_BACKEND=m365-web" ".env" >nul
if errorlevel 1 (
    echo [STOP] .env is not configured for GOLEM_BACKEND=m365-web.
    echo Use this launcher only from the dedicated M365 POC copy.
    exit /b 1
)

node "scripts\ensure-m365-workspace-env.js"
if errorlevel 1 exit /b 1

if /I "%~1"=="--check" (
    echo [M365 POC] Configuration and encrypted project storage check passed.
    exit /b 0
)

echo [M365 POC] Starting the local Dashboard and visible Microsoft Edge...
echo [M365 POC] Complete account sign-in and MFA yourself in the Edge window.
call npm.cmd run dashboard
exit /b %ERRORLEVEL%

@echo off
setlocal
cd /d "%~dp0"

set "M365_INSTALL_REQUIRED="
if not exist "node_modules" set "M365_INSTALL_REQUIRED=1"
if not exist "web-dashboard\node_modules" set "M365_INSTALL_REQUIRED=1"
if not exist "web-dashboard\.next" set "M365_INSTALL_REQUIRED=1"
if not exist "integrations\m365-session-bridge\apps\mcp-server\dist\index.js" set "M365_INSTALL_REQUIRED=1"
if not exist "data\mcp-servers.json" set "M365_INSTALL_REQUIRED=1"
if exist "data\mcp-servers.json" (
    findstr /C:"m365-session-bridge" "data\mcp-servers.json" >nul
    if errorlevel 1 set "M365_INSTALL_REQUIRED=1"
)

if defined M365_INSTALL_REQUIRED (
    echo [M365 Golem] First-run installation or repair is required.
    call "%~dp0Install-M365-Golem.bat"
    if errorlevel 1 exit /b 1
)

if not exist ".env" copy /Y "M365-POC.env.example" ".env" >nul
findstr /B /C:"GOLEM_BACKEND=m365-web" ".env" >nul
if errorlevel 1 (
    echo [STOP] .env is not configured for GOLEM_BACKEND=m365-web.
    exit /b 1
)

node "scripts\ensure-m365-workspace-env.js"
if errorlevel 1 exit /b 1

if /I "%~1"=="--check" (
    echo [M365 Golem] Configuration and encrypted project storage check passed.
    exit /b 0
)

echo [M365 Golem] Starting the local Dashboard and visible Microsoft Edge...
echo [M365 Golem] Complete account sign-in and MFA yourself in the Edge window.
call npm.cmd run dashboard
exit /b %ERRORLEVEL%

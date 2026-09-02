@echo off
REM Launched by Edge via Native Messaging (see native-host-manifest.json "path").
REM %~dp0 is this .cmd file's own directory, so this works regardless of install location.
set "M365_BRIDGE_STATE_DIR=%LOCALAPPDATA%\M365-Golem\m365-session-bridge"
set "M365_BRIDGE_POLICY_PATH=%M365_BRIDGE_STATE_DIR%\policy.json"
set "M365_BRIDGE_SECRET_PATH=%M365_BRIDGE_STATE_DIR%\runtime\ipc-secret.json"
set "M365_BRIDGE_NATIVE_LOG_PATH=%M365_BRIDGE_STATE_DIR%\logs\native-host.log"
for %%I in ("%~dp0..\..\..\..") do set "M365_GOLEM_ROOT=%%~fI"
set "M365_BRIDGE_NODE=node"
if exist "%~dp0node-path.local.txt" set /p "M365_BRIDGE_NODE="<"%~dp0node-path.local.txt"
"%M365_BRIDGE_NODE%" "%~dp0dist\index.js" %*

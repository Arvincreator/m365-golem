@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-m365-golem.ps1" %*
exit /b %ERRORLEVEL%

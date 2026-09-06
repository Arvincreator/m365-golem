@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-m365-release.ps1" %*
exit /b %ERRORLEVEL%

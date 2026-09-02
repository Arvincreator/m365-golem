@echo off
setlocal
cd /d "%~dp0"
call "%~dp0Start-M365-POC.bat" %*
exit /b %ERRORLEVEL%

@echo off
setlocal
cd /d "%~dp0"
call "%~dp0Install-M365-Golem.bat" %*
exit /b %ERRORLEVEL%

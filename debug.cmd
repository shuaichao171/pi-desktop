@echo off
setlocal EnableExtensions
cd /d "%~dp0" || exit /b 1

node scripts/dist-debug.mjs %*
set "DEBUG_EXIT=%ERRORLEVEL%"
if not "%DEBUG_EXIT%"=="0" pause
if "%~1"=="" if "%DEBUG_EXIT%"=="0" pause
exit /b %DEBUG_EXIT%

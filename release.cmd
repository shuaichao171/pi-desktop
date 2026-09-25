@echo off
setlocal EnableExtensions
cd /d "%~dp0"
if errorlevel 1 exit /b 1

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js 22.19 or newer is required.
  pause
  exit /b 1
)

node scripts/release.mjs %*
set "RELEASE_EXIT=%ERRORLEVEL%"
if "%~1"=="" pause
exit /b %RELEASE_EXIT%

@echo off
setlocal EnableExtensions

cd /d "%~dp0"
if errorlevel 1 (
  echo [ERROR] Cannot enter the project directory.
  goto :failed
)

echo Pi Desktop - Windows build
echo Project: "%CD%"
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js 22.19 or newer is required.
  goto :failed
)
node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1)"
if errorlevel 1 (
  echo [ERROR] Node.js 22.19 or newer is required.
  goto :failed
)

where pnpm >nul 2>&1
if errorlevel 1 (
  echo [ERROR] pnpm 11.11.0 is required. Run: corepack enable
  goto :failed
)
for /f "delims=" %%V in ('pnpm --version') do set "PNPM_VERSION=%%V"
if not "%PNPM_VERSION%"=="11.11.0" (
  echo [ERROR] pnpm 11.11.0 is required; found %PNPM_VERSION%.
  goto :failed
)

echo [1/5] Installing dependencies...
call pnpm install --frozen-lockfile
if errorlevel 1 goto :failed

echo [2/5] Verifying the Pi SDK lockfile...
node scripts/sync-pi.mjs --verify
if errorlevel 1 goto :failed

echo [3/5] Checking types...
call pnpm typecheck
if errorlevel 1 goto :failed

echo [4/5] Running tests...
call pnpm test
if errorlevel 1 goto :failed

echo [5/5] Building the Windows installers...
call pnpm dist:win
if errorlevel 1 goto :failed

for /f "delims=" %%V in ('node -p "require('./package.json').version"') do set "APP_VERSION=%%V"
set "SETUP=release\Pi-Desktop-Setup-%APP_VERSION%-x64.exe"
set "PORTABLE=release\Pi-Desktop-Portable-%APP_VERSION%-x64.exe"
if not exist "%SETUP%" (
  echo [ERROR] Missing installer: %SETUP%
  goto :failed
)
if not exist "%PORTABLE%" (
  echo [ERROR] Missing portable executable: %PORTABLE%
  goto :failed
)

echo.
echo Build complete:
echo   "%CD%\%SETUP%"
echo   "%CD%\%PORTABLE%"
set "BUILD_EXIT=0"
goto :finish

:failed
set "BUILD_EXIT=%ERRORLEVEL%"
if "%BUILD_EXIT%"=="0" set "BUILD_EXIT=1"
echo.
echo [ERROR] Build failed. See the message above.

:finish
if not defined CI if not defined PI_DESKTOP_NO_PAUSE pause
exit /b %BUILD_EXIT%

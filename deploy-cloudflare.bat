@echo off
setlocal EnableExtensions
set "REPO=https://github.com/Taolee-crypto/timelink-backend.git"
set "APPDIR=%USERPROFILE%\Downloads\timelink-backend"

echo ==========================================
echo        TimeLink Cloudflare Deploy
echo ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is required.
  echo Install Node.js 20+ and run this file again.
  goto :fail
)

if not exist "%~dp0wrangler.toml" (
  echo [1/4] This launcher is outside the TimeLink backend folder.
  where git >nul 2>nul
  if errorlevel 1 (
    echo [ERROR] Git is required when running the launcher by itself.
    echo Install Git, then run this file again.
    goto :fail
  )

  if not exist "%APPDIR%\wrangler.toml" (
    echo Downloading the latest TimeLink backend from GitHub...
    git clone "%REPO%" "%APPDIR%"
    if errorlevel 1 goto :fail
  ) else (
    echo Updating existing TimeLink backend...
    cd /d "%APPDIR%"
    git pull --ff-only
    if errorlevel 1 goto :fail
  )
  cd /d "%APPDIR%"
)

if not exist wrangler.toml (
  echo [ERROR] wrangler.toml not found.
  goto :fail
)

echo [2/4] Installing dependencies...
if not exist node_modules\wrangler (
  call npm install
  if errorlevel 1 goto :fail
) else (
  echo Dependencies already installed.
)

echo.
echo [3/4] Checking Cloudflare login...
call npx wrangler whoami
if errorlevel 1 (
  echo Cloudflare login is required.
  call npx wrangler login
  if errorlevel 1 goto :fail
)

echo.
echo [4/4] Deploying timelink-backend Worker...
call npx wrangler deploy
if errorlevel 1 goto :fail

echo.
echo ==========================================
echo        DEPLOYMENT COMPLETED
echo ==========================================
echo Worker: timelink-backend
echo API:    https://api.timelink.digital
echo.
echo Now test TL3 conversion in Creator Center.
pause
exit /b 0

:fail
echo.
echo ==========================================
echo        DEPLOYMENT FAILED
echo ==========================================
pause
exit /b 1

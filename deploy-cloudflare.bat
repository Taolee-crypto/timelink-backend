@echo off
setlocal
cd /d "%~dp0"

echo ==========================================
echo        TimeLink Cloudflare Deploy
echo ==========================================
echo.
where node >nul 2>nul
if errorlevel 1 ( echo [ERROR] Node.js 20+ is required. & pause & exit /b 1 )
if not exist node_modules\wrangler ( echo [1/3] Installing dependencies... & call npm install || goto :fail ) else ( echo [1/3] Dependencies already installed. )
echo.
echo [2/3] Checking Cloudflare login...
call npx wrangler whoami
if errorlevel 1 ( echo Cloudflare login is required. & call npx wrangler login || goto :fail )
echo.
echo [3/3] Deploying timelink-backend Worker...
call npx wrangler deploy
if errorlevel 1 goto :fail
echo.
echo ==========================================
echo        DEPLOYMENT COMPLETED
echo ==========================================
echo Worker: timelink-backend
echo API:    https://api.timelink.digital
echo.
echo Test TL3 upload from Creator Center.
pause
exit /b 0
:fail
echo.
echo DEPLOYMENT FAILED
pause
exit /b 1

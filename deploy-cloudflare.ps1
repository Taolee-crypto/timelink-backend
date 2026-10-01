$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js 20+ is required." }
if (-not (Test-Path "node_modules/wrangler")) { npm install }
try { npx wrangler whoami } catch { npx wrangler login }
npx wrangler deploy
Write-Host "DEPLOYMENT COMPLETED: https://api.timelink.digital"

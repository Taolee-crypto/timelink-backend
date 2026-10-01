$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Stop-Deploy([string]$message) {
  Write-Host ""
  Write-Host "DEPLOYMENT FAILED: $message" -ForegroundColor Red
  exit 1
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Stop-Deploy "Node.js 20+ is required."
}

if (-not (Test-Path "node_modules/wrangler")) {
  npm install
  if ($LASTEXITCODE -ne 0) { Stop-Deploy "npm install failed." }
}

npx wrangler whoami
if ($LASTEXITCODE -ne 0) {
  Write-Host "Cloudflare login is required."
  npx wrangler login
  if ($LASTEXITCODE -ne 0) { Stop-Deploy "Cloudflare login failed." }
}

npx wrangler deploy
if ($LASTEXITCODE -ne 0) {
  Stop-Deploy "Cloudflare Worker deployment failed. See the Wrangler error above."
}

Write-Host ""
Write-Host "DEPLOYMENT COMPLETED: https://api.timelink.digital" -ForegroundColor Green

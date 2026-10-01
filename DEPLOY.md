# TimeLink Backend Cloudflare Deployment

Windows: double-click deploy-cloudflare.bat.

Command line: deploy-cloudflare.bat

PowerShell: .\deploy-cloudflare.ps1

First run may open a browser for Cloudflare login. No Cloudflare secret is stored in GitHub.

Worker: timelink-backend
API: https://api.timelink.digital
D1: timelink-db
R2: timelink-audio

This deployment includes the existing TL3 v2 browser conversion and the multipart endpoints /api/upload/init, /api/upload/part, and /api/upload/complete, while retaining /api/upload compatibility.

If JWT_SECRET has not been configured in Cloudflare, run: npx wrangler secret put JWT_SECRET

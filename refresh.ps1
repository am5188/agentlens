# refresh.ps1 — 一键刷新 AgentLens：抓取 → 评分 → 构建 → 部署
# 用法: pwsh .\agentlens\refresh.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
  Write-Host "[1/4] 抓取 OKX.AI 市场数据（断点续抓）..." -ForegroundColor Cyan
  node agentlens\crawler.mjs crawl

  Write-Host "[2/4] 计算信任分与定价基准..." -ForegroundColor Cyan
  node agentlens\score.mjs

  Write-Host "[3/4] 构建 Worker 产物..." -ForegroundColor Cyan
  node agentlens\build-worker.mjs

  Write-Host "[4/4] 部署到 Cloudflare..." -ForegroundColor Cyan
  Push-Location agentlens\worker
  npx wrangler deploy
  Pop-Location

  Write-Host "`n完成。https://agentlens.am518.uk" -ForegroundColor Green
} finally {
  Pop-Location
}

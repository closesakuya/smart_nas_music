param([switch]$Dev, [int]$Port = 0)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Test-Path -LiteralPath '.env')) { throw '请先复制 .env.example 为 .env，并设置密码与 API 配置。' }
if (-not (Test-Path -LiteralPath '.venv\Scripts\python.exe')) { python -m venv .venv }
if ($Dev) {
    & '.\.venv\Scripts\python.exe' -m uvicorn backend.main:app --host 0.0.0.0 --port $(if ($Port) { $Port } else { 8765 }) --reload --no-proxy-headers
} else {
    & '.\.venv\Scripts\python.exe' -m backend.run --port $Port
}

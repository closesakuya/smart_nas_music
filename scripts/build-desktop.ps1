param([string]$Runtime = 'win-x64')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$dotnet = Join-Path $projectRoot '_TMP\dotnet-sdk\dotnet.exe'
if (-not (Test-Path -LiteralPath $dotnet)) { $dotnet = 'dotnet' }
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
& $dotnet publish desktop/SummerMusic.Desktop.csproj -c Release -r $Runtime --self-contained true -o desktop/publish
if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed' }
$ffmpeg = (Get-Command ffmpeg.exe -ErrorAction Stop).Source
Copy-Item -LiteralPath $ffmpeg -Destination 'desktop/publish/ffmpeg.exe' -Force
$ffprobe = (Get-Command ffprobe.exe -ErrorAction Stop).Source
# Chocolatey exposes a shim that is not portable; use the real executable when available.
$realProbe = Get-ChildItem -LiteralPath 'C:\ProgramData\chocolatey\lib\ffmpeg' -Filter ffprobe.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
if ($realProbe) { $ffprobe = $realProbe.FullName }
Copy-Item -LiteralPath $ffprobe -Destination 'desktop/publish/ffprobe.exe' -Force
Write-Output 'Client built: desktop/publish/SummerMusic.Desktop.exe'

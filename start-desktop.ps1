param([string]$Server = 'http://127.0.0.1:8765')
$ErrorActionPreference = 'Stop'
$client = Join-Path $PSScriptRoot 'desktop\publish\SummerMusic.Desktop.exe'
if (-not (Test-Path -LiteralPath $client)) { throw 'Please run scripts/build-desktop.ps1 first.' }
Start-Process -FilePath $client -ArgumentList ('--project="{0}" --server="{1}"' -f $PSScriptRoot, $Server) -WorkingDirectory $PSScriptRoot

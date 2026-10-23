$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$python = Join-Path $projectRoot '.venv\Scripts\python.exe'
$data = Join-Path $projectRoot 'data'
New-Item -ItemType Directory -Path $data -Force | Out-Null
$worker = Start-Process -FilePath $python -ArgumentList '-m', 'backend.run' -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $data 'service.log') -RedirectStandardError (Join-Path $data 'service-error.log') -PassThru
$worker.WaitForExit()
exit $worker.ExitCode

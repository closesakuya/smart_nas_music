param([ValidateSet('Install','Start','Stop','Restart','Status')][string]$Action = 'Status')
$ErrorActionPreference = 'Stop'
$taskName = 'MusicSmartend'
$projectRoot = Split-Path -Parent $PSScriptRoot
$python = Join-Path $projectRoot '.venv\Scripts\python.exe'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    $elevated = Start-Process -FilePath $powershell -Verb RunAs -WindowStyle Hidden -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "{0}" -Action {1}' -f $PSCommandPath, $Action) -Wait -PassThru
    exit $elevated.ExitCode
}
function Get-ServiceProcesses {
    $all = @(Get-CimInstance Win32_Process)
    $roots = @($all | Where-Object { $_.ExecutablePath -eq $python -and $_.CommandLine -match '-m\s+backend\.run(?:\s|$)' })
    $ids = @($roots | ForEach-Object { $_.ProcessId })
    do {
        $children = @($all | Where-Object { $_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids })
        $ids += @($children | ForEach-Object { $_.ProcessId })
    } while ($children.Count -gt 0)
    @($all | Where-Object { $_.ProcessId -in $ids })
}
function Stop-ServiceTask {
    $owned = @(Get-ServiceProcesses)
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $taskName
    }
    foreach ($process in $owned) {
        $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($process.ProcessId)"
        if ($current -and $current.CreationDate -eq $process.CreationDate) {
            Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
}
try {
    if ($Action -eq 'Install') {
        if (-not (Test-Path -LiteralPath $python)) { throw 'Project Python environment is missing.' }
        $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if ($existing -and ($existing.Actions.Arguments -notlike ('*' + $projectRoot + '*'))) { throw 'Task name belongs to another application.' }
        $taskAction = New-ScheduledTaskAction -Execute $powershell -Argument ('-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f (Join-Path $PSScriptRoot 'service-host.ps1')) -WorkingDirectory $projectRoot
        $trigger = New-ScheduledTaskTrigger -AtStartup
        $trigger.Delay = 'PT30S'
        $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
        Stop-ServiceTask
        Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $trigger -Settings $settings -Principal $principal -Description 'Local Music Smartend web player. Start at boot without interactive login.' -Force | Out-Null
        Start-ScheduledTask -TaskName $taskName
    } elseif ($Action -eq 'Start') {
        if (-not (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) { throw 'Run service-control.ps1 -Action Install first.' }
        if (@(Get-ServiceProcesses).Count -eq 0) { Start-ScheduledTask -TaskName $taskName }
    } elseif ($Action -eq 'Restart') {
        Stop-ServiceTask
        Start-ScheduledTask -TaskName $taskName
    } elseif ($Action -eq 'Stop') {
        Stop-ServiceTask
    }
    $task = Get-ScheduledTask -TaskName $taskName
    $info = Get-ScheduledTaskInfo -TaskName $taskName
    [pscustomobject]@{
        TaskName = $task.TaskName
        State = [string]$task.State
        User = $task.Principal.UserId
        Enabled = $task.Settings.Enabled
        BootTrigger = @($task.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskBootTrigger' }).Count -gt 0
        LastTaskResult = $info.LastTaskResult
        CheckedAt = (Get-Date).ToString('o')
    } | ConvertTo-Json | Out-File -LiteralPath (Join-Path $projectRoot 'data\service-status.json') -Encoding utf8
    $task | Select-Object TaskName, State
} catch {
    New-Item -ItemType Directory -Path (Join-Path $projectRoot 'data') -Force | Out-Null
    $_ | Out-String | Out-File -LiteralPath (Join-Path $projectRoot 'data\service-control-error.log') -Encoding utf8
    Write-Error $_ -ErrorAction Continue
    exit 1
}

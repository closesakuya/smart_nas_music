$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$client = Join-Path $projectRoot 'desktop\publish\SummerMusic.Desktop.exe'
if (-not (Test-Path -LiteralPath $client)) { throw 'Build the PC client first.' }
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop 'Summer Music.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
if ((Test-Path -LiteralPath $shortcutPath) -and $shortcut.TargetPath -ne $client) { throw 'An unrelated Summer Music shortcut already exists.' }
$shortcut.TargetPath = $client
$shortcut.Arguments = '--project="' + $projectRoot + '"'
$shortcut.WorkingDirectory = $projectRoot
$shortcut.IconLocation = $client + ',0'
$shortcut.Description = 'Summer Music PC Hi-Fi'
$shortcut.Save()
Write-Output 'Created desktop shortcut: Summer Music'

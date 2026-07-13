param(
  [ValidateSet("install", "uninstall", "start", "stop", "restart", "status")]
  [string]$Action = "install",

  [string]$TaskName = "OrbitFS Remote Desktop Commander",

  [string]$Package = "@wonderwhy-er/desktop-commander@latest"
)

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ErrorActionPreference = "Stop"

function Assert-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run PowerShell as Administrator."
  }
}

function Get-RepoRoot {
  return Split-Path -Parent $PSScriptRoot
}

function Get-RuntimeDir {
  return Join-Path (Get-RepoRoot) "runtime\remote-desktop-commander-task"
}

function Get-RunnerPath {
  return Join-Path (Get-RuntimeDir) "run-remote-desktop-commander.cmd"
}

function Resolve-NpxPath {
  $cmd = Get-Command "npx.cmd" -ErrorAction SilentlyContinue
  if (-not $cmd) { throw "npx.cmd was not found. Install Node.js first, then reopen PowerShell." }
  return $cmd.Source
}

function Write-Runner {
  $runtime = Get-RuntimeDir
  New-Item -ItemType Directory -Path $runtime -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $runtime "logs") -Force | Out-Null

  $npx = Resolve-NpxPath
  $log = Join-Path $runtime "logs\remote-desktop-commander.log"
  $err = Join-Path $runtime "logs\remote-desktop-commander.err.log"

  $runner = @"
@echo off
setlocal
cd /d "$runtime"
echo ===== started %DATE% %TIME% =====>> "$log"
echo npx: $npx>> "$log"
"$npx" --yes $Package >> "$log" 2>> "$err"
echo ===== exited %DATE% %TIME% code %ERRORLEVEL% =====>> "$log"
exit /b %ERRORLEVEL%
"@

  Set-Content -LiteralPath (Get-RunnerPath) -Value $runner -Encoding ASCII
}

function Install-Task {
  Assert-Administrator
  Write-Runner

  $runner = Get-RunnerPath
  $action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$runner`""
  $triggerStartup = New-ScheduledTaskTrigger -AtStartup
  $triggerLogon = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest

  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($existing) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }

  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($triggerStartup, $triggerLogon) -Settings $settings -Principal $principal | Out-Null
  Start-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 2
  Show-Status
}

function Show-Status {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $task) {
    Write-Host "$TaskName is not installed."
    return
  }

  $info = Get-ScheduledTaskInfo -TaskName $TaskName
  Write-Host "${TaskName}: $($task.State)"
  Write-Host "LastRunTime: $($info.LastRunTime)"
  Write-Host "LastTaskResult: $($info.LastTaskResult)"
  Write-Host "Runner: $(Get-RunnerPath)"
  Write-Host "Logs: $(Join-Path (Get-RuntimeDir) 'logs')"
}

switch ($Action) {
  "install" { Install-Task }
  "uninstall" {
    Assert-Administrator
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Removed $TaskName."
  }
  "start" {
    Assert-Administrator
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 1
    Show-Status
  }
  "stop" {
    Assert-Administrator
    Stop-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 1
    Show-Status
  }
  "restart" {
    Assert-Administrator
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 1
    Show-Status
  }
  "status" { Show-Status }
}

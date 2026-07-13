param(
  [ValidateSet("install", "uninstall", "start", "stop", "restart", "status", "verify")]
  [string]$Action = "install",

  [string]$TaskName = "OrbitFS Remote Desktop Commander",

  [string]$Package = "@wonderwhy-er/desktop-commander@latest",

  [string]$Mode = "remote"
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

function Get-RepoRoot { return Split-Path -Parent $PSScriptRoot }
function Get-RuntimeDir { return Join-Path (Get-RepoRoot) "runtime\remote-desktop-commander-task" }
function Get-RunnerPath { return Join-Path (Get-RuntimeDir) "run-remote-desktop-commander.cmd" }
function Get-LogPath { return Join-Path (Get-RuntimeDir) "logs\remote-desktop-commander.log" }
function Get-ErrPath { return Join-Path (Get-RuntimeDir) "logs\remote-desktop-commander.err.log" }

function Resolve-NpxPath {
  $cmd = Get-Command "npx.cmd" -ErrorAction SilentlyContinue
  if (-not $cmd) { throw "npx.cmd was not found. Install Node.js first, then reopen PowerShell." }
  return $cmd.Source
}

function Get-RecentOutputText {
  $parts = @()
  foreach ($path in @((Get-LogPath), (Get-ErrPath))) {
    if (Test-Path -LiteralPath $path) {
      $parts += (Get-Content -LiteralPath $path -Tail 140 -ErrorAction SilentlyContinue) -join "`n"
    }
  }
  return ($parts -join "`n")
}

function Show-RelinkUrl {
  $text = Get-RecentOutputText
  $matches = [regex]::Matches($text, 'https://mcp\.desktopcommander\.app/add-device\?session_id=[A-Za-z0-9._~%+-]+')
  if ($matches.Count -gt 0) {
    $url = $matches[$matches.Count - 1].Value
    Write-Host ""
    Write-Host "RELINK / ADD DEVICE URL"
    Write-Host "-----------------------"
    Write-Host $url
    try {
      Set-Clipboard -Value $url
      Write-Host "Copied to clipboard."
    } catch {
      Write-Host "Could not copy to clipboard. Copy it manually."
    }
    return $true
  }
  return $false
}

function Write-Runner {
  $runtime = Get-RuntimeDir
  New-Item -ItemType Directory -Path $runtime -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $runtime "logs") -Force | Out-Null

  $npx = Resolve-NpxPath
  $log = Get-LogPath
  $err = Get-ErrPath

  $runner = @"
@echo off
setlocal
cd /d "$runtime"
echo ===== started %DATE% %TIME% =====>> "$log"
echo command: "$npx" --yes $Package $Mode>> "$log"
"$npx" --yes $Package $Mode >> "$log" 2>> "$err"
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
  Start-Sleep -Seconds 4
  Show-Status
  Verify-Task
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
  Write-Host "Command: npx --yes $Package $Mode"
  Write-Host "Runner: $(Get-RunnerPath)"
  Write-Host "Logs: $(Join-Path (Get-RuntimeDir) 'logs')"
  [void](Show-RelinkUrl)
}

function Verify-Task {
  Write-Host ""
  Write-Host "Verification"
  Write-Host "------------"

  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $task) {
    Write-Host "FAIL: Scheduled Task is not installed."
    return
  }
  Write-Host "OK: Scheduled Task exists. State: $($task.State)"

  try {
    $npx = Resolve-NpxPath
    Write-Host "OK: npx found at $npx"
  } catch {
    Write-Host "FAIL: $($_.Exception.Message)"
  }

  $runner = Get-RunnerPath
  if (Test-Path -LiteralPath $runner) { Write-Host "OK: Runner exists." } else { Write-Host "FAIL: Runner missing." }

  $hasRelinkUrl = Show-RelinkUrl
  if (-not $hasRelinkUrl) {
    Write-Host ""
    Write-Host "No add-device relink URL found in recent logs yet."
    Write-Host "If this is the first install, open logs or restart once."
  }

  $log = Get-LogPath
  $err = Get-ErrPath
  if (Test-Path -LiteralPath $log) {
    $logText = (Get-Content -LiteralPath $log -Tail 60 -ErrorAction SilentlyContinue) -join "`n"
    if ($logText -match "desktop-commander|remote|http|localhost|listening|connected|online|mcp|add-device") {
      Write-Host "OK: Recent log output detected."
    } elseif ($logText -match "exited") {
      Write-Host "WARN: Runner exited. Check logs below."
    } else {
      Write-Host "WARN: Log exists but no clear online marker yet."
    }
    Write-Host ""
    Write-Host "Recent log:"
    Get-Content -LiteralPath $log -Tail 30 -ErrorAction SilentlyContinue
  } else {
    Write-Host "WARN: No normal log yet."
  }

  if (Test-Path -LiteralPath $err) {
    $errText = (Get-Content -LiteralPath $err -Tail 40 -ErrorAction SilentlyContinue) -join "`n"
    if ($errText.Trim()) {
      Write-Host ""
      Write-Host "Recent error log:"
      Get-Content -LiteralPath $err -Tail 40 -ErrorAction SilentlyContinue
    }
  }
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
    Write-Runner
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 4
    Show-Status
    Verify-Task
  }
  "stop" {
    Assert-Administrator
    Stop-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 1
    Show-Status
  }
  "restart" {
    Assert-Administrator
    Write-Runner
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 4
    Show-Status
    Verify-Task
  }
  "status" { Show-Status }
  "verify" { Show-Status; Verify-Task }
}

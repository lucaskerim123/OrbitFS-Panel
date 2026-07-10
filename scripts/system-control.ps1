param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("hive", "tunnel", "panel", "sorter")]
  [string]$Target,

  [ValidateSet("start", "stop", "restart")]
  [string]$Action = "restart",

  [string]$PanelServiceName = $(if ($env:PANEL_SERVICE_NAME) { $env:PANEL_SERVICE_NAME } else { "MasterBrainPanel" }),

  [string]$HiveServiceName = $(if ($env:HIVE_SERVICE_NAME) { $env:HIVE_SERVICE_NAME } else { "MasterHiveServer" }),

  [string]$HiveDir = $(if ($env:HIVE_SERVER_DIR) { $env:HIVE_SERVER_DIR } else { "C:\mcp-hive-server" }),

  [string]$CloudflaredServiceName = $(if ($env:CLOUDFLARED_SERVICE_NAME) { $env:CLOUDFLARED_SERVICE_NAME } else { "MasterHiveTunnel" }),

  [string]$CloudflaredDir = $(if ($env:CLOUDFLARED_DIR) { $env:CLOUDFLARED_DIR } else { "C:\cloudflared" }),

  [string]$SorterServiceName = $(if ($env:SORTER_SERVICE_NAME) { $env:SORTER_SERVICE_NAME } else { "MasterHiveSorter" })
)

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ErrorActionPreference = "Stop"

$HiveServerScript = Join-Path $HiveDir "server.js"
$HiveOutLog = Join-Path $HiveDir "out.log"
$HiveErrLog = Join-Path $HiveDir "err.log"
$HivePingUrl = if ($env:HIVE_URL) { "$($env:HIVE_URL.TrimEnd('/'))/api/ping" } else { "http://localhost:3939/api/ping" }
$HiveShutdownUrl = if ($env:HIVE_URL) { "$($env:HIVE_URL.TrimEnd('/'))/api/admin/shutdown" } else { "http://localhost:3939/api/admin/shutdown" }
$HiveApiKey = if ($env:HIVE_API_KEY) { $env:HIVE_API_KEY } else { "" }
$CloudflaredExe = if ($env:CLOUDFLARED_EXE) { $env:CLOUDFLARED_EXE } else { Join-Path $CloudflaredDir "cloudflared.exe" }
$CloudflaredConfig = if ($env:CLOUDFLARED_CONFIG) { $env:CLOUDFLARED_CONFIG } else { Join-Path $HOME ".cloudflared\config.yml" }
$CloudflaredTunnelName = if ($env:CLOUDFLARED_TUNNEL_NAME) { $env:CLOUDFLARED_TUNNEL_NAME } else { "master-hive" }

function Assert-ServiceExists {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  $null = Get-Service -Name $Name -ErrorAction Stop
}

function Test-ServiceExists {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  [bool](Get-Service -Name $Name -ErrorAction SilentlyContinue)
}

function Get-HiveProcesses {
  try {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
      Where-Object { $_.CommandLine -like (Get-HiveCommandPattern) }
  } catch {
    @()
  }
}

function Get-HivePids {
  $ids = New-Object System.Collections.Generic.List[int]

  try {
    $lines = & 'C:\Windows\System32\netstat.exe' -ano | Select-String ':3939'
    foreach ($line in $lines) {
      if ($line.Line -match 'LISTENING\s+(\d+)\s*$') {
        $parsedPid = 0
        if ([int]::TryParse($matches[1], [ref]$parsedPid)) {
          $proc = Get-Process -Id $parsedPid -ErrorAction SilentlyContinue
          if ($proc -and $proc.ProcessName -eq "node") {
            $ids.Add($parsedPid)
          }
        }
      }
    }
  } catch {
  }

  $ids | Select-Object -Unique
}

function Test-HiveHttp {
  try {
    $resp = Invoke-WebRequest -Uri $HivePingUrl -Method GET -TimeoutSec 3 -UseBasicParsing
    return ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 300)
  } catch {
    return $false
  }
}

function Get-HiveCommandPattern {
  return "*" + ($HiveServerScript -replace "\\", "\\") + "*"
}

function Start-BackgroundCommand {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Executable,

    [Parameter(Mandatory = $true)]
    [string[]]$Arguments,

    [Parameter(Mandatory = $true)]
    [string]$WorkingDirectory,

    [Parameter(Mandatory = $true)]
    [string]$StdoutPath,

    [Parameter(Mandatory = $true)]
    [string]$StderrPath
  )

  $argumentString = ($Arguments | ForEach-Object {
    if ($_ -match '[\s"]') {
      '"' + ($_ -replace '"', '\"') + '"'
    } else {
      $_
    }
  }) -join " "

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Executable
  $psi.Arguments = $argumentString
  $psi.WorkingDirectory = $WorkingDirectory
  $psi.UseShellExecute = $true
  $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden

  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  if (-not $proc.Start()) {
    throw "Failed to start $Executable"
  }
  $proc
}

function Stop-HiveProcess {
  if (Test-ServiceExists -Name $HiveServiceName) {
    Stop-Service -Name $HiveServiceName -Force -ErrorAction Stop
    for ($i = 0; $i -lt 12; $i++) {
      if (-not (Test-HiveHttp)) { return }
      Start-Sleep -Seconds 1
    }
    throw "Hive service '$HiveServiceName' stop requested but $HivePingUrl is still responding."
  }

  $stoppedAny = $false
  if (Test-HiveHttp -and $HiveApiKey) {
    try {
      Invoke-WebRequest -Uri $HiveShutdownUrl -Method POST -Headers @{ Authorization = "Bearer $HiveApiKey"; "X-Hive-Flow" = "webpanel" } -TimeoutSec 5 -UseBasicParsing | Out-Null
      $stoppedAny = $true
    } catch {
    }
  }

  if (Test-HiveHttp) {
    foreach ($hiveProcessId in @(Get-HivePids)) {
      & 'C:\Windows\System32\taskkill.exe' /PID $hiveProcessId /T /F | Out-Null
      $stoppedAny = $true
    }
  }

  for ($i = 0; $i -lt 8; $i++) {
    if (-not (Test-HiveHttp)) {
      return
    }
    Start-Sleep -Seconds 1
  }

  if ($stoppedAny -or (Test-HiveHttp)) {
    throw "Hive server stop requested but $HivePingUrl is still responding."
  }
}

function Start-HiveProcess {
  if (Test-ServiceExists -Name $HiveServiceName) {
    Start-Service -Name $HiveServiceName -ErrorAction Stop
    for ($i = 0; $i -lt 20; $i++) {
      Start-Sleep -Seconds 1
      if (Test-HiveHttp) {
        return
      }
    }
    throw "Hive service '$HiveServiceName' started but $HivePingUrl did not come up."
  }

  if (-not (Test-Path -LiteralPath $HiveDir)) {
    throw "Hive directory not found: $HiveDir"
  }
  if (-not (Test-Path -LiteralPath $HiveServerScript)) {
    throw "Hive server entry file not found: $HiveServerScript"
  }

  if (-not (Test-HiveHttp)) {
    $proc = Start-BackgroundCommand `
      -Executable "node" `
      -Arguments @($HiveServerScript) `
      -WorkingDirectory $HiveDir `
      -StdoutPath $HiveOutLog `
      -StderrPath $HiveErrLog

    for ($i = 0; $i -lt 12; $i++) {
      Start-Sleep -Seconds 1
      if (Test-HiveHttp) {
        return
      }
      if ($proc.HasExited) {
        $stderr = if (Test-Path -LiteralPath $HiveErrLog) { (Get-Content $HiveErrLog -Tail 40 -ErrorAction SilentlyContinue) -join "`n" } else { "" }
        $stdout = if (Test-Path -LiteralPath $HiveOutLog) { (Get-Content $HiveOutLog -Tail 20 -ErrorAction SilentlyContinue) -join "`n" } else { "" }
        $message = "Hive server exited during startup."
        if ($stderr) { $message += " stderr: $stderr" }
        elseif ($stdout) { $message += " stdout: $stdout" }
        throw $message
      }
    }

    $stderr = if (Test-Path -LiteralPath $HiveErrLog) { (Get-Content $HiveErrLog -Tail 40 -ErrorAction SilentlyContinue) -join "`n" } else { "" }
    $stdout = if (Test-Path -LiteralPath $HiveOutLog) { (Get-Content $HiveOutLog -Tail 20 -ErrorAction SilentlyContinue) -join "`n" } else { "" }
    $message = "Hive server process started but /api/ping did not come up at $HivePingUrl."
    if ($stderr) { $message += " stderr: $stderr" }
    elseif ($stdout) { $message += " stdout: $stdout" }
    throw $message
  }
}

function Stop-TunnelProcess {
  if (Test-ServiceExists -Name $CloudflaredServiceName) {
    Stop-Service -Name $CloudflaredServiceName -Force -ErrorAction Stop
    return
  }
  Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
}

function Start-TunnelProcess {
  if (Test-ServiceExists -Name $CloudflaredServiceName) {
    Start-Service -Name $CloudflaredServiceName -ErrorAction Stop
    return
  }
  $running = Get-Process cloudflared -ErrorAction SilentlyContinue
  if (-not $running) {
    Start-BackgroundCommand `
      -Executable $CloudflaredExe `
      -Arguments @("--config", $CloudflaredConfig, "tunnel", "run", $CloudflaredTunnelName) `
      -WorkingDirectory $CloudflaredDir `
      -StdoutPath (Join-Path $CloudflaredDir "tunnel_out.log") `
      -StderrPath (Join-Path $CloudflaredDir "tunnel_err.log")
  }
}

# panel stop/restart are called detached from server.js after it has already
# responded to the HTTP request, since both kill the very process serving
# that request. panel start is called synchronously - the service is already
# stopped in that case, so there's no request to lose.
switch ("$Target.$Action") {
  "hive.start"     { Start-HiveProcess }
  "hive.stop"      { Stop-HiveProcess }
  "hive.restart"   { Stop-HiveProcess; Start-Sleep -Seconds 1; Start-HiveProcess }

  "tunnel.start"   { Start-TunnelProcess }
  "tunnel.stop"    { Stop-TunnelProcess }
  "tunnel.restart" { Stop-TunnelProcess; Start-Sleep -Seconds 1; Start-TunnelProcess }

  "panel.start"    { Assert-ServiceExists -Name $PanelServiceName; Start-Service -Name $PanelServiceName -ErrorAction Stop }
  "panel.stop"     { Assert-ServiceExists -Name $PanelServiceName; Start-Sleep -Seconds 1; Stop-Service -Name $PanelServiceName -Force -ErrorAction Stop }
  "panel.restart"  { Assert-ServiceExists -Name $PanelServiceName; Start-Sleep -Seconds 1; Restart-Service -Name $PanelServiceName -Force -ErrorAction Stop }

  "sorter.start"   { Assert-ServiceExists -Name $SorterServiceName; Start-Service -Name $SorterServiceName -ErrorAction Stop }
  "sorter.stop"    { Assert-ServiceExists -Name $SorterServiceName; Stop-Service -Name $SorterServiceName -Force -ErrorAction Stop }
  "sorter.restart" { Assert-ServiceExists -Name $SorterServiceName; Restart-Service -Name $SorterServiceName -Force -ErrorAction Stop }
}

Write-Output '{"ok":true}'

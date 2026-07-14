param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("hive", "tunnel", "panel", "sorter")]
  [string]$Target,

  [ValidateSet("start", "stop", "restart")]
  [string]$Action = "restart",

  [string]$PanelServiceName = $(if ($env:PANEL_SERVICE_NAME) { $env:PANEL_SERVICE_NAME } else { "OrbitFSPanel" }),

  [string]$HiveServiceName = $(if ($env:HIVE_SERVICE_NAME) { $env:HIVE_SERVICE_NAME } else { "OrbitFSMcpServer" }),

  [string]$HiveDir = $(if ($env:HIVE_SERVER_DIR) { $env:HIVE_SERVER_DIR } else { "F:\orbitfs-mcp-server" }),

  [string]$CloudflaredServiceName = $(if ($env:CLOUDFLARED_SERVICE_NAME) { $env:CLOUDFLARED_SERVICE_NAME } else { "OrbitFSTunnel" }),

  [string]$CloudflaredDir = $(if ($env:CLOUDFLARED_DIR) { $env:CLOUDFLARED_DIR } else { "C:\cloudflared" }),

  [string]$SorterServiceName = $(if ($env:SORTER_SERVICE_NAME) { $env:SORTER_SERVICE_NAME } else { "OrbitFSSorter" })
)

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ErrorActionPreference = "Stop"

$HiveServerScript = Join-Path $HiveDir "server.js"
$HiveOutLog = Join-Path $HiveDir "out.log"
$HiveErrLog = Join-Path $HiveDir "err.log"
$HivePingUrl = if ($env:HIVE_URL) { "$($env:HIVE_URL.TrimEnd('/'))/api/ping" } else { "http://localhost:3939/api/ping" }
$HiveShutdownUrl = if ($env:HIVE_URL) { "$($env:HIVE_URL.TrimEnd('/'))/api/admin/shutdown" } else { "http://localhost:3939/api/admin/shutdown" }
$HiveApiKey = if ($env:HIVE_API_KEY) { $env:HIVE_API_KEY } else { "" }
$PanelDir = Split-Path -Parent $PSScriptRoot
$PanelServerScript = Join-Path $PanelDir "server.js"
$PanelOutLog = Join-Path $PanelDir "service-out.log"
$PanelErrLog = Join-Path $PanelDir "service-err.log"
function Get-SorterDir {
  $default = Join-Path $PanelDir "plugins\OrbitFS Sorter"
  $candidates = @()
  if ($env:SORTER_DIR) { $candidates += $env:SORTER_DIR }
  $candidates += $default
  foreach ($candidate in $candidates | Select-Object -Unique) {
    if ($candidate -and (Test-Path -LiteralPath (Join-Path $candidate "server.js"))) {
      return $candidate
    }
  }
  return $default
}

$SorterApiKey = $null
$SorterPingUrl = $null
$SorterDir = Get-SorterDir
$SorterServerScript = Join-Path $SorterDir "server.js"
$SorterOutLog = Join-Path $SorterDir "out.log"
$SorterErrLog = Join-Path $SorterDir "err.log"
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

function Wait-ForServiceStatus {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,

    [Parameter(Mandatory = $true)]
    [ValidateSet("Running", "Stopped")]
    [string]$DesiredStatus,

    [int]$TimeoutSeconds = 15
  )

  for ($i = 0; $i -lt $TimeoutSeconds; $i++) {
    $service = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if (-not $service) {
      if ($DesiredStatus -eq "Stopped") {
        return
      }
      break
    }

    if ($service.Status.ToString() -eq $DesiredStatus) {
      return
    }

    Start-Sleep -Seconds 1
  }

  throw "Service '$Name' did not reach state '$DesiredStatus' within $TimeoutSeconds seconds."
}

function Stop-ManagedService {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  if (-not (Test-ServiceExists -Name $Name)) {
    return $false
  }

  try {
    Stop-Service -Name $Name -Force -ErrorAction Stop
    Wait-ForServiceStatus -Name $Name -DesiredStatus "Stopped"
    return $true
  } catch {
    return $false
  }
}

function Start-ManagedService {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  if (-not (Test-ServiceExists -Name $Name)) {
    return $false
  }

  try {
    Start-Service -Name $Name -ErrorAction Stop
    Wait-ForServiceStatus -Name $Name -DesiredStatus "Running"
    return $true
  } catch {
    return $false
  }
}

function Restart-ManagedService {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  if (-not (Test-ServiceExists -Name $Name)) {
    return $false
  }

  try {
    Restart-Service -Name $Name -Force -ErrorAction Stop
    Wait-ForServiceStatus -Name $Name -DesiredStatus "Running"
    return $true
  } catch {
    return $false
  }
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

function Get-SorterPort {
  $candidates = New-Object System.Collections.Generic.List[int]

  $configPort = 4055
  try {
    $configPath = Join-Path $SorterDir "config.json"
    if (Test-Path -LiteralPath $configPath) {
      $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
      $port = [int]$config.port
      if ($port -gt 0) {
        $configPort = $port
        if (-not $candidates.Contains($port)) { $candidates.Add($port) }
      }
    }
  } catch {
  }

  if (-not $candidates.Contains($configPort)) { $candidates.Add($configPort) }

  $portFile = Join-Path $SorterDir ".sorter-port"
  if (Test-Path -LiteralPath $portFile) {
    try {
      $port = [int]((Get-Content -LiteralPath $portFile -Raw).Trim())
      if ($port -gt 0 -and -not $candidates.Contains($port)) { $candidates.Add($port) }
    } catch {
    }
  }

  try {
    if ($env:SORTER_URL) {
      $port = [int](([uri]$env:SORTER_URL).Port)
      if ($port -gt 0 -and -not $candidates.Contains($port)) { $candidates.Add($port) }
    }
  } catch {
  }

  for ($offset = 0; $offset -lt 10; $offset++) {
    $port = $configPort + $offset
    if ($port -gt 0 -and -not $candidates.Contains($port)) { $candidates.Add($port) }
  }

  foreach ($candidate in $candidates) {
    if (Test-SorterPort -Port $candidate) {
      return $candidate
    }
  }

  return $configPort
}

function Get-SorterPingUrl {
  return "http://localhost:$(Get-SorterPort)/api/status"
}

function Test-SorterPort {
  param(
    [Parameter(Mandatory = $true)]
    [int]$Port
  )

  try {
    $apiKey = Get-SorterApiKey
    $headers = if ($apiKey) { @{ Authorization = "Bearer $apiKey" } } else { @{} }
    $resp = Invoke-WebRequest -Uri "http://localhost:$Port/api/status" -Method GET -Headers $headers -TimeoutSec 2 -UseBasicParsing
    return ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 300)
  } catch {
    return $false
  }
}

function Get-SorterApiKey {
  if ($env:HIVE_API_KEY) { return $env:HIVE_API_KEY }

  $envPath = Join-Path $SorterDir ".env"
  if (Test-Path -LiteralPath $envPath) {
    try {
      foreach ($line in Get-Content -LiteralPath $envPath -ErrorAction Stop) {
        if ($line -match '^\s*HIVE_API_KEY\s*=\s*(.+?)\s*$') {
          return $matches[1]
        }
      }
    } catch {
    }
  }

  return ""
}

function Get-HiveCommandPattern {
  return "*" + ($HiveServerScript -replace "\\", "\\") + "*"
}

function Get-CommandPattern {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ScriptPath
  )

  "*" + ($ScriptPath -replace "\\", "\\") + "*"
}

function Get-NodeProcessesByScriptPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ScriptPath
  )

  try {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
      Where-Object { $_.CommandLine -like (Get-CommandPattern -ScriptPath $ScriptPath) }
  } catch {
    @()
  }
}

function Get-NodeProcessesByPort {
  param(
    [Parameter(Mandatory = $true)]
    [int]$Port
  )

  $ids = New-Object System.Collections.Generic.List[int]
  try {
    $needle = [regex]::Escape(":$Port")
    $lines = & 'C:\Windows\System32\netstat.exe' -ano | Select-String $needle
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

function Stop-NodeProcessesByScriptPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ScriptPath,

    [Parameter(Mandatory = $true)]
    [string]$Label
  )

  foreach ($proc in @(Get-NodeProcessesByScriptPath -ScriptPath $ScriptPath)) {
    & 'C:\Windows\System32\taskkill.exe' /PID $proc.ProcessId /T /F | Out-Null
  }

  if (@(Get-NodeProcessesByScriptPath -ScriptPath $ScriptPath).Count -gt 0) {
    throw "$Label stop requested but matching node processes are still running."
  }
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

function Test-SorterHttp {
  try {
    $SorterPingUrl = Get-SorterPingUrl
    return (Test-SorterPort -Port ([uri]$SorterPingUrl).Port)
  } catch {
    return $false
  }
}

function Stop-HiveProcess {
  if (Stop-ManagedService -Name $HiveServiceName) {
    for ($i = 0; $i -lt 12; $i++) {
      if (-not (Test-HiveHttp)) { return }
      Start-Sleep -Seconds 1
    }
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

  if (Test-HiveHttp) {
    foreach ($proc in @(Get-HiveProcesses)) {
      & 'C:\Windows\System32\taskkill.exe' /PID $proc.ProcessId /T /F | Out-Null
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
    throw "OrbitFS server force-stop requested but $HivePingUrl is still responding."
  }
}

function Start-HiveProcess {
  if (Start-ManagedService -Name $HiveServiceName) {
    for ($i = 0; $i -lt 20; $i++) {
      Start-Sleep -Seconds 1
      if (Test-HiveHttp) {
        return
      }
    }
    throw "OrbitFS service '$HiveServiceName' started but $HivePingUrl did not come up."
  }

  if (-not (Test-Path -LiteralPath $HiveDir)) {
    throw "OrbitFS directory not found: $HiveDir"
  }
  if (-not (Test-Path -LiteralPath $HiveServerScript)) {
    throw "OrbitFS server entry file not found: $HiveServerScript"
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
        $message = "OrbitFS server exited during startup."
        if ($stderr) { $message += " stderr: $stderr" }
        elseif ($stdout) { $message += " stdout: $stdout" }
        throw $message
      }
    }

    $stderr = if (Test-Path -LiteralPath $HiveErrLog) { (Get-Content $HiveErrLog -Tail 40 -ErrorAction SilentlyContinue) -join "`n" } else { "" }
    $stdout = if (Test-Path -LiteralPath $HiveOutLog) { (Get-Content $HiveOutLog -Tail 20 -ErrorAction SilentlyContinue) -join "`n" } else { "" }
    $message = "OrbitFS server process started but /api/ping did not come up at $HivePingUrl."
    if ($stderr) { $message += " stderr: $stderr" }
    elseif ($stdout) { $message += " stdout: $stdout" }
    throw $message
  }
}

function Stop-TunnelProcess {
  if (Stop-ManagedService -Name $CloudflaredServiceName) {
    $running = Get-Process cloudflared -ErrorAction SilentlyContinue
    if (-not $running) {
      return
    }
  }
  Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
}

function Start-TunnelProcess {
  if (Start-ManagedService -Name $CloudflaredServiceName) {
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

function Stop-PanelProcess {
  if (Stop-ManagedService -Name $PanelServiceName) {
    Start-Sleep -Seconds 2
  }

  Stop-NodeProcessesByScriptPath -ScriptPath $PanelServerScript -Label "Panel"
}

function Start-PanelProcess {
  if (Start-ManagedService -Name $PanelServiceName) {
    return
  }

  if (-not (Test-Path -LiteralPath $PanelServerScript)) {
    throw "Panel server entry file not found: $PanelServerScript"
  }

  $null = Start-BackgroundCommand `
    -Executable "node" `
    -Arguments @($PanelServerScript) `
    -WorkingDirectory $PanelDir `
    -StdoutPath $PanelOutLog `
    -StderrPath $PanelErrLog
}

function Stop-SorterProcess {
  $sorterPort = Get-SorterPort

  if (Stop-ManagedService -Name $SorterServiceName) {
    for ($i = 0; $i -lt 8; $i++) {
      if (-not (Test-SorterHttp)) {
        return
      }
      Start-Sleep -Seconds 1
    }
  }

  foreach ($proc in @(Get-NodeProcessesByPort -Port $sorterPort)) {
    & 'C:\Windows\System32\taskkill.exe' /PID $proc /T /F | Out-Null
  }

  for ($i = 0; $i -lt 8; $i++) {
    if (-not (Test-SorterHttp)) {
      return
    }
    Start-Sleep -Seconds 1
  }

  Stop-NodeProcessesByScriptPath -ScriptPath $SorterServerScript -Label "Sorter"

  for ($i = 0; $i -lt 8; $i++) {
    if (-not (Test-SorterHttp)) {
      return
    }
    Start-Sleep -Seconds 1
  }

  throw "Sorter stop requested but $(Get-SorterPingUrl) is still responding."
}

function Start-SorterProcess {
  if (Test-SorterHttp) {
    return
  }

  if (Start-ManagedService -Name $SorterServiceName) {
    for ($i = 0; $i -lt 12; $i++) {
      Start-Sleep -Seconds 1
      if (Test-SorterHttp) {
        return
      }
    }
  }

  if (-not (Test-Path -LiteralPath $SorterServerScript)) {
    throw "Sorter server entry file not found: $SorterServerScript"
  }

  $null = Start-BackgroundCommand `
    -Executable "node" `
    -Arguments @($SorterServerScript) `
    -WorkingDirectory $SorterDir `
    -StdoutPath $SorterOutLog `
    -StderrPath $SorterErrLog

  for ($i = 0; $i -lt 12; $i++) {
    Start-Sleep -Seconds 1
    if (Test-SorterHttp) {
      return
    }
  }

  $stderr = if (Test-Path -LiteralPath $SorterErrLog) { (Get-Content $SorterErrLog -Tail 40 -ErrorAction SilentlyContinue) -join "`n" } else { "" }
  $stdout = if (Test-Path -LiteralPath $SorterOutLog) { (Get-Content $SorterOutLog -Tail 20 -ErrorAction SilentlyContinue) -join "`n" } else { "" }
  $message = "Sorter process started but /api/status did not come up at $(Get-SorterPingUrl)."
  if ($stderr) { $message += " stderr: $stderr" }
  elseif ($stdout) { $message += " stdout: $stdout" }
  throw $message
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

  "panel.start"    { Start-PanelProcess }
  "panel.stop"     { Start-Sleep -Seconds 1; Stop-PanelProcess }
  "panel.restart"  { Stop-PanelProcess; Start-Sleep -Seconds 1; Start-PanelProcess }

  "sorter.start"   { Start-SorterProcess }
  "sorter.stop"    { Stop-SorterProcess }
  "sorter.restart" { Stop-SorterProcess; Start-Sleep -Seconds 1; Start-SorterProcess }
}

Write-Output '{"ok":true}'


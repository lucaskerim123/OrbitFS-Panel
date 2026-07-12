param(
  [string]$PanelServiceName = $(if ($env:PANEL_SERVICE_NAME) { $env:PANEL_SERVICE_NAME } else { "OrbitFSPanel" }),
  [string]$HiveServiceName = $(if ($env:HIVE_SERVICE_NAME) { $env:HIVE_SERVICE_NAME } else { "OrbitFSMcpServer" }),
  [string]$HiveDir = $(if ($env:HIVE_SERVER_DIR) { $env:HIVE_SERVER_DIR } else { "F:\orbitfs-mcp-server" }),
  [string]$CloudflaredServiceName = $(if ($env:CLOUDFLARED_SERVICE_NAME) { $env:CLOUDFLARED_SERVICE_NAME } else { "OrbitFSTunnel" }),
  [string]$CloudflaredDir = $(if ($env:CLOUDFLARED_DIR) { $env:CLOUDFLARED_DIR } else { "C:\cloudflared" }),
  [string]$SorterServiceName = $(if ($env:SORTER_SERVICE_NAME) { $env:SORTER_SERVICE_NAME } else { "OrbitFSSorter" })
)

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$result = @{}
$HiveServerScript = Join-Path $HiveDir "server.js"
$HivePingUrl = if ($env:HIVE_URL) { "$($env:HIVE_URL.TrimEnd('/'))/api/ping" } else { "http://localhost:3939/api/ping" }

function Get-SorterDir {
  $panelDir = Split-Path -Parent $PSScriptRoot
  $default = Join-Path $panelDir "plugins\OrbitFS Sorter"
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

$SorterDir = Get-SorterDir
function Get-SorterApiKey {
  if ($env:HIVE_API_KEY) { return $env:HIVE_API_KEY }
  $envPath = Join-Path $SorterDir ".env"
  if (Test-Path -LiteralPath $envPath) {
    try {
      foreach ($line in Get-Content -LiteralPath $envPath -ErrorAction Stop) {
        if ($line -match '^\s*HIVE_API_KEY\s*=\s*(.+?)\s*$') { return $matches[1] }
      }
    } catch {}
  }
  return ""
}

function Get-SorterPingUrl {
  $configPort = 4055
  try {
    $configPath = Join-Path $SorterDir "config.json"
    if (Test-Path -LiteralPath $configPath) {
      $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
      $port = [int]$config.port
      if ($port -gt 0) { $configPort = $port }
    }
  } catch {}
  return "http://localhost:$configPort/api/status"
}

$panelSvc = Get-Service -Name $PanelServiceName -ErrorAction SilentlyContinue
$result.panel = @{ status = if ($panelSvc) { $panelSvc.Status.ToString() } else { "NotFound" } }

$hiveSvc = Get-Service -Name $HiveServiceName -ErrorAction SilentlyContinue
$tunnelSvc = Get-Service -Name $CloudflaredServiceName -ErrorAction SilentlyContinue

try {
  $resp = Invoke-WebRequest -Uri $HivePingUrl -Method GET -TimeoutSec 3 -UseBasicParsing
  $result.hive = @{ running = ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 300); reachable = $true; source = "http_ping"; service = if ($hiveSvc) { $hiveSvc.Status.ToString() } else { $null } }
} catch {
  $result.hive = @{ running = $false; reachable = $false; source = "http_ping"; service = if ($hiveSvc) { $hiveSvc.Status.ToString() } else { $null } }
}

$tunnelProc = Get-Process cloudflared -ErrorAction SilentlyContinue | Select-Object -First 1
$result.tunnel = @{ running = [bool]$tunnelProc -or [bool]($tunnelSvc -and $tunnelSvc.Status -eq "Running"); processId = if ($tunnelProc) { $tunnelProc.Id } else { $null }; service = if ($tunnelSvc) { $tunnelSvc.Status.ToString() } else { $null } }

$sorterSvc = Get-Service -Name $SorterServiceName -ErrorAction SilentlyContinue
try {
  $SorterPingUrl = Get-SorterPingUrl
  $SorterApiKey = Get-SorterApiKey
  $sorterHeaders = if ($SorterApiKey) { @{ Authorization = "Bearer $SorterApiKey" } } else { @{} }
  $resp = Invoke-WebRequest -Uri $SorterPingUrl -Method GET -Headers $sorterHeaders -TimeoutSec 3 -UseBasicParsing
  $result.sorter = @{ running = ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 300); reachable = $true; source = "http_ping"; service = if ($sorterSvc) { $sorterSvc.Status.ToString() } else { $null } }
} catch {
  $result.sorter = @{ running = $false; reachable = $false; source = "http_ping"; service = if ($sorterSvc) { $sorterSvc.Status.ToString() } else { $null } }
}

try {
  $storagePath = if ($env:PANEL_STORAGE_PATH) { $env:PANEL_STORAGE_PATH } elseif ($env:HIVE_ROOT) { $env:HIVE_ROOT } else { $HiveDir }
  $resolvedStoragePath = (Resolve-Path -LiteralPath $storagePath -ErrorAction Stop).Path
  $volumeRoot = [System.IO.Path]::GetPathRoot($resolvedStoragePath)
  $driveName = $volumeRoot.TrimEnd('\').TrimEnd(':')
  $drive = Get-PSDrive -Name $driveName -PSProvider FileSystem -ErrorAction Stop
  $usedBytes = [double]$drive.Used
  $freeBytes = [double]$drive.Free
  $totalBytes = $usedBytes + $freeBytes
  $usedPercent = if ($totalBytes -gt 0) { [math]::Round(($usedBytes / $totalBytes) * 100, 1) } else { 0 }
  $result.disk = @{
    drive = "$driveName`:"
    label = "Hive storage"
    path = $resolvedStoragePath
    root = $volumeRoot
    usedGB = [math]::Round(($usedBytes / 1GB), 1)
    freeGB = [math]::Round(($freeBytes / 1GB), 1)
    totalGB = [math]::Round(($totalBytes / 1GB), 1)
    usedPercent = $usedPercent
  }
} catch {
  $result.disk = @{ usedGB = $null; freeGB = $null; totalGB = $null; usedPercent = $null; label = "Hive storage"; path = if ($env:PANEL_STORAGE_PATH) { $env:PANEL_STORAGE_PATH } else { $HiveDir }; status = "Unknown"; error = $_.Exception.Message }
}

$result | ConvertTo-Json -Depth 5 -Compress

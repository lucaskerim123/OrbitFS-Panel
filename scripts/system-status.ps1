param(
  [string]$PanelServiceName = $(if ($env:PANEL_SERVICE_NAME) { $env:PANEL_SERVICE_NAME } else { "MasterBrainPanel" }),
  [string]$HiveServiceName = $(if ($env:HIVE_SERVICE_NAME) { $env:HIVE_SERVICE_NAME } else { "MasterHiveServer" }),
  [string]$HiveDir = $(if ($env:HIVE_SERVER_DIR) { $env:HIVE_SERVER_DIR } else { "C:\mcp-hive-server" }),
  [string]$CloudflaredServiceName = $(if ($env:CLOUDFLARED_SERVICE_NAME) { $env:CLOUDFLARED_SERVICE_NAME } else { "MasterHiveTunnel" }),
  [string]$CloudflaredDir = $(if ($env:CLOUDFLARED_DIR) { $env:CLOUDFLARED_DIR } else { "C:\cloudflared" }),
  [string]$SorterServiceName = $(if ($env:SORTER_SERVICE_NAME) { $env:SORTER_SERVICE_NAME } else { "MasterHiveSorter" })
)

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$result = @{}
$HiveServerScript = Join-Path $HiveDir "server.js"
$HivePingUrl = if ($env:HIVE_URL) { "$($env:HIVE_URL.TrimEnd('/'))/api/ping" } else { "http://localhost:3939/api/ping" }
$SorterPingUrl = if ($env:SORTER_URL) { "$($env:SORTER_URL.TrimEnd('/'))/api/status" } else { "http://localhost:4055/api/status" }
$SorterApiKey = if ($env:HIVE_API_KEY) { $env:HIVE_API_KEY } else { "" }
$SystemDriveName = if ($env:PANEL_SYSTEM_DRIVE) { $env:PANEL_SYSTEM_DRIVE } else { "C" }

$panelSvc = Get-Service -Name $PanelServiceName -ErrorAction SilentlyContinue
$result.panel = @{ status = if ($panelSvc) { $panelSvc.Status.ToString() } else { "NotFound" } }

$hiveSvc = Get-Service -Name $HiveServiceName -ErrorAction SilentlyContinue
$tunnelSvc = Get-Service -Name $CloudflaredServiceName -ErrorAction SilentlyContinue

try {
  $resp = Invoke-WebRequest -Uri $HivePingUrl -Method GET -TimeoutSec 3 -UseBasicParsing
  $result.hive = @{
    running = ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 300)
    reachable = $true
    source = "http_ping"
    service = if ($hiveSvc) { $hiveSvc.Status.ToString() } else { $null }
  }
} catch {
  $result.hive = @{
    running = $false
    reachable = $false
    source = "http_ping"
    service = if ($hiveSvc) { $hiveSvc.Status.ToString() } else { $null }
  }
}

$tunnelProc = Get-Process cloudflared -ErrorAction SilentlyContinue | Select-Object -First 1
$result.tunnel = @{
  running = [bool]$tunnelProc -or [bool]($tunnelSvc -and $tunnelSvc.Status -eq "Running")
  processId = if ($tunnelProc) { $tunnelProc.Id } else { $null }
  service = if ($tunnelSvc) { $tunnelSvc.Status.ToString() } else { $null }
}

$sorterSvc = Get-Service -Name $SorterServiceName -ErrorAction SilentlyContinue
try {
  $sorterHeaders = if ($SorterApiKey) { @{ Authorization = "Bearer $SorterApiKey" } } else { @{} }
  $resp = Invoke-WebRequest -Uri $SorterPingUrl -Method GET -Headers $sorterHeaders -TimeoutSec 3 -UseBasicParsing
  $result.sorter = @{
    running = ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 300)
    reachable = $true
    source = "http_ping"
    service = if ($sorterSvc) { $sorterSvc.Status.ToString() } else { $null }
  }
} catch {
  $result.sorter = @{
    running = $false
    reachable = $false
    source = "http_ping"
    service = if ($sorterSvc) { $sorterSvc.Status.ToString() } else { $null }
  }
}

try {
  $drive = Get-PSDrive $SystemDriveName -PSProvider FileSystem
  $result.disk = @{
    usedGB  = [math]::Round(($drive.Used / 1GB), 1)
    freeGB  = [math]::Round(($drive.Free / 1GB), 1)
    totalGB = [math]::Round((($drive.Used + $drive.Free) / 1GB), 1)
  }
} catch {
  $result.disk = @{
    usedGB  = $null
    freeGB  = $null
    totalGB = $null
    status  = "Unknown"
  }
}

$result | ConvertTo-Json -Depth 5 -Compress

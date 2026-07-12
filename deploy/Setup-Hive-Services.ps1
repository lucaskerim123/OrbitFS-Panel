#Requires -RunAsAdministrator
[CmdletBinding()]
param(
  [string]$HiveAppDir = "F:\orbitfs-mcp-server",
  [string]$HiveServiceName = "OrbitFSMcpServer",
  [string]$TunnelServiceName = "OrbitFSTunnel",
  [string]$CloudflaredDir = "C:\cloudflared",
  [string]$CloudflaredConfig = "C:\Users\Lucas\.cloudflared\config.yml",
  [string]$CloudflaredTunnelName = "master-hive",
  [string]$NssmExe = "C:\nssm\nssm.exe"
)

$ErrorActionPreference = "Stop"

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    OK: $msg" -ForegroundColor Green }

function Get-ListenerPid([int]$Port) {
  $lines = & 'C:\Windows\System32\netstat.exe' -ano | Select-String ":$Port"
  foreach ($line in $lines) {
    if ($line.Line -match 'LISTENING\s+(\d+)\s*$') {
      return [int]$matches[1]
    }
  }
  return $null
}

function Stop-ListenerIfPresent([int]$Port) {
  $pidValue = Get-ListenerPid $Port
  if ($pidValue) {
    & 'C:\Windows\System32\taskkill.exe' /PID $pidValue /T /F | Out-Null
    Start-Sleep -Seconds 1
  }
}

if (-not (Test-Path -LiteralPath $NssmExe)) {
  throw "nssm.exe not found at $NssmExe"
}

$nodeExe = (Get-Command node -ErrorAction Stop).Source
$cloudflaredExe = Join-Path $CloudflaredDir "cloudflared.exe"
if (-not (Test-Path -LiteralPath $cloudflaredExe)) {
  throw "cloudflared.exe not found at $cloudflaredExe"
}

Write-Step "Configuring Hive server service"
if (-not (Get-Service -Name $HiveServiceName -ErrorAction SilentlyContinue)) {
  & $NssmExe install $HiveServiceName $nodeExe "server.js" | Out-Null
  Write-Ok "Created service $HiveServiceName"
}
& $NssmExe set $HiveServiceName Application $nodeExe | Out-Null
& $NssmExe set $HiveServiceName AppDirectory $HiveAppDir | Out-Null
& $NssmExe set $HiveServiceName AppParameters "server.js" | Out-Null
& $NssmExe set $HiveServiceName AppStdout (Join-Path $HiveAppDir "service-out.log") | Out-Null
& $NssmExe set $HiveServiceName AppStderr (Join-Path $HiveAppDir "service-err.log") | Out-Null
& $NssmExe set $HiveServiceName AppRotateFiles 1 | Out-Null
& $NssmExe set $HiveServiceName AppRotateBytes 1048576 | Out-Null
& $NssmExe set $HiveServiceName Start SERVICE_AUTO_START | Out-Null
Stop-ListenerIfPresent 3939
Restart-Service -Name $HiveServiceName -Force -ErrorAction SilentlyContinue
if ((Get-Service -Name $HiveServiceName).Status -ne "Running") {
  Start-Service -Name $HiveServiceName
}
Write-Ok "Hive service running"

Write-Step "Configuring cloudflared service"
if (-not (Get-Service -Name $TunnelServiceName -ErrorAction SilentlyContinue)) {
  & $NssmExe install $TunnelServiceName $cloudflaredExe "tunnel run $CloudflaredTunnelName" | Out-Null
  Write-Ok "Created service $TunnelServiceName"
}
& $NssmExe set $TunnelServiceName Application $cloudflaredExe | Out-Null
& $NssmExe set $TunnelServiceName AppDirectory $CloudflaredDir | Out-Null
& $NssmExe set $TunnelServiceName AppParameters "tunnel --config `"$CloudflaredConfig`" run $CloudflaredTunnelName" | Out-Null
& $NssmExe set $TunnelServiceName AppStdout (Join-Path $CloudflaredDir "service-out.log") | Out-Null
& $NssmExe set $TunnelServiceName AppStderr (Join-Path $CloudflaredDir "service-err.log") | Out-Null
& $NssmExe set $TunnelServiceName AppRotateFiles 1 | Out-Null
& $NssmExe set $TunnelServiceName AppRotateBytes 1048576 | Out-Null
& $NssmExe set $TunnelServiceName Start SERVICE_AUTO_START | Out-Null
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Restart-Service -Name $TunnelServiceName -Force -ErrorAction SilentlyContinue
if ((Get-Service -Name $TunnelServiceName).Status -ne "Running") {
  Start-Service -Name $TunnelServiceName
}
Write-Ok "Tunnel service running"

Write-Step "Done"
Write-Host "Hive service: $HiveServiceName"
Write-Host "Tunnel service: $TunnelServiceName"


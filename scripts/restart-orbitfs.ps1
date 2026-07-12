[CmdletBinding()]
param(
    [string]$McpServiceName = "OrbitFSMcpServer",
    [string]$PanelServiceName = "OrbitFSPanel",
    [int]$McpPort = 3939,
    [int]$PanelPort = 4000,
    [int]$HealthTimeoutSeconds = 45,
    [switch]$SkipMcp,
    [switch]$ForceKillRelatedNodeProcesses
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Write-Step {
    param([string]$Message)
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Get-ServiceSafe {
    param([string]$Name)
    Get-Service -Name $Name -ErrorAction SilentlyContinue
}

function Stop-ServiceSafe {
    param([string]$Name)
    $service = Get-ServiceSafe -Name $Name
    if (-not $service) {
        Write-Warning "Service '$Name' was not found."
        return
    }
    if ($service.Status -ne "Stopped") {
        Write-Host "Stopping service: $Name"
        Stop-Service -Name $Name -Force -ErrorAction SilentlyContinue
        try { $service.WaitForStatus("Stopped", [TimeSpan]::FromSeconds(20)) } catch {}
    }
}

function Start-ServiceRequired {
    param([string]$Name)
    $service = Get-ServiceSafe -Name $Name
    if (-not $service) { throw "Service '$Name' was not found." }
    Write-Host "Starting service: $Name"
    Start-Service -Name $Name -ErrorAction Stop
    $service.WaitForStatus("Running", [TimeSpan]::FromSeconds(20))
}

function Stop-PortListeners {
    param([int[]]$Ports)
    foreach ($port in $Ports) {
        $connections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        foreach ($connection in $connections) {
            $pidValue = [int]$connection.OwningProcess
            if ($pidValue -le 0 -or $pidValue -eq $PID) { continue }
            $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
            $processName = if ($process) { $process.ProcessName } else { "unknown" }
            Write-Host "Killing stale listener on port ${port}: PID $pidValue ($processName)"
            Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
        }
    }
}

function Stop-RelatedNodeProcesses {
    $processes = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue
    foreach ($process in $processes) {
        $commandLine = [string]$process.CommandLine
        if ($commandLine -match "OrbitFS|orbitfs-mcp|OrbitFS-Panel|server\.js|start-server\.mjs") {
            Write-Host "Killing related Node process: PID $($process.ProcessId)"
            Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
}

function Wait-ForHttp {
    param([string]$Name, [string]$Url, [int]$TimeoutSeconds)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) {
                Write-Host "$Name healthy: $Url" -ForegroundColor Green
                return $true
            }
        } catch {}
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)
    return $false
}

Write-Step "Checking administrator privileges"
$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($currentIdentity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an elevated PowerShell window."
}

Write-Step "Stopping OrbitFS services"
Stop-ServiceSafe -Name $PanelServiceName
if (-not $SkipMcp) { Stop-ServiceSafe -Name $McpServiceName }

Write-Step "Removing stale port listeners"
$ports = @($PanelPort)
if (-not $SkipMcp) { $ports += $McpPort }
Stop-PortListeners -Ports $ports

if ($ForceKillRelatedNodeProcesses) {
    Write-Step "Removing related Node processes"
    Stop-RelatedNodeProcesses
}

Start-Sleep -Seconds 2

if (-not $SkipMcp) {
    Write-Step "Attempting MCP service restart"
    try {
        Start-ServiceRequired -Name $McpServiceName
        if (-not (Wait-ForHttp -Name "OrbitFS MCP" -Url "http://127.0.0.1:$McpPort/api/ping" -TimeoutSeconds 15)) {
            Write-Warning "MCP service started but its health endpoint did not respond. Continuing with panel startup."
        }
    } catch {
        Write-Warning "MCP could not be started: $($_.Exception.Message)"
        Write-Warning "Continuing so the panel can still come online. Start MCP manually when ready."
    }
}

Write-Step "Starting panel service"
Start-ServiceRequired -Name $PanelServiceName

Write-Step "Waiting for panel health"
if (-not (Wait-ForHttp -Name "OrbitFS Panel" -Url "http://127.0.0.1:$PanelPort/" -TimeoutSeconds $HealthTimeoutSeconds)) {
    throw "OrbitFS Panel did not become healthy within $HealthTimeoutSeconds seconds."
}

Write-Host "`nOrbitFS Panel restarted successfully." -ForegroundColor Green
if ($SkipMcp) {
    Write-Host "MCP was skipped and can be started manually." -ForegroundColor Yellow
}

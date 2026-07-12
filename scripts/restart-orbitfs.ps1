[CmdletBinding()]
param(
    [string]$McpServiceName = "OrbitFSMcpServer",
    [string]$PanelServiceName = "OrbitFSPanel",
    [int]$McpPort = 3939,
    [int]$PanelPort = 4000,
    [int]$HealthTimeoutSeconds = 45,
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
    return Get-Service -Name $Name -ErrorAction SilentlyContinue
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
        Stop-Service -Name $Name -Force -ErrorAction Stop
        $service.WaitForStatus("Stopped", [TimeSpan]::FromSeconds(20))
    }
}

function Start-ServiceSafe {
    param([string]$Name)

    $service = Get-ServiceSafe -Name $Name
    if (-not $service) {
        throw "Service '$Name' was not found."
    }

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
            if ($pidValue -le 0 -or $pidValue -eq $PID) {
                continue
            }

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
    param(
        [string]$Name,
        [string]$Url,
        [int]$TimeoutSeconds
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) {
                Write-Host "$Name healthy: $Url" -ForegroundColor Green
                return
            }
        }
        catch {
            Start-Sleep -Seconds 2
        }
    } while ((Get-Date) -lt $deadline)

    throw "$Name did not become healthy within $TimeoutSeconds seconds: $Url"
}

Write-Step "Checking administrator privileges"
$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($currentIdentity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an elevated PowerShell window."
}

Write-Step "Stopping OrbitFS services"
Stop-ServiceSafe -Name $PanelServiceName
Stop-ServiceSafe -Name $McpServiceName

Write-Step "Removing stale port listeners"
Stop-PortListeners -Ports @($McpPort, $PanelPort)

if ($ForceKillRelatedNodeProcesses) {
    Write-Step "Removing related Node processes"
    Stop-RelatedNodeProcesses
}

Start-Sleep -Seconds 2

Write-Step "Starting MCP service"
Start-ServiceSafe -Name $McpServiceName

Write-Step "Waiting for MCP health"
Wait-ForHttp -Name "OrbitFS MCP" -Url "http://127.0.0.1:$McpPort/api/ping" -TimeoutSeconds $HealthTimeoutSeconds

Write-Step "Starting panel service"
Start-ServiceSafe -Name $PanelServiceName

Write-Step "Waiting for panel health"
Wait-ForHttp -Name "OrbitFS Panel" -Url "http://127.0.0.1:$PanelPort/" -TimeoutSeconds $HealthTimeoutSeconds

Write-Host "`nOrbitFS MCP and Panel restarted successfully." -ForegroundColor Green

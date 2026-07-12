[CmdletBinding()]
param(
    [string]$PanelServiceName = "OrbitFSPanel",
    [int]$PanelPort = 4000,
    [int]$HealthTimeoutSeconds = 45
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

function Stop-PortListener {
    param([int]$Port)
    $connections = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    foreach ($connection in $connections) {
        $pidValue = [int]$connection.OwningProcess
        if ($pidValue -le 0 -or $pidValue -eq $PID) { continue }
        $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
        $processName = if ($process) { $process.ProcessName } else { "unknown" }
        Write-Host "Killing stale panel listener on port ${Port}: PID $pidValue ($processName)"
        Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
    }
}

function Wait-ForHttp {
    param([string]$Url, [int]$TimeoutSeconds)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) { return $true }
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

Write-Step "Restarting panel only"
$service = Get-ServiceSafe -Name $PanelServiceName
if (-not $service) { throw "Service '$PanelServiceName' was not found." }

if ($service.Status -ne "Stopped") {
    Stop-Service -Name $PanelServiceName -Force -ErrorAction SilentlyContinue
    try { $service.WaitForStatus("Stopped", [TimeSpan]::FromSeconds(20)) } catch {}
}

Stop-PortListener -Port $PanelPort
Start-Sleep -Seconds 2

Start-Service -Name $PanelServiceName -ErrorAction Stop
$service.WaitForStatus("Running", [TimeSpan]::FromSeconds(20))

if (-not (Wait-ForHttp -Url "http://127.0.0.1:$PanelPort/" -TimeoutSeconds $HealthTimeoutSeconds)) {
    throw "OrbitFS Panel did not become healthy within $HealthTimeoutSeconds seconds."
}

Write-Host "`nOrbitFS Panel restarted successfully." -ForegroundColor Green

#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Installs OrbitFS (panel, MCP server, sorter, Cloudflare tunnel) as Windows
  services via NSSM, and puts the panel behind an IIS reverse proxy.

.DESCRIPTION
  Replaces the old Setup-Hive-Services.ps1 + Setup-IIS.ps1 (deleted - they
  only covered some services and had a Windows username baked into a
  default path). This script:
    1. Ensures NSSM is available (downloads it if missing).
    2. Installs/updates all 4 services, every path derived from -CodeDir so
       nothing is hardcoded to a specific drive or username:
         OrbitFSMcpServer   - node server.js in <CodeDir>\orbitfs-mcp
         OrbitFSSorter      - node server.js in <CodeDir>\orbitfs-mcp\hive-addon-sorter
         OrbitFSPanel       - node server.js in <CodeDir>\orbitfs-panel
         OrbitFSTunnel      - cloudflared, only if -TunnelName is given
    3. Installs the IIS URL Rewrite + ARR modules if missing, enables the
       proxy feature, and creates a reverse-proxy site for the panel (and
       the sorter under /sorter, matching the panel's Sorter tab).

  Safe to re-run: every step checks current state first.

.PARAMETER CodeDir
  The same folder you passed to Install-OrbitFS.ps1 (or wherever
  orbitfs-mcp\ and orbitfs-panel\ actually live). Prompted for if omitted.

.PARAMETER TunnelName
  Cloudflare tunnel name (from `cloudflared tunnel create <name>`, run once,
  interactively, before this script - that step needs a browser login and
  can't be scripted). Leave blank to skip installing the tunnel service.

.PARAMETER CloudflaredConfig
  Path to the tunnel's config.yml. Defaults to the current user's
  ~\.cloudflared\config.yml - override if cloudflared was set up under a
  different account.

.PARAMETER SitePort
  HTTP port IIS binds the reverse-proxy site to. Put a real HTTPS
  certificate on this site afterwards (win-acme for Let's Encrypt, or IIS
  Manager -> Bindings) since login PINs and session tokens travel over it.

.PARAMETER HostHeader
  Optional domain (e.g. panel.example.com) to bind the IIS site to instead
  of accepting all Host headers on SitePort.

.PARAMETER SkipIIS
  Only install the 4 services, skip the IIS reverse-proxy step entirely
  (e.g. if you're fronting the panel with something else, or accessing it
  via Cloudflare Tunnel directly).

.EXAMPLE
  .\Setup-Services.ps1 -CodeDir "F:\" -TunnelName master-hive -HostHeader panel.example.com

.EXAMPLE
  # Services only, no IIS
  .\Setup-Services.ps1 -CodeDir "D:\apps" -SkipIIS
#>
[CmdletBinding()]
param(
  [string]$CodeDir,
  [string]$TunnelName = "",
  [string]$CloudflaredConfig = (Join-Path $env:USERPROFILE ".cloudflared\config.yml"),
  [string]$CloudflaredDir = "C:\cloudflared",
  [int]$SitePort = 8080,
  [string]$HostHeader = "",
  [string]$SitePath = "C:\inetpub\orbitfs-proxy",
  [string]$NssmDir = "C:\nssm",
  [switch]$SkipIIS
)

$ErrorActionPreference = "Stop"

function Write-Step($msg)  { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)    { Write-Host "    OK: $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "    NOTE: $msg" -ForegroundColor Yellow }

function Read-PathWithDefault([string]$Prompt, [string]$Default) {
  $answer = Read-Host "$Prompt [$Default]"
  if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
  return $answer
}

function Invoke-WebRequestWithRetry($Uri, $OutFile, $Attempts = 4) {
  $headers = @{ "User-Agent" = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" }
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    try { Invoke-WebRequest -Uri $Uri -OutFile $OutFile -UseBasicParsing -Headers $headers -TimeoutSec 30; return $true }
    catch {
      Write-Warn2 "Download attempt $attempt/$Attempts from $Uri failed ($($_.Exception.Message))"
      if ($attempt -lt $Attempts) { Start-Sleep -Seconds ($attempt * 5) }
    }
  }
  return $false
}

function Install-OrUpdateService([string]$Name, [string]$Exe, [string]$Args, [string]$WorkDir, [string]$StartType, [string]$NssmExe) {
  $existing = Get-Service -Name $Name -ErrorAction SilentlyContinue
  if (-not $existing) {
    & $NssmExe install $Name $Exe | Out-Null
    Write-Ok "created service $Name"
  } else {
    Write-Ok "service $Name already exists, updating its settings"
  }
  & $NssmExe set $Name Application $Exe | Out-Null
  & $NssmExe set $Name AppDirectory $WorkDir | Out-Null
  & $NssmExe set $Name AppParameters $Args | Out-Null
  & $NssmExe set $Name AppStdout (Join-Path $WorkDir "service-out.log") | Out-Null
  & $NssmExe set $Name AppStderr (Join-Path $WorkDir "service-err.log") | Out-Null
  & $NssmExe set $Name AppRotateFiles 1 | Out-Null
  & $NssmExe set $Name AppRotateBytes 1048576 | Out-Null
  & $NssmExe set $Name Start $StartType | Out-Null
}

# --- 0. Resolve CodeDir -------------------------------------------------------
Write-Step "Resolving install locations"
if (-not $CodeDir) {
  $CodeDir = Read-PathWithDefault "Where is OrbitFS installed (the folder holding orbitfs-mcp and orbitfs-panel)?" "F:\"
}
$HiveServerDir = Join-Path $CodeDir "orbitfs-mcp"
$SorterDir = Join-Path $HiveServerDir "hive-addon-sorter"
$PanelDir = Join-Path $CodeDir "orbitfs-panel"

foreach ($check in @(
  @{ Path = $HiveServerDir; Label = "MCP server" },
  @{ Path = $PanelDir; Label = "Panel" }
)) {
  if (-not (Test-Path -LiteralPath (Join-Path $check.Path "server.js"))) {
    throw "$($check.Label) not found at $($check.Path) (no server.js). Run Install-OrbitFS.ps1 first, or pass the correct -CodeDir."
  }
}
Write-Ok "MCP server: $HiveServerDir"
Write-Ok "Sorter:     $SorterDir$(if (-not (Test-Path (Join-Path $SorterDir 'server.js'))) { ' (not installed - skipping its service)' })"
Write-Ok "Panel:      $PanelDir"

$nodeExe = (Get-Command node -ErrorAction Stop).Source

# --- 1. NSSM -------------------------------------------------------------------
Write-Step "Ensuring NSSM is available"
$nssmExe = Join-Path $NssmDir "nssm.exe"
if (-not (Test-Path $nssmExe)) {
  $onPath = Get-Command nssm -ErrorAction SilentlyContinue
  if ($onPath) { $nssmExe = $onPath.Source; Write-Ok "NSSM found on PATH at $nssmExe" }
}
if (-not (Test-Path $nssmExe) -and (Get-Command choco -ErrorAction SilentlyContinue)) {
  Write-Warn2 "NSSM not found, installing via Chocolatey..."
  choco install nssm -y --no-progress | Out-Null
  $onPath = Get-Command nssm -ErrorAction SilentlyContinue
  if ($onPath) { $nssmExe = $onPath.Source; Write-Ok "NSSM installed via Chocolatey at $nssmExe" }
}
if (-not (Test-Path $nssmExe)) {
  Write-Warn2 "NSSM not found at $nssmExe, downloading from nssm.cc..."
  $zipPath = Join-Path $env:TEMP "nssm.zip"
  $extractPath = Join-Path $env:TEMP "nssm-extract"
  if (-not (Invoke-WebRequestWithRetry "https://nssm.cc/release/nssm-2.24.zip" $zipPath)) {
    throw "Couldn't download NSSM. Install Chocolatey (https://chocolatey.org/install) so this script can 'choco install nssm', or download https://nssm.cc/release/nssm-2.24.zip manually, extract nssm-2.24\win64\nssm.exe to $nssmExe, and re-run."
  }
  if (Test-Path $extractPath) { Remove-Item $extractPath -Recurse -Force }
  Expand-Archive -Path $zipPath -DestinationPath $extractPath -Force
  $arch = if ([Environment]::Is64BitOperatingSystem) { "win64" } else { "win32" }
  New-Item -ItemType Directory -Path $NssmDir -Force | Out-Null
  Copy-Item (Join-Path $extractPath "nssm-2.24\$arch\nssm.exe") $nssmExe -Force
  Remove-Item $zipPath, $extractPath -Recurse -Force
  Write-Ok "NSSM installed to $nssmExe"
} else {
  Write-Ok "NSSM present at $nssmExe"
}

# --- 2. MCP server service -----------------------------------------------------
Write-Step "Installing OrbitFSMcpServer"
Install-OrUpdateService -Name "OrbitFSMcpServer" -Exe $nodeExe -Args "server.js" -WorkDir $HiveServerDir -StartType "SERVICE_DEMAND_START" -NssmExe $nssmExe
Write-Ok "OrbitFSMcpServer configured (Manual start - launch it from the panel's System tab)"

# --- 3. Sorter service (only if present) ---------------------------------------
if (Test-Path -LiteralPath (Join-Path $SorterDir "server.js")) {
  Write-Step "Installing OrbitFSSorter"
  Install-OrUpdateService -Name "OrbitFSSorter" -Exe $nodeExe -Args "server.js" -WorkDir $SorterDir -StartType "SERVICE_DEMAND_START" -NssmExe $nssmExe
  Write-Ok "OrbitFSSorter configured (Manual start - launch it from the panel's System tab)"
} else {
  Write-Warn2 "hive-addon-sorter not found under $HiveServerDir, skipping OrbitFSSorter"
}

# --- 4. Panel service ------------------------------------------------------------
Write-Step "Installing OrbitFSPanel"
Install-OrUpdateService -Name "OrbitFSPanel" -Exe $nodeExe -Args "server.js" -WorkDir $PanelDir -StartType "SERVICE_AUTO_START" -NssmExe $nssmExe
Restart-Service -Name "OrbitFSPanel" -Force -ErrorAction SilentlyContinue
if ((Get-Service -Name "OrbitFSPanel").Status -ne "Running") { Start-Service -Name "OrbitFSPanel" }
Start-Sleep -Seconds 2
if ((Get-Service -Name "OrbitFSPanel").Status -ne "Running") {
  throw "OrbitFSPanel did not start. Check $PanelDir\service-err.log for details."
}
Write-Ok "OrbitFSPanel running (Automatic start)"

# --- 5. Cloudflare tunnel service (optional) -------------------------------------
if ($TunnelName) {
  Write-Step "Installing OrbitFSTunnel"
  $cloudflaredExe = Join-Path $CloudflaredDir "cloudflared.exe"
  if (-not (Test-Path -LiteralPath $cloudflaredExe)) {
    Write-Warn2 "cloudflared.exe not found at $cloudflaredExe - skipping tunnel service. Install cloudflared and re-run with the same -TunnelName."
  } elseif (-not (Test-Path -LiteralPath $CloudflaredConfig)) {
    Write-Warn2 "$CloudflaredConfig not found - run 'cloudflared tunnel login' and 'cloudflared tunnel create $TunnelName' first, then re-run this script."
  } else {
    Install-OrUpdateService -Name "OrbitFSTunnel" -Exe $cloudflaredExe -Args "tunnel --config `"$CloudflaredConfig`" run $TunnelName" -WorkDir $CloudflaredDir -StartType "SERVICE_AUTO_START" -NssmExe $nssmExe
    Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Restart-Service -Name "OrbitFSTunnel" -Force -ErrorAction SilentlyContinue
    if ((Get-Service -Name "OrbitFSTunnel").Status -ne "Running") { Start-Service -Name "OrbitFSTunnel" }
    Write-Ok "OrbitFSTunnel running (Automatic start)"
  }
} else {
  Write-Step "Skipping Cloudflare tunnel service (-TunnelName not given)"
}

# --- 6. IIS reverse proxy ----------------------------------------------------------
if ($SkipIIS) {
  Write-Step "Skipping IIS (-SkipIIS)"
} else {
  Write-Step "Checking IIS URL Rewrite + Application Request Routing modules"
  function Test-IISModuleInstalled($registryName) { Test-Path "HKLM:\SOFTWARE\Microsoft\IIS Extensions\$registryName" }

  if (-not (Test-IISModuleInstalled "URL Rewrite")) {
    Write-Warn2 "URL Rewrite not found, downloading + installing..."
    $msi = Join-Path $env:TEMP "urlrewrite.msi"
    if (-not (Invoke-WebRequestWithRetry "https://download.microsoft.com/download/1/2/8/128E2E22-C1B9-44A4-BE2A-5859ED1D4592/rewrite_amd64_en-US.msi" $msi)) {
      throw "Couldn't download URL Rewrite. Install manually: https://www.iis.net/downloads/microsoft/url-rewrite, or re-run with -SkipIIS."
    }
    Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /quiet /norestart" -Wait
    Remove-Item $msi -Force
    Write-Ok "URL Rewrite installed"
  } else { Write-Ok "URL Rewrite already installed" }

  if (-not (Test-IISModuleInstalled "Application Request Routing")) {
    Write-Warn2 "ARR not found, downloading + installing..."
    $msi = Join-Path $env:TEMP "arr.msi"
    if (-not (Invoke-WebRequestWithRetry "https://download.microsoft.com/download/E/9/8/E9849D6A-020E-47E4-9FD0-A023E99B54EB/requestRouter_amd64.msi" $msi)) {
      throw "Couldn't download ARR. Install manually: https://www.iis.net/downloads/microsoft/application-request-routing, or re-run with -SkipIIS."
    }
    Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /quiet /norestart" -Wait
    Remove-Item $msi -Force
    Write-Ok "ARR installed"
  } else { Write-Ok "ARR already installed" }

  Write-Warn2 "If either module was just installed, run 'iisreset' once after this script finishes."

  Import-Module WebAdministration -ErrorAction Stop

  Write-Step "Enabling ARR reverse-proxy feature"
  Set-WebConfigurationProperty -pspath "MACHINE/WEBROOT/APPHOST" -filter "system.webServer/proxy" -name "enabled" -value "True"
  Write-Ok "Proxy enabled at the server level"

  Write-Step "Creating/updating IIS site 'OrbitFSPanel'"
  New-Item -ItemType Directory -Path $SitePath -Force | Out-Null

  # /sorter/* forwards to the sorter's own port (auto-picked, read from
  # .sorter-port) so the panel's Sorter tab works when opened standalone too;
  # everything else forwards to the panel.
  $sorterPortFile = Join-Path $SorterDir ".sorter-port"
  $sorterPort = if (Test-Path -LiteralPath $sorterPortFile) { (Get-Content -LiteralPath $sorterPortFile -Raw).Trim() } else { "4055" }

  $webConfig = @"
<?xml version="1.0" encoding="UTF-8"?>
<configuration>
  <system.webServer>
    <rewrite>
      <rules>
        <rule name="SorterReverseProxy" stopProcessing="true">
          <match url="^sorter/?(.*)$" />
          <action type="Rewrite" url="http://localhost:$sorterPort/{R:1}" />
        </rule>
        <rule name="OrbitFSPanelReverseProxy" stopProcessing="true">
          <match url="(.*)" />
          <action type="Rewrite" url="http://localhost:4000/{R:1}" />
        </rule>
      </rules>
    </rewrite>
  </system.webServer>
</configuration>
"@
  Set-Content -Path (Join-Path $SitePath "web.config") -Value $webConfig -Encoding UTF8
  Write-Ok "web.config written to $SitePath"

  $existingSite = Get-Website -Name "OrbitFSPanel" -ErrorAction SilentlyContinue
  if (-not $existingSite) {
    New-Website -Name "OrbitFSPanel" -PhysicalPath $SitePath -Port $SitePort -HostHeader $HostHeader -Force | Out-Null
    Write-Ok "Site 'OrbitFSPanel' created, bound to port $SitePort$(if ($HostHeader) { " (host header: $HostHeader)" })"
  } else {
    Set-ItemProperty "IIS:\Sites\OrbitFSPanel" -Name physicalPath -Value $SitePath
    Write-Ok "Site 'OrbitFSPanel' already existed, physical path refreshed"
  }
  Start-Website -Name "OrbitFSPanel" -ErrorAction SilentlyContinue
}

# --- Done ---------------------------------------------------------------------
Write-Step "Done"
Write-Host @"

Services installed:
  OrbitFSPanel      Automatic  $PanelDir
  OrbitFSMcpServer  Manual     $HiveServerDir
  OrbitFSSorter     Manual     $SorterDir
$(if ($TunnelName) { "  OrbitFSTunnel     Automatic  $CloudflaredDir (tunnel: $TunnelName)" })
$(if (-not $SkipIIS) { "
IIS reverse proxy: http://localhost:$SitePort$(if ($HostHeader) { " (host: $HostHeader)" }) -> localhost:4000, /sorter/* -> localhost:$sorterPort" })

Next steps (manual, on purpose - real credentials/DNS):
  1. Point DNS at this machine if you used -HostHeader.
  2. Bind HTTPS: IIS Manager -> Sites -> OrbitFSPanel -> Bindings -> Add https
     (win-acme, https://www.win-acme.com, for a free auto-renewing cert).
  3. Create your login if you haven't: node "$PanelDir\scripts\add-user.mjs" <username> <pin>
  4. Start OrbitFSMcpServer once from the panel's System tab.

Useful commands:
  Restart-Service OrbitFSPanel        # after a git pull + npm install
  Get-Content "$PanelDir\service-err.log" -Tail 50   # if a service won't start
"@ -ForegroundColor Cyan

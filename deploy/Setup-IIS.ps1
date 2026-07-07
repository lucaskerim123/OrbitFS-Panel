#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Deploys The Master Brain panel behind IIS on this Windows Server/VPS.

.DESCRIPTION
  Automates the "Running on IIS" steps from README.md:
    1. Installs/updates the panel as a background Windows service (via NSSM),
       so it keeps running without a logged-in session.
    2. Ensures the IIS URL Rewrite and Application Request Routing (ARR)
       modules are present (downloads + silently installs them if missing).
    3. Enables ARR's reverse-proxy feature server-wide.
    4. Creates (or updates) an IIS site that reverse-proxies all requests to
       the panel's local port.

  Safe to re-run: every step checks current state first and only changes
  what's missing, so running this again after a `git pull` + `npm install`
  just restarts the service with the new code.

.PARAMETER AppDir
  Path to the cloned the-master-brain repo (with node_modules installed and
  .env / config.json already created — see README.md's manual setup steps
  1-5, this script only automates step 6 onward).

.PARAMETER PanelPort
  Port the Node panel listens on. Must match PANEL_PORT in AppDir\.env.

.PARAMETER SiteName
  Name of the IIS site this script creates for the reverse proxy.

.PARAMETER SitePort
  HTTP port IIS binds the proxy site to. Put a real HTTPS cert on this site
  afterwards (IIS Manager -> Bindings, or win-acme for Let's Encrypt) since
  login PINs and session tokens travel over this connection.

.PARAMETER HostHeader
  Optional domain name (e.g. brain.your-domain.com) to bind the site to
  instead of accepting all Host headers on SitePort.

.EXAMPLE
  .\Setup-IIS.ps1 -AppDir C:\the-master-brain -PanelPort 4000 -HostHeader brain.example.com
#>

[CmdletBinding()]
param(
  [string]$AppDir = "C:\the-master-brain",
  [string]$ServiceName = "MasterBrainPanel",
  [int]$PanelPort = 4000,
  [string]$SiteName = "MasterBrainPanel",
  [string]$SitePath = "C:\inetpub\master-brain-proxy",
  [int]$SitePort = 8080,
  [string]$HostHeader = "",
  [string]$NssmDir = "C:\nssm"
)

$ErrorActionPreference = "Stop"

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    OK: $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "    NOTE: $msg" -ForegroundColor Yellow }

# Some of the third-party hosts below (nssm.cc especially) intermittently
# 503 scripted requests. Retry a few times with a browser-like User-Agent
# before giving up, instead of failing the whole script on the first blip.
function Invoke-WebRequestWithRetry($Uri, $OutFile, $Attempts = 4) {
  $headers = @{ "User-Agent" = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" }
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    try {
      Invoke-WebRequest -Uri $Uri -OutFile $OutFile -UseBasicParsing -Headers $headers -TimeoutSec 30
      return $true
    } catch {
      Write-Warn2 "Download attempt $attempt/$Attempts from $Uri failed ($($_.Exception.Message))"
      if ($attempt -lt $Attempts) { Start-Sleep -Seconds ($attempt * 5) }
    }
  }
  return $false
}

# --- 0. Sanity checks -------------------------------------------------------
Write-Step "Checking prerequisites"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js isn't on PATH. Install it first: https://nodejs.org/ (LTS), then re-run this script."
}
Write-Ok "Node.js found: $(node --version)"

if (-not (Test-Path (Join-Path $AppDir "server.js"))) {
  throw "AppDir '$AppDir' doesn't look like the-master-brain (server.js not found). Clone the repo there first."
}
if (-not (Test-Path (Join-Path $AppDir "node_modules"))) {
  throw "'$AppDir\node_modules' is missing. Run 'npm install' in $AppDir first."
}
if (-not (Test-Path (Join-Path $AppDir ".env"))) {
  throw "'$AppDir\.env' is missing. Copy .env.example to .env and fill it in first (see README.md)."
}
Write-Ok "the-master-brain found at $AppDir with dependencies and .env in place"

# --- 1. NSSM (Windows service wrapper) --------------------------------------
Write-Step "Ensuring NSSM is available"

$nssmExe = Join-Path $NssmDir "nssm.exe"

if (-not (Test-Path $nssmExe)) {
  $onPath = Get-Command nssm -ErrorAction SilentlyContinue
  if ($onPath) {
    $nssmExe = $onPath.Source
    Write-Ok "NSSM already available on PATH at $nssmExe"
  }
}

if (-not (Test-Path $nssmExe) -and (Get-Command choco -ErrorAction SilentlyContinue)) {
  Write-Warn2 "NSSM not found, installing via Chocolatey..."
  choco install nssm -y --no-progress | Out-Null
  $onPath = Get-Command nssm -ErrorAction SilentlyContinue
  if ($onPath) {
    $nssmExe = $onPath.Source
    Write-Ok "NSSM installed via Chocolatey at $nssmExe"
  }
}

if (-not (Test-Path $nssmExe)) {
  Write-Warn2 "NSSM not found at $nssmExe, downloading from nssm.cc..."
  $zipPath = Join-Path $env:TEMP "nssm.zip"
  $extractPath = Join-Path $env:TEMP "nssm-extract"
  if (-not (Invoke-WebRequestWithRetry "https://nssm.cc/release/nssm-2.24.zip" $zipPath)) {
    throw "Couldn't download NSSM from nssm.cc after several attempts (it intermittently 503s under load). Options: re-run this script in a few minutes; install Chocolatey (https://chocolatey.org/install) so this script can 'choco install nssm' instead; or download https://nssm.cc/release/nssm-2.24.zip manually in a browser, extract nssm-2.24\win64\nssm.exe to $nssmExe, then re-run this script."
  }
  if (Test-Path $extractPath) { Remove-Item $extractPath -Recurse -Force }
  Expand-Archive -Path $zipPath -DestinationPath $extractPath -Force
  $arch = if ([Environment]::Is64BitOperatingSystem) { "win64" } else { "win32" }
  New-Item -ItemType Directory -Path $NssmDir -Force | Out-Null
  Copy-Item (Join-Path $extractPath "nssm-2.24\$arch\nssm.exe") $nssmExe -Force
  Remove-Item $zipPath, $extractPath -Recurse -Force
  Write-Ok "NSSM installed to $nssmExe"
} else {
  Write-Ok "NSSM already present at $nssmExe"
}

# --- 2. Register/update the panel as a Windows service ----------------------
Write-Step "Registering '$ServiceName' Windows service"

$nodeExe = (Get-Command node).Source
$existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue

if (-not $existingService) {
  & $nssmExe install $ServiceName $nodeExe "server.js"
  Write-Ok "Service '$ServiceName' created"
} else {
  Write-Ok "Service '$ServiceName' already exists, updating its settings"
}

& $nssmExe set $ServiceName AppDirectory $AppDir
& $nssmExe set $ServiceName AppParameters "server.js"
& $nssmExe set $ServiceName Application $nodeExe
& $nssmExe set $ServiceName AppStdout (Join-Path $AppDir "service-out.log")
& $nssmExe set $ServiceName AppStderr (Join-Path $AppDir "service-err.log")
& $nssmExe set $ServiceName AppRotateFiles 1
& $nssmExe set $ServiceName AppRotateBytes 1048576
& $nssmExe set $ServiceName Start SERVICE_AUTO_START

Restart-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
if ((Get-Service -Name $ServiceName).Status -ne "Running") {
  Start-Service -Name $ServiceName
}
Start-Sleep -Seconds 2
$svc = Get-Service -Name $ServiceName
if ($svc.Status -ne "Running") {
  throw "Service '$ServiceName' did not start. Check $AppDir\service-err.log for details."
}
Write-Ok "Service '$ServiceName' is running"

# --- 3. IIS URL Rewrite + ARR modules ---------------------------------------
Write-Step "Checking IIS URL Rewrite + Application Request Routing modules"

function Test-IISModuleInstalled($registryName) {
  $path = "HKLM:\SOFTWARE\Microsoft\IIS Extensions\$registryName"
  return Test-Path $path
}

if (-not (Test-IISModuleInstalled "URL Rewrite")) {
  Write-Warn2 "URL Rewrite module not found, downloading + installing..."
  $msi = Join-Path $env:TEMP "urlrewrite.msi"
  if (-not (Invoke-WebRequestWithRetry "https://download.microsoft.com/download/1/2/8/128E2E22-C1B9-44A4-BE2A-5859ED1D4592/rewrite_amd64_en-US.msi" $msi)) {
    throw "Couldn't download the URL Rewrite module after several attempts. Re-run this script, or install it manually: https://www.iis.net/downloads/microsoft/url-rewrite"
  }
  Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /quiet /norestart" -Wait
  Remove-Item $msi -Force
  Write-Ok "URL Rewrite installed"
} else {
  Write-Ok "URL Rewrite already installed"
}

if (-not (Test-IISModuleInstalled "Application Request Routing")) {
  Write-Warn2 "Application Request Routing (ARR) not found, downloading + installing..."
  $msi = Join-Path $env:TEMP "arr.msi"
  if (-not (Invoke-WebRequestWithRetry "https://download.microsoft.com/download/E/9/8/E9849D6A-020E-47E4-9FD0-A023E99B54EB/requestRouter_amd64.msi" $msi)) {
    throw "Couldn't download Application Request Routing after several attempts. Re-run this script, or install it manually: https://www.iis.net/downloads/microsoft/application-request-routing"
  }
  Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /quiet /norestart" -Wait
  Remove-Item $msi -Force
  Write-Ok "ARR installed"
} else {
  Write-Ok "ARR already installed"
}

Write-Warn2 "If either module was just installed, restart IIS once (iisreset) after this script finishes."

Import-Module WebAdministration -ErrorAction Stop

# --- 4. Enable ARR's proxy feature server-wide ------------------------------
Write-Step "Enabling ARR reverse-proxy feature"
Set-WebConfigurationProperty -pspath "MACHINE/WEBROOT/APPHOST" -filter "system.webServer/proxy" -name "enabled" -value "True"
Write-Ok "Proxy enabled at the server level"

# --- 5. Create the reverse-proxy site ---------------------------------------
Write-Step "Creating/updating IIS site '$SiteName'"

New-Item -ItemType Directory -Path $SitePath -Force | Out-Null

$webConfig = @"
<?xml version="1.0" encoding="UTF-8"?>
<configuration>
  <system.webServer>
    <rewrite>
      <rules>
        <rule name="MasterBrainReverseProxy" stopProcessing="true">
          <match url="(.*)" />
          <action type="Rewrite" url="http://localhost:$PanelPort/{R:1}" />
        </rule>
      </rules>
    </rewrite>
  </system.webServer>
</configuration>
"@
Set-Content -Path (Join-Path $SitePath "web.config") -Value $webConfig -Encoding UTF8
Write-Ok "web.config written to $SitePath"

$existingSite = Get-Website -Name $SiteName -ErrorAction SilentlyContinue
if (-not $existingSite) {
  New-Website -Name $SiteName -PhysicalPath $SitePath -Port $SitePort -HostHeader $HostHeader -Force | Out-Null
  Write-Ok "Site '$SiteName' created, bound to port $SitePort$(if ($HostHeader) { " (host header: $HostHeader)" })"
} else {
  Set-ItemProperty "IIS:\Sites\$SiteName" -Name physicalPath -Value $SitePath
  Write-Ok "Site '$SiteName' already existed, physical path refreshed"
}

Start-Website -Name $SiteName -ErrorAction SilentlyContinue

Write-Step "Done"
Write-Host @"

The Master Brain panel is now:
  - Running as Windows service '$ServiceName' (node server.js in $AppDir, port $PanelPort)
  - Reverse-proxied by IIS site '$SiteName' on port $SitePort$(if ($HostHeader) { " for host '$HostHeader'" })

Next steps (manual, on purpose — these need real credentials/DNS):
  1. Point DNS for your domain at this VPS's public IP, if you used -HostHeader.
  2. Bind HTTPS: IIS Manager -> Sites -> $SiteName -> Bindings -> Add https,
     with a real certificate (win-acme, https://www.win-acme.com, is the
     easiest way to get + auto-renew a free Let's Encrypt cert on IIS).
  3. Create your login account if you haven't yet:
       node "$AppDir\scripts\add-user.mjs" <username> <pin>
  4. Open https://<your-domain-or-ip>/ from your phone and log in.

Useful commands:
  Restart-Service $ServiceName        # after a git pull + npm install
  Get-Content "$AppDir\service-err.log" -Tail 50   # if the service won't start
"@ -ForegroundColor Cyan

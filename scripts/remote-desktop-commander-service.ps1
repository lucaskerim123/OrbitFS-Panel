param(
  [ValidateSet("install", "uninstall", "start", "stop", "restart", "status")]
  [string]$Action = "install",

  [string]$ServiceName = "OrbitFSRemoteDesktopCommander",

  [string]$DisplayName = "OrbitFS Remote Desktop Commander",

  [string]$Package = "@wonderwhy-er/desktop-commander@latest",

  [string]$WorkingDirectory = $PSScriptRoot
)

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ErrorActionPreference = "Stop"

function Assert-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run PowerShell as Administrator."
  }
}

function Escape-Xml([string]$Value) {
  return [System.Security.SecurityElement]::Escape($Value)
}

function Get-ServiceRuntimeDirectory {
  $repoRoot = Split-Path -Parent $PSScriptRoot
  return Join-Path $repoRoot "runtime\remote-desktop-commander"
}

function Get-ServiceExecutable {
  return Join-Path (Get-ServiceRuntimeDirectory) "$ServiceName.exe"
}

function Get-ServiceConfigPath {
  return Join-Path (Get-ServiceRuntimeDirectory) "$ServiceName.xml"
}

function Get-WinSwDownloadUrl {
  $headers = @{ "User-Agent" = "OrbitFS-Panel" }
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/winsw/winsw/releases/latest" -Headers $headers
  $asset = $release.assets | Where-Object { $_.name -match '^WinSW-x64\.exe$' } | Select-Object -First 1
  if (-not $asset) {
    throw "Could not locate the WinSW x64 executable in the latest release."
  }
  return $asset.browser_download_url
}

function Resolve-Npx {
  $command = Get-Command "npx.cmd" -ErrorAction SilentlyContinue
  if (-not $command) {
    throw "npx.cmd was not found. Install Node.js first."
  }
  return $command.Source
}

function Write-ServiceConfig {
  param(
    [Parameter(Mandatory = $true)][string]$NpxPath,
    [Parameter(Mandatory = $true)][string]$ConfigPath
  )

  $profilePath = [Environment]::GetFolderPath("UserProfile")
  $logPath = Join-Path (Get-ServiceRuntimeDirectory) "logs"
  New-Item -ItemType Directory -Path $logPath -Force | Out-Null

  $xml = @"
<service>
  <id>$(Escape-Xml $ServiceName)</id>
  <name>$(Escape-Xml $DisplayName)</name>
  <description>Runs Remote Desktop Commander continuously in the background for OrbitFS.</description>
  <executable>$(Escape-Xml $NpxPath)</executable>
  <arguments>--yes $(Escape-Xml $Package)</arguments>
  <workingdirectory>$(Escape-Xml $WorkingDirectory)</workingdirectory>
  <env name="HOME" value="$(Escape-Xml $profilePath)" />
  <env name="USERPROFILE" value="$(Escape-Xml $profilePath)" />
  <startmode>Automatic</startmode>
  <delayedAutoStart>true</delayedAutoStart>
  <stoptimeout>20sec</stoptimeout>
  <onfailure action="restart" delay="5 sec" />
  <onfailure action="restart" delay="15 sec" />
  <onfailure action="restart" delay="30 sec" />
  <resetfailure>1 hour</resetfailure>
  <logpath>$(Escape-Xml $logPath)</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>10485760</sizeThreshold>
    <keepFiles>5</keepFiles>
  </log>
</service>
"@

  Set-Content -LiteralPath $ConfigPath -Value $xml -Encoding UTF8
}

function Install-CommanderService {
  Assert-Administrator

  $runtime = Get-ServiceRuntimeDirectory
  New-Item -ItemType Directory -Path $runtime -Force | Out-Null

  $serviceExe = Get-ServiceExecutable
  $configPath = Get-ServiceConfigPath
  $npx = Resolve-Npx

  if (-not (Test-Path -LiteralPath $serviceExe)) {
    $url = Get-WinSwDownloadUrl
    Write-Host "Downloading WinSW..."
    Invoke-WebRequest -Uri $url -OutFile $serviceExe -UseBasicParsing
  }

  Write-ServiceConfig -NpxPath $npx -ConfigPath $configPath

  $existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if ($existing) {
    & $serviceExe stop | Out-Null
    & $serviceExe uninstall | Out-Null
    Start-Sleep -Seconds 1
  }

  & $serviceExe install
  & $serviceExe start
  Start-Sleep -Seconds 2

  $service = Get-Service -Name $ServiceName -ErrorAction Stop
  Write-Host "$DisplayName installed. Status: $($service.Status)"
  Write-Host "Logs: $(Join-Path $runtime 'logs')"
}

function Uninstall-CommanderService {
  Assert-Administrator
  $serviceExe = Get-ServiceExecutable
  if (-not (Test-Path -LiteralPath $serviceExe)) {
    Write-Host "Service runtime is not installed."
    return
  }
  & $serviceExe stop | Out-Null
  & $serviceExe uninstall
}

function Invoke-ServiceAction([string]$Name) {
  Assert-Administrator
  $serviceExe = Get-ServiceExecutable
  if (-not (Test-Path -LiteralPath $serviceExe)) {
    throw "Service runtime not found. Run with -Action install first."
  }
  & $serviceExe $Name
}

switch ($Action) {
  "install"   { Install-CommanderService }
  "uninstall" { Uninstall-CommanderService }
  "start"     { Invoke-ServiceAction "start" }
  "stop"      { Invoke-ServiceAction "stop" }
  "restart"   { Invoke-ServiceAction "restart" }
  "status" {
    $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($service) {
      Write-Host "${DisplayName}: $($service.Status)"
      Write-Host "Runtime: $(Get-ServiceRuntimeDirectory)"
    } else {
      Write-Host "$DisplayName is not installed."
    }
  }
}

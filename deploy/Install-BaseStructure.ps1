<#
.SYNOPSIS
  One-shot bootstrap for a fresh machine: creates the shared Hive folder
  skeleton, generates .env files for both repos, and runs npm install.

.DESCRIPTION
  Run this AFTER you've cloned both repos onto the new machine:
    - mcp-hive-server   (the MCP/REST server)
    - the-master-brain  (this repo, the webpanel)

  It is safe to re-run: existing folders, files, and .env values are never
  overwritten. Missing pieces are filled in.

  This script does NOT set up Windows services, the Cloudflare tunnel, or
  IIS. See GETTING_STARTED.md for the full walkthrough, and
  deploy/Setup-Hive-Services.ps1 / deploy/Setup-IIS.ps1 for the next steps
  after this script.

.PARAMETER HiveServerDir
  Path to the mcp-hive-server repo. Defaults to a sibling "mcp-hive-server"
  folder next to this repo's parent directory.

.PARAMETER PanelDir
  Path to this repo (the-master-brain). Defaults to the parent of the
  deploy/ folder this script lives in.

.PARAMETER HiveRoot
  Path to the shared FireStorm file root the Hive server will serve.
  Defaults to the value already in mcp-hive-server\.env if one exists,
  otherwise "C:\Project FireStorm\The Master Hive".

.EXAMPLE
  .\Install-BaseStructure.ps1

.EXAMPLE
  .\Install-BaseStructure.ps1 -HiveServerDir "D:\apps\mcp-hive-server" -HiveRoot "D:\FireStorm"
#>
[CmdletBinding()]
param(
  [string]$HiveServerDir,
  [string]$PanelDir,
  [string]$HiveRoot
)

$ErrorActionPreference = "Stop"

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    OK: $msg" -ForegroundColor Green }
function Write-Skip($msg) { Write-Host "    skip: $msg" -ForegroundColor DarkGray }
function Write-Warn2($msg) { Write-Host "    WARNING: $msg" -ForegroundColor Yellow }

function New-RandomSecret([int]$Length = 44) {
  $chars = (48..57) + (65..90) + (97..122)
  -join (1..$Length | ForEach-Object { [char]($chars | Get-Random) })
}

function Get-EnvValue([string]$EnvPath, [string]$Key) {
  if (-not (Test-Path -LiteralPath $EnvPath)) { return $null }
  $line = Get-Content -LiteralPath $EnvPath | Where-Object { $_ -match "^\s*$Key\s*=" } | Select-Object -First 1
  if (-not $line) { return $null }
  return ($line -split "=", 2)[1].Trim()
}

function Ensure-Dir([string]$DirPath) {
  if (Test-Path -LiteralPath $DirPath) {
    Write-Skip "$DirPath already exists"
  } else {
    New-Item -ItemType Directory -Path $DirPath -Force | Out-Null
    Write-Ok "created $DirPath"
  }
}

function Ensure-File([string]$FilePath, [string]$Content) {
  if (Test-Path -LiteralPath $FilePath) {
    Write-Skip "$FilePath already exists"
  } else {
    Set-Content -LiteralPath $FilePath -Value $Content -Encoding UTF8
    Write-Ok "created $FilePath"
  }
}

# --- Resolve paths ---

$DeployDir = $PSScriptRoot
if (-not $PanelDir) { $PanelDir = Split-Path -Parent $DeployDir }
if (-not $HiveServerDir) {
  $candidate = Join-Path (Split-Path -Parent $PanelDir) "mcp-hive-server"
  $HiveServerDir = $candidate
}

Write-Step "Checking prerequisites"
try {
  $nodeVersion = (node --version)
  Write-Ok "Node.js $nodeVersion found"
} catch {
  throw "Node.js is not installed or not on PATH. Install Node 18+ from https://nodejs.org/ and re-run this script."
}

if (-not (Test-Path -LiteralPath $PanelDir)) {
  throw "Panel repo not found at $PanelDir. Clone the-master-brain there first, or pass -PanelDir."
}
if (-not (Test-Path -LiteralPath $HiveServerDir)) {
  throw "Hive server repo not found at $HiveServerDir. Clone mcp-hive-server there first, or pass -HiveServerDir."
}
Write-Ok "Panel repo: $PanelDir"
Write-Ok "Hive server repo: $HiveServerDir"

$hiveEnvPath = Join-Path $HiveServerDir ".env"
if (-not $HiveRoot) {
  $existing = Get-EnvValue -EnvPath $hiveEnvPath -Key "HIVE_ROOT"
  $HiveRoot = if ($existing) { $existing } else { "C:\Project FireStorm\The Master Hive" }
}
Write-Ok "Hive root: $HiveRoot"

# --- Create the FireStorm folder skeleton ---

Write-Step "Creating Hive root folder skeleton"
Ensure-Dir $HiveRoot

$trashFolder = [char]::ConvertFromUtf32(0x1F5D1) + " Trash"  # avoids source-encoding issues with the literal emoji
$protectedRoots = @(
  "_system",
  "_sorter",
  $trashFolder,
  "0. Core Folder",
  "1. Master Court System",
  "2. Mental Health System",
  "3. Legal Charges - AVO",
  "Media"
)
foreach ($folder in $protectedRoots) {
  Ensure-Dir (Join-Path $HiveRoot $folder)
}

$systemDir = Join-Path $HiveRoot "_system"
Ensure-Dir (Join-Path $systemDir "Startup")
Ensure-Dir (Join-Path $systemDir "Rules")
Ensure-Dir (Join-Path $systemDir "Index")

$placeholderNote = "<!-- placeholder created by Install-BaseStructure.ps1 - replace with real content -->`n"

Ensure-File (Join-Path $systemDir "Startup\00_MASTER_STARTUP.md") "$placeholderNote# Master Startup`n"
Ensure-File (Join-Path $systemDir "Startup\01_COURT_SYSTEM_STARTUP.md") "$placeholderNote# Court System Startup`n"
Ensure-File (Join-Path $systemDir "Startup\02_MENTAL_HEALTH_SYSTEM_STARTUP.md") "$placeholderNote# Mental Health System Startup`n"
Ensure-File (Join-Path $systemDir "Startup\03_MEDIA_STARTUP.md") "$placeholderNote# Media Startup`n"
Ensure-File (Join-Path $systemDir "Rules\load_order.md") "$placeholderNote# Load Order`n"
Ensure-File (Join-Path $systemDir "Rules\project_rules.md") "$placeholderNote# Project Rules`n"
Ensure-File (Join-Path $systemDir "Rules\saving_rules.md") "$placeholderNote# Saving Rules`n"
Ensure-File (Join-Path $systemDir "Rules\commands.md") "$placeholderNote# Commands`n"
Ensure-File (Join-Path $systemDir "Index\file_index.json") "{}`n"
Ensure-File (Join-Path $systemDir "chatgpt_mcp_instructions.md") "$placeholderNote# ChatGPT MCP Instructions`n"
Ensure-File (Join-Path $systemDir "claude_mcp_instructions.md") "$placeholderNote# Claude MCP Instructions`n"

# --- Log folders ---

Write-Step "Creating log folders"
Ensure-Dir (Join-Path $HiveServerDir "logs")
Ensure-Dir (Join-Path $PanelDir "logs")

# --- .env for mcp-hive-server ---

Write-Step "Setting up mcp-hive-server\.env"
$hiveApiKey = $null
if (Test-Path -LiteralPath $hiveEnvPath) {
  Write-Skip ".env already exists, leaving it as-is"
  $hiveApiKey = Get-EnvValue -EnvPath $hiveEnvPath -Key "HIVE_API_KEY"
} else {
  $examplePath = Join-Path $HiveServerDir ".env.example"
  if (-not (Test-Path -LiteralPath $examplePath)) {
    throw "$examplePath not found - can't generate .env from it."
  }
  $hiveApiKey = New-RandomSecret
  $sessionSecret = New-RandomSecret
  $content = Get-Content -LiteralPath $examplePath -Raw
  $content = $content -replace "(?m)^HIVE_ROOT=.*$", "HIVE_ROOT=$HiveRoot"
  $content = $content -replace "(?m)^HIVE_API_KEY=\s*$", "HIVE_API_KEY=$hiveApiKey"
  $content = $content -replace "(?m)^SESSION_SECRET=\s*$", "SESSION_SECRET=$sessionSecret"
  Set-Content -LiteralPath $hiveEnvPath -Value $content -Encoding UTF8
  Write-Ok "generated .env with a fresh HIVE_API_KEY and SESSION_SECRET"
  Write-Warn2 "PUBLIC_BASE_URL still needs to be set by hand once you know your tunnel/domain"
}

# --- .env for the-master-brain ---

Write-Step "Setting up the-master-brain\.env"
$panelEnvPath = Join-Path $PanelDir ".env"
if (Test-Path -LiteralPath $panelEnvPath) {
  Write-Skip ".env already exists, leaving it as-is"
} else {
  $examplePath = Join-Path $PanelDir ".env.example"
  if (-not (Test-Path -LiteralPath $examplePath)) {
    throw "$examplePath not found - can't generate .env from it."
  }
  $hivePort = Get-EnvValue -EnvPath $hiveEnvPath -Key "PORT"
  if (-not $hivePort) { $hivePort = "3939" }
  $content = Get-Content -LiteralPath $examplePath -Raw
  if ($hiveApiKey) {
    $content = $content -replace "(?m)^HIVE_API_KEY=.*$", "HIVE_API_KEY=$hiveApiKey"
  }
  $content = $content -replace "(?m)^HIVE_URL=.*$", "HIVE_URL=http://localhost:$hivePort"
  $content = $content -replace "(?m)^HIVE_SERVER_DIR=.*$", "HIVE_SERVER_DIR=$HiveServerDir"
  $content = $content -replace "(?m)^HIVE_LOG_DIR=.*$", "HIVE_LOG_DIR=$(Join-Path $HiveServerDir 'logs')"
  Set-Content -LiteralPath $panelEnvPath -Value $content -Encoding UTF8
  Write-Ok "generated .env, matched HIVE_API_KEY to the Hive server's"
}

# --- npm install ---

Write-Step "Installing dependencies (mcp-hive-server)"
Push-Location $HiveServerDir
try { npm install } finally { Pop-Location }
Write-Ok "mcp-hive-server dependencies installed"

Write-Step "Installing dependencies (the-master-brain)"
Push-Location $PanelDir
try { npm install } finally { Pop-Location }
Write-Ok "the-master-brain dependencies installed"

# --- Done ---

Write-Step "Base structure ready"
Write-Host @"

Next steps:
  1. Open $hiveEnvPath and fill in PUBLIC_BASE_URL (and the CF_* values
     if you're using Cloudflare Access OAuth instead of the bearer key).
  2. Create your first panel login:
       cd "$PanelDir"
       node scripts/add-user.mjs <username> <4-10 digit pin>
  3. Start the Hive server:
       cd "$HiveServerDir"
       npm start
  4. Start the panel (in another window):
       cd "$PanelDir"
       npm start
  5. Open http://localhost:4000 and log in.

See GETTING_STARTED.md for the full walkthrough, including the Cloudflare
tunnel and running both as Windows services.
"@

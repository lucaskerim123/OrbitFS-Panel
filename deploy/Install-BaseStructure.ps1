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

$protectedRoots = @(
  "_system",
  "_sorter",
  "_trash",
  "0. Core",
  "1. Legal",
  "2. Wellbeing",
  "_media"
)
foreach ($folder in $protectedRoots) {
  Ensure-Dir (Join-Path $HiveRoot $folder)
}

# Shared core subfolders. Current AVO / Active Orders hold AVO and
# current-order (ICO, bail, CCO) material - shared between the Legal and
# Wellbeing projects, not duplicated into either one.
$coreDir = Join-Path $HiveRoot "0. Core"
foreach ($folder in @("Master Logs", "Profiles", "Shared Notes", "Current AVO", "Active Orders")) {
  Ensure-Dir (Join-Path $coreDir $folder)
}

# Legal project subfolders (court/case-management workflow).
$legalDir = Join-Path $HiveRoot "1. Legal"
foreach ($folder in @("0. Intake - Needs Review", "1. Addons", "Archive", "Documents", "Imports", "Key Dates", "Maintenance", "Reference Files", "Written Records")) {
  Ensure-Dir (Join-Path $legalDir $folder)
}

# Wellbeing project subfolders (mental health workflow).
$wellbeingDir = Join-Path $HiveRoot "2. Wellbeing"
foreach ($folder in @("0. Waiting To Be Sorted - Approval Required", "1. Plugin-Addons", "Archive", "Imports", "Letters - Documents", "Notes", "Pure Vent Mode", "Sessions")) {
  Ensure-Dir (Join-Path $wellbeingDir $folder)
}

# Media subfolders.
$mediaDir = Join-Path $HiveRoot "_media"
foreach ($folder in @("Photos", "Videos", "Audio")) {
  Ensure-Dir (Join-Path $mediaDir $folder)
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

$rebuildIndexScript = @'
from pathlib import Path
from datetime import datetime, timezone
import json
import os

ROOT = Path(os.environ.get("MASTER_HIVE_ROOT", r"C:\\Project FireStorm\\The Master Hive")).resolve()
OUTPUT = ROOT / "_system" / "Index" / "file_index.json"

INCLUDE_EXTENSIONS = {
    ".md", ".txt", ".json", ".csv",
    ".docx", ".pdf", ".xlsx", ".xls",
    ".jpg", ".jpeg", ".png", ".webp",
    ".mp4", ".mov", ".m4a", ".mp3", ".wav",
    ".zip"
}

EXCLUDE_DIR_NAMES = {".git", "__pycache__"}

def should_skip(path: Path) -> bool:
    parts_lower = [p.lower() for p in path.parts]
    if any(part in EXCLUDE_DIR_NAMES for part in parts_lower):
        return True
    if "archive" in parts_lower:
        return True
    return False

def classify_system(relative_path: str) -> str:
    normalized = relative_path.replace("\\", "/")
    if normalized.startswith("0. Core/"):
        return "core"
    if normalized.startswith("1. Legal/"):
        return "legal"
    if normalized.startswith("2. Wellbeing/"):
        return "wellbeing"
    if normalized.startswith("_media/Photos/"):
        return "media_photos"
    if normalized.startswith("_media/Videos/"):
        return "media_videos"
    if normalized.startswith("_media/Audio/"):
        return "media_audio"
    if normalized.startswith("_system/"):
        return "system"
    return "master_hive_root"

def file_info(path: Path):
    stat = path.stat()
    relative = str(path.relative_to(ROOT)).replace("\\", "/")
    return {
        "path": relative,
        "name": path.name,
        "extension": path.suffix.lower(),
        "size_bytes": stat.st_size,
        "modified_utc": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
        "system": classify_system(relative)
    }

def main():
    if not ROOT.exists():
        raise SystemExit(f"Root does not exist: {ROOT}")

    files = []
    for path in ROOT.rglob("*"):
        if not path.is_file():
            continue
        if path == OUTPUT:
            continue
        if should_skip(path):
            continue
        if path.suffix.lower() not in INCLUDE_EXTENSIONS:
            continue
        files.append(file_info(path))

    files.sort(key=lambda x: x["modified_utc"], reverse=True)

    by_system = {}
    for item in files:
        by_system[item["system"]] = by_system.get(item["system"], 0) + 1

    index = {
        "project": "Project FireStorm - The Master Hive",
        "root": str(ROOT),
        "generated_utc": datetime.now(timezone.utc).isoformat(),
        "archive_excluded": True,
        "total_files": len(files),
        "counts_by_system": by_system,
        "load_first_folders": [
            "0. Core"
        ],
        "latest_files": files[:75],
        "all_files": files
    }

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(index, indent=2), encoding="utf-8")

    print(f"Wrote {OUTPUT}")
    print(f"Indexed {len(files)} files")
    for key, count in sorted(by_system.items()):
        print(f"  {key}: {count}")

if __name__ == "__main__":
    main()
'@
Ensure-File (Join-Path $systemDir "rebuild_index.py") $rebuildIndexScript

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

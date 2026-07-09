<#
.SYNOPSIS
    Sets up the Project FireStorm - The Master Hive folder structure on Windows.

.DESCRIPTION
    Creates the agreed Master Hive structure:
    - _system startup/rules/index files
    - 0. Core Folder
    - 1. Master Court System
    - 2. Mental Health System
    - 3. Legal Charges - AVO
    - Media

    Also creates starter Markdown files and a Python index rebuild script.

.USAGE
    powershell -ExecutionPolicy Bypass -File .\setup-master-hive-v3.ps1

    Optional:
    powershell -ExecutionPolicy Bypass -File .\setup-master-hive-v3.ps1 -CreateScheduledTask

.NOTES
    Default root:
    C:\Project FireStorm\The Master Hive
#>

param(
    [string]$Root = "C:\Project FireStorm\The Master Hive",
    [switch]$CreateScheduledTask
)

$ErrorActionPreference = "Stop"

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Ensure-Directory {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Force -Path $Path | Out-Null
        Write-Host "Created: $Path"
    } else {
        Write-Host "Exists:  $Path"
    }
}

function Write-FileIfMissing {
    param(
        [string]$Path,
        [string]$Content
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        $Parent = Split-Path -Parent $Path
        Ensure-Directory $Parent
        $Content | Set-Content -Encoding UTF8 -LiteralPath $Path
        Write-Host "Created file: $Path"
    } else {
        Write-Host "Kept existing file: $Path"
    }
}

Write-Step "Creating Master Hive folder structure"

$folders = @(
    "$Root\_system",
    "$Root\_system\Startup",
    "$Root\_system\Rules",
    "$Root\_system\Index",

    "$Root\0. Core Folder",
    "$Root\0. Core Folder\Master Logs",
    "$Root\0. Core Folder\Profiles",
    "$Root\0. Core Folder\Profiles\Master Profiles",
    "$Root\0. Core Folder\Profiles\Mental Health Profiles",
    "$Root\0. Core Folder\Profiles\Court Profiles",
    "$Root\0. Core Folder\Profiles\Relationship Profiles",
    "$Root\0. Core Folder\Shared Notes",

    "$Root\1. Master Court System",
    "$Root\1. Master Court System\0. Waiting To Be Sorted - Approval Required",
    "$Root\1. Master Court System\1. Plugin-Addons",
    "$Root\1. Master Court System\Evidence Files",
    "$Root\1. Master Court System\Court Days",
    "$Root\1. Master Court System\Court Days\November - TikTok",
    "$Root\1. Master Court System\Statements",
    "$Root\1. Master Court System\Court Documents",
    "$Root\1. Master Court System\Imports",
    "$Root\1. Master Court System\Archive",

    "$Root\2. Mental Health System",
    "$Root\2. Mental Health System\0. Waiting To Be Sorted - Approval Required",
    "$Root\2. Mental Health System\1. Plugin-Addons",
    "$Root\2. Mental Health System\Letters - Documents",
    "$Root\2. Mental Health System\Pure Vent Mode",
    "$Root\2. Mental Health System\Sessions",
    "$Root\2. Mental Health System\Notes",
    "$Root\2. Mental Health System\Imports",
    "$Root\2. Mental Health System\Archive",

    "$Root\3. Legal Charges - AVO",
    "$Root\3. Legal Charges - AVO\Current AVO",
    "$Root\3. Legal Charges - AVO\Incidents",
    "$Root\3. Legal Charges - AVO\Statements",
    "$Root\3. Legal Charges - AVO\Convicted - CCO",
    "$Root\3. Legal Charges - AVO\Convicted - CCO\Briefs - CCO",
    "$Root\3. Legal Charges - AVO\Convicted - ICO",
    "$Root\3. Legal Charges - AVO\Convicted - ICO\Briefs - ICO",
    "$Root\3. Legal Charges - AVO\Active Matters",
    "$Root\3. Legal Charges - AVO\Archive",

    "$Root\Media",
    "$Root\Media\Photos",
    "$Root\Media\Videos",
    "$Root\Media\Audio"
)

foreach ($folder in $folders) {
    Ensure-Directory $folder
}

Write-Step "Creating startup and rules files"

$masterStartup = @"
# 00_MASTER_STARTUP

Root:
$Root

The Master Hive is the core private drive for Project FireStorm.

Before answering anything related to Project FireStorm:

1. Read this file.
2. Read `_system/Rules/load_order.md`.
3. Read `_system/Rules/project_rules.md`.
4. Read `_system/Rules/saving_rules.md`.
5. Read `_system/Index/file_index.json` if it exists.
6. Detect the correct subsystem:
   - Court/legal/AVO/charges/evidence/statements/bail/ICO/CCO = `1. Master Court System` and `3. Legal Charges - AVO`
   - Mental health/vent/profiles/sessions/personal notes = `2. Mental Health System`
   - Photos/videos/audio = `Media`
7. Load `0. Core Folder` for shared truth when relevant.

Core principle:
- `0. Core Folder` is shared truth.
- Project folders are working systems.
- `3. Legal Charges - AVO` is shared legal source material.
- Archive folders are not loaded unless explicitly requested.
"@

$courtStartup = @"
# 01_COURT_SYSTEM_STARTUP

Use this startup file for court, legal, AVO, charges, evidence, statements, bail, ICO, CCO, timelines, court-day, and case-document tasks.

Load order for court tasks:

1. `_system/Startup/00_MASTER_STARTUP.md`
2. `_system/Rules/load_order.md`
3. `_system/Rules/project_rules.md`
4. `_system/Index/file_index.json`
5. `0. Core Folder`
6. `3. Legal Charges - AVO`
7. `1. Master Court System`

Search locations:
- `0. Core Folder/Master Logs`
- `0. Core Folder/Profiles`
- `3. Legal Charges - AVO`
- `1. Master Court System/Evidence Files`
- `1. Master Court System/Statements`
- `1. Master Court System/Court Documents`
- `1. Master Court System/Court Days`

Saving:
- Unsure court item: `1. Master Court System/0. Waiting To Be Sorted - Approval Required`
- Court drafts/outputs: `1. Master Court System/Court Documents`
- Court evidence bundles: `1. Master Court System/Evidence Files`
- Legal source material: `3. Legal Charges - AVO`
- Shared profiles: `0. Core Folder/Profiles`
- Shared logs/timelines: `0. Core Folder/Master Logs`
"@

$mentalStartup = @"
# 02_MENTAL_HEALTH_SYSTEM_STARTUP

Use this startup file for mental health, venting, profiles, personal notes, sessions, letters, and emotional-log tasks.

Load order for mental-health tasks:

1. `_system/Startup/00_MASTER_STARTUP.md`
2. `_system/Rules/load_order.md`
3. `_system/Rules/project_rules.md`
4. `_system/Index/file_index.json`
5. `0. Core Folder`
6. `2. Mental Health System`

Only load `3. Legal Charges - AVO` when the topic touches:
- court
- charges
- AVO
- allegations
- statements
- evidence
- bail
- ICO/CCO

Saving:
- Unsure mental-health item: `2. Mental Health System/0. Waiting To Be Sorted - Approval Required`
- New vent entries: `2. Mental Health System/Pure Vent Mode`
- Letters: `2. Mental Health System/Letters - Documents`
- Sessions: `2. Mental Health System/Sessions`
- Notes: `2. Mental Health System/Notes`
- Shared profiles: `0. Core Folder/Profiles`
"@

$mediaStartup = @"
# 03_MEDIA_STARTUP

Use this startup file for photos, videos, audio, screenshots, recordings, and media evidence.

Media folders:
- Photos: `Media/Photos`
- Videos: `Media/Videos`
- Audio: `Media/Audio`

Rules:
- Do not rename or delete original media unless explicitly asked.
- If media is legal evidence, record its relevance in `1. Master Court System/Evidence Files` or `3. Legal Charges - AVO`.
- If media is personal/mental-health context, record its relevance in `2. Mental Health System/Notes`.
- Keep original media files in `Media`.
"@

$loadOrder = @"
# Load Order

Universal Project FireStorm load order:

1. `_system/Startup/00_MASTER_STARTUP.md`
2. `_system/Rules/load_order.md`
3. `_system/Rules/project_rules.md`
4. `_system/Rules/saving_rules.md`
5. `_system/Index/file_index.json`

Then detect task type.

## Court / Legal / AVO / Evidence

Load:
1. `_system/Startup/01_COURT_SYSTEM_STARTUP.md`
2. `0. Core Folder`
3. `3. Legal Charges - AVO`
4. `1. Master Court System`

## Mental Health / Vent / Personal / Profiles

Load:
1. `_system/Startup/02_MENTAL_HEALTH_SYSTEM_STARTUP.md`
2. `0. Core Folder`
3. `2. Mental Health System`

Only load `3. Legal Charges - AVO` if legal context is relevant.

## Media

Load:
1. `_system/Startup/03_MEDIA_STARTUP.md`
2. `Media`

## Archive Rule

Do not load or search `Archive` folders unless the user explicitly asks to include archived material.
"@

$projectRules = @"
# Project Rules

The Master Hive is organised like a private Google Drive.

## Top-level folders

`_system`
- Startup files, load rules, project rules, saving rules, index, and scripts.

`0. Core Folder`
- Shared truth used by all systems.
- Master logs, relationship timeline, shared notes, and reusable profiles.

`1. Master Court System`
- Court workflow, court documents, court days, evidence bundles, imports, and outputs.

`2. Mental Health System`
- Mental health workflow, vent entries, letters, sessions, personal notes, imports, and outputs.

`3. Legal Charges - AVO`
- Legal source material for charges, AVO, statements, incidents, bail, ICO, CCO, and active matters.

`Media`
- Original photos, videos, and audio.

## Core Rules

- Read before editing.
- Never overwrite a file without reading it first.
- Never delete files unless explicitly asked.
- Use waiting/sorting folders when unsure.
- Do not load Archive folders unless explicitly requested.
- Prefer `0. Core Folder` for shared facts that multiple projects need.
"@

$savingRules = @"
# Saving Rules

## If unsure

Save to the relevant waiting folder:

- Court unsure:
  `1. Master Court System/0. Waiting To Be Sorted - Approval Required`

- Mental-health unsure:
  `2. Mental Health System/0. Waiting To Be Sorted - Approval Required`

## Shared core material

- Master incident logs:
  `0. Core Folder/Master Logs`

- Relationship timeline:
  `0. Core Folder/Master Logs`

- Shared notes:
  `0. Core Folder/Shared Notes`

- Profiles:
  `0. Core Folder/Profiles`

## Court material

- Court drafts and outputs:
  `1. Master Court System/Court Documents`

- Evidence bundles:
  `1. Master Court System/Evidence Files`

- Statements:
  `1. Master Court System/Statements`

- Court-day specific material:
  `1. Master Court System/Court Days`

## Mental-health material

- Vent entries:
  `2. Mental Health System/Pure Vent Mode`

- Letters:
  `2. Mental Health System/Letters - Documents`

- Sessions:
  `2. Mental Health System/Sessions`

- Notes:
  `2. Mental Health System/Notes`

## Legal Charges / AVO material

- AVO documents:
  `3. Legal Charges - AVO/Current AVO`

- Incidents:
  `3. Legal Charges - AVO/Incidents`

- Legal statements:
  `3. Legal Charges - AVO/Statements`

- CCO material:
  `3. Legal Charges - AVO/Convicted - CCO`

- ICO material:
  `3. Legal Charges - AVO/Convicted - ICO`

- Active matters:
  `3. Legal Charges - AVO/Active Matters`

## Media

- Photos:
  `Media/Photos`

- Videos:
  `Media/Videos`

- Audio:
  `Media/Audio`
"@

$chatgptInstructions = @"
# ChatGPT / MCP Instructions

For Project FireStorm, use this root folder:

$Root

Before answering anything related to Project FireStorm:

1. Read `_system/Startup/00_MASTER_STARTUP.md`.
2. Read `_system/Rules/load_order.md`.
3. Read `_system/Rules/project_rules.md`.
4. Read `_system/Rules/saving_rules.md`.
5. Read `_system/Index/file_index.json` if available.
6. Detect the correct subsystem:
   - Court/legal/AVO/charges/evidence/statements/bail/ICO/CCO = Court + Legal Charges
   - Mental health/vent/profile/session/personal = Mental Health
   - Photos/videos/audio = Media
7. Load the relevant startup file:
   - `_system/Startup/01_COURT_SYSTEM_STARTUP.md`
   - `_system/Startup/02_MENTAL_HEALTH_SYSTEM_STARTUP.md`
   - `_system/Startup/03_MEDIA_STARTUP.md`

Rules:
- Use `0. Core Folder` as shared truth.
- Use project folders as working systems.
- Use `3. Legal Charges - AVO` as shared legal source material.
- Do not load archive folders unless explicitly asked.
- Never overwrite without reading first.
- Never delete unless explicitly asked.
"@

Write-FileIfMissing "$Root\_system\Startup\00_MASTER_STARTUP.md" $masterStartup
Write-FileIfMissing "$Root\_system\Startup\01_COURT_SYSTEM_STARTUP.md" $courtStartup
Write-FileIfMissing "$Root\_system\Startup\02_MENTAL_HEALTH_SYSTEM_STARTUP.md" $mentalStartup
Write-FileIfMissing "$Root\_system\Startup\03_MEDIA_STARTUP.md" $mediaStartup

Write-FileIfMissing "$Root\_system\Rules\load_order.md" $loadOrder
Write-FileIfMissing "$Root\_system\Rules\project_rules.md" $projectRules
Write-FileIfMissing "$Root\_system\Rules\saving_rules.md" $savingRules
Write-FileIfMissing "$Root\_system\chatgpt_mcp_instructions.md" $chatgptInstructions

Write-Step "Creating starter core files"

Write-FileIfMissing "$Root\0. Core Folder\Master Logs\Master_Incident_Log_v1.md" "# Master Incident Log v1`n`n"
Write-FileIfMissing "$Root\0. Core Folder\Master Logs\Master_Incident_Log_v2.md" "# Master Incident Log v2`n`n"
Write-FileIfMissing "$Root\0. Core Folder\Master Logs\Master_Incident_Log_v3.md" "# Master Incident Log v3`n`n"
Write-FileIfMissing "$Root\0. Core Folder\Master Logs\Master_Relationship_Timeline.md" "# Master Relationship Timeline`n`n"

Write-Step "Creating Python index rebuild script"

$rebuildIndex = @'
from pathlib import Path
from datetime import datetime, timezone
import json

ROOT = Path(r"__ROOT__")
OUTPUT = ROOT / "_system" / "Index" / "file_index.json"

INCLUDE_EXTENSIONS = {
    ".md", ".txt", ".json", ".csv",
    ".docx", ".xlsx", ".pdf",
    ".jpg", ".jpeg", ".png", ".webp",
    ".mp4", ".mov", ".m4a", ".mp3", ".wav"
}

EXCLUDED_DIR_NAMES = {"Archive", ".git", "__pycache__"}

def file_info(path: Path):
    stat = path.stat()
    return {
        "path": str(path.relative_to(ROOT)).replace("\\", "/"),
        "name": path.name,
        "extension": path.suffix.lower(),
        "size_bytes": stat.st_size,
        "modified_utc": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat()
    }

def should_skip(path: Path) -> bool:
    parts = set(path.parts)
    return any(excluded in parts for excluded in EXCLUDED_DIR_NAMES)

def main():
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

    index = {
        "project": "Project FireStorm - The Master Hive",
        "root": str(ROOT),
        "generated_utc": datetime.now(timezone.utc).isoformat(),
        "total_files": len(files),
        "latest_files": files[:100],
        "all_files": files
    }

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(index, indent=2), encoding="utf-8")

    print(f"Wrote {OUTPUT}")
    print(f"Indexed {len(files)} files")

if __name__ == "__main__":
    main()
'@

$rebuildIndex = $rebuildIndex.Replace("__ROOT__", $Root.Replace("\", "\\"))
$rebuildIndexPath = "$Root\_system\rebuild_index.py"
Write-FileIfMissing $rebuildIndexPath $rebuildIndex

Write-Step "Running first index rebuild if Python is available"

try {
    $pythonVersion = python --version 2>$null
    if ($LASTEXITCODE -eq 0) {
        python "$rebuildIndexPath"
    } else {
        Write-Host "Python not found. Skipping index rebuild."
    }
} catch {
    Write-Host "Python not found. Skipping index rebuild."
}

if ($CreateScheduledTask) {
    Write-Step "Creating scheduled task for index rebuild"

    $TaskName = "MasterHiveRebuildIndex"
    $Action = New-ScheduledTaskAction `
        -Execute "python.exe" `
        -Argument "`"$rebuildIndexPath`""

    $Trigger = New-ScheduledTaskTrigger `
        -Once `
        -At (Get-Date).AddMinutes(1) `
        -RepetitionInterval (New-TimeSpan -Minutes 10)

    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $Action `
        -Trigger $Trigger `
        -Description "Rebuilds Project FireStorm Master Hive file index every 10 minutes" `
        -Force | Out-Null

    Write-Host "Scheduled task created/updated: $TaskName"
}

Write-Step "Done"

Write-Host ""
Write-Host "Master Hive root:"
Write-Host $Root -ForegroundColor Green

Write-Host ""
Write-Host "MCP/ChatGPT should be pointed at:"
Write-Host $Root -ForegroundColor Green

Write-Host ""
Write-Host "Main instruction file:"
Write-Host "$Root\_system\chatgpt_mcp_instructions.md" -ForegroundColor Green

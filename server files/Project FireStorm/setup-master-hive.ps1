param(
    [string]$Root = "C:\Project FireStorm\The Master Hive",
    [switch]$CreateScheduledTask,
    [int]$IndexIntervalMinutes = 10,
    [switch]$OverwriteSystemFiles
)

$ErrorActionPreference = "Stop"

function Ensure-Directory {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Force -Path $Path | Out-Null
        Write-Host "[OK] Created: $Path" -ForegroundColor Green
    } else {
        Write-Host "[INFO] Exists: $Path" -ForegroundColor Cyan
    }
}

function Write-TextFile {
    param([string]$Path, [string]$Content, [switch]$Overwrite)
    if ((Test-Path -LiteralPath $Path) -and (-not $Overwrite)) {
        Write-Host "[WARN] Skipped existing file: $Path" -ForegroundColor Yellow
        return
    }
    Ensure-Directory (Split-Path -Parent $Path)
    Set-Content -LiteralPath $Path -Value $Content -Encoding UTF8
    Write-Host "[OK] Wrote: $Path" -ForegroundColor Green
}

Write-Host "[INFO] Master Hive root: $Root" -ForegroundColor Cyan

$Folders = @(
    "$Root\_system",
    "$Root\A) Global Core files",
    "$Root\A) Global Core files\[ADDON1] Master Profiles",
    "$Root\B) Global Master Charges - AVO",
    "$Root\B) Global Master Charges - AVO\Incidents",
    "$Root\B) Global Master Charges - AVO\Statements",
    "$Root\B) Global Master Charges - AVO\Current AVO",
    "$Root\B) Global Master Charges - AVO\Convicted- CCO",
    "$Root\B) Global Master Charges - AVO\Convicted - ICO",
    "$Root\B) Global Master Charges - AVO\Active_H 188213002_Sept-November",
    "$Root\1. Master Court System",
    "$Root\1. Master Court System\0. Document Output",
    "$Root\1. Master Court System\1. Plugin-Addon (Plug and Play)",
    "$Root\1. Master Court System\current",
    "$Root\1. Master Court System\cases",
    "$Root\1. Master Court System\evidence",
    "$Root\1. Master Court System\timelines",
    "$Root\1. Master Court System\people",
    "$Root\1. Master Court System\documents",
    "$Root\1. Master Court System\imports",
    "$Root\1. Master Court System\archive",
    "$Root\2. Mental Health System",
    "$Root\2. Mental Health System\0. Document Output",
    "$Root\2. Mental Health System\1. Plugin-Addon (Plug and Play)",
    "$Root\2. Mental Health System\2. Letters - Documents",
    "$Root\2. Mental Health System\3. Pure vent mode",
    "$Root\2. Mental Health System\3. Pure vent mode\July 2026",
    "$Root\2. Mental Health System\current",
    "$Root\2. Mental Health System\profiles",
    "$Root\2. Mental Health System\sessions",
    "$Root\2. Mental Health System\notes",
    "$Root\2. Mental Health System\imports",
    "$Root\2. Mental Health System\archive",
    "$Root\Media",
    "$Root\Media\Photos",
    "$Root\Media\Videos",
    "$Root\Media\Audio"
)

foreach ($Folder in $Folders) { Ensure-Directory $Folder }

$LoadOrder = @"
# Master Hive Load Order

Root:
$Root

The Master Hive is the source/root drive for Project FireStorm.

## Core load order

Before answering anything related to Project FireStorm:

1. Read root system files:
   - _system/project_rules.md
   - _system/file_index.json

2. Load shared Master Hive source folders first:
   - A) Global Core files
   - B) Global Master Charges - AVO

3. Detect the correct subsystem:
   - Court, legal, AVO, charges, evidence, statements, bail, ICO, CCO, timelines:
     use 1. Master Court System

   - Mental health, venting, profiles, letters, sessions, personal notes:
     use 2. Mental Health System

   - Photos, videos, audio:
     use Media

4. Load the relevant subsystem current files.

5. Search only the relevant subsystem unless the user asks for a full Master Hive search.

## Important A/B rule

A) Global Core files and B) Global Master Charges - AVO are shared Master Hive load-first folders.

They are used by both:
- 1. Master Court System
- 2. Mental Health System

Do not treat A/B references inside project maps as duplicates. They are shared Master Hive sources.

## Archive rule

Do not load archive folders unless explicitly asked.
"@

$ProjectRules = @"
# Master Hive Project Rules

The Master Hive is organised like a private Google Drive for Project FireStorm.

## Main folders

### A) Global Core files

Use this for shared identity, relationship, profile, incident, and timeline material that is useful across both Court and Mental Health workflows.

### B) Global Master Charges - AVO

Use this for shared legal/AVO/charges source material that is used by both Court and Mental Health workflows.

### 1. Master Court System

Use this for court-specific working files and outputs.

Save court outputs to:
1. Master Court System\0. Document Output

### 2. Mental Health System

Use this for mental health, personal, vent, session, letter, and profile work.

Save mental health outputs to:
2. Mental Health System\0. Document Output

Save pure vent entries to:
2. Mental Health System\3. Pure vent mode

### Media

Use this for:
- Media\Photos
- Media\Videos
- Media\Audio

## Saving rules

- Read before editing.
- Never overwrite a file without reading it first.
- Never delete files unless explicitly asked.
- Do not overwrite vent entries.
- New pure vent entries should be timestamped and placed into the correct month folder.
- Put shared global context in A) Global Core files.
- Put shared charges/AVO/legal source material in B) Global Master Charges - AVO.
- Put court-specific work in 1. Master Court System.
- Put mental-health-specific work in 2. Mental Health System.
- Put media in Media.

## Assistant/MCP safety rules

- Do not point MCP at all of C:\.
- Point MCP only at:
  $Root

- Do not load archive folders unless specifically requested.
- Do not scan huge image/video dump folders unless the task requires media evidence.
"@

$ChatGPTInstructions = @"
# ChatGPT / MCP Instructions for Project FireStorm

Use this root folder:

$Root

This is the Master Hive core drive.

Before answering anything related to Project FireStorm:

1. Read:
   _system/load_order.md
   _system/project_rules.md
   _system/file_index.json

2. Load shared Master Hive source folders first:
   A) Global Core files
   B) Global Master Charges - AVO

3. Detect the correct subsystem:
   - Court, legal, AVO, charges, evidence, statements, bail, ICO, CCO, timelines:
     use 1. Master Court System

   - Mental health, venting, profiles, letters, sessions, personal notes:
     use 2. Mental Health System

   - Photos, videos, audio:
     use Media

4. Load the relevant subsystem files only after checking shared A/B source folders.

5. Do not treat A/B folders inside project maps as duplicates. They are shared Master Hive sources.

6. Do not load archive folders unless explicitly asked.

Saving rules:
- Shared global identity/profile/timeline/incident material goes in:
  A) Global Core files

- Shared AVO/charges/legal source material goes in:
  B) Global Master Charges - AVO

- Court-specific outputs go in:
  1. Master Court System\0. Document Output

- Mental-health-specific outputs go in:
  2. Mental Health System\0. Document Output

- Pure vent entries go in:
  2. Mental Health System\3. Pure vent mode

- Media goes in:
  Media\Photos
  Media\Videos
  Media\Audio

- Never overwrite a file without reading it first.
- Never delete files unless explicitly asked.
"@

$CourtCurrentState = @"
# Court System Current State

## Active Matters

_To be filled in._

## Key People

_To be filled in._

## Important Evidence

_To be filled in._

## Open Tasks

_To be filled in._

## Last Updated

_To be filled in._
"@

$MentalCurrentState = @"
# Mental Health Current State

## Active Context

_To be filled in._

## Important Profiles

_To be filled in._

## Current Open Threads

_To be filled in._

## Last Updated

_To be filled in._
"@

Write-TextFile "$Root\_system\load_order.md" $LoadOrder -Overwrite:$OverwriteSystemFiles
Write-TextFile "$Root\_system\project_rules.md" $ProjectRules -Overwrite:$OverwriteSystemFiles
Write-TextFile "$Root\_system\chatgpt_mcp_instructions.md" $ChatGPTInstructions -Overwrite:$OverwriteSystemFiles

Write-TextFile "$Root\1. Master Court System\current\current_state.md" $CourtCurrentState -Overwrite:$OverwriteSystemFiles
Write-TextFile "$Root\1. Master Court System\current\active_summary.md" "# Court System Active Summary`n`n_To be filled in._" -Overwrite:$OverwriteSystemFiles

Write-TextFile "$Root\2. Mental Health System\current\current_state.md" $MentalCurrentState -Overwrite:$OverwriteSystemFiles
Write-TextFile "$Root\2. Mental Health System\current\active_summary.md" "# Mental Health Active Summary`n`n_To be filled in._" -Overwrite:$OverwriteSystemFiles
Write-TextFile "$Root\2. Mental Health System\current\active_profiles.md" "# Mental Health Active Profiles`n`n_To be filled in._" -Overwrite:$OverwriteSystemFiles

$PythonIndexScript = @'
from pathlib import Path
from datetime import datetime, timezone
import json
import os

ROOT = Path(os.environ.get("MASTER_HIVE_ROOT", r"__ROOT_PLACEHOLDER__")).resolve()
OUTPUT = ROOT / "_system" / "file_index.json"

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
    if normalized.startswith("A) Global Core files/"):
        return "global_core"
    if normalized.startswith("B) Global Master Charges - AVO/"):
        return "global_master_charges_avo"
    if normalized.startswith("1. Master Court System/"):
        return "court"
    if normalized.startswith("2. Mental Health System/"):
        return "mental_health"
    if normalized.startswith("Media/Photos/"):
        return "media_photos"
    if normalized.startswith("Media/Videos/"):
        return "media_videos"
    if normalized.startswith("Media/Audio/"):
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
            "A) Global Core files",
            "B) Global Master Charges - AVO"
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

$PythonIndexScript = $PythonIndexScript.Replace("__ROOT_PLACEHOLDER__", ($Root -replace "\\", "\\"))
Write-TextFile "$Root\_system\rebuild_index.py" $PythonIndexScript -Overwrite:$true

try {
    python --version | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "[INFO] Running initial index rebuild..." -ForegroundColor Cyan
        $env:MASTER_HIVE_ROOT = $Root
        python "$Root\_system\rebuild_index.py"
    }
} catch {
    Write-Host "[WARN] Python was not found in PATH. Run rebuild_index.py later after installing Python." -ForegroundColor Yellow
}

if ($CreateScheduledTask) {
    $ScriptPath = "$Root\_system\rebuild_index.py"
    $TaskName = "MasterHiveRebuildIndex"
    $Action = New-ScheduledTaskAction -Execute "python.exe" -Argument "`"$ScriptPath`""
    $Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $IndexIntervalMinutes)

    try {
        $ExistingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if ($ExistingTask) {
            Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        }
        Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Description "Rebuilds The Master Hive file index for ChatGPT/MCP" | Out-Null
        Write-Host "[OK] Scheduled task created: $TaskName every $IndexIntervalMinutes minutes" -ForegroundColor Green
    } catch {
        Write-Host "[WARN] Could not create Scheduled Task. Try running PowerShell as Administrator." -ForegroundColor Yellow
        Write-Host $_.Exception.Message
    }
}

Write-Host ""
Write-Host "[OK] Master Hive setup finished." -ForegroundColor Green
Write-Host "Recommended MCP root: $Root" -ForegroundColor Cyan
Write-Host "Do NOT expose all of C:\ to MCP/ChatGPT." -ForegroundColor Yellow

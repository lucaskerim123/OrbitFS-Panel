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

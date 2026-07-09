from pathlib import Path
from datetime import datetime, timezone
import json

ROOT = Path(r"C:\\Project FireStorm\\The Master Hive")
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

from pathlib import Path
import argparse

parser = argparse.ArgumentParser(description='Replace text across safe text/code files.')
parser.add_argument('--root', default='.', help='Root folder to scan')
parser.add_argument('--old', required=True, help='Old text to replace')
parser.add_argument('--new', required=True, help='New replacement text')
parser.add_argument('--dry-run', action='store_true', help='Show matches without writing changes')
args = parser.parse_args()

root = Path(args.root).resolve()
extensions = {
    '.py', '.md', '.txt', '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg',
    '.js', '.ts', '.tsx', '.jsx', '.html', '.css', '.ps1', '.bat', '.cmd'
}
skip_dirs = {'.git', 'node_modules', '__pycache__', '.venv', 'venv'}
changed = []

for path in root.rglob('*'):
    if any(part in skip_dirs for part in path.parts):
        continue
    if not path.is_file() or path.suffix.lower() not in extensions:
        continue
    try:
        text = path.read_text(encoding='utf-8')
    except Exception:
        continue
    if args.old not in text:
        continue
    changed.append(str(path.relative_to(root)))
    if not args.dry_run:
        path.write_text(text.replace(args.old, args.new), encoding='utf-8')

print('Matched files:' if args.dry_run else 'Updated files:')
print('\n'.join(changed) if changed else 'No matches found.')

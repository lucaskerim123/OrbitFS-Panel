# Project Rules

The Master Hive is organised like a private Google Drive.

## Top-level folders

_system
- Startup files, load rules, project rules, saving rules, commands, index, and scripts.

0. Core Folder
- Shared truth used by all systems.
- Master logs, relationship timeline, shared notes, and reusable profiles.

1. Master Court System
- Court workflow, court documents, court days, evidence bundles, imports, and outputs.

2. Mental Health System
- Mental health workflow, vent entries, letters, sessions, personal notes, imports, and outputs.

3. Legal Charges - AVO
- Legal source material for charges, AVO, statements, incidents, bail, ICO, CCO, and active matters.

Media
- Original photos, videos, and audio.

_sorter
- Inbox for anything uploaded via ChatGPT or Claude. Files sit here untouched until the user runs /sortfiles - see _system/Rules/commands.md.

🗑 Trash
- Soft-delete holding area.
- Files moved here are pending permanent deletion.
- `🗑 Trash` is emptied manually with /emptybin or automatically purged after 4 days by default.
- Admins can change the auto-purge retention in Master Brain.

## Core Rules

- Read before editing.
- Never overwrite a file without reading it first.
- Never delete files unless explicitly asked.
- Use waiting/sorting folders when unsure.
- Do not load Archive folders unless explicitly requested.
- Prefer 0. Core Folder for shared facts that multiple projects need.
- Never triage or move files out of _sorter automatically - only when the user runs /sortfiles.
- Never move a file out of _sorter or a waiting folder without presenting the proposed destination first and getting approval.
- Deleting from the panel should move files to `🗑 Trash` first; permanent deletion happens only through `/emptybin` or the auto-purge window.
- Root system folders must not be deleted or moved to trash.

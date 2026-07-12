# Project Rules

The Master Hive is organised like a private Google Drive.

## Top-level folders

_system
- Startup files, load rules, project rules, saving rules, commands, index, and scripts.

0. Core
- Shared truth used by all systems.
- Master logs, relationship timeline, shared notes, reusable profiles, AVO
  documents (Current AVO), and current orders (Active Orders - ICO, bail,
  CCO, and other active conditions). AVO/orders material is shared between
  the Legal and Wellbeing projects and lives here, not inside either project
  folder.

1. Legal
- Court and legal workflow: case management, court documents, evidence,
  statements, imports, and outputs. AVO documents and current orders
  (ICO/bail/CCO) are shared core material - see 0. Core above, not here.

2. Wellbeing
- Mental health workflow, vent entries, letters, sessions, personal notes, imports, and outputs.

_media
- Original photos, videos, and audio.

_sorter
- Inbox for anything uploaded via ChatGPT or Claude. Files sit here untouched until the user runs /sortfiles - see _system/Rules/commands.md.

_trash
- Soft-delete holding area.
- Files moved here are pending permanent deletion.
- `_trash` is emptied manually with /emptybin or automatically purged after 4 days by default.
- Admins can change the auto-purge retention in Master Brain.

## Core Rules

- Read before editing.
- Never overwrite a file without reading it first.
- Never delete files unless explicitly asked.
- Use waiting/sorting folders when unsure.
- Do not load Archive folders unless explicitly requested.
- Prefer 0. Core for shared facts that multiple projects need.
- Never triage or move files out of _sorter automatically - only when the user runs /sortfiles.
- Never move a file out of _sorter or a waiting folder without presenting the proposed destination first and getting approval.
- Deleting from the panel should move files to `_trash` first; permanent deletion happens only through `/emptybin` or the auto-purge window.
- Root system folders must not be deleted or moved to trash.

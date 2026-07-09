# Saving Rules

## If unsure

Save to the relevant waiting folder:

- Court unsure:
  1. Master Court System/0. Waiting To Be Sorted - Approval Required

- Mental-health unsure:
  2. Mental Health System/0. Waiting To Be Sorted - Approval Required

## Shared core material

- Master incident logs:
  0. Core Folder/Master Logs

- Relationship timeline:
  0. Core Folder/Master Logs

- Shared notes:
  0. Core Folder/Shared Notes

- Profiles:
  0. Core Folder/Profiles

## Court material

- Court drafts and outputs:
  1. Master Court System/Court Documents

- Evidence bundles:
  1. Master Court System/Evidence Files

- Statements:
  1. Master Court System/Statements

- Court-day specific material:
  1. Master Court System/Court Days

## Mental-health material

- Vent entries:
  2. Mental Health System/Pure Vent Mode

- Letters:
  2. Mental Health System/Letters - Documents

- Sessions:
  2. Mental Health System/Sessions

- Notes:
  2. Mental Health System/Notes

## Legal Charges / AVO material

- AVO documents:
  3. Legal Charges - AVO/Current AVO

- Incidents:
  3. Legal Charges - AVO/Incidents

- Legal statements:
  3. Legal Charges - AVO/Statements

- CCO material:
  3. Legal Charges - AVO/Convicted - CCO

- ICO material:
  3. Legal Charges - AVO/Convicted - ICO

- Active matters:
  3. Legal Charges - AVO/Active Matters

## Sorting workflow (_sorter)

Sorting is manual only. Do not scan or triage _sorter automatically - not at session start, not when new files appear, not on any schedule. Only act on _sorter when the user runs /sortfiles (see _system/Rules/commands.md).

When /sortfiles runs:
- List _sorter recursively.
- For each item, classify and propose a destination:
  - Court/legal/AVO-leaning: 1. Master Court System/0. Waiting To Be Sorted - Approval Required
  - Mental-health-leaning: 2. Mental Health System/0. Waiting To Be Sorted - Approval Required
  - Anything else: ask before guessing.
- From a waiting folder, propose a specific final destination (per the rules above) and move only after approval.
- Never move a file without presenting the proposed destination first.

## Media

- Photos:
  Media/Photos

- Videos:
  Media/Videos

- Audio:
  Media/Audio

## Trash / deletion workflow

- Panel delete actions should move files or folders into `🗑 Trash`, preserving their original relative path under a timestamped trash entry.
- `🗑 Trash` is a temporary holding area, not a working folder.
- `/emptybin` permanently deletes everything currently inside `🗑 Trash`.
- If `/emptybin` is not run, trash entries are automatically purged after 4 days by default.
- Admins can change the auto-purge retention in Master Brain.
- Protected top-level system folders must never be deleted or moved into trash.

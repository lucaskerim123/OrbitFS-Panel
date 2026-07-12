# Saving Rules

## If unsure

Save to the relevant waiting folder:

- Court unsure:
  1. Legal/0. Intake - Needs Review

- Mental-health unsure:
  2. Wellbeing/0. Waiting To Be Sorted - Approval Required

## Shared core material

- Master incident logs:
  0. Core/Master Logs

- Relationship timeline:
  0. Core/Master Logs

- Shared notes:
  0. Core/Shared Notes

- Profiles:
  0. Core/Profiles

- AVO documents:
  0. Core/Current AVO

- Current orders (ICO, bail, CCO, and other active conditions):
  0. Core/Active Orders

AVO and current-orders material is shared core material, not project-specific -
both the Court/Legal project and the Mental Health/Wellbeing project reference
it from here, so it must not be duplicated into 1. Legal or 2. Wellbeing.

## Court / legal material

Court and case-management material lives under 1. Legal (the separate Master
Court System and Legal Charges - AVO folders were consolidated into it). Use
its existing subfolders (Documents, Archive, Imports, Key Dates, Maintenance,
Reference Files, Written Records, 0. Intake - Needs Review) until a
finer-grained structure is recreated. AVO documents and current orders
(ICO/bail/CCO) go to 0. Core instead - see "Shared core material" above.

## Mental-health material

- Vent entries:
  2. Wellbeing/Pure Vent Mode

- Letters:
  2. Wellbeing/Letters - Documents

- Sessions:
  2. Wellbeing/Sessions

- Notes:
  2. Wellbeing/Notes

## Sorting workflow (_sorter)

Sorting is manual only. Do not scan or triage _sorter automatically - not at session start, not when new files appear, not on any schedule. Only act on _sorter when the user runs /sortfiles (see _system/Rules/commands.md).

When /sortfiles runs:
- List _sorter recursively.
- For each item, classify and propose a destination:
  - Court/legal/AVO-leaning: 1. Legal/0. Intake - Needs Review
  - Mental-health-leaning: 2. Wellbeing/0. Waiting To Be Sorted - Approval Required
  - Anything else: ask before guessing.
- From a waiting folder, propose a specific final destination (per the rules above) and move only after approval.
- Never move a file without presenting the proposed destination first.

## Media

- Photos:
  _media/Photos

- Videos:
  _media/Videos

- Audio:
  _media/Audio

## Trash / deletion workflow

- Panel delete actions should move files or folders into `_trash`, preserving their original relative path under a timestamped trash entry.
- `_trash` is a temporary holding area, not a working folder.
- `/emptybin` permanently deletes everything currently inside `_trash`.
- If `/emptybin` is not run, trash entries are automatically purged after 4 days by default.
- Admins can change the auto-purge retention in Master Brain.
- Protected top-level system folders must never be deleted or moved into trash.

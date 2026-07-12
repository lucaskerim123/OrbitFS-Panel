# Commands

## /sortfiles

Manually triggers the _sorter triage workflow. This is the ONLY way sorting happens - never run this automatically on session start, on new uploads, on a schedule, or for any other implicit reason.

When the user types /sortfiles (or clearly asks to "sort files" / "run sortfiles" / "sort the sorter folder"):

1. List _sorter recursively (list_files, recursive: true).
2. If empty, say so and stop.
3. For each file, read enough of it to classify it:
   - Court/legal/AVO-leaning -> proposed waiting folder: 1. Legal/0. Intake - Needs Review
   - Mental-health-leaning -> proposed waiting folder: 2. Wellbeing/0. Waiting To Be Sorted - Approval Required
   - Unclear -> ask the user rather than guessing.
4. Present the full proposed move list (file -> destination) in chat before moving anything.
5. Wait for explicit approval. Move only the files approved; leave the rest.
6. After a file lands in a waiting folder, a follow-up pass proposes its specific final destination per _system/Rules/saving_rules.md, again waiting for approval before that move.

Do not:
- Scan or move _sorter contents outside of this command.
- Move a file without showing its proposed destination first.
- Treat approval of one file as approval for the rest.

## /emptybin

Permanently deletes everything currently inside `_trash`.

This is the only command that should fully clear `_trash` on demand.

When the user types `/emptybin` (or clearly asks to "empty the bin" / "empty trash" / "clear _trash"):

1. Confirm they mean permanent deletion of everything currently inside `_trash`.
2. If they confirm, run the trash-empty action.
3. Report how many trash entries were deleted.

Do not:
- Empty `_trash` without explicit confirmation.
- Treat moving a file into `_trash` as permanent deletion.
- Delete `_trash` itself.

Automatic retention:
- Files and folders moved into `_trash` are automatically purged after 4 days by default if `/emptybin` is not run first.
- Admins may change the auto-purge retention in the Master Brain System tab.

## /startup

Loads the correct Project FireStorm startup context into the chat without making any file changes.

Command shape:

`/startup <project> <low|med|high>`

Examples:

- `/startup Master med`
- `/startup Court low`
- `/startup Mental high`
- `/startup Court:Mental med`
- `/startup Court:Media high`

Compatibility aliases:

- `light` = `low`
- `normal` = `med`
- `full` = `high`

If the user omits load strength, use `med`.

Projects:

- `Master`
- `Court`
- `Mental`
- `Media`

Projects may be combined with `:`. For combined commands, always load `Master` first, then the requested projects in the order given.

Startup files:

- `Master` -> `_system/Startup/00_MASTER_STARTUP.md`
- `Court` -> `_system/Startup/01_COURT_SYSTEM_STARTUP.md`
- `Mental` -> `_system/Startup/02_MENTAL_HEALTH_SYSTEM_STARTUP.md`
- `Media` -> `_system/Startup/03_MEDIA_STARTUP.md`

Core 4 context for `/startup`:

1. `_system/Startup/00_MASTER_STARTUP.md`
2. each requested project startup file
3. `_system/Rules/load_order.md`
4. `_system/Rules/project_rules.md`

Load strengths:

### low

Use for quick context.

1. Read `_system/Startup/00_MASTER_STARTUP.md`.
2. Read each requested project startup file.
3. Do not scan folders.
4. Do not load extra rule files unless a startup file explicitly requires them.
5. Reply with the startup confirmation for each requested project.

### med

Default mode.

1. Read `_system/Startup/00_MASTER_STARTUP.md`.
2. Read each requested project startup file.
3. Read `_system/Rules/load_order.md`.
4. Read `_system/Rules/project_rules.md`.
5. List only relevant top-level folders for the requested projects.
6. Do not read evidence, notes, statements, letters, archives, or private user content unless the user names a specific target.
7. Reply with:
   - startup confirmation
   - active rules
   - top-level folders now in scope

### high

Use for deep session setup.

1. Read `_system/Startup/00_MASTER_STARTUP.md`.
2. Read each requested project startup file.
3. Read `_system/Rules/load_order.md`.
4. Read `_system/Rules/project_rules.md`.
5. Read `_system/Rules/saving_rules.md`.
6. List relevant top-level and second-level folders.
7. Do not read Archive folders unless explicitly requested.
8. Do not read broad private/user content unless needed for a concrete task.
9. Reply with:
   - startup confirmation
   - active rules
   - structure summary
   - recommended next files or folders if more context is needed

Project folder scope:

- `Master` -> `_system`, `0. Core`
- `Court` -> `1. Legal`
- `Mental` -> `2. Wellbeing`
- `Media` -> `_media`

Never auto-load:

- any `Archive` folder
- private/user content at depth unless the user asks for a concrete task

Safety:

- `/startup` is read-only
- `/startup` must not write, move, delete, upload, rename, or create folders
- `/startup` must not triage or move `_sorter`
- if the command is ambiguous, default to `/startup Master med` and ask which project the user wants

Protected root folders:

- `_system`
- `_sorter`
- `_trash`
- `0. Core`
- `1. Legal`
- `2. Wellbeing`
- `_media`

These top-level folders are system roots and must not be deleted or moved into trash.

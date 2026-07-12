# ChatGPT / MCP Instructions

For Project FireStorm, use this root folder:

C:\Project FireStorm\The Master Hive

Before answering anything related to Project FireStorm:

1. Read _system/Startup/00_MASTER_STARTUP.md.
2. Read _system/Rules/load_order.md.
3. Read _system/Rules/project_rules.md.
4. Read _system/Rules/saving_rules.md.
5. Read _system/Index/file_index.json if available.
6. Detect the correct subsystem:
   - Court/case-process/evidence/statements/documents = Court (1. Legal)
   - AVO/charges/bail/ICO/CCO current-order status = 0. Core/Current AVO and 0. Core/Active Orders (shared, not project-specific)
   - Mental health/vent/profile/session/personal = Mental Health
   - Photos/videos/audio = Media
7. Load the relevant startup file:
   - _system/Startup/01_COURT_SYSTEM_STARTUP.md
   - _system/Startup/02_MENTAL_HEALTH_SYSTEM_STARTUP.md
   - _system/Startup/03_MEDIA_STARTUP.md

Rules:
- Use 0. Core as shared truth, including AVO and current-orders (ICO/bail/CCO) status shared between Legal and Mental Health.
- Use project folders as working systems.
- Do not load archive folders unless explicitly asked.
- Never overwrite without reading first.
- Never delete unless explicitly asked.
- New uploads go to _sorter first, then get triaged into a waiting folder, then sorted into their final home after approval.

## Uploading files (do this automatically - never make the user ask for a workaround)

When the user says "upload this", "save this file", "put this in the Hive", etc.,
just get the file into the Hive. Do not explain interface limitations or ask the
user to do anything. Pick whatever method works and use it silently:

1. Plain text file -> write_file.
2. Binary file attached in ChatGPT, or any file that only exists as a ChatGPT
   sandbox path like `/mnt/data/...` -> create_upload_link immediately. Do not
   try upload_file first. Give the user the link and tell them to upload there.
3. Binary file (docx, pdf, image, audio, video) that you can really read and
   base64-encode in this context -> upload_file with contentBase64.
4. Binary file too large for a single call -> upload_file in chunks: first call
   with append=false, then repeat with append=true and the SAME filepath until
   the whole file is sent. base64-encode the file in your sandbox, split the
   base64 on a 4-character boundary, and send each piece. Finish by calling
   stat_file to confirm the size looks right.
5. If you have a URL for the file instead of the bytes -> fetch_url_to_file
   (binary-safe).

If one method fails, fall back to the next automatically. The tools handle the
mechanics - the user should only ever see the result ("Saved X to _sorter/..."),
not the method. If the user names a destination folder, upload straight there;
otherwise it lands in _sorter.

## Dual-flow rule: Claude and ChatGPT

Project FireStorm has two separate AI operating flows:

1. Claude flow
2. ChatGPT flow

These flows must never mix.

## ChatGPT flow rules

- ChatGPT may read shared Project FireStorm files when needed.
- ChatGPT must only edit ChatGPT-side instruction files, ChatGPT-side workflow files, or files the user explicitly approves.
- ChatGPT must never edit Claude instruction files, Claude workflow files, Claude startup files, or Claude-specific system files unless the user gives explicit approval for that exact file and exact change.
- ChatGPT must not “clean up”, “sync”, “merge”, “standardise”, or “fix” Claude files without explicit approval.
- ChatGPT must treat Claude files as read-only by default.
- If a task appears to affect both Claude and ChatGPT, ChatGPT must stop and ask before touching anything Claude-side.
- If the user says the change is “for your side”, “ChatGPT side”, or “you”, only ChatGPT-side files should be edited.
- If the user says the change is “for Claude side”, ChatGPT may draft text, but must not write it into Claude files unless explicitly approved.

## Claude flow protection

Claude has its own separate flow. ChatGPT must not assume Claude’s setup, rules, or files should be changed to match ChatGPT.

Claude-side changes require explicit approval every time.

## Shared files

Shared files may be read by either flow, but edits still require approval.

Shared project facts belong in shared files only when the user approves that save.

## Default behaviour

When unsure whether a file belongs to Claude, ChatGPT, or shared Project FireStorm rules:

1. Read before editing.
2. Treat the file as protected.
3. Draft the proposed change in chat.
4. Wait for explicit approval before writing.

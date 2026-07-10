# The Master Brain

Mobile-first admin panel for the Master Hive file server.

It is the operator UI for the shared Hive server and covers:

- File browsing, upload, download, move, rename, and sort operations
- A full-featured file viewer/editor:
  - Code and text files: syntax-highlighted CodeMirror editor with an
    Edit/Read toggle (Read mode is the same highlighted buffer, locked),
    Find & Replace, adjustable font family/size, and an unsaved-changes
    guard before you can navigate away or close the tab
  - Markdown: same Edit/Read toggle, Read mode renders sanitized HTML
  - PDF: in-app viewer with page thumbnails, page nav, and zoom (not the
    bare browser iframe)
  - DOCX: rendered with formatting via `mammoth.js`
  - XLSX/CSV: read-only table, with sheet tabs for multi-sheet workbooks
  - ZIP: browse contents (name/size, nested) without downloading first
  - All of the above are view-only where the format can't be safely
    edited in-browser (PDF, DOCX) — download, edit locally, re-upload
- Per-file admin permission overrides (🔒 on a file row hides it from
  non-admin users)
- System tab: infrastructure telemetry (Hive/tunnel/panel/sorter health,
  disk usage, ChatGPT↔Claude connection flows), power controls for each
  service, and admin management (users, file permissions, trash, connected
  MCP clients)
- The Sorter — a separate optional addon (`hive-addon-sorter`) that
  previews AI-free, rule-based destination suggestions for files dropped in
  `_sorter`, and only moves them once you approve and confirm. Opens from
  the Files tab's Sort button; has its own "← Back to Master Brain" link
- Home button (the "Master Brain" title) jumps back to the Files tab root
  from anywhere; re-clicking the active Files tab does the same

## What it talks to

- `mcp-hive-server` over REST (`/api/*`)
- The same server's MCP endpoint for Claude and ChatGPT clients
- The shared FireStorm file root at `C:\Project FireStorm\The Master Hive`
- `hive-addon-sorter` (optional, its own service) for the Sort feature

## Setup on a new machine

New machine, nothing installed yet? Run `deploy/Install-BaseStructure.ps1`
- it creates the shared Hive file folders, generates `.env` for this repo
and for `mcp-hive-server`, and runs `npm install` for both. Full
walkthrough in [GETTING_STARTED.md](GETTING_STARTED.md).

Short version, once both repos are cloned:

1. Install Node.js.
2. Clone this repo (and `mcp-hive-server`, as a sibling folder).
3. Run `npm install`.
4. Copy `.env.example` to `.env`.
5. Set `HIVE_URL` to the Hive server, usually `http://localhost:3939`.
6. Set `HIVE_API_KEY` to the same value used by the Hive server.
7. Create the first user with `node scripts/add-user.mjs <username> <pin>`.
8. Start the panel with `npm start`.

## Roles

- `admin` - sees System, users, permissions, and trash controls
- `user` - sees Files only

## Trash workflow

- Panel deletes move items into `_trash`
- `_trash` can be emptied from the admin System tab
- Trash retention is configurable in the System tab
- Protected root folders cannot be deleted or moved to trash

## Windows service / reverse proxy

The `deploy/Setup-IIS.ps1` script can install and wire the panel as a service behind IIS.
The System tab can also restart the panel, Hive server, and tunnel on Windows.

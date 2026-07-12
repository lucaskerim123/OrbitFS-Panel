# The OrbitFS

Mobile-first admin panel for the Master Hive file server.

It is the operator UI for the shared Hive server and covers:

- File browsing, upload, download, move, rename, and sort operations
  - Move/rename uses a visual folder browser with breadcrumbs and folder filtering; no destination path typing required
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
- Granular per-file and per-folder user permissions for view/read, write,
  download, move/rename, delete/trash, and create/upload. Folder rules inherit
  downward, specific file/subfolder rules override them, and Admin always has
  every action.
- System tab: infrastructure telemetry (Hive/tunnel/panel/sorter health,
  disk usage, ChatGPT↔Claude connection flows), power controls for each
  service, and admin management (users, file permissions, trash, connected
  MCP clients)
- OrbitFS Sorter — a separate optional addon (`orbitfs-panel/plugins/OrbitFS Sorter`) that
  previews AI-free, rule-based destination suggestions for files dropped in
  `_sorter`, and only moves them once you approve and confirm. Opens from
  the Files tab's Sort button; has its own "← Back to OrbitFS" link
- Home button (the "OrbitFS" title) jumps back to the Files tab root
  from anywhere; re-clicking the active Files tab does the same

## What it talks to

- `orbitfs-mcp` over REST (`/api/*`)
- The same server's MCP endpoint for Claude and ChatGPT clients
- The shared FireStorm file root, wherever you chose to put it
- The sorter (optional, its own service) for the Sort feature

## Setup on a new machine

New machine, nothing installed yet? Run `deploy/Install-OrbitFS.ps1`
- it asks where you want the code and the data folder (or takes
`-CodeDir`/`-HiveDataRoot` params), clones `orbitfs-mcp` for you, creates
the shared file folders, generates `.env` for both repos, and runs
`npm install` for both. Full walkthrough in
[GETTING_STARTED.md](GETTING_STARTED.md).

Short version:

1. Install Node.js and Git.
2. Clone this repo.
3. Run `cd deploy; .\Install-OrbitFS.ps1` and answer the two location
   prompts (or pass `-CodeDir`/`-HiveDataRoot`).
4. Set `PUBLIC_BASE_URL` in the generated `orbitfs-mcp\.env`.
5. Create the first user with `node scripts/add-user.mjs <username> <pin>`.
8. Start the panel with `npm start`.

## Cloud deploy

Render and Railway deployment material lives in `cloud-deploy/`:

- `cloud-deploy/README.md`
- `cloud-deploy/render.yaml.example`
- `cloud-deploy/railway.json.example`

## Roles

- `admin` - sees System, users, permissions, and trash controls
- `user` - sees Files only

## Trash workflow

- Panel deletes move items into `_trash`
- `_trash` can be emptied from the admin System tab
- Trash retention is configurable in the System tab
- Protected root folders cannot be deleted or moved to trash

## Windows service / reverse proxy

The `deploy/Setup-Services.ps1` script installs the panel, MCP server, sorter,
and Cloudflare tunnel as Windows services (NSSM), and wires the panel behind
an IIS reverse proxy - see [GETTING_STARTED.md](GETTING_STARTED.md).
The System tab can also restart the panel, MCP server, and tunnel on Windows.

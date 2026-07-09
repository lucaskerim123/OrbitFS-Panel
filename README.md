# The Master Brain

Mobile-first admin panel for the Master Hive file server.

It is the operator UI for the shared Hive server and covers:

- File browsing, editing, upload, download, move, rename, and sort operations
- System status for the Hive server, Cloudflare tunnel, and this panel
- Admin-only controls for users, permissions, trash retention, and emptying `🗑 Trash`

## What it talks to

- `mcp-hive-server` over REST (`/api/*`)
- The same server's MCP endpoint for Claude and ChatGPT clients
- The shared FireStorm file root at `C:\Project FireStorm\The Master Hive`

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

- Panel deletes move items into `🗑 Trash`
- `🗑 Trash` can be emptied from the admin System tab
- Trash retention is configurable in the System tab
- Protected root folders cannot be deleted or moved to trash

## Windows service / reverse proxy

The `deploy/Setup-IIS.ps1` script can install and wire the panel as a service behind IIS.
The System tab can also restart the panel, Hive server, and tunnel on Windows.

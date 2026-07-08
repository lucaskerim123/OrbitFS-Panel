# The Master Brain

Mobile-first admin panel for the Master Hive file server. Two things, so
there's no reason to RDP into the VPS for routine work:

- **Files** — browse, open/edit text files in-place, upload, download, move
  or rename, create folders, delete, and **Sort** — drop files/folders into
  `_sorter` and hit the Sort button to have the Hive server ask Claude to
  file each one into its real home elsewhere in the store.
- **System** — see whether the Hive server, the Cloudflare tunnel, and this
  panel itself are up, restart any of them, tail their logs, check disk
  space, and see which MCP clients (Claude, ChatGPT) are currently
  registered against the Hive.

It talks to one `mcp-hive-server` instance over its REST API (`/api/*`,
alongside the MCP endpoint that Claude/ChatGPT use) — normally the same VPS
this panel runs on, reached over `localhost`.

## Setup on the VPS

1. Have `mcp-hive-server` already running on this VPS (its own `HIVE_ROOT`,
   port, `HIVE_API_KEY`, etc. — see that repo's own setup). For the Sort
   button to work, that server also needs `ANTHROPIC_API_KEY` set in its
   `.env` — Sort is powered by that server's own model call, not this panel.
2. Clone this repo and install dependencies:
   ```
   git clone <this repo>
   cd the-master-brain
   npm install
   cp .env.example .env
   ```
3. Edit `.env`:
   - `HIVE_URL` — usually `http://localhost:3939`.
   - `HIVE_API_KEY` — same value as `HIVE_API_KEY` in the Hive server's own
     `.env`.
4. Create at least one login account (username + PIN):
   ```
   node scripts/add-user.mjs lucas 482917
   ```
   Add one line per person who needs access; re-running with an existing
   username replaces their PIN.
5. Start it: `npm start` (listens on `PANEL_PORT`, default `4000`).

## Login and roles

Each user logs in with a username + PIN (not a shared key). PINs are hashed
(scrypt) in `users.json` — never stored in plain text — and a login issues a
12-hour session token. Five wrong PIN attempts for a username lock it out for
15 minutes.

Every account has a role, `admin` or `user`. Admins see a "System" tab
covering service status/restarts, logs, connected MCP clients, and user
management. Regular users only see the Files tab. There's always at least one
admin — the panel refuses to delete or demote the last one.

Bootstrap the first account from the shell:
```
node scripts/add-user.mjs lucas 482917
```
(the very first account created this way defaults to `admin`; pass a role
explicitly to override, e.g. `node scripts/add-user.mjs guest 111222 user`).
After that, admins can add, update, or remove accounts from the System tab's
Users card — no shell access needed.

## Quick deploy on IIS (Windows VPS)

After steps 1-4 above, `deploy/Setup-IIS.ps1` automates the rest — installing
the panel as a background Windows service and putting it behind IIS as a
reverse proxy:

```powershell
# In an elevated PowerShell (Run as Administrator) on the VPS, after
# cloning the repo and completing steps 1-4 above:
cd C:\path\to\the-master-brain
.\deploy\Setup-IIS.ps1 -AppDir C:\path\to\the-master-brain
```

What it does:
- Installs [NSSM](https://nssm.cc/) if missing and registers the panel as a
  `MasterBrainPanel` Windows service (auto-starts on boot, restarts on
  failure, logs to `service-out.log` / `service-err.log` in the repo — also
  viewable from the panel's System tab).
- Downloads + silently installs the IIS **URL Rewrite** and **Application
  Request Routing (ARR)** modules if they aren't already present.
- Enables ARR's reverse-proxy feature and creates an IIS site that forwards
  all traffic to the panel's local port.

It's safe to re-run (e.g. after `git pull && npm install`) — it only
restarts the service and refreshes the IIS config, it won't duplicate
anything. Run `Get-Help .\deploy\Setup-IIS.ps1 -Full` for all parameters.

If you're already reaching the Hive server through a Cloudflare Tunnel
"published application", the simplest way to expose this panel publicly is
the same way: add another published application on the same tunnel pointing
at `localhost:4000` (or `:8080` for the IIS reverse-proxy site). Cloudflare
terminates HTTPS at the edge, so no separate certificate is needed. Otherwise,
bind HTTPS directly in IIS Manager (Sites → your site → Bindings → Add
`https`) with a certificate — [win-acme](https://www.win-acme.com/) is the
easiest way to get a free auto-renewing Let's Encrypt cert on IIS. This
matters either way: login PINs and session tokens travel over this
connection.

The sections below cover the same setup by hand, and other hosting options
(systemd on Linux, or a manual nginx/IIS reverse proxy), if you'd rather not
run the script or aren't on Windows.

## Running as a service (systemd)

```ini
# /etc/systemd/system/master-brain.service
[Unit]
Description=The Master Brain panel
After=network.target

[Service]
WorkingDirectory=/opt/the-master-brain
ExecStart=/usr/bin/node server.js
Restart=on-failure
EnvironmentFile=/opt/the-master-brain/.env
User=master-brain

[Install]
WantedBy=multi-user.target
```

```
sudo systemctl daemon-reload
sudo systemctl enable --now master-brain
```

Note: the System tab's restart/status/log-tailing features are Windows-only
(they shell out to PowerShell) - on Linux, use `systemctl`/journalctl
directly for those; file management still works everywhere.

## Reverse proxy (nginx)

```nginx
server {
    listen 443 ssl;
    server_name brain.your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

Put this behind HTTPS (e.g. certbot) since login PINs and session tokens are
sent from the browser.

## Running on IIS (Windows Server), by hand

`deploy/Setup-IIS.ps1` (see "Quick deploy on IIS" above) automates
everything below — this section is the manual walkthrough of what it does,
useful if you want to understand or customize the setup.

Node/Express doesn't run inside IIS's worker process natively. The
straightforward way to put this behind IIS is a reverse proxy — run the
Node app as its own background process on the VPS, and have IIS forward
requests to it (the same shape as the nginx setup above):

1. Run the panel as a persistent Windows process. The simplest option is
   [NSSM](https://nssm.cc/) (Non-Sucking Service Manager):
   ```
   nssm install MasterBrainPanel "C:\Program Files\nodejs\node.exe" "C:\the-master-brain\server.js"
   nssm set MasterBrainPanel AppDirectory "C:\the-master-brain"
   nssm start MasterBrainPanel
   ```
   (dotenv reads `.env` from `AppDirectory`, same as running `npm start`
   manually.) `pm2` with `pm2-windows-startup` is an equally fine alternative.
2. Install the **URL Rewrite** and **Application Request Routing (ARR)**
   modules for IIS (both free Microsoft downloads).
3. In IIS Manager, select the server node → Application Request Routing
   Cache → Server Proxy Settings → check "Enable proxy".
4. On the site you want to serve the panel from, add a URL Rewrite rule:
   - Match: pattern `(.*)`
   - Action: rewrite to `http://localhost:4000/{R:1}`
5. Bind that site to HTTPS with a certificate (IIS Manager → Bindings), since
   login PINs and session tokens travel over this connection.

An alternative is [`iisnode`](https://github.com/Azure/iisnode), which hosts
Node apps directly inside IIS's own worker process instead of proxying to a
separate one. It avoids running a second process, but it's much less
actively maintained and has its own quirks around static file serving and
process recycling — the reverse-proxy approach above is simpler and easier
to reason about, so it's the one recommended here.

## Notes

- Files are considered text-editable in the panel based on extension (`.md`,
  `.txt`, `.json`, `.js`, `.py`, `.yml`, `.html`, `.css`, `.csv`, `.log`,
  etc.) — anything else opens a preview with a Download button instead of
  trying to load raw bytes into a text editor.
- The System tab's "Restart panel" button really does restart the Windows
  service serving your request — the response comes back first, then the
  restart happens about a second later. Expect a brief disconnect.
- Claude's/ChatGPT's MCP connection to the Hive server is completely
  separate from this panel and unaffected by anything here.

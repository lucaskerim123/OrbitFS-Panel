# The Master Brain

Web panel for browsing and syncing the two Master Hive nodes:

- **PC node** — the `mcp-hive-server` instance running on your Windows PC, reached over its Cloudflare tunnel.
- **VPS node** — a second `mcp-hive-server` instance running on this VPS, always online.

The panel lets you browse/edit files on either node, and keeps the two in sync
(two-way, last-write-wins by modified time, with deletion propagation), with a
manual "Sync now" button, a configurable auto-sync interval, and a sync
history log.

## Setup on the VPS

1. Deploy a second `mcp-hive-server` instance on this same VPS (its own
   `HIVE_ROOT`, its own port, e.g. `3939`, `HIVE_API_KEY`, etc. — see that
   repo's own setup). It does not need a Cloudflare tunnel if the panel talks
   to it over `localhost`.
2. Clone this repo and install dependencies:
   ```
   git clone <this repo>
   cd the-master-brain
   npm install
   cp .env.example .env
   cp config.example.json config.json
   ```
3. Edit `.env`:
   - `PANEL_API_KEY` — pick a new secret; this is what you'll type into the
     panel's login screen.
   - `NODE_PC_URL` / `NODE_PC_API_KEY` — your PC's public tunnel URL and its
     `HIVE_API_KEY`.
   - `NODE_VPS_URL` / `NODE_VPS_API_KEY` — usually `http://localhost:3939`
     and the VPS Hive instance's `HIVE_API_KEY`.
4. Adjust `config.json` if you want a different sync direction, interval, or
   include/exclude patterns (also editable later from the panel's Sync tab).
5. Start it: `npm start` (listens on `PANEL_PORT`, default `4000`).

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

Put this behind HTTPS (e.g. certbot) since the panel's own `PANEL_API_KEY` is
sent as a bearer token from the browser.

## Notes

- `config.json`, `sync-state.json`, and `sync-history.jsonl` are runtime state
  (gitignored) — `sync-state.json` is what makes deletion propagation work,
  don't delete it unless you want the next sync to treat everything as new.
- ChatGPT's existing MCP connection to the Hive server(s) is untouched by this
  panel — point it at whichever node(s) you want it to use.

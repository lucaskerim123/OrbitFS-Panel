# Getting Started (plain-language walkthrough)

This is the no-assumptions guide to getting the Hive server and the webpanel
running on a brand new Windows machine (a fresh VPS, a new PC, whatever).
If you already know what you're doing, the short version is in each repo's
README. This version spells out every step.

There are always **two repos** involved:

- `mcp-hive-server` - the actual server. Talks to Claude/ChatGPT (MCP) and
  stores/serves your files. Nothing works without this running.
- `the-master-brain` - this repo. A phone/browser-friendly control panel
  that talks to the Hive server over the network. Optional, but it's how
  you browse files and restart things without RDP-ing into the box.

They're independent processes. The Hive server can run with no panel at
all. The panel is useless without a Hive server to talk to.

## 0. Before you start

You need:

- A Windows machine (Windows 10/11 or Windows Server) with admin access.
- [Node.js](https://nodejs.org/) 18 or newer installed. Check with:
  ```powershell
  node --version
  ```
  If that errors, install Node first and come back.
- [Git](https://git-scm.com/) installed, or some way to get both repos
  onto the machine (a zip download works too).

## 1. Get both repos onto the machine

Pick a parent folder and clone both repos as **siblings** (this matters -
the install script in step 3 looks for `mcp-hive-server` next to
`the-master-brain` by default):

```powershell
cd C:\
git clone <mcp-hive-server-repo-url> mcp-hive-server
git clone <the-master-brain-repo-url> the-master-brain
```

If you can't put them side by side, that's fine too - you'll just pass
explicit paths to the install script in the next step.

## 2. Run the base-structure install script

This is the one script that sets everything up: it creates the shared file
folders the Hive server expects, generates `.env` files for both repos
with a fresh API key, and runs `npm install` in both.

```powershell
cd C:\the-master-brain\deploy
.\Install-BaseStructure.ps1
```

If your repos aren't siblings, tell it where they are:

```powershell
.\Install-BaseStructure.ps1 -HiveServerDir "D:\apps\mcp-hive-server" -PanelDir "D:\apps\the-master-brain"
```

It's safe to run more than once - it never overwrites a `.env` file or
folder that already exists, it only fills in what's missing.

When it finishes, it prints exactly what to do next. The short version is
steps 3-6 below.

## 3. Fill in the two things the script can't guess

Open `C:\mcp-hive-server\.env` in a text editor and set:

- `PUBLIC_BASE_URL` - the URL this server will be reachable at from the
  internet (your Cloudflare tunnel domain, or `http://localhost:3939` if
  you're only testing locally and don't need Claude/ChatGPT to reach it
  yet).

Everything else was already filled in for you (a random `HIVE_API_KEY` and
`SESSION_SECRET`, and `HIVE_ROOT` pointing at the folder skeleton the
script just created).

If you want Claude/ChatGPT to connect via Cloudflare Access OAuth (instead
of the simpler bearer-key fallback), also fill in `CF_AUTHORIZE_URL`,
`CF_TOKEN_URL`, `CF_CLIENT_ID`, `CF_CLIENT_SECRET` from your Cloudflare
Access application. If you don't know what that means yet, skip it - the
bearer key works fine on its own.

## 4. Create your first panel login

```powershell
cd C:\the-master-brain
node scripts/add-user.mjs myusername 1234
```

The username and PIN are yours to pick (PIN is 4-10 digits). The very
first user created becomes an `admin` automatically.

## 5. Start both servers

Two separate terminal windows, one per server:

```powershell
# Terminal 1
cd C:\mcp-hive-server
npm start
```

```powershell
# Terminal 2
cd C:\the-master-brain
npm start
```

## 6. Check it's alive

- Hive server: open `http://localhost:3939/api/ping` - should return `ok`.
- Panel: open `http://localhost:4000` in a browser, log in with the
  username/PIN from step 4.

If both of those work, the base install is done. Everything past this
point is about making it reachable from the internet and keeping it
running unattended - useful for a real deployment, skip it if you're just
testing locally.

## 7. (Optional) Make it reachable from the internet

You need a way to expose `localhost:3939` to the outside world so Claude
and ChatGPT can reach `/mcp`. This setup uses a
[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/):

1. Install `cloudflared` on the machine.
2. Create a tunnel and point a DNS record at it, following Cloudflare's
   own tunnel setup docs.
3. Set `PUBLIC_BASE_URL` in `mcp-hive-server\.env` to that domain.

## 8. (Optional) Run both as Windows services

Running `npm start` in a terminal window dies when you close the window or
log out. For a real deployment, run both as services so they survive
reboots and stay up unattended.

`the-master-brain\deploy\Setup-Hive-Services.ps1` uses
[NSSM](https://nssm.cc/) to install the Hive server and the Cloudflare
tunnel as Windows services. Read the script's parameters first (paths to
`nssm.exe`, `cloudflared.exe`, your tunnel name) - the defaults match the
original VPS layout, not necessarily yours:

```powershell
cd C:\the-master-brain\deploy
.\Setup-Hive-Services.ps1
```

For the panel itself, install it as a service the same way with NSSM
(point it at `node.exe` with `server.js` in `the-master-brain`), or use
`deploy\Setup-IIS.ps1` to put it behind IIS as a reverse proxy.

## 9. (Optional) The "hard stop" button

The panel's System tab has a guarded button that shuts down the entire
machine (`Stop-Computer -Force`). It's off by default. To enable it:

1. Create a PowerShell script that does the shutdown, e.g.:
   ```powershell
   Stop-Computer -ComputerName localhost -Force
   ```
2. Set `PANEL_HARDSTOP_SCRIPT_PATH` in `the-master-brain\.env` to that
   script's path.
3. Set `PANEL_HARDSTOP_PASSWORD` in `the-master-brain\.env` to a real
   password.

Leave both blank if you don't want this feature - the button will just
refuse to run.

## Troubleshooting

- **`node` not recognized** - Node.js isn't installed or isn't on PATH.
  Reinstall from nodejs.org and open a new terminal.
- **Hive server won't start / crashes immediately** - check
  `mcp-hive-server\.env` has `HIVE_ROOT`, `HIVE_API_KEY`, `PORT`,
  `PUBLIC_BASE_URL`, and `SESSION_SECRET` all set. Check
  `mcp-hive-server\err.log` for the actual error.
- **Panel loads but can't reach the Hive server** - check `HIVE_URL` and
  `HIVE_API_KEY` in `the-master-brain\.env` match the Hive server's own
  `PORT` and `HIVE_API_KEY`.
- **"Path is required" or file errors from the Hive server** - the
  `HIVE_ROOT` folder or one of its subfolders is missing. Re-run
  `deploy\Install-BaseStructure.ps1` - it's safe to run again and will
  fill in anything missing.
- **Claude/ChatGPT can't connect** - confirm `PUBLIC_BASE_URL` is set and
  actually reachable from the internet (tunnel/DNS working), and that
  you're using the right auth method (bearer key vs Cloudflare Access
  OAuth) on the client side.

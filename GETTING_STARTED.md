# Getting Started (plain-language walkthrough)

This is the no-assumptions guide to getting OrbitFS running on a brand new
Windows machine (a fresh VPS, a new PC, whatever). If you already know what
you're doing, the short version is in each repo's README. This version
spells out every step.

There are always **two repos** involved:

- `orbitfs-mcp` - the actual server. Talks to Claude/ChatGPT (MCP) and
  stores/serves your files. Nothing works without this running.
- `orbitfs-panel` - this repo. A phone/browser-friendly control panel
  that talks to the MCP server over the network. Optional, but it's how
  you browse files and restart things without RDP-ing into the box.

They're independent processes. The MCP server can run with no panel at
all. The panel is useless without an MCP server to talk to.

Neither script hardcodes a drive letter or username - `Install-OrbitFS.ps1`
asks (or takes `-CodeDir`/`-HiveDataRoot` params) for exactly where you want
the code and the data folder, so you can put them anywhere.

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

## 1. Get the panel repo onto the machine

You only need to clone one repo yourself - the install script clones the
other:

```powershell
git clone <orbitfs-panel-repo-url> orbitfs-panel
cd orbitfs-panel\deploy
```

## 2. Run the installer - it asks where you want everything

This is the one script that sets everything up: clones the MCP server repo,
creates the shared file folders it expects, generates `.env` for both repos
with a fresh API key, and runs `npm install` in both.

```powershell
.\Install-OrbitFS.ps1
```

With no parameters it **prompts you** for two locations (press Enter to
accept the suggested default, or type your own):

- **Code install directory** - where `orbitfs-mcp\` and `orbitfs-panel\`
  end up (e.g. `F:\`, `D:\apps`, wherever you have space).
- **FireStorm data directory** - where the actual shared files live. Keep
  it separate from the code if you want, e.g. on a dedicated data drive.

Or skip the prompts by passing both up front:

```powershell
.\Install-OrbitFS.ps1 -CodeDir "D:\apps" -HiveDataRoot "D:\FireStorm\The Master Hive"
```

It's safe to run more than once - it never overwrites a `.env` file or
folder that already exists, it only fills in what's missing.

When it finishes, it prints exactly what to do next. The short version is
steps 3-6 below.

## 3. Fill in the one thing the script can't guess

Open `<CodeDir>\orbitfs-mcp\.env` in a text editor and set:

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
cd <CodeDir>\orbitfs-panel
node scripts/add-user.mjs myusername 1234
```

The username and PIN are yours to pick (PIN is 4-10 digits). The very
first user created becomes an `admin` automatically.

## 5. Start both servers

Two separate terminal windows, one per server:

```powershell
# Terminal 1
cd <CodeDir>\orbitfs-mcp
npm start
```

```powershell
# Terminal 2
cd <CodeDir>\orbitfs-panel
npm start
```

## 6. Check it's alive

- MCP server: open `http://localhost:3939/api/ping` - should return
  `{"ok":true,"name":"orbitfs"}`.
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
2. Run `cloudflared tunnel login` and `cloudflared tunnel create <name>`
   (interactive, needs a browser login - can't be scripted). Point a DNS
   record at it, following Cloudflare's own tunnel setup docs.
3. Set `PUBLIC_BASE_URL` in `<CodeDir>\orbitfs-mcp\.env` to that domain.

## 8. (Optional) Run everything as Windows services

Running `npm start` in a terminal window dies when you close the window or
log out. For a real deployment, run everything as a service so it survives
reboots and stays up unattended.

`orbitfs-panel\deploy\Setup-Services.ps1` uses [NSSM](https://nssm.cc/) to
install **all four** pieces as services - the MCP server, the sorter (if
present), the panel, and the Cloudflare tunnel (if you did step 7) - plus
an IIS reverse proxy for the panel. Every path is derived from `-CodeDir`,
so point it at wherever you installed things in step 2:

```powershell
cd <CodeDir>\orbitfs-panel\deploy
.\Setup-Services.ps1 -CodeDir "<CodeDir>" -TunnelName <your-tunnel-name> -HostHeader panel.yourdomain.com
```

Leave off `-TunnelName` to skip the tunnel service, or add `-SkipIIS` to
skip the reverse proxy (e.g. if you're only reaching the panel through the
Cloudflare tunnel). Run `Get-Help .\Setup-Services.ps1 -Full` for every
parameter.

The MCP server and sorter services install as **Manual** start - launch
them from the panel's System tab rather than having them auto-start, so
you control when the file store becomes writable.

## 9. (Optional) The "hard stop" button

The panel's System tab has a guarded button that shuts down the entire
machine (`Stop-Computer -Force`). It's off by default. To enable it:

1. Create a PowerShell script that does the shutdown, e.g.:
   ```powershell
   Stop-Computer -ComputerName localhost -Force
   ```
2. Set `PANEL_HARDSTOP_SCRIPT_PATH` in `orbitfs-panel\.env` to that
   script's path.
3. Set `PANEL_HARDSTOP_PASSWORD` in `orbitfs-panel\.env` to a real
   password.

Leave both blank if you don't want this feature - the button will just
refuse to run.

## Troubleshooting

- **`node` not recognized** - Node.js isn't installed or isn't on PATH.
  Reinstall from nodejs.org and open a new terminal.
- **MCP server won't start / crashes immediately** - check
  `orbitfs-mcp\.env` has `HIVE_ROOT`, `HIVE_API_KEY`, `PORT`,
  `PUBLIC_BASE_URL`, and `SESSION_SECRET` all set. Check
  `orbitfs-mcp\service-err.log` (or `err.log` if running via `npm start`)
  for the actual error.
- **Panel loads but can't reach the MCP server** - check `HIVE_URL` and
  `HIVE_API_KEY` in `orbitfs-panel\.env` match the MCP server's own
  `PORT` and `HIVE_API_KEY`.
- **"Path is required" or file errors from the MCP server** - the
  `HIVE_ROOT` folder or one of its subfolders is missing. Re-run
  `deploy\Install-OrbitFS.ps1` - it's safe to run again and will
  fill in anything missing.
- **A service won't start after Setup-Services.ps1** - check
  `<CodeDir>\orbitfs-mcp\service-err.log` or
  `<CodeDir>\orbitfs-panel\service-err.log`. A common cause is the service
  still pointing at an old path - re-run `Setup-Services.ps1` with the
  correct `-CodeDir` to refresh it.
- **Claude/ChatGPT can't connect** - confirm `PUBLIC_BASE_URL` is set and
  actually reachable from the internet (tunnel/DNS working), and that
  you're using the right auth method (bearer key vs Cloudflare Access
  OAuth) on the client side.


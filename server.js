import dotenv from "dotenv";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import fsSync from "fs";
import { execFile, spawn } from "child_process";
import { Readable } from "stream";
import { makeHiveClient } from "./hive-client.js";
import { verifyLogin, validateSession, invalidateSession, listUsers, upsertUser, removeUser } from "./auth.js";
import { canAccessPath, filterEntriesForRole, listPermissions, setPermission, clearPermission } from "./permissions.js";
import { needsSetup, runSetup, tryStartHiveServer } from "./setup.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });
const PORT = process.env.PANEL_PORT || 4000;
const LOG_DIR = path.join(__dirname, "logs");
const PANEL_EVENT_LOG = path.join(LOG_DIR, "master-brain-panel-events.jsonl");
const PANEL_ERROR_LOG = path.join(LOG_DIR, "master-brain-panel-errors.jsonl");
const PANEL_SERVICE_NAME = process.env.PANEL_SERVICE_NAME || "MasterBrainPanel";
const HIVE_SERVICE_NAME = process.env.HIVE_SERVICE_NAME || "MasterHiveServer";
const HIVE_SERVER_DIR = process.env.HIVE_SERVER_DIR || "C:\\mcp-hive-server";
const HIVE_LOG_DIR = process.env.HIVE_LOG_DIR || path.join(HIVE_SERVER_DIR, "logs");
const CLOUDFLARED_SERVICE_NAME = process.env.CLOUDFLARED_SERVICE_NAME || "MasterHiveTunnel";
const CLOUDFLARED_DIR = process.env.CLOUDFLARED_DIR || "C:\\cloudflared";
const SORTER_SERVICE_NAME = process.env.SORTER_SERVICE_NAME || "MasterHiveSorter";
const SORTER_DIR = process.env.SORTER_DIR || "F:\\hive-addon-sorter";
const SORTER_URL = process.env.SORTER_URL || "http://localhost:4055";
const POWERSHELL_CANDIDATES = [
  process.env.PANEL_POWERSHELL_PATH,
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  "C:\\Windows\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe",
  "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  "powershell.exe",
  "pwsh.exe",
].filter(Boolean);

let hive = makeHiveClient(process.env.HIVE_URL, process.env.HIVE_API_KEY);

const app = express();
app.set("etag", false);

function resolvePowerShellCommand() {
  for (const candidate of POWERSHELL_CANDIDATES) {
    if (!candidate.includes("\\") && !candidate.includes("/")) return candidate;
    if (fsSync.existsSync(candidate)) return candidate;
  }
  return "powershell.exe";
}

const POWERSHELL_CMD = resolvePowerShellCommand();

function logEvent(event, fields = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...fields });
  console.log(line);
  fs.mkdir(LOG_DIR, { recursive: true })
    .then(() => fs.appendFile(PANEL_EVENT_LOG, `${line}\n`))
    .catch(() => {});
}

function logError(event, err, fields = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, error: err.message, ...fields });
  console.error(line);
  fs.mkdir(LOG_DIR, { recursive: true })
    .then(() => fs.appendFile(PANEL_ERROR_LOG, `${line}\n`))
    .catch(() => {});
}

function requestContext(req) {
  return {
    method: req.method,
    path: req.path,
    ip: req.ip,
    user: req.username,
    role: req.role,
  };
}

function sessionOf(req) {
  const auth = req.headers["authorization"];
  if (!auth || !auth.startsWith("Bearer ")) return null;
  return validateSession(auth.slice(7));
}

function requireAdmin(req, res, next) {
  if (req.role !== "admin") return res.status(403).json({ error: "Admin access required" });
  next();
}

async function requireFileAccess(req, res, filepath) {
  if (await canAccessPath(req.role, filepath)) return true;
  res.status(403).json({ error: "File access denied" });
  return false;
}

// --- Auth ------------------------------------------------------------------

app.post("/api/login", express.json(), async (req, res) => {
  const { username, pin } = req.body || {};
  if (!username || !pin) return res.status(400).json({ error: "username and pin required" });
  try {
    const result = await verifyLogin(username, pin);
    if (!result) {
      logEvent("panel.login.failed", { username });
      return res.status(401).json({ error: "Invalid username or PIN" });
    }
    logEvent("panel.login.ok", { username: result.username, role: result.role });
    res.json(result); // { token, username, role }
  } catch (err) {
    logError("panel.login.error", err, { username });
    res.status(429).json({ error: err.message });
  }
});

app.post("/api/logout", (req, res) => {
  const auth = req.headers["authorization"];
  if (auth?.startsWith("Bearer ")) invalidateSession(auth.slice(7));
  res.json({ ok: true });
});

// --- First-run setup -----------------------------------------------------
// Unauthenticated on purpose (there's no admin to authenticate as yet), but
// runSetup() itself refuses to do anything once an account already exists.

app.get("/api/setup/status", async (req, res) => {
  try {
    res.json({ needsSetup: await needsSetup() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/setup", express.json(), async (req, res) => {
  try {
    const result = await runSetup(req.body || {}, {
      panelDir: __dirname,
      hiveServerDir: HIVE_SERVER_DIR,
      panelPort: PORT,
    });
    hive = makeHiveClient(result.hiveUrl, result.hiveApiKey);
    process.env.HIVE_URL = result.hiveUrl;
    process.env.HIVE_API_KEY = result.hiveApiKey;
    logEvent("panel.setup.complete", { dataFolder: result.dataFolder, adminUsername: req.body?.adminUsername });
    const hiveStatus = await tryStartHiveServer(HIVE_SERVER_DIR, result.hiveUrl);
    res.json({
      ok: true,
      hiveStatus,
      mcpUrl: result.mcpUrl,
      hiveApiKey: result.hiveApiKey,
      oauthConfigured: result.oauthConfigured,
    });
  } catch (err) {
    if (!err.status) logError("panel.setup.error", err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  if (req.path === "/login" || req.path === "/logout") return next();
  const session = sessionOf(req);
  if (!session) return res.status(401).json({ error: "Unauthorized" });
  req.username = session.username;
  req.role = session.role;
  next();
});

app.use("/api", (req, res, next) => {
  const started = Date.now();
  res.on("finish", () => {
    logEvent("panel.http.request", {
      ...requestContext(req),
      status: res.statusCode,
      ms: Date.now() - started,
    });
  });
  next();
});

app.get("/api/status", async (req, res) => {
  res.json({ hive: { ok: await hive.ping(), url: hive.baseUrl }, checkedAt: new Date().toISOString() });
});

// --- Files -------------------------------------------------------------
// Thin passthrough to the Hive node's own REST API (see mcp-hive-server),
// except upload/download which stream raw bytes rather than round-tripping
// through JSON, so this handles any file type/size sanely.
// File permissions are intentionally basic: default user access, with optional
// admin-only path overrides stored by this panel.

app.get("/api/files", async (req, res) => {
  try {
    const entries = await hive.listFiles(req.query.subpath);
    res.json({ entries: await filterEntriesForRole(entries, req.role, req.query.subpath || "") });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/file", async (req, res) => {
  try {
    if (!(await requireFileAccess(req, res, req.query.path))) return;
    res.json({ content: await hive.readFile(req.query.path) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put("/api/file", express.json({ limit: "25mb" }), async (req, res) => {
  try {
    if (!(await requireFileAccess(req, res, req.body.path))) return;
    await hive.writeFile(req.body.path, req.body.content ?? "");
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/file", async (req, res) => {
  try {
    if (!(await requireFileAccess(req, res, req.query.path))) return;
    await hive.deleteFile(req.query.path);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/trash", express.json(), async (req, res) => {
  try {
    if (!(await requireFileAccess(req, res, req.body.path))) return;
    if (!(await requireFileAccess(req, res, "_trash"))) return;
    res.json(await hive.moveToTrash(req.body.path));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/trash/empty", requireAdmin, async (req, res) => {
  try {
    if (!(await requireFileAccess(req, res, "_trash"))) return;
    res.json(await hive.emptyTrash());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/system/trash-config", requireAdmin, async (req, res) => {
  try {
    res.json(await hive.getTrashConfig());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/system/trash-config", requireAdmin, express.json(), async (req, res) => {
  try {
    res.json(await hive.setTrashConfig(req.body?.retentionDays));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/move", express.json(), async (req, res) => {
  try {
    if (!(await requireFileAccess(req, res, req.body.from))) return;
    if (!(await requireFileAccess(req, res, req.body.to))) return;
    await hive.moveFile(req.body.from, req.body.to);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/sort/preview", async (req, res) => {
  try {
    if (!(await requireFileAccess(req, res, "_sorter"))) return;
    res.json(await hive.previewSort());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/sort/apply", express.json(), async (req, res) => {
  try {
    const moves = req.body?.moves || [];
    for (const m of moves) {
      if (!(await requireFileAccess(req, res, `_sorter/${m.item}`))) return;
      if (!(await requireFileAccess(req, res, `${m.destination}/${m.item}`))) return;
    }
    res.json(await hive.applySort(moves));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/mkdir", express.json(), async (req, res) => {
  try {
    if (!(await requireFileAccess(req, res, req.body.path))) return;
    await hive.mkdir(req.body.path);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/download", async (req, res) => {
  try {
    if (!(await requireFileAccess(req, res, req.query.path))) return;
    const url = new URL("/api/download", hive.baseUrl);
    url.searchParams.set("path", req.query.path);
    const upstream = await fetch(url, { headers: hive.headers });
    if (!upstream.ok) return res.status(upstream.status).json({ error: "download failed" });
    res.set("Content-Type", upstream.headers.get("content-type") || "application/octet-stream");
    const cd = upstream.headers.get("content-disposition");
    if (cd) res.set("Content-Disposition", cd);
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/upload", express.raw({ type: () => true, limit: "2gb" }), async (req, res) => {
  try {
    if (!(await requireFileAccess(req, res, req.query.path))) return;
    const url = new URL("/api/upload", hive.baseUrl);
    url.searchParams.set("path", req.query.path);
    const upstream = await fetch(url, {
      method: "POST",
      headers: { ...hive.headers, "Content-Type": req.headers["content-type"] || "application/octet-stream" },
      body: req.body,
    });
    const body = await upstream.json().catch(() => ({}));
    res.status(upstream.status).json(body);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/file-permissions", requireAdmin, async (req, res) => {
  try {
    res.json({ rules: await listPermissions() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/file-permissions", requireAdmin, express.json(), async (req, res) => {
  const { path: filepath, role } = req.body || {};
  if (!filepath && filepath !== "") return res.status(400).json({ error: "path required" });
  if (!["admin", "user"].includes(role)) return res.status(400).json({ error: "role must be admin or user" });
  try {
    res.json({ ok: true, permission: await setPermission(filepath, role) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/file-permissions", requireAdmin, async (req, res) => {
  if (!req.query.path && req.query.path !== "") return res.status(400).json({ error: "path required" });
  try {
    res.json({ ok: true, permission: await clearPermission(req.query.path) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- System monitoring / control ----------------------------------------
// So there's no reason to RDP into the VPS just to check whether the Hive
// server / tunnel / this panel itself are alive, or to bounce one of them.

function runPs(args) {
  return new Promise((resolve, reject) => {
    execFile(
      POWERSHELL_CMD,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", ...args],
      { timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve(stdout.trim());
      }
    );
  });
}

app.get("/api/system/status", async (req, res) => {
  try {
    const out = await runPs([
      "-File",
      path.join(__dirname, "scripts", "system-status.ps1"),
      "-PanelServiceName",
      PANEL_SERVICE_NAME,
      "-HiveServiceName",
      HIVE_SERVICE_NAME,
      "-HiveDir",
      HIVE_SERVER_DIR,
      "-CloudflaredServiceName",
      CLOUDFLARED_SERVICE_NAME,
      "-CloudflaredDir",
      CLOUDFLARED_DIR,
      "-SorterServiceName",
      SORTER_SERVICE_NAME,
    ]);
    const status = JSON.parse(out);
    const hiveOk = await hive.ping();
    status.hive = {
      ...(status.hive || {}),
      running: hiveOk,
      reachable: hiveOk,
      source: "http_ping",
      url: hive.baseUrl,
    };
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const CONTROL_TARGETS = new Set(["hive", "tunnel", "panel", "sorter"]);
const CONTROL_ACTIONS = new Set(["start", "stop", "restart"]);
const HARDSTOP_SCRIPT_PATH = process.env.PANEL_HARDSTOP_SCRIPT_PATH || "C:\\Users\\Lucas\\Desktop\\hardstop.ps1";
const GUARDED_HARDSTOP_CONFIRM_TEXT = "RUN HARDSTOP";
const HARDSTOP_PASSWORD = process.env.PANEL_HARDSTOP_PASSWORD || "";

app.post("/api/system/control", requireAdmin, express.json(), async (req, res) => {
  const target = req.body?.target;
  const action = req.body?.action || "restart";
  if (!CONTROL_TARGETS.has(target)) return res.status(400).json({ error: "invalid target" });
  if (!CONTROL_ACTIONS.has(action)) return res.status(400).json({ error: "invalid action" });

  const scriptPath = path.join(__dirname, "scripts", "system-control.ps1");

  if (target === "panel" && action !== "start") {
    // stop/restart kill the very process handling this request, so respond
    // first, then let a detached child do it a second later.
    const verb = action === "stop" ? "stopping" : "restarting";
    res.json({ ok: true, note: `Panel ${verb} - reconnect in a few seconds.` });
    const child = spawn(
      POWERSHELL_CMD,
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        "-Target",
        "panel",
        "-Action",
        action,
        "-PanelServiceName",
        PANEL_SERVICE_NAME,
        "-HiveServiceName",
        HIVE_SERVICE_NAME,
        "-HiveDir",
        HIVE_SERVER_DIR,
        "-CloudflaredServiceName",
        CLOUDFLARED_SERVICE_NAME,
        "-CloudflaredDir",
        CLOUDFLARED_DIR,
        "-SorterServiceName",
        SORTER_SERVICE_NAME,
      ],
      { detached: true, stdio: ["ignore", "pipe", "pipe"] }
    );
    child.stdout.on("data", (d) => logEvent("panel.control.child.stdout", { data: d.toString() }));
    child.stderr.on("data", (d) => logEvent("panel.control.child.stderr", { data: d.toString() }));
    child.on("error", (e) => logError("panel.control.child.error", e));
    child.on("exit", (code, signal) => logEvent("panel.control.child.exit", { code, signal }));
    child.unref();
    return;
  }

  try {
    const out = await runPs([
      "-File",
      scriptPath,
      "-Target",
      target,
      "-Action",
      action,
      "-PanelServiceName",
      PANEL_SERVICE_NAME,
      "-HiveServiceName",
      HIVE_SERVICE_NAME,
      "-HiveDir",
      HIVE_SERVER_DIR,
      "-CloudflaredServiceName",
      CLOUDFLARED_SERVICE_NAME,
      "-CloudflaredDir",
      CLOUDFLARED_DIR,
      "-SorterServiceName",
      SORTER_SERVICE_NAME,
    ]);
    res.json(out ? JSON.parse(out) : { ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/system/hardstop", requireAdmin, express.json({ limit: "8kb" }), async (req, res) => {
  const confirmText = typeof req.body?.confirmText === "string" ? req.body.confirmText.trim() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";

  if (confirmText !== GUARDED_HARDSTOP_CONFIRM_TEXT) {
    return res.status(400).json({ error: `type ${GUARDED_HARDSTOP_CONFIRM_TEXT} exactly` });
  }
  if (!HARDSTOP_PASSWORD) {
    return res.status(503).json({ error: "PANEL_HARDSTOP_PASSWORD is not configured on the server" });
  }
  if (password !== HARDSTOP_PASSWORD) {
    logEvent("panel.guarded_hardstop.denied", { ...requestContext(req), reason: "bad_password" });
    return res.status(403).json({ error: "Invalid hard-stop password" });
  }
  logEvent("panel.guarded_hardstop.start", { ...requestContext(req), scriptPath: HARDSTOP_SCRIPT_PATH });

  execFile(
    POWERSHELL_CMD,
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", HARDSTOP_SCRIPT_PATH],
    { timeout: 20000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
    (err, stdout, stderr) => {
      if (err) {
        logError("panel.guarded_hardstop.error", err, { ...requestContext(req), scriptPath: HARDSTOP_SCRIPT_PATH });
        return res.status(500).json({ error: stderr?.trim() || stdout?.trim() || err.message });
      }
      logEvent("panel.guarded_hardstop.ok", {
        ...requestContext(req),
        scriptPath: HARDSTOP_SCRIPT_PATH,
        stdoutBytes: Buffer.byteLength(stdout || ""),
        stderrBytes: Buffer.byteLength(stderr || ""),
      });
      res.json({ ok: true, stdout, stderr });
    }
  );
});

const LOG_FILES = {
  "panel-events": PANEL_EVENT_LOG,
  "panel-errors": PANEL_ERROR_LOG,
  "panel-out": path.join(__dirname, "service-out.log"),
  "panel-err": path.join(__dirname, "service-err.log"),
  "hive-out": path.join(HIVE_SERVER_DIR, "out.log"),
  "hive-err": path.join(HIVE_SERVER_DIR, "err.log"),
  "hive-events": path.join(HIVE_LOG_DIR, "master-hive-events.jsonl"),
  "hive-errors": path.join(HIVE_LOG_DIR, "master-hive-errors.jsonl"),
  "tunnel-out": path.join(CLOUDFLARED_DIR, "tunnel_out.log"),
  "tunnel-err": path.join(CLOUDFLARED_DIR, "tunnel_err.log"),
  "sorter-out": path.join(SORTER_DIR, "out.log"),
  "sorter-err": path.join(SORTER_DIR, "err.log"),
};

app.get("/api/system/logs", async (req, res) => {
  const file = LOG_FILES[req.query.which];
  if (!file) return res.status(400).json({ error: "unknown log source" });
  try {
    const raw = await fs.readFile(file, "utf-8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    res.json({ lines: lines.slice(-200) });
  } catch (err) {
    res.json({ lines: [], error: err.message });
  }
});

app.get("/api/system/oauth", async (req, res) => {
  try {
    res.json(await hive.oauthState());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- User management (admin only) ---------------------------------------

app.get("/api/users", requireAdmin, async (req, res) => {
  try {
    res.json({ users: await listUsers() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/users", requireAdmin, express.json(), async (req, res) => {
  const { username, pin, role } = req.body || {};
  try {
    await upsertUser(username, pin, role);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/users/:username", requireAdmin, async (req, res) => {
  try {
    await removeUser(req.params.username);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get(["/", "/index.html"], async (req, res, next) => {
  try {
    const indexPath = path.join(__dirname, "public", "index.html");
    const html = await fs.readFile(indexPath, "utf-8");
    const injected = html.includes("permissions.js")
      ? html
      : html.replace("</body>", "  <script src=\"permissions.js\"></script>\n</body>");
    res.set("Cache-Control", "no-store");
    res.type("html").send(injected);
  } catch (err) {
    next(err);
  }
});

// no-store: this panel gets redeployed often and is small enough that
// caching isn't worth the risk of a phone/CDN serving a stale bundle with
// missing buttons after every update.
app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders: (res) => res.set("Cache-Control", "no-store"),
  })
);

app.listen(PORT, () => {
  logEvent("panel.powershell.command", { command: POWERSHELL_CMD });
  logEvent("panel.server.start", {
    port: PORT,
    panelServiceName: PANEL_SERVICE_NAME,
    hiveServerDir: HIVE_SERVER_DIR,
    hiveLogDir: HIVE_LOG_DIR,
    cloudflaredDir: CLOUDFLARED_DIR,
  });
});

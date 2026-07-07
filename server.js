import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import { execFile, spawn } from "child_process";
import { Readable } from "stream";
import { makeHiveClient } from "./hive-client.js";
import { verifyLogin, validateSession, invalidateSession, listUsers, upsertUser, removeUser } from "./auth.js";
import { canAccessPath, filterEntriesForRole, listPermissions, setPermission, clearPermission } from "./permissions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PANEL_PORT || 4000;

const hive = makeHiveClient(process.env.HIVE_URL, process.env.HIVE_API_KEY);

const app = express();

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
    if (!result) return res.status(401).json({ error: "Invalid username or PIN" });
    res.json(result); // { token, username, role }
  } catch (err) {
    res.status(429).json({ error: err.message });
  }
});

app.post("/api/logout", (req, res) => {
  const auth = req.headers["authorization"];
  if (auth?.startsWith("Bearer ")) invalidateSession(auth.slice(7));
  res.json({ ok: true });
});

app.use("/api", (req, res, next) => {
  if (req.path === "/login" || req.path === "/logout") return next();
  const session = sessionOf(req);
  if (!session) return res.status(401).json({ error: "Unauthorized" });
  req.username = session.username;
  req.role = session.role;
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
      "powershell.exe",
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
    const out = await runPs(["-File", path.join(__dirname, "scripts", "system-status.ps1")]);
    res.json(JSON.parse(out));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const RESTART_TARGETS = new Set(["hive", "tunnel", "panel"]);

app.post("/api/system/restart", express.json(), async (req, res) => {
  const target = req.body?.target;
  if (!RESTART_TARGETS.has(target)) return res.status(400).json({ error: "invalid target" });

  const scriptPath = path.join(__dirname, "scripts", "system-restart.ps1");

  if (target === "panel") {
    // This kills the very process handling this request, so respond first,
    // then let a detached child do the restart a second later.
    res.json({ ok: true, note: "Panel restarting - reconnect in a few seconds." });
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-Target", "panel"],
      { detached: true, stdio: "ignore" }
    );
    child.unref();
    return;
  }

  try {
    await runPs(["-File", scriptPath, "-Target", target]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const LOG_FILES = {
  "panel-out": path.join(__dirname, "service-out.log"),
  "panel-err": path.join(__dirname, "service-err.log"),
  "hive-out": "C:\\mcp-hive-server\\out.log",
  "hive-err": "C:\\mcp-hive-server\\err.log",
  "tunnel-out": "C:\\cloudflared\\tunnel_out.log",
  "tunnel-err": "C:\\cloudflared\\tunnel_err.log",
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
  console.log(`The Master Brain panel listening on :${PORT}`);
});

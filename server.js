import dotenv from "dotenv";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import fsSync from "fs";
import { execFile, spawn } from "child_process";
import { Readable } from "stream";
import { makeOrbitFSClient } from "./orbitfs-client.js";
import { resolveLocalOrbitFSRoot, makeLocalOps } from "./local-orbitfs-ops.js";
import { verifyLogin, validateSession, invalidateSession, listUsers, upsertUser, removeUser, getUserProfile, updateUserProfile } from "./auth.js";
import { canAccessPath, permissionsForPath, filterEntriesForRole, listPermissions, setPermission, clearPermission, normalizeFilePath } from "./permissions.js";
import { needsSetup, runSetup, tryStartOrbitFSServer } from "./setup.js";
import { workspaceRouter } from "./workspace-routes.js";
import { beginDownload } from "./download-limits.js";
import { evaluateWorkspaceLifecycle } from "./workspaces.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function withTimeout(promise, ms, message = "Operation timed out") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
dotenv.config({ path: path.join(__dirname, ".env") });
const PORT = process.env.PANEL_PORT || 4000;
const LOG_DIR = path.join(__dirname, "logs");
const WORKSPACE_ROOT = path.dirname(__dirname);
const CLOUD_MODE = ["1", "true", "yes"].includes(String(process.env.ORBITFS_CLOUD || "").toLowerCase());
const PANEL_EVENT_LOG = path.join(LOG_DIR, "orbitfs-panel-events.jsonl");
const PANEL_ERROR_LOG = path.join(LOG_DIR, "orbitfs-panel-errors.jsonl");
const PANEL_SERVICE_NAME = process.env.PANEL_SERVICE_NAME || "OrbitFSPanel";
const HIVE_SERVICE_NAME = process.env.HIVE_SERVICE_NAME || "OrbitFSMcpServer";
const HIVE_SERVER_DIR = process.env.HIVE_SERVER_DIR || "F:\\OrbitFS Project\\orbitfs-mcp";
const HIVE_LOG_DIR = process.env.HIVE_LOG_DIR || path.join(HIVE_SERVER_DIR, "logs");
const CLOUDFLARED_SERVICE_NAME = process.env.CLOUDFLARED_SERVICE_NAME || "OrbitFSTunnel";
const CLOUDFLARED_DIR = process.env.CLOUDFLARED_DIR || "C:\\cloudflared";
const SORTER_SERVICE_NAME = process.env.SORTER_SERVICE_NAME || "OrbitFSSorter";
const DEFAULT_SORTER_DIR = path.join(__dirname, "plugins", "OrbitFS Sorter");
const ENV_SORTER_DIR = process.env.SORTER_DIR;
const SORTER_DIR = ENV_SORTER_DIR && fsSync.existsSync(path.join(ENV_SORTER_DIR, "server.js"))
  ? ENV_SORTER_DIR
  : DEFAULT_SORTER_DIR;
const SORTER_URL = process.env.SORTER_URL || "http://localhost:4055";
const POWERSHELL_CANDIDATES = [
  process.env.PANEL_POWERSHELL_PATH,
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  "C:\\Windows\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe",
  "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  "powershell.exe",
  "pwsh.exe",
].filter(Boolean);

let hive = makeOrbitFSClient(process.env.HIVE_URL, process.env.HIVE_API_KEY);

// Read-only disk fallback for browsing/viewing/downloading when the MCP
// server is down - see local-orbitfs-ops.js for why writes aren't covered here.
const localOrbitFSRoot = resolveLocalOrbitFSRoot(HIVE_SERVER_DIR);
const localOps = localOrbitFSRoot ? makeLocalOps(localOrbitFSRoot) : null;

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

async function sessionOf(req) {
  const auth = req.headers["authorization"];
  if (!auth || !auth.startsWith("Bearer ")) return null;
  return validateSession(auth.slice(7));
}

function requireAdmin(req, res, next) {
  if (req.role !== "admin") return res.status(403).json({ error: "Admin access required" });
  next();
}

async function requireFileAccess(req, res, filepath, action = "read") {
  if (await canAccessPath(req.role, filepath, action)) return true;
  res.status(403).json({ error: `${action[0].toUpperCase()}${action.slice(1)} permission denied for ${normalizeFilePath(filepath) || "/"}` });
  return false;
}

function parentPath(filepath) {
  return normalizeFilePath(filepath).split("/").slice(0, -1).join("/");
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

app.post("/api/logout", async (req, res) => {
  const auth = req.headers["authorization"];
  if (auth?.startsWith("Bearer ")) await invalidateSession(auth.slice(7));
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
    hive = makeOrbitFSClient(result.hiveUrl, result.hiveApiKey);
    process.env.HIVE_URL = result.hiveUrl;
    process.env.HIVE_API_KEY = result.hiveApiKey;
    logEvent("panel.setup.complete", { dataFolder: result.dataFolder, adminUsername: req.body?.adminUsername });
    const hiveStatus = await tryStartOrbitFSServer(HIVE_SERVER_DIR, result.hiveUrl);
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

app.use("/api", async (req, res, next) => {
  res.set("Cache-Control", "no-store");
  if (req.path === "/login" || req.path === "/logout") return next();
  const session = await sessionOf(req);
  if (!session) return res.status(401).json({ error: "Unauthorized" });
  req.username = session.username;
  req.role = session.role;
  req.userId = session.userId;
  next();
});

app.use("/api", workspaceRouter());

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
  const hiveOk = await hive.ping();
  const sorterInstalled = fsSync.existsSync(SORTER_DIR);
  const sorterPort = sorterInstalled ? await resolveSorterPort() : null;
  const sorterOk = sorterInstalled && await sorterOnline(sorterPort || 0);
  res.json({
    hive: { ok: hiveOk, url: hive.baseUrl },
    sorter: { installed: sorterInstalled, ok: sorterOk, port: sorterPort },
    localFallback: { available: !!localOps, active: !hiveOk && !!localOps },
    checkedAt: new Date().toISOString(),
  });
});

// --- Sorter integration ----------------------------------------------------
// The addon sorter runs as its own localhost service and auto-picks a port.
// The panel probes the live sorter port before proxying so it does not rely on
// a stale .sorter-port file or a hardcoded fallback.

function getSorterApiKey() {
  return process.env.HIVE_API_KEY || "";
}

function sorterPortCandidates() {
  const ports = [];
  const add = (value) => {
    const port = Number(value);
    if (Number.isInteger(port) && port > 0 && !ports.includes(port)) ports.push(port);
  };

  let configPort = 4055;
  try {
    const config = JSON.parse(fsSync.readFileSync(path.join(SORTER_DIR, "config.json"), "utf8"));
    const port = Number(config.port);
    if (Number.isInteger(port) && port > 0) configPort = port;
  } catch {
  }

  add(configPort);

  try {
    const p = Number(fsSync.readFileSync(path.join(SORTER_DIR, ".sorter-port"), "utf8").trim());
    add(p);
  } catch {}

  try {
    add(new URL(SORTER_URL).port);
  } catch {}

  for (let i = 0; i < 10; i += 1) add(configPort + i);

  return ports;
}

async function testSorterPort(port) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1200);
  try {
    const headers = getSorterApiKey() ? { Authorization: `Bearer ${getSorterApiKey()}` } : {};
    const resp = await fetch(`http://localhost:${port}/api/status`, {
      signal: controller.signal,
      headers,
    });
    return resp.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveSorterPort() {
  const candidates = sorterPortCandidates();
  for (const port of candidates) {
    if (await testSorterPort(port)) return port;
  }
  return candidates[0] || 4055;
}

async function sorterOnline(port) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const headers = getSorterApiKey() ? { Authorization: `Bearer ${getSorterApiKey()}` } : {};
    const resp = await fetch(`http://localhost:${port}/api/status`, {
      signal: controller.signal,
      headers,
    });
    return resp.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// installed = folder exists (feature present at all); online = service is
// actually answering right now. The Sorter tab shows only when online.
// SORTER_ENABLED=false forces it hidden even if the folder exists.
app.get("/api/sorter-available", async (req, res) => {
  const enabled = process.env.SORTER_ENABLED !== "false";
  const installed = enabled && fsSync.existsSync(SORTER_DIR);
  const port = installed ? await resolveSorterPort() : null;
  const online = installed && (await sorterOnline(port || 0));
  res.json({ available: installed, online, url: port ? `http://localhost:${port}` : SORTER_URL });
});

app.use("/api/sorter", express.raw({ type: "*/*", limit: "2mb" }), async (req, res) => {
  try {
    const port = await resolveSorterPort();
    const headers = { "Content-Type": req.get("content-type") || "application/json" };
    const apiKey = getSorterApiKey();
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const resp = await fetch(`http://localhost:${port}/api${req.url}`, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method) || !req.body?.length ? undefined : req.body,
    });
    const text = await resp.text();
    res.status(resp.status).type(resp.headers.get("content-type") || "application/json").send(text);
  } catch (err) {
    res.status(502).json({ error: `Sorter unreachable: ${err.message}` });
  }
});

// --- Files -------------------------------------------------------------
// Thin passthrough to the OrbitFS MCP node's own REST API (see orbitfs-mcp),
// except upload/download which stream raw bytes rather than round-tripping
// through JSON, so this handles any file type/size sanely.
// Granular inherited file/folder permissions. Admin bypasses every file ACL;
// users receive the most specific rule for read/write/download/move/delete/create.

app.get("/api/files", async (req, res) => {
  try {
    const subpath = req.query.subpath || "";
    if (!(await requireFileAccess(req, res, subpath, "read"))) return;
    let entries;
    try {
      entries = await withTimeout(hive.listFiles(req.query.subpath), 3500, "MCP file listing timed out");
    } catch (hiveErr) {
      if (!localOps) throw hiveErr;
      entries = await localOps.listFiles(req.query.subpath);
    }
    res.json({
      entries: await filterEntriesForRole(entries, req.role, subpath),
      folderPermissions: await permissionsForPath(req.role, subpath),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/file", async (req, res) => {
  try {
    if (!(await requireFileAccess(req, res, req.query.path, "read"))) return;
    let content;
    try {
      content = await withTimeout(hive.readFile(req.query.path), 3500, "MCP file read timed out");
    } catch (hiveErr) {
      if (!localOps) throw hiveErr;
      content = await localOps.readFile(req.query.path);
    }
    res.json({ content, permissions: await permissionsForPath(req.role, req.query.path) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put("/api/file", express.json({ limit: "25mb" }), async (req, res) => {
  try {
    if (!(await requireFileAccess(req, res, req.body.path, "write"))) return;
    await hive.writeFile(req.body.path, req.body.content ?? "");
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/file", async (req, res) => {
  try {
    if (!(await requireFileAccess(req, res, req.query.path, "delete"))) return;
    await hive.deleteFile(req.query.path);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/trash", express.json(), async (req, res) => {
  try {
    if (!(await requireFileAccess(req, res, req.body.path, "delete"))) return;
    res.json(await hive.moveToTrash(req.body.path));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/trash/empty", requireAdmin, async (req, res) => {
  try {
    if (!(await requireFileAccess(req, res, "_trash", "delete"))) return;
    res.json(await hive.emptyTrash());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

const STARTUP_CONFIG_PATH = localOrbitFSRoot ? path.join(localOrbitFSRoot, "_system", "Config", "startup-loading.json") : null;
const STARTUP_CONFIG_DEFAULT = {
  defaultStrength: "medium",
  excludeFolders: ["_trash", "trash", "archive", "archives", "_sorter", "2. Wellbeing/Pure Vent Mode"],
  presets: {
    "1. Legal": { low: [], medium: [], high: [], custom1: [], custom2: [] },
    "2. Wellbeing": { low: [], medium: [], high: [], custom1: [], custom2: [] },
  },
};

app.get("/api/system/startup-config", requireAdmin, async (req, res) => {
  try {
    if (!STARTUP_CONFIG_PATH) throw new Error("Local OrbitFS root is unavailable");
    let config = STARTUP_CONFIG_DEFAULT;
    try { config = { ...STARTUP_CONFIG_DEFAULT, ...JSON.parse(await fs.readFile(STARTUP_CONFIG_PATH, "utf8")) }; } catch {}
    delete config.defaultProject;
    res.json(config);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post("/api/system/startup-config", requireAdmin, express.json(), async (req, res) => {
  try {
    if (!STARTUP_CONFIG_PATH) throw new Error("Local OrbitFS root is unavailable");
    const body = req.body || {};
    const clean = structuredClone(STARTUP_CONFIG_DEFAULT);
    clean.defaultStrength = ["low", "medium", "high", "custom"].includes(body.defaultStrength) ? body.defaultStrength : "medium";
    for (const project of ["1. Legal", "2. Wellbeing"]) {
      for (const strength of ["low", "medium", "high"]) {
        clean.presets[project][strength] = [...new Set((body.presets?.[project]?.[strength] || []).map((v) => normalizeFilePath(v)).filter((v) => v && !v.includes("..") && !/^(?:[a-z]:|\\)/i.test(v)))];
      }
    }
    await fs.mkdir(path.dirname(STARTUP_CONFIG_PATH), { recursive: true });
    await fs.writeFile(STARTUP_CONFIG_PATH, JSON.stringify(clean, null, 2), "utf8");
    res.json(clean);
  } catch (err) { res.status(400).json({ error: err.message }); }
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
    if (!(await requireFileAccess(req, res, req.body.from, "move"))) return;
    if (!(await requireFileAccess(req, res, parentPath(req.body.to), "create"))) return;
    await hive.moveFile(req.body.from, req.body.to);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/bulk-download/validate", express.json(), async (req,res)=>{
  try {
    const paths=Array.isArray(req.body?.paths)?req.body.paths:[];
    if(!paths.length) throw new Error("Select at least one file");
    if(paths.length>3) throw new Error("Maximum 3 files per bulk download");
    if(!localOps) throw new Error("Bulk download size validation is unavailable");
    let total=0;
    for(const item of paths){
      if(!(await requireFileAccess(req,res,item,"download"))) return;
      const full=localOps.safeResolve(item);
      const stat=await fs.stat(full);
      if(!stat.isFile()) throw new Error("Folders cannot be bulk downloaded");
      total+=stat.size;
    }
    if(total>262144000) throw new Error("Bulk download limit is 250 MB");
    res.json({ok:true,paths,totalBytes:total});
  } catch(err){res.status(400).json({error:err.message});}
});

app.post("/api/bulk-move", express.json(), async (req,res)=>{
  try {
    const paths=Array.isArray(req.body?.paths)?req.body.paths:[];
    const destination=String(req.body?.destination||"").replace(/^\/+|\/+$/g,"");
    if(!paths.length) throw new Error("Select at least one item");
    const targets=paths.map(item=>({from:item,to:destination?`${destination}/${path.posix.basename(item)}`:path.posix.basename(item)}));
    for(const item of targets){
      if(!(await requireFileAccess(req,res,item.from,"move"))) return;
      if(!(await requireFileAccess(req,res,parentPath(item.to),"create"))) return;
    }
    for(const item of targets) await hive.moveFile(item.from,item.to);
    res.json({ok:true,moved:targets.length});
  } catch(err){res.status(400).json({error:err.message});}
});

app.post("/api/bulk-trash", express.json(), async (req,res)=>{
  try {
    const paths=Array.isArray(req.body?.paths)?req.body.paths:[];
    if(!paths.length) throw new Error("Select at least one item");
    for(const item of paths) if(!(await requireFileAccess(req,res,item,"delete"))) return;
    for(const item of paths) await hive.moveToTrash(item);
    res.json({ok:true,trashed:paths.length});
  } catch(err){res.status(400).json({error:err.message});}
});

app.post("/api/sort/preview", async (req, res) => {
  try {
    if (!(await requireFileAccess(req, res, "_sorter", "read"))) return;
    res.json(await hive.previewSort());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/sort/apply", express.json(), async (req, res) => {
  try {
    const moves = req.body?.moves || [];
    for (const m of moves) {
      if (!(await requireFileAccess(req, res, `_sorter/${m.item}`, "move"))) return;
      if (!(await requireFileAccess(req, res, m.destination, "create"))) return;
    }
    res.json(await hive.applySort(moves));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/mkdir", express.json(), async (req, res) => {
  try {
    if (!(await requireFileAccess(req, res, parentPath(req.body.path), "create"))) return;
    await hive.mkdir(req.body.path);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// View raw bytes in the panel under read permission without granting the
// separate right to download/save the file.
app.get("/api/preview", async (req, res) => {
  try {
    if (!(await requireFileAccess(req, res, req.query.path, "read"))) return;
    const url = new URL("/api/download", hive.baseUrl);
    url.searchParams.set("path", req.query.path);
    let upstream;
    try {
      upstream = await fetch(url, { headers: hive.headers });
    } catch {
      upstream = null;
    }
    if (upstream && upstream.ok) {
      res.set("Content-Type", upstream.headers.get("content-type") || "application/octet-stream");
      res.set("Content-Disposition", "inline");
      return Readable.fromWeb(upstream.body).pipe(res);
    }
    if (localOps) {
      const { stream } = await localOps.downloadStream(req.query.path);
      res.set("Content-Type", "application/octet-stream");
      res.set("Content-Disposition", "inline");
      return stream.pipe(res);
    }
    return res.status(upstream ? upstream.status : 502).json({ error: "preview failed" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/download", async (req, res) => {
  try {
    if (!(await requireFileAccess(req, res, req.query.path, "download"))) return;
    const url = new URL("/api/download", hive.baseUrl);
    url.searchParams.set("path", req.query.path);
    let upstream;
    try {
      upstream = await fetch(url, { headers: hive.headers });
    } catch {
      upstream = null; // MCP unreachable - fall through to the local disk read below
    }
    if (upstream && upstream.ok) {
      res.set("Content-Type", upstream.headers.get("content-type") || "application/octet-stream");
      const cd = upstream.headers.get("content-disposition");
      if (cd) res.set("Content-Disposition", cd);
      return Readable.fromWeb(upstream.body).pipe(res);
    }
    if (localOps) {
      try {
        const { stream, filename } = await localOps.downloadStream(req.query.path);
        res.set("Content-Type", "application/octet-stream");
        res.set("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`);
        return stream.pipe(res);
      } catch (localErr) {
        return res.status(400).json({ error: localErr.message });
      }
    }
    return res.status(upstream ? upstream.status : 502).json({ error: "download failed" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/upload", express.raw({ type: () => true, limit: "2gb" }), async (req, res) => {
  try {
    if (!(await requireFileAccess(req, res, parentPath(req.query.path), "create"))) return;
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

app.get("/api/file-permissions/effective", requireAdmin, async (req, res) => {
  if (!req.query.path && req.query.path !== "") return res.status(400).json({ error: "path required" });
  try {
    res.json({ path: normalizeFilePath(req.query.path), permissions: await permissionsForPath("user", req.query.path) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/file-permissions", requireAdmin, express.json(), async (req, res) => {
  const { path: filepath, permissions } = req.body || {};
  if (!filepath && filepath !== "") return res.status(400).json({ error: "path required" });
  if (!permissions || typeof permissions !== "object") return res.status(400).json({ error: "permissions object required" });
  try {
    res.json({ ok: true, permission: await setPermission(filepath, permissions) });
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
// So there's no reason to RDP into the VPS just to check whether the OrbitFS
// server / tunnel / this panel itself are alive, or to bounce one of them.

function runPs(args) {
  return new Promise((resolve, reject) => {
    execFile(
      POWERSHELL_CMD,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", ...args],
      { timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve(stdout.trim());
      }
    );
  });
}

async function readDiskUsage(basePath) {
  try {
    const stats = await fs.statfs(basePath);
    const blockSize = Number(stats.bsize || stats.frsize || 0);
    const total = blockSize * Number(stats.blocks || 0);
    const free = blockSize * Number(stats.bavail || stats.bfree || 0);
    const used = Math.max(0, total - free);
    const toGb = (bytes) => Number((bytes / (1024 ** 3)).toFixed(2));
    return {
      totalGB: toGb(total),
      freeGB: toGb(free),
      usedGB: toGb(used),
    };
  } catch {
    return { totalGB: 0, freeGB: 0, usedGB: 0 };
  }
}

async function buildCloudSystemStatus() {
  const hiveOk = await hive.ping();
  const sorterPort = fsSync.existsSync(SORTER_DIR) ? await resolveSorterPort() : 0;
  const sorterRunning = fsSync.existsSync(SORTER_DIR) && (await sorterOnline(sorterPort));
  const disk = await readDiskUsage(process.env.HIVE_ROOT || localOrbitFSRoot || WORKSPACE_ROOT);
  return {
    panel: {
      exists: true,
      running: true,
      status: "Cloud",
      note: "Running inside managed hosting.",
    },
    hive: {
      exists: true,
      running: hiveOk,
      reachable: hiveOk,
      status: hiveOk ? "Running" : "Unreachable",
      source: "http_ping",
      url: hive.baseUrl,
    },
    tunnel: {
      exists: false,
      running: false,
      status: "ManagedByHost",
      note: "Public routing is handled by the hosting provider.",
    },
    sorter: {
      exists: fsSync.existsSync(SORTER_DIR),
      running: sorterRunning,
      status: sorterRunning ? "Running" : "Stopped",
      url: sorterPort ? `http://127.0.0.1:${sorterPort}` : SORTER_URL,
    },
    disk,
    cloudMode: true,
    checkedAt: new Date().toISOString(),
  };
}

app.get("/api/system/status", async (req, res) => {
  if (CLOUD_MODE) {
    try {
      return res.json(await buildCloudSystemStatus());
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
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
  if (CLOUD_MODE) {
    return res.status(501).json({ error: "System service control is disabled in cloud mode." });
  }
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
  if (CLOUD_MODE) {
    return res.status(501).json({ error: "Hard stop is disabled in cloud mode." });
  }
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
  "hive-out": path.join(HIVE_SERVER_DIR, "service-out.log"),
  "hive-err": path.join(HIVE_SERVER_DIR, "service-err.log"),
  "hive-events": path.join(HIVE_LOG_DIR, "master-hive-events.jsonl"),
  "hive-errors": path.join(HIVE_LOG_DIR, "master-hive-errors.jsonl"),
  "tunnel-out": path.join(CLOUDFLARED_DIR, "tunnel_out.log"),
  "tunnel-err": path.join(CLOUDFLARED_DIR, "tunnel_err.log"),
  "sorter-out": path.join(SORTER_DIR, "service-out.log"),
  "sorter-err": path.join(SORTER_DIR, "service-err.log"),
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

app.get("/api/me", async (req,res) => {
  try { res.json({ user:await getUserProfile(req.userId) }); }
  catch(error) { res.status(400).json({error:error.message}); }
});
app.patch("/api/me", express.json(), async (req,res) => {
  try { res.json({ user:await updateUserProfile(req.userId,req.body||{}) }); }
  catch(error) { res.status(400).json({error:error.message}); }
});

app.get("/api/users", requireAdmin, async (req, res) => {
  try {
    res.json({ users: await listUsers() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/users", requireAdmin, express.json(), async (req, res) => {
  const { username, pin, role, email } = req.body || {};
  try {
    await upsertUser(username, pin, role, email);
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

// The panel must stay on a fixed port: IIS reverse-proxies
// brain.incendiarynetworks.cc to localhost:4000 via a hardcoded web.config
// rule, so auto-picking a port here would silently break the public URL.
// Only the sorter auto-ports (it owns updating the cloudflared ingress).
app.listen(PORT, () => {
  logEvent("panel.powershell.command", { command: POWERSHELL_CMD });
  evaluateWorkspaceLifecycle().catch((error)=>logError("workspace.lifecycle.error",error));
  setInterval(()=>evaluateWorkspaceLifecycle().catch((error)=>logError("workspace.lifecycle.error",error)),60*60*1000).unref();
  logEvent("panel.server.start", {
    port: PORT,
    panelServiceName: PANEL_SERVICE_NAME,
    hiveServerDir: HIVE_SERVER_DIR,
    hiveLogDir: HIVE_LOG_DIR,
    cloudflaredDir: CLOUDFLARED_DIR,
  });
});

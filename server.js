import dotenv from "dotenv";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import fsSync from "fs";
import { execFile, spawn } from "child_process";
import { Readable } from "stream";
import crypto from "crypto";
import mammoth from "mammoth";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { makeOrbitFSClient } from "./orbitfs-client.js";
import { resolveLocalOrbitFSRoot, makeLocalOps } from "./local-orbitfs-ops.js";
import { verifyLogin, validateSession, invalidateSession, listUsers, upsertUser, removeUser, getUserProfile, updateUserProfile } from "./auth.js";
import { canAccessPath, permissionsForPath, filterEntriesForRole, listPermissions, setPermission, clearPermission, normalizeFilePath } from "./permissions.js";
import { needsSetup, runSetup, tryStartOrbitFSServer } from "./setup.js";
import { workspaceRouter } from "./workspace-routes.js";
import { beginDownload } from "./download-limits.js";
import { evaluateWorkspaceLifecycle, getWorkspaceForUser, listUserWorkspaces } from "./workspaces.js";
import { effectiveWorkspaceAdminPermissions, fullWorkspaceAdminPermissions } from "./workspace-permissions.js";
import { addonEnabled, addonPath, addonStatus, listAddonStatuses, attachAddon, detachAddon, initialiseAddonState, isPathInParkedAddons } from "./addons.js";
import { getRestrictedTabs } from "./tab-restrictions.js";
import { resolveMcpIdentity } from "./workspace-mcp.js";
import { query } from "./db.js";
import { COMPONENTS, activateComponents, assertComponentLicensed, getComponentStatus, getLicenseSummary, isLicenseEnforced, licenseGuard, startLicenseHeartbeat } from "./license.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function withTimeout(promise, ms, message = "Operation timed out") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
dotenv.config({ path: path.join(__dirname, ".env") });
await initialiseAddonState();
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
const SORTER_DIR = ENV_SORTER_DIR
  && !isPathInParkedAddons(ENV_SORTER_DIR)
  && fsSync.existsSync(path.join(ENV_SORTER_DIR, "server.js"))
  ? ENV_SORTER_DIR
  : DEFAULT_SORTER_DIR;
const SORTER_URL = process.env.SORTER_URL || "http://localhost:4055";

function stopWindowsServiceIfRunning(serviceName, reason) {
  if (!serviceName || CLOUD_MODE) return;
  execFile(
    POWERSHELL_CMD,
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `if((Get-Service -Name '${serviceName}' -ErrorAction SilentlyContinue).Status -eq 'Running'){Stop-Service -Name '${serviceName}' -Force}`],
    { windowsHide:true },
    (error) => {
      if (error) logError("license.service_stop.failed", Object.assign(error, { serviceName, reason }));
      else logEvent("license.service_stop", { serviceName, reason });
    }
  );
}

function enforceLicensedServices(summary) {
  const mcp = summary?.components?.[COMPONENTS.MCP];
  const sorter = summary?.components?.[COMPONENTS.SORTER];
  if (mcp && !(mcp.allowed === true && mcp.lockedToThisInstallation !== false && mcp.state !== "blocked")) {
    stopWindowsServiceIfRunning(HIVE_SERVICE_NAME, "mcp_license_blocked");
  }
  if (sorter && !(sorter.allowed === true && sorter.lockedToThisInstallation !== false && sorter.state !== "blocked")) {
    stopWindowsServiceIfRunning(SORTER_SERVICE_NAME, "sorter_license_blocked");
  }
}

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
const SHARE_LINKS_PATH = path.join(__dirname, "runtime", "share-links.json");
const SHARE_DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SHARE_MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;

async function readShareLinks() {
  try {
    const parsed = JSON.parse(await fs.readFile(SHARE_LINKS_PATH, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeShareLinks(links) {
  await fs.mkdir(path.dirname(SHARE_LINKS_PATH), { recursive: true });
  await fs.writeFile(SHARE_LINKS_PATH, JSON.stringify(links, null, 2), "utf8");
}

function shareBaseUrl(req) {
  const configured = String(process.env.PANEL_PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  if (configured) return configured;
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "https").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  return host ? `${proto}://${host}` : "";
}

async function pruneShareLinks(links) {
  const now = Date.now();
  let changed = false;
  for (const [token, link] of Object.entries(links)) {
    if (!link?.expiresAt || Date.parse(link.expiresAt) <= now) {
      delete links[token];
      changed = true;
    }
  }
  if (changed) await writeShareLinks(links);
  return links;
}

async function getShareLink(token) {
  const links = await pruneShareLinks(await readShareLinks());
  return links[token] || null;
}

async function createShareLinkRecord(req, filepath, ttlMs = SHARE_DEFAULT_TTL_MS) {
  const links = await pruneShareLinks(await readShareLinks());
  const token = crypto.randomBytes(24).toString("base64url");
  const safeTtl = Math.min(Math.max(Number(ttlMs || SHARE_DEFAULT_TTL_MS), 60 * 60 * 1000), SHARE_MAX_TTL_MS);
  const now = Date.now();
  links[token] = {
    path: normalizeFilePath(filepath),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + safeTtl).toISOString(),
    createdBy: req.username || null,
    downloads: 0,
    lastAccessedAt: null,
  };
  await writeShareLinks(links);
  const base = shareBaseUrl(req);
  return { token, ...links[token], url: `${base}/s/${token}`, legacyUrl: `${base}/share/${token}` };
}


const app = express();
app.set("etag", false);
const workspaceAddonAssets = express.static(path.join(addonPath("workspaces"), "public"), {
  setHeaders: (res) => res.set("Cache-Control", "no-store"),
});
app.use("/addon-assets/workspaces", async (req,res,next) => {
  try {
    if (!(await addonEnabled("workspaces"))) return res.status(404).end();
    workspaceAddonAssets(req,res,next);
  } catch (error) { res.status(404).end(); }
});

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

const ADDON_LICENSE_COMPONENTS = Object.freeze({
  workspaces: COMPONENTS.WORKSPACES,
  sorter: COMPONENTS.SORTER,
});

async function requireLicensedRoute(res, component, options = {}) {
  try {
    await assertComponentLicensed(component, options);
    return true;
  } catch (error) {
    res.status(error.status || 403).json({
      error: error.message,
      code: error.code || "LICENSE_REQUIRED",
      license: error.license || null,
    });
    return false;
  }
}

function isWorkspaceOnlyPath(pathname = "") {
  return [
    "/workspaces", "/workspace-", "/notifications",
    "/notification-preferences", "/admin/notifications",
    "/tab-restrictions", "/bulk-download", "/bulk-move", "/bulk-trash",
  ].some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
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

// --- Licensing -----------------------------------------------------------

app.get("/api/license/status", async (req, res) => {
  try {
    const session = await sessionOf(req);
    if (!session) return res.status(401).json({ error: "Unauthorized" });
    res.json(await getLicenseSummary({ refresh: req.query.refresh === "1" }));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message, code: error.code });
  }
});

app.post("/api/license/activate", express.json(), async (req, res) => {
  try {
    const firstRun = await needsSetup();
    if (!firstRun) {
      const panelStatus = await getComponentStatus(COMPONENTS.PANEL);
      if (panelStatus.licensed) {
        const session = await sessionOf(req);
        if (!session) return res.status(401).json({ error: "Unauthorized" });
        if (session.role !== "admin") return res.status(403).json({ error: "Admin access required" });
      }
    }
    const activationComponents = [COMPONENTS.PANEL];
    const license = await activateComponents(req.body?.licenseKey, activationComponents);
    logEvent("panel.license.activated", { components: activationComponents, keyHint: license.keyHint });
    res.json({ ok: true, license });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message,
      code: error.code || "LICENSE_ACTIVATION_FAILED",
      license: error.license || null,
    });
  }
});

// --- First-run setup -----------------------------------------------------
// Unauthenticated on purpose (there's no admin to authenticate as yet), but
// runSetup() itself refuses to do anything once an account already exists.

app.get("/api/setup/status", async (req, res) => {
  try {
    const systemSetup = await needsSetup();
    let license = null;
    let needsLicenseSetup = false;
    if (!systemSetup && isLicenseEnforced()) {
      license = await getComponentStatus(COMPONENTS.PANEL);
      needsLicenseSetup = !license.licensed;
    }
    res.json({ needsSetup: systemSetup, needsLicenseSetup, license });
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
      license: result.license,
    });
  } catch (err) {
    if (!err.status) logError("panel.setup.error", err);
    res.status(err.status || 500).json({
      error: err.message,
      code: err.code || "SETUP_FAILED",
      license: err.license || null,
    });
  }
});

app.use("/api", async (req, res, next) => {
  res.set("Cache-Control", "no-store");
  if (req.path === "/login" || req.path === "/logout" || req.path.startsWith("/license/")) return next();
  const session = await sessionOf(req);
  if (!session) return res.status(401).json({ error: "Unauthorized" });
  req.username = session.username;
  req.role = session.role;
  req.userId = session.userId;
  next();
});

// Server-to-server only (orbitfs-mcp calls this to resolve a Cloudflare
// Access email into a role/workspace) - not under /api, not session-gated,
// gated on its own shared secret instead. MCP_INTERNAL_KEY unset = disabled.
const MCP_INTERNAL_KEY = process.env.MCP_INTERNAL_KEY || "";
app.get("/internal/mcp-identity", async (req, res) => {
  if (!MCP_INTERNAL_KEY || req.get("X-Internal-Key") !== MCP_INTERNAL_KEY) return res.status(401).json({ error: "Unauthorized" });
  const email = String(req.query.email || "").trim();
  if (!email) return res.status(400).json({ error: "email is required" });
  try {
    await assertComponentLicensed(COMPONENTS.MCP);
    const identity = await resolveMcpIdentity(email);
    if (identity.role === "member") await assertComponentLicensed(COMPONENTS.WORKSPACES);
    res.json(identity);
  } catch (error) {
    res.status(error.status || 403).json({
      error: error.message,
      code: error.code || "LICENSE_REQUIRED",
      license: error.license || null,
    });
  }
});

app.use("/api", licenseGuard(COMPONENTS.PANEL));
const DEFAULT_MAINTENANCE_MESSAGE = "OrbitFS is in maintenance mode while Main Workspace files are being changed. Do not edit or upload files. Data changed during maintenance may be lost; OrbitFS is not responsible for changes made while this warning is active.";

async function maintenanceStatus() {
  const row=(await query("SELECT setting_value,updated_at FROM system_settings WHERE setting_key='maintenance_mode' LIMIT 1")).rows[0];
  const value=row?.setting_value && typeof row.setting_value==='object' ? row.setting_value : {};
  return { enabled:value.enabled===true, message:String(value.message||DEFAULT_MAINTENANCE_MESSAGE).trim().slice(0,2000), updatedBy:value.updatedBy||null, updatedAt:row?.updated_at||null };
}

app.get("/api/maintenance-status", async (_req,res) => {
  try { res.json(await maintenanceStatus()); } catch(error){ res.status(500).json({error:error.message}); }
});
app.patch("/api/system/maintenance", requireAdmin, express.json(), async (req,res) => {
  try {
    const enabled=req.body?.enabled===true;
    const message=String(req.body?.message||DEFAULT_MAINTENANCE_MESSAGE).trim().slice(0,2000)||DEFAULT_MAINTENANCE_MESSAGE;
    const value={enabled,message,updatedBy:req.username};
    await query("INSERT INTO system_settings(setting_key,setting_value,updated_at) VALUES('maintenance_mode',$1::jsonb,now()) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=now()",[JSON.stringify(value)]);
    logEvent("panel.maintenance.updated",{enabled,user:req.username});
    res.json(await maintenanceStatus());
  } catch(error){ res.status(400).json({error:error.message}); }
});

// --- Google Drive import: one shared OAuth client ID for the whole panel --
// (an admin sets this once; every user still signs into their own Google
// account through it - the client ID identifies the app, not the person).
async function driveConfig() {
  const row=(await query("SELECT setting_value FROM system_settings WHERE setting_key='google_drive_client_id' LIMIT 1")).rows[0];
  const value=row?.setting_value && typeof row.setting_value==='object' ? row.setting_value : {};
  return { clientId: value.clientId || null };
}
app.get("/api/drive-config", async (_req,res) => {
  try { res.json(await driveConfig()); } catch(error){ res.status(500).json({error:error.message}); }
});
app.patch("/api/system/drive-config", requireAdmin, express.json(), async (req,res) => {
  try {
    const clientId=String(req.body?.clientId||"").trim();
    if (!clientId) throw new Error("clientId is required");
    const value={clientId,updatedBy:req.username};
    await query("INSERT INTO system_settings(setting_key,setting_value,updated_at) VALUES('google_drive_client_id',$1::jsonb,now()) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=now()",[JSON.stringify(value)]);
    logEvent("panel.drive_config.updated",{user:req.username});
    res.json(await driveConfig());
  } catch(error){ res.status(400).json({error:error.message}); }
});

async function currentAddonStatuses() {
  const [sorter, sorterLicense, workspacesLicense] = await Promise.all([
    addonStatus("sorter"),
    getComponentStatus(COMPONENTS.SORTER).catch(() => ({ licensed:false })),
    getComponentStatus(COMPONENTS.WORKSPACES).catch(() => ({ licensed:false })),
  ]);
  let online = false;
  if (sorter.installed && sorterLicense.licensed) {
    const port = await resolveSorterPort().catch(() => null);
    online = !!port && await sorterOnlineWithRetry(port).catch(() => false);
  }
  const statuses = await listAddonStatuses({
    sorter:{ online },
    workspaces:{ online:await addonEnabled("workspaces") && workspacesLicense.licensed },
  });
  return statuses.map((addon) => {
    if (addon.id === "sorter") return { ...addon, licensed:!!sorterLicense.licensed, online, available:!!sorterLicense.licensed && !!addon.installed && !!addon.attached };
    if (addon.id === "workspaces") return { ...addon, licensed:!!workspacesLicense.licensed, online:!!addon.online && !!workspacesLicense.licensed, available:!!workspacesLicense.licensed && !!addon.installed && !!addon.attached };
    return addon;
  });
}
async function sorterAccessForRequest(req) {
  const workspacesAttached = await addonEnabled("workspaces");
  const restricted = await getRestrictedTabs(req.userId, req.role);
  const all = await listUserWorkspaces(req.userId, req.role);
  const main = all.find((item) => item.is_main) || all[0] || null;
  let workspace = main;
  if (workspacesAttached) {
    const requested = req.get("x-workspace-id") || req.query?.workspaceId || req.body?.workspaceId;
    if (requested) workspace = await getWorkspaceForUser(requested, req.userId, req.role) || main;
  }
  if (!workspace) throw new Error("Main workspace is unavailable");
  const owns = req.role === "admin" || workspace.permission === "owner" || String(workspace.owner_id) === String(req.userId);
  let permissions;
  if (owns) permissions = fullWorkspaceAdminPermissions();
  else if (!workspacesAttached || workspace.is_main) permissions = { use_sorter:true, manage_sorter_settings:false };
  else permissions = await effectiveWorkspaceAdminPermissions(workspace.id, workspace.permission);
  if (restricted.includes("sorter")) permissions = { ...permissions, use_sorter:false, manage_sorter_settings:false };
  return {
    workspace,
    useSorter:!!permissions.use_sorter,
    accessSorterSettings:!!permissions.use_sorter && !!permissions.manage_sorter_settings,
    workspacesAttached,
  };
}

app.get("/api/addons/status", async (req,res) => {
  try {
    const addons = (await currentAddonStatuses()).map(({folderPath,requiredFiles,...addon}) => addon);
    res.json({ addons });
  } catch (error) { res.status(500).json({ error:error.message }); }
});
app.get("/api/addons", requireAdmin, async (req,res) => {
  try { res.json({ addons:await currentAddonStatuses() }); }
  catch (error) { res.status(500).json({ error:error.message }); }
});
app.post("/api/addons/:id/attach", requireAdmin, async (req,res) => {
  try {
    const id = req.params.id;
    const before = await addonStatus(id).catch(() => null);
    const addon = before?.attached ? before : await attachAddon(id);
    const component = ADDON_LICENSE_COMPONENTS[id];
    if (component && isLicenseEnforced()) {
      try {
        await activateComponents(null, [component]);
      } catch (error) {
        if (!before?.attached) await detachAddon(id).catch(() => {});
        throw error;
      }
    }
    logEvent("panel.addon.attached", { addon:id, user:req.username });
    res.json({ ok:true, addon, addons:await currentAddonStatuses() });
  } catch (error) {
    res.status(error.status || 400).json({ error:error.message, code:error.code || "ADDON_ATTACH_FAILED", license:error.license || null });
  }
});
app.post("/api/addons/:id/detach", requireAdmin, async (req,res) => {
  try {
    let online = false;
    if (req.params.id === "sorter") {
      const port = await resolveSorterPort().catch(() => null);
      online = !!port && await sorterOnline(port).catch(() => false);
    }
    const addon = await detachAddon(req.params.id, { sorterOnline:online });
    logEvent("panel.addon.detached", { addon:req.params.id, user:req.username });
    res.json({ addon, addons:await currentAddonStatuses() });
  } catch (error) { res.status(error.status || 400).json({ error:error.message }); }
});
app.get("/api/sorter-access", async (req,res) => {
  try {
    const access = await sorterAccessForRequest(req);
    res.json({ workspaceId:access.workspace.id, useSorter:access.useSorter, accessSorterSettings:access.accessSorterSettings, workspace:{ id:access.workspace.id, name:access.workspace.name || "Main Workspace", is_main:!!access.workspace.is_main, permission:access.workspace.permission || (req.role === "admin" ? "owner" : "viewer"), drive_state:access.workspace.drive_state || "online", status:access.workspace.status || "active" } });
  } catch (error) { res.status(400).json({ error:error.message }); }
});

const workspaceAddonRouter = workspaceRouter();
app.use("/api", async (req,res,next) => {
  try {
    if (!(await addonEnabled("workspaces"))) return next();
    const license = await getComponentStatus(COMPONENTS.WORKSPACES);
    if (!license.licensed) {
      if (!isWorkspaceOnlyPath(req.path)) return next();
      return res.status(403).json({ error: "OrbitFS Workspaces licence is blocked or not activated", code: "LICENSE_REQUIRED", license });
    }
    return workspaceAddonRouter(req,res,next);
  } catch (error) {
    if (!isWorkspaceOnlyPath(req.path)) return next();
    return res.status(error.status || 503).json({
      error: error.message,
      code: error.code || "WORKSPACES_UNAVAILABLE",
      license: error.license || null,
    });
  }
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
  const hiveOk = await hive.ping();
  const sorterAddon = await addonStatus("sorter");
  const sorterPort = sorterAddon.attached ? await resolveSorterPort() : null;
  const sorterOk = sorterAddon.attached && await sorterOnlineWithRetry(sorterPort || 0);
  res.json({
    hive: { ok: hiveOk, url: hive.baseUrl },
    sorter: { installed:sorterAddon.installed, attached:sorterAddon.attached, status:sorterAddon.status, ok:sorterOk, port:sorterPort },
    addons: (await currentAddonStatuses()).map(({folderPath,requiredFiles,...addon}) => addon),
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
    const resp = await fetch(`http://127.0.0.1:${port}/api/status`, {
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
    const resp = await fetch(`http://127.0.0.1:${port}/api/status`, {
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

async function sorterOnlineWithRetry(port, attempts = 3) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await sorterOnline(port)) return true;
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

// installed = folder exists (feature present at all); online = service is
// actually answering right now. The Sorter tab shows only when online.
// SORTER_ENABLED=false forces it hidden even if the folder exists.
app.get("/api/sorter-available", async (req, res) => {
  const enabled = process.env.SORTER_ENABLED !== "false";
  const addon = await addonStatus("sorter");
  const license = await getComponentStatus(COMPONENTS.SORTER);
  const attached = enabled && addon.attached;
  const port = attached ? await resolveSorterPort() : null;
  const online = attached && license.licensed && (await sorterOnlineWithRetry(port || 0));
  res.json({ available:addon.installed && license.licensed, installed:addon.installed, attached, status:addon.status, online, license, url:port ? `http://localhost:${port}` : SORTER_URL });
});

app.use("/api/sorter", express.raw({ type: "*/*", limit: "2mb" }), async (req, res) => {
  try {
    const addon = await addonStatus("sorter");
    if (!addon.attached || process.env.SORTER_ENABLED === "false") {
      return res.status(404).json({ error:"Sorter addon is not attached", addonStatus:addon.status });
    }
    if (!(await requireLicensedRoute(res, COMPONENTS.SORTER))) return;
    const access = await sorterAccessForRequest(req);
    if (!access.useSorter) return res.status(403).json({ error:"Sorter access is not enabled for your workspace role" });
    const workspace = access.workspace;
    const sorterPath = String(req.url || "").split("?")[0];
    const settingsRequest = sorterPath === "/settings" || sorterPath.startsWith("/settings/") || (sorterPath === "/learning" && req.method === "DELETE");
    if (settingsRequest && !access.accessSorterSettings) return res.status(403).json({ error:"Sorter settings access is not enabled for your workspace role" });
    if ((sorterPath === "/policy" || sorterPath.startsWith("/policy/")) && req.role !== "admin") return res.status(403).json({ error:"Admin access required" });
    const port = await resolveSorterPort();
    const headers = { "Content-Type":req.get("content-type") || "application/json" };
    const apiKey = getSorterApiKey();
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    headers["X-Workspace-Id"] = String(workspace.id);
    headers["X-Workspace-Root"] = encodeURIComponent(workspace.filesystem_root);
    headers["X-Sorter-Admin"] = String(req.role === "admin");
    headers["X-Sorter-Owner"] = String(req.role === "admin" || workspace.permission === "owner" || String(workspace.owner_id) === String(req.userId));
    headers["X-Workspace-Role"] = String(workspace.permission || (req.role === "admin" ? "owner" : "viewer"));
    headers["X-Workspace-Main"] = String(!!workspace.is_main);
    headers["X-System-Role"] = String(req.role || "user");
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


// --- Document conversion/export ----------------------------------------
const EXPORT_FORMATS = new Set(["md", "txt", "html", "docx", "pdf"]);
const EXPORT_TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".json", ".jsonl", ".csv", ".log", ".xml", ".html", ".css", ".js", ".mjs", ".ts", ".tsx", ".jsx", ".yml", ".yaml"]);
const EXPORT_SOURCE_EXTENSIONS = new Set([".docx", ".pdf"]);

function escapeXml(value = "") {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeHtml(value = "") {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function markdownToPlainText(text = "") {
  return String(text)
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/`{1,3}([^`]+)`{1,3}/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1")
    .replace(/^>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "- ");
}

function markdownToHtml(text = "", title = "OrbitFS Export") {
  const rows = String(text).split(/\r?\n/).map((line) => {
    if (/^###\s+/.test(line)) return `<h3>${escapeHtml(line.replace(/^###\s+/, ""))}</h3>`;
    if (/^##\s+/.test(line)) return `<h2>${escapeHtml(line.replace(/^##\s+/, ""))}</h2>`;
    if (/^#\s+/.test(line)) return `<h1>${escapeHtml(line.replace(/^#\s+/, ""))}</h1>`;
    if (/^\s*[-*+]\s+/.test(line)) return `<p class="bullet">• ${escapeHtml(line.replace(/^\s*[-*+]\s+/, ""))}</p>`;
    if (!line.trim()) return `<div class="gap"></div>`;
    return `<p>${escapeHtml(line)}</p>`;
  }).join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{font-family:Inter,Arial,sans-serif;max-width:820px;margin:32px auto;padding:0 18px;line-height:1.55;color:#111}h1,h2,h3{line-height:1.2}.gap{height:.65rem}.bullet{padding-left:1rem}pre,code{background:#f2f4f7;border-radius:6px;padding:.1rem .25rem}</style></head><body>${rows}</body></html>`;
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function dosDateTime(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const d = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: d };
}

function zipStore(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const dt = dosDateTime();
  for (const file of files) {
    const name = Buffer.from(file.name.replace(/\\/g, "/"), "utf8");
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dt.time, 10); local.writeUInt16LE(dt.date, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26); name.copy(local, 30);
    localParts.push(local, data);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dt.time, 12); central.writeUInt16LE(dt.date, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42); name.copy(central, 46);
    centralParts.push(central);
    offset += local.length + data.length;
  }
  const centralSize = centralParts.reduce((sum, b) => sum + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function textToDocx(text = "", title = "OrbitFS Export") {
  const paragraphs = String(text).split(/\r?\n/).map((line) => {
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    const style = heading ? `<w:pPr><w:pStyle w:val="Heading${heading[1].length}"/></w:pPr>` : "";
    const value = heading ? heading[2] : line;
    return `<w:p>${style}<w:r><w:t xml:space="preserve">${escapeXml(value)}</w:t></w:r></w:p>`;
  }).join("");
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="22"/></w:rPr></w:style></w:styles>`;
  return zipStore([
    { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>` },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>` },
    { name: "word/_rels/document.xml.rels", data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { name: "word/document.xml", data: documentXml },
    { name: "word/styles.xml", data: stylesXml },
  ]);
}

function textToPdf(text = "", title = "OrbitFS Export") {
  const lines = [`${title}`, "", ...markdownToPlainText(text).split(/\r?\n/)];
  const pages = [];
  for (let i = 0; i < lines.length; i += 42) pages.push(lines.slice(i, i + 42));
  const objects = [];
  const add = (s) => { objects.push(Buffer.from(s, "binary")); return objects.length; };
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add("<< /Type /Pages /Kids [" + pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ") + "] /Count " + pages.length + " >>");
  pages.forEach((pageLines, i) => {
    const contentId = 4 + i * 2;
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${3 + pages.length * 2} 0 R >> >> /Contents ${contentId} 0 R >>`);
    const ops = ["BT", "/F1 10 Tf", "50 742 Td"];
    pageLines.forEach((line, idx) => {
      if (idx) ops.push("0 -16 Td");
      ops.push(`(${String(line).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)").slice(0, 105)}) Tj`);
    });
    ops.push("ET");
    const stream = ops.join("\n");
    add(`<< /Length ${Buffer.byteLength(stream, "binary")} >>\nstream\n${stream}\nendstream`);
  });
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let body = Buffer.from("%PDF-1.4\n", "binary");
  const offsets = [0];
  objects.forEach((obj, i) => { offsets.push(body.length); body = Buffer.concat([body, Buffer.from(`${i + 1} 0 obj\n`, "binary"), obj, Buffer.from("\nendobj\n", "binary")]); });
  const xref = body.length;
  const table = [`xref`, `0 ${objects.length + 1}`, `0000000000 65535 f `, ...offsets.slice(1).map((o) => String(o).padStart(10, "0") + " 00000 n "), `trailer << /Root 1 0 R /Size ${objects.length + 1} >>`, `startxref`, String(xref), `%%EOF`].join("\n");
  return Buffer.concat([body, Buffer.from(table, "binary")]);
}

function exportName(filepath, format) {
  const base = path.basename(String(filepath || "export")).replace(/\.[^.]+$/, "") || "export";
  return `${base}.${format}`;
}

function exportContent(filepath, content, format) {
  const title = path.basename(filepath || "OrbitFS Export");
  if (format === "md") return { body: Buffer.from(String(content), "utf8"), type: "text/markdown; charset=utf-8" };
  if (format === "txt") return { body: Buffer.from(markdownToPlainText(content), "utf8"), type: "text/plain; charset=utf-8" };
  if (format === "html") return { body: Buffer.from(markdownToHtml(content, title), "utf8"), type: "text/html; charset=utf-8" };
  if (format === "docx") return { body: textToDocx(content, title), type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
  if (format === "pdf") return { body: textToPdf(content, title), type: "application/pdf" };
  throw new Error("Unsupported export format");
}

async function extractReadableSource(filepath) {
  const ext = path.extname(String(filepath || "")).toLowerCase();
  if (EXPORT_TEXT_EXTENSIONS.has(ext)) {
    try {
      return { text: await withTimeout(hive.readFile(filepath), 3500, "MCP file read timed out"), sourceType: "text" };
    } catch (hiveErr) {
      if (!localOps) throw hiveErr;
      return { text: await localOps.readFile(filepath), sourceType: "text" };
    }
  }
  if (!EXPORT_SOURCE_EXTENSIONS.has(ext)) {
    throw new Error("Export/extraction supports readable text, Markdown, DOCX and text-based PDF files.");
  }
  if (!localOps) throw new Error("Source extraction needs local OrbitFS disk access.");
  const absolute = localOps.safeResolve(filepath);
  if (ext === ".docx") {
    const result = await mammoth.extractRawText({ path: absolute });
    const messages = (result.messages || []).map((m) => m.message).filter(Boolean);
    return { text: result.value || "", sourceType: "docx", warnings: messages };
  }
  if (ext === ".pdf") {
    const result = await pdfParse(await fs.readFile(absolute));
    const text = result.text || "";
    const warnings = text.trim().length < 20 ? ["PDF returned little or no text. It may be scanned/image-based."] : [];
    return { text, sourceType: "pdf", pages: result.numpages || null, warnings };
  }
}

async function readExportSource(filepath) {
  const extracted = await extractReadableSource(filepath);
  if (!extracted.text || !extracted.text.trim()) throw new Error("No readable text could be extracted from this file.");
  return extracted.text;
}

function extractedMarkdown(filepath, extracted) {
  const title = path.basename(String(filepath || "Source"));
  const lines = [
    "---",
    `source_file: ${JSON.stringify(title)}`,
    `source_type: ${JSON.stringify(extracted.sourceType || "text")}`,
    `extracted_at: ${JSON.stringify(new Date().toISOString())}`,
    extracted.pages ? `pages: ${extracted.pages}` : null,
    extracted.warnings?.length ? `warnings: ${JSON.stringify(extracted.warnings)}` : null,
    "---",
    "",
    `# ${title}`,
    "",
    extracted.text || "",
  ].filter((line) => line !== null);
  return lines.join("\n");
}

function siblingMarkdownPath(filepath) {
  const clean = normalizeFilePath(filepath);
  const parsed = path.posix.parse(clean.replace(/\\/g, "/"));
  return path.posix.join(parsed.dir, `${parsed.name}.md`).replace(/^\/+/, "");
}

function sourceArchivePath(filepath) {
  const clean = normalizeFilePath(filepath);
  const parsed = path.posix.parse(clean.replace(/\\/g, "/"));
  return path.posix.join(parsed.dir, "_sources", parsed.base).replace(/^\/+/, "");
}

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
    clean.defaultStrength = ["low", "medium", "high", "custom1", "custom2", "custom"].includes(body.defaultStrength) ? body.defaultStrength : "medium";
    for (const project of ["1. Legal", "2. Wellbeing"]) {
      for (const strength of ["low", "medium", "high", "custom1", "custom2"]) {
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

app.post("/api/share", express.json(), async (req, res) => {
  try {
    const filepath = normalizeFilePath(req.body?.path || "");
    if (!filepath) throw new Error("File path is required");
    if (!(await requireFileAccess(req, res, filepath, "download"))) return;
    const days = Number(req.body?.days || 7);
    const ttlMs = days * 24 * 60 * 60 * 1000;
    const link = await createShareLinkRecord(req, filepath, ttlMs);
    res.json({ ok: true, ...link });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

async function renderSharePage(req, res) {
  try {
    const link = await getShareLink(req.params.token);
    if (!link) return res.status(404).send("Share link expired or not found.");
    const base = shareBaseUrl(req) || "/";
    const token = encodeURIComponent(req.params.token);
    res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OrbitFS shared file</title><style>body{margin:0;background:#07101d;color:#edf3ff;font-family:Inter,system-ui,sans-serif;min-height:100vh;display:grid;place-items:center;padding:18px 18px 88px;overflow:hidden}body:before{content:"";position:fixed;inset:-20%;background:radial-gradient(circle at 20% 20%,rgba(57,115,200,.24),transparent 32%),radial-gradient(circle at 85% 70%,rgba(69,205,180,.14),transparent 34%),linear-gradient(135deg,#07101d,#101827 55%,#07101d);z-index:-2}.promo-bg{position:fixed;left:12px;right:12px;bottom:12px;padding:15px 16px;background:linear-gradient(90deg,rgba(57,115,200,.28),rgba(20,28,41,.92));border:1px solid rgba(120,168,255,.30);border-radius:18px;backdrop-filter:blur(12px);text-align:center;color:#dbe6f7;font-size:.94rem;box-shadow:0 16px 42px rgba(0,0,0,.32)}.promo-bg a{color:#91bcff;font-weight:900;text-decoration:none}.card{width:min(520px,100%);background:rgba(20,28,41,.92);border:1px solid #2b374c;border-radius:18px;padding:18px;box-shadow:0 18px 60px rgba(0,0,0,.35);backdrop-filter:blur(14px)}h1{font-size:1.1rem;margin:.2rem 0 .6rem}.path{overflow-wrap:anywhere;color:#aebbd0;font-size:.9rem}.btn{display:block;text-align:center;margin-top:16px;padding:13px;border-radius:12px;background:#3973c8;color:white;text-decoration:none;font-weight:800}.muted{color:#98a6bd;font-size:.8rem;margin-top:12px}</style></head><body><main class="card"><h1>OrbitFS shared file</h1><p class="path">${escapeHtml(link.path)}</p><a class="btn" href="/s/${token}/download">Download file</a><p class="muted">No account required. Link expires ${escapeHtml(new Date(link.expiresAt).toLocaleString())}.</p></main><div class="promo-bg">Want your own workspace? Come check us out at <a href="${base}">${escapeHtml(base)}</a></div></body></html>`);
  } catch (err) {
    res.status(500).send("Share link failed.");
  }
}

app.get("/s/:token", renderSharePage);
app.get("/share/:token", renderSharePage);

async function downloadSharedFile(req, res) {
  try {
    const links = await pruneShareLinks(await readShareLinks());
    const link = links[req.params.token];
    if (!link) return res.status(404).send("Share link expired or not found.");
    if (!localOps) return res.status(503).send("File sharing needs local OrbitFS disk access.");
    const { stream, filename, size } = await localOps.downloadStream(link.path);
    link.downloads = Number(link.downloads || 0) + 1;
    link.lastAccessedAt = new Date().toISOString();
    links[req.params.token] = link;
    await writeShareLinks(links);
    res.set("Content-Type", "application/octet-stream");
    if (size != null) res.set("Content-Length", String(size));
    res.set("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`);
    return stream.pipe(res);
  } catch (err) {
    res.status(404).send("File unavailable.");
  }
}

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

app.get("/api/export", async (req, res) => {
  try {
    const filepath = String(req.query.path || "");
    const format = String(req.query.format || "").toLowerCase();
    if (!EXPORT_FORMATS.has(format)) throw new Error("Choose export format: md, txt, html, docx or pdf");
    if (!(await requireFileAccess(req, res, filepath, "download"))) return;
    const content = await readExportSource(filepath);
    const exported = exportContent(filepath, content, format);
    res.set("Content-Type", exported.type);
    res.set("Content-Disposition", `attachment; filename="${encodeURIComponent(exportName(filepath, format))}"`);
    return res.send(exported.body);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/extract-source", express.json(), async (req, res) => {
  try {
    const sourcePath = normalizeFilePath(req.body?.path || "");
    if (!sourcePath) throw new Error("Source path is required");
    if (!(await requireFileAccess(req, res, sourcePath, "read"))) return;
    const targetPath = normalizeFilePath(req.body?.targetPath || siblingMarkdownPath(sourcePath));
    if (!(await requireFileAccess(req, res, parentPath(targetPath), "create"))) return;
    if (!(await requireFileAccess(req, res, targetPath, "write"))) return;
    if (!localOps) throw new Error("Source extraction needs local OrbitFS disk access");
    const extracted = await extractReadableSource(sourcePath);
    if (!extracted.text || !extracted.text.trim()) throw new Error("No readable text could be extracted from this source file");
    const markdown = extractedMarkdown(sourcePath, extracted);
    const archivePath = sourceArchivePath(sourcePath);
    const archiveAbsolute = localOps.safeResolve(archivePath);
    await fs.mkdir(path.dirname(archiveAbsolute), { recursive: true });
    try { await fs.copyFile(localOps.safeResolve(sourcePath), archiveAbsolute, fsSync.constants.COPYFILE_EXCL); } catch (copyErr) { if (copyErr.code !== "EEXIST") throw copyErr; }
    await hive.writeFile(targetPath, markdown);
    res.json({ ok: true, sourcePath, targetPath, archivePath, characters: markdown.length, warnings: extracted.warnings || [] });
  } catch (err) {
    res.status(400).json({ error: err.message });
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
    const addonStatuses = await currentAddonStatuses();
    status.addons = addonStatuses.map(({folderPath,requiredFiles,...addon}) => addon);
    const sorterAddon = addonStatuses.find((addon) => addon.id === "sorter");
    const sorterLicense = await getComponentStatus(COMPONENTS.SORTER, { refresh:true }).catch(() => ({ licensed:false }));
    const liveSorterPort = sorterAddon?.attached && sorterLicense.licensed ? await resolveSorterPort().catch(() => 0) : 0;
    const sorterReachable = sorterLicense.licensed && !!liveSorterPort && await sorterOnlineWithRetry(liveSorterPort).catch(() => false);
    status.sorter = {
      ...(status.sorter || {}),
      installed:!!sorterAddon?.installed,
      attached:!!sorterAddon?.attached && !!sorterLicense.licensed,
      licensed:!!sorterLicense.licensed,
      addonStatus:sorterLicense.licensed ? (sorterAddon?.status || "uninstalled") : "blocked",
      running:sorterReachable,
      reachable:sorterReachable,
      status:sorterLicense.licensed ? (sorterReachable ? "Running" : "Stopped") : "Blocked by licence",
      url:liveSorterPort ? "http://127.0.0.1:" + liveSorterPort : SORTER_URL,
    };
    const mcpLicense = await getComponentStatus(COMPONENTS.MCP, { refresh:true }).catch(() => ({ licensed:false }));
    const hiveOk = mcpLicense.licensed ? await hive.ping().catch(() => false) : false;
    status.hive = {
      ...(status.hive || {}),
      licensed:!!mcpLicense.licensed,
      running: hiveOk,
      reachable: hiveOk,
      source: mcpLicense.licensed ? "http_ping" : "license_blocked",
      status: mcpLicense.licensed ? (hiveOk ? "Running" : "Stopped") : "Blocked by licence",
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
  if (target === "tunnel" && action !== "restart") {
    return res.status(403).json({ error: "Cloudflare Tunnel must stay on. Restart is the only allowed action." });
  }
  if (target === "sorter") {
    if (action !== "stop") {
      if (!(await addonEnabled("sorter"))) {
        return res.status(409).json({ error:"Attach the Sorter addon in Config before starting it." });
      }
      try {
        await activateComponents(null, [COMPONENTS.SORTER]);
      } catch (error) {
        stopWindowsServiceIfRunning(SORTER_SERVICE_NAME, "sorter_license_blocked_start_attempt");
        return res.status(error.status || 403).json({ error:"Sorter is blocked by licence. Stop is allowed; start/restart is blocked.", code:error.code || "LICENSE_REQUIRED", license:error.license || null });
      }
    }
  }
  if (target === "hive") {
    if (action !== "stop") {
      try {
        await activateComponents(null, [COMPONENTS.MCP]);
      } catch (error) {
        stopWindowsServiceIfRunning(HIVE_SERVICE_NAME, "mcp_license_blocked_start_attempt");
        return res.status(error.status || 403).json({ error:"MCP is blocked by licence. Stop is allowed; start/restart is blocked.", code:error.code || "LICENSE_REQUIRED", license:error.license || null });
      }
    }
  }
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

app.get("/api/system/hardstop-status", requireAdmin, async (_req, res) => {
  try {
    const scriptExists = await fs.access(HARDSTOP_SCRIPT_PATH).then(() => true).catch(() => false);
    res.json({
      ready: scriptExists && Boolean(HARDSTOP_PASSWORD) && !CLOUD_MODE,
      scriptExists,
      passwordConfigured: Boolean(HARDSTOP_PASSWORD),
      cloudMode: CLOUD_MODE,
      scriptPath: HARDSTOP_SCRIPT_PATH,
    });
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

app.post("/api/system/oauth/disconnect", requireAdmin, express.json(), async (req, res) => {
  try {
    res.json(await hive.disconnectOauth(req.body?.email, req.body?.flow || null));
  } catch (err) {
    res.status(400).json({ error: err.message });
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
    let injected = html.includes("permissions.js")
      ? html
      : html.replace("</body>", "  <script src=\"permissions.js\"></script>\n</body>");
    if (!injected.includes("workspace-expand-fix.js")) {
      injected = injected.replace("</body>", "  <script src=\"workspace-expand-fix.js?v=20260716-expandfix1\"></script>\n</body>");
    }
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
app.listen(PORT, async () => {
  logEvent("panel.powershell.command", { command: POWERSHELL_CMD });
  if (await addonEnabled("workspaces")) evaluateWorkspaceLifecycle().catch((error)=>logError("workspace.lifecycle.error",error));
  setInterval(async()=>{if(await addonEnabled("workspaces")) evaluateWorkspaceLifecycle().catch((error)=>logError("workspace.lifecycle.error",error));},60*60*1000).unref();
  logEvent("panel.server.start", {
    port: PORT,
    panelServiceName: PANEL_SERVICE_NAME,
    hiveServerDir: HIVE_SERVER_DIR,
    hiveLogDir: HIVE_LOG_DIR,
    cloudflaredDir: CLOUDFLARED_DIR,
  });
});

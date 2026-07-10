// First-run setup wizard: creates the data folder, writes both this panel's
// and the Hive server's .env files, and creates the first admin login.
// Exists so a fresh clone of both repos can be configured entirely from the
// browser instead of hand-editing .env files and running add-user.mjs.
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import crypto from "crypto";
import { upsertUser, listUsers } from "./auth.js";

function randomSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

// The folder the user picks in the wizard is a base location (e.g.
// "F:\Project Firestorm") - the actual working root always lives one level
// deeper, inside this subfolder, so the base folder can hold other things
// (installers, other projects) without them getting mixed into the Hive's
// own _system/_sorter/_trash structure.
const HIVE_SUBFOLDER_NAME = "The Master Hive";

// Merges `overrides` into an .env file's KEY=value lines. If the file
// doesn't exist yet, starts from `templatePath` (usually .env.example).
// Existing keys not in `overrides` are left untouched; keys in `overrides`
// replace the existing line, or are appended if missing entirely. Mirrors
// deploy/Install-BaseStructure.ps1's approach so both the CLI and UI paths
// produce the same shape of .env.
async function upsertEnvFile(envPath, templatePath, overrides) {
  let content;
  try {
    content = await fs.readFile(envPath, "utf-8");
  } catch {
    content = await fs.readFile(templatePath, "utf-8");
  }
  for (const [key, value] of Object.entries(overrides)) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, "m");
    content = pattern.test(content) ? content.replace(pattern, line) : `${content.trimEnd()}\n${line}\n`;
  }
  await fs.writeFile(envPath, content, "utf-8");
  return content;
}

function readEnvValue(envPath, key) {
  try {
    const content = fsSync.readFileSync(envPath, "utf-8");
    const match = content.match(new RegExp(`^${key}=(.*)$`, "m"));
    return match ? match[1].trim() : "";
  } catch {
    return "";
  }
}

export async function needsSetup() {
  const users = await listUsers();
  return users.length === 0;
}

async function ensureHiveSkeleton(dataFolder) {
  await fs.mkdir(dataFolder, { recursive: true });
  const systemDir = path.join(dataFolder, "_system");
  const dirs = [
    "_sorter",
    "_trash",
    path.join("_system", "Startup"),
    path.join("_system", "Rules"),
    path.join("_system", "Index"),
  ];
  for (const dir of dirs) {
    await fs.mkdir(path.join(dataFolder, dir), { recursive: true });
  }

  const placeholder = "<!-- placeholder created by the setup wizard - replace with real content -->\n";
  const files = {
    [path.join("Startup", "00_MASTER_STARTUP.md")]: `${placeholder}# Master Startup\n`,
    [path.join("Rules", "load_order.md")]: `${placeholder}# Load Order\n`,
    [path.join("Rules", "project_rules.md")]: `${placeholder}# Project Rules\n`,
    [path.join("Rules", "saving_rules.md")]: `${placeholder}# Saving Rules\n`,
    [path.join("Rules", "commands.md")]: `${placeholder}# Commands\n`,
    [path.join("Index", "file_index.json")]: "{}\n",
  };
  for (const [rel, content] of Object.entries(files)) {
    const filePath = path.join(systemDir, rel);
    try {
      await fs.access(filePath);
    } catch {
      await fs.writeFile(filePath, content, "utf-8");
    }
  }
}

// Fields expected in `input`:
//   dataFolder (required, absolute path), hivePort, publicBaseUrl,
//   adminUsername (required), adminPin (required, 4-10 digits)
export async function runSetup(input, { panelDir, hiveServerDir, panelPort }) {
  if (!(await needsSetup())) {
    const err = new Error("Setup has already been completed");
    err.status = 409;
    throw err;
  }

  const baseFolder = String(input.dataFolder || "").trim();
  if (!baseFolder || !/^[a-zA-Z]:[\\/]/.test(baseFolder)) {
    const err = new Error("Data folder must be a full Windows path starting with a drive letter (e.g. D:\\MyFiles)");
    err.status = 400;
    throw err;
  }
  const dataFolder = path.join(baseFolder, HIVE_SUBFOLDER_NAME);
  const hivePort = String(input.hivePort || "3939").trim();
  if (!/^\d{2,5}$/.test(hivePort)) {
    const err = new Error("Server port must be a number");
    err.status = 400;
    throw err;
  }
  const publicBaseUrl = String(input.publicBaseUrl || "").trim() || `http://localhost:${hivePort}`;
  const adminUsername = String(input.adminUsername || "").trim();
  const adminPin = String(input.adminPin || "").trim();
  if (!adminUsername) {
    const err = new Error("Admin username is required");
    err.status = 400;
    throw err;
  }
  if (!/^\d{4,10}$/.test(adminPin)) {
    const err = new Error("Admin PIN must be 4-10 digits");
    err.status = 400;
    throw err;
  }

  try {
    await ensureHiveSkeleton(dataFolder);
  } catch (fsErr) {
    const err = new Error(`Couldn't create that folder (${fsErr.code || fsErr.message}). Check the drive letter exists and you have permission to write there.`);
    err.status = 400;
    throw err;
  }

  const hiveEnvPath = path.join(hiveServerDir, ".env");
  const hiveEnvExample = path.join(hiveServerDir, ".env.example");
  const existingApiKey = readEnvValue(hiveEnvPath, "HIVE_API_KEY");
  const existingSessionSecret = readEnvValue(hiveEnvPath, "SESSION_SECRET");
  const hiveApiKey = existingApiKey || randomSecret();
  const sessionSecret = existingSessionSecret || randomSecret();

  await upsertEnvFile(hiveEnvPath, hiveEnvExample, {
    HIVE_ROOT: dataFolder,
    HIVE_API_KEY: hiveApiKey,
    SESSION_SECRET: sessionSecret,
    PORT: hivePort,
    PUBLIC_BASE_URL: publicBaseUrl,
  });

  const panelEnvPath = path.join(panelDir, ".env");
  const panelEnvExample = path.join(panelDir, ".env.example");
  await upsertEnvFile(panelEnvPath, panelEnvExample, {
    PANEL_PORT: String(panelPort),
    HIVE_URL: `http://localhost:${hivePort}`,
    HIVE_API_KEY: hiveApiKey,
    HIVE_SERVER_DIR: hiveServerDir,
    HIVE_LOG_DIR: path.join(hiveServerDir, "logs"),
  });

  await upsertUser(adminUsername, adminPin, "admin");

  return { hiveApiKey, hiveUrl: `http://localhost:${hivePort}`, dataFolder };
}

// Best-effort: start the Hive server if it isn't already responding. Never
// throws - setup should succeed even if this fails, the user can start it
// manually (or it's already running as a service).
export async function tryStartHiveServer(hiveServerDir, hiveUrl) {
  try {
    const resp = await fetch(new URL("/api/ping", hiveUrl), { signal: AbortSignal.timeout(3000) });
    if (resp.ok) return { started: false, reason: "already running" };
  } catch {
    // not reachable - fall through and try to start it
  }
  try {
    const { spawn } = await import("child_process");
    const child = spawn("node", ["server.js"], {
      cwd: hiveServerDir,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return { started: true };
  } catch (err) {
    return { started: false, reason: err.message };
  }
}

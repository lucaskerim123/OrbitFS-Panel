import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PLUGINS_DIR = path.join(__dirname, "plugins");
const STATE_PATH = path.join(__dirname, "runtime", "addons.json");

export const ADDONS = {
  workspaces: {
    id: "workspaces",
    name: "OrbitFS Workspaces",
    description: "Branched workspaces, members, roles, invitations and workspace permissions.",
    folderName: "OrbitFS Workspaces",
    requiredFiles: ["manifest.json", "public/workspace-ui.js"],
  },
  sorter: {
    id: "sorter",
    name: "OrbitFS Sorter",
    description: "Workspace inbox scanning, sorting previews and learned destinations.",
    folderName: "OrbitFS Sorter",
    requiredFiles: ["server.js", "package.json"],
  },
};
function addonFolder(definition) {
  return path.join(PLUGINS_DIR, definition.folderName);
}

async function readState() {
  try {
    const parsed = JSON.parse(await fs.readFile(STATE_PATH, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeState(state) {
  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
  const temp = `${STATE_PATH}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await fs.rename(temp, STATE_PATH);
}

function folderInstalled(definition) {
  const folder = addonFolder(definition);
  return fsSync.existsSync(folder)
    && definition.requiredFiles.every((file) => fsSync.existsSync(path.join(folder, file)));
}
export function addonPath(id) {
  const definition = ADDONS[id];
  if (!definition) throw new Error("Unknown addon");
  return addonFolder(definition);
}

export async function addonStatus(id, extra = {}) {
  const definition = ADDONS[id];
  if (!definition) throw new Error("Unknown addon");
  const state = await readState();
  const installed = folderInstalled(definition);
  if (!installed && state[id]?.attached) {
    state[id] = { ...(state[id] || {}), attached: false, detachedAt: new Date().toISOString(), reason: "folder_missing" };
    await writeState(state);
  }
  const attached = installed && state[id]?.attached === true;
  return {
    ...definition,
    folderPath: addonFolder(definition),
    installed,
    attached,
    status: !installed ? "uninstalled" : attached ? "attached" : "detached",
    ...extra,
  };
}
export async function addonEnabled(id) {
  const status = await addonStatus(id);
  return status.attached;
}

export async function listAddonStatuses(extraById = {}) {
  const statuses = [];
  for (const id of Object.keys(ADDONS)) {
    statuses.push(await addonStatus(id, extraById[id] || {}));
  }
  return statuses;
}

export async function attachAddon(id) {
  const definition = ADDONS[id];
  if (!definition) throw new Error("Unknown addon");
  if (!folderInstalled(definition)) {
    const error = new Error(`Place the ${definition.folderName} folder in the plugins folder before attaching it.`);
    error.status = 409;
    throw error;
  }
  const state = await readState();
  state[id] = { ...(state[id] || {}), attached: true, attachedAt: new Date().toISOString(), reason: null };
  await writeState(state);
  return addonStatus(id);
}
export async function detachAddon(id, { sorterOnline = false } = {}) {
  const definition = ADDONS[id];
  if (!definition) throw new Error("Unknown addon");
  if (id === "sorter" && sorterOnline) {
    const error = new Error("Stop the Sorter service in Systems before detaching the addon.");
    error.status = 409;
    throw error;
  }
  const state = await readState();
  state[id] = { ...(state[id] || {}), attached: false, detachedAt: new Date().toISOString(), reason: "manual" };
  await writeState(state);
  return addonStatus(id, id === "sorter" ? { online: false } : {});
}

export async function initialiseAddonState() {
  const state = await readState();
  let changed = false;
  for (const [id, definition] of Object.entries(ADDONS)) {
    if (!state[id] && folderInstalled(definition)) {
      state[id] = { attached: true, attachedAt: new Date().toISOString(), migrated: true };
      changed = true;
    }
  }
  if (changed) await writeState(state);
  return state;
}

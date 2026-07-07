import fs from "fs/promises";
import { minimatch } from "minimatch";

const STATE_PATH = process.env.SYNC_STATE_PATH || "./sync-state.json";
const HISTORY_PATH = process.env.SYNC_HISTORY_PATH || "./sync-history.jsonl";
const MAX_HISTORY_LINES = 500;

async function loadState() {
  try {
    return JSON.parse(await fs.readFile(STATE_PATH, "utf-8"));
  } catch {
    return {};
  }
}

async function saveState(state) {
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

async function appendHistory(entries) {
  if (!entries.length) return;
  const lines = entries.map((e) => JSON.stringify({ ...e, timestamp: new Date().toISOString() }));
  await fs.appendFile(HISTORY_PATH, lines.join("\n") + "\n", "utf-8");
  await trimHistory();
}

async function trimHistory() {
  try {
    const raw = await fs.readFile(HISTORY_PATH, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    if (lines.length > MAX_HISTORY_LINES) {
      await fs.writeFile(HISTORY_PATH, lines.slice(-MAX_HISTORY_LINES).join("\n") + "\n", "utf-8");
    }
  } catch {
    // no history file yet
  }
}

export async function readHistory(limit = 100) {
  try {
    const raw = await fs.readFile(HISTORY_PATH, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    return lines.slice(-limit).reverse().map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function isIncluded(path, config) {
  const included = config.include.some((p) => minimatch(path, p));
  const excluded = config.exclude.some((p) => minimatch(path, p));
  return included && !excluded;
}

function toMap(manifest) {
  const map = {};
  for (const entry of manifest) map[entry.path] = entry;
  return map;
}

function planOps(pcMap, vpsMap, lastState, config) {
  const allPaths = new Set([...Object.keys(pcMap), ...Object.keys(vpsMap), ...Object.keys(lastState)]);
  const ops = [];
  const settledState = {}; // paths that are already in sync and need no op this run

  for (const path of allPaths) {
    if (!isIncluded(path, config)) continue;
    const pc = pcMap[path];
    const vps = vpsMap[path];
    const last = lastState[path];

    if (pc && vps) {
      if (pc.sha256 === vps.sha256) {
        settledState[path] = pc;
      } else {
        const pcNewer = new Date(pc.mtime) >= new Date(vps.mtime);
        ops.push({
          type: "copy",
          path,
          from: pcNewer ? "pc" : "vps",
          to: pcNewer ? "vps" : "pc",
          entryOnSuccess: pcNewer ? pc : vps,
        });
      }
    } else if (pc && !vps) {
      if (last && last.sha256 === pc.sha256) {
        ops.push({ type: "delete", path, on: "pc", entryOnSuccess: null });
      } else {
        ops.push({ type: "copy", path, from: "pc", to: "vps", entryOnSuccess: pc });
      }
    } else if (!pc && vps) {
      if (last && last.sha256 === vps.sha256) {
        ops.push({ type: "delete", path, on: "vps", entryOnSuccess: null });
      } else {
        ops.push({ type: "copy", path, from: "vps", to: "pc", entryOnSuccess: vps });
      }
    }
    // else: gone from both sides and not settled - simply drop from state below.
  }

  return { ops, settledState };
}

function allowedByDirection(op, direction) {
  if (direction === "two-way") return true;
  const target = op.type === "copy" ? op.to : op.on;
  if (direction === "pc-to-vps") return target === "vps";
  if (direction === "vps-to-pc") return target === "pc";
  return true;
}

export async function runSync(pcClient, vpsClient, config) {
  const [pcManifest, vpsManifest] = await Promise.all([pcClient.manifest(), vpsClient.manifest()]);
  const lastState = await loadState();
  const { ops, settledState } = planOps(toMap(pcManifest), toMap(vpsManifest), lastState, config);

  const clients = { pc: pcClient, vps: vpsClient };
  const nextState = { ...settledState };
  const results = [];

  for (const op of ops) {
    const { entryOnSuccess, ...opInfo } = op;
    if (!allowedByDirection(op, config.direction)) {
      if (lastState[op.path]) nextState[op.path] = lastState[op.path];
      continue;
    }
    try {
      if (op.type === "copy") {
        const content = await clients[op.from].readFile(op.path);
        await clients[op.to].writeFile(op.path, content);
      } else {
        await clients[op.on].deleteFile(op.path);
      }
      results.push({ ...opInfo, result: "ok" });
      if (entryOnSuccess) nextState[op.path] = entryOnSuccess;
    } catch (err) {
      results.push({ ...opInfo, result: "error", error: err.message });
      if (lastState[op.path]) nextState[op.path] = lastState[op.path];
    }
  }

  await appendHistory(results);
  await saveState(nextState);
  return results;
}

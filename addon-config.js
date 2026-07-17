import fsSync from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { isPathInParkedAddons } from "./addons.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function validSorterDir(candidate) {
  return !!candidate
    && !isPathInParkedAddons(candidate)
    && fsSync.existsSync(path.join(candidate, "server.js"));
}

export function loadAddonConfig(rootDir = __dirname) {
  const defaultSorterDir = path.join(rootDir, "plugins", "OrbitFS Sorter");
  const sorterDir = validSorterDir(process.env.SORTER_DIR)
    ? process.env.SORTER_DIR
    : defaultSorterDir;

  const mcpDir = process.env.HIVE_SERVER_DIR || "F:\\OrbitFS Project\\orbitfs-mcp";
  const mcpPort = Number(process.env.HIVE_PORT || 3939);
  const sorterPort = Number(process.env.SORTER_PORT || 4055);
  return {
    panel: {
      serviceName: process.env.PANEL_SERVICE_NAME || "OrbitFSPanel",
      port: Number(process.env.PANEL_PORT || 4000),
    },
    tunnel: {
      serviceName: process.env.CLOUDFLARED_SERVICE_NAME || "OrbitFSTunnel",
      path: process.env.CLOUDFLARED_DIR || "C:\\cloudflared",
    },
    mcp: {
      id: "mcp",
      serviceName: process.env.HIVE_SERVICE_NAME || "OrbitFSMcpServer",
      path: mcpDir,
      logDir: process.env.HIVE_LOG_DIR || path.join(mcpDir, "logs"),
      port: mcpPort,
      url: process.env.HIVE_URL || `http://localhost:${mcpPort}`,
    },
    sorter: {
      id: "sorter",
      serviceName: process.env.SORTER_SERVICE_NAME || "OrbitFSSorter",
      path: sorterDir,
      defaultPath: defaultSorterDir,
      port: sorterPort,
      url: process.env.SORTER_URL || `http://localhost:${sorterPort}`,
    },
    workspaces: {
      id: "workspaces",
      root: process.env.WORKSPACES_ROOT || "F:\\OrbitFS Project\\Branched Workspaces",
    },
  };
}

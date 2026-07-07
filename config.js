import fs from "fs/promises";

const CONFIG_PATH = process.env.SYNC_CONFIG_PATH || "./config.json";

const DEFAULT_CONFIG = {
  direction: "two-way", // two-way | pc-to-vps | vps-to-pc
  intervalMinutes: 15, // 0 disables the automatic schedule
  include: ["**"],
  exclude: [],
};

export async function loadConfig() {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf-8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveConfig(config) {
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

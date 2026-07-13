import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import dotenv from "dotenv";

export function resolveLocalHiveRoot(hiveServerDir) {
  try {
    const parsed = dotenv.parse(fsSync.readFileSync(path.join(hiveServerDir, ".env"), "utf8"));
    return parsed.HIVE_ROOT || null;
  } catch { return null; }
}

function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString("utf16le");
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return buf.slice(2).swap16().toString("utf16le");
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.slice(3).toString("utf-8");
  return buf.toString("utf-8");
}

export function makeLocalOps(root) {
  const ROOT = path.resolve(root);
  function safeResolve(rel) {
    const full = path.resolve(ROOT, rel || ".");
    if (full !== ROOT && !full.startsWith(ROOT + path.sep)) throw new Error("Path escapes the workspace root");
    return full;
  }

  async function listFiles(subpath) {
    const dir = safeResolve(subpath);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return Promise.all(entries.map(async (e) => {
      if (e.isDirectory()) return { name: e.name, type: "dir" };
      const stat = await fs.stat(path.join(dir, e.name));
      return { name: e.name, type: "file", size: stat.size, mtime: stat.mtime.toISOString() };
    }));
  }

  async function readFile(filepath) { return decodeText(await fs.readFile(safeResolve(filepath))); }
  async function writeFile(filepath, content) {
    const full = safeResolve(filepath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content ?? "", "utf8");
  }
  async function writeBuffer(filepath, buffer) {
    const full = safeResolve(filepath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, buffer);
  }
  async function mkdir(filepath) { await fs.mkdir(safeResolve(filepath), { recursive: true }); }
  async function moveFile(from, to) {
    const source = safeResolve(from);
    const target = safeResolve(to);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rename(source, target);
  }
  async function deleteFile(filepath) {
    await fs.rm(safeResolve(filepath), { recursive: true, force: false });
  }
  async function moveToTrash(filepath) {
    const source = safeResolve(filepath);
    const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(16).slice(2, 8)}`;
    const trashDir = safeResolve(path.join("_trash", stamp));
    await fs.mkdir(trashDir, { recursive: true });
    const target = path.join(trashDir, path.basename(source));
    await fs.rename(source, target);
    return { ok: true, trashPath: path.relative(ROOT, target).replace(/\\/g, "/") };
  }
  async function downloadStream(filepath) {
    const full = safeResolve(filepath);
    const stat = await fs.stat(full);
    if (!stat.isFile()) throw new Error("Not a file");
    return { stream: fsSync.createReadStream(full), filename: path.basename(full), size: stat.size };
  }
  async function fileSize(filepath) {
    try { return (await fs.stat(safeResolve(filepath))).size; }
    catch (error) { if (error.code === "ENOENT") return 0; throw error; }
  }

  return {
    ROOT, safeResolve, listFiles, readFile, writeFile, writeBuffer,
    mkdir, moveFile, deleteFile, moveToTrash, downloadStream, fileSize,
  };
}

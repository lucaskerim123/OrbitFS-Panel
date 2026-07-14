import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(APP_DIR, '.env') });
// Sorter now lives under orbitfs-panel/plugins/OrbitFS Sorter. It prefers its own
// .env, but can still fall back to the main MCP server's .env for HIVE_ROOT
// on installs where the sorter-specific env hasn't been generated yet.
const mcpEnvPath = path.resolve(APP_DIR, '..', '..', '..', 'orbitfs-mcp', '.env');
const mcpEnv = await fs.readFile(mcpEnvPath, 'utf8').then(dotenv.parse).catch(() => ({}));
const config = JSON.parse(await fs.readFile(path.join(APP_DIR, 'config.json'), 'utf8'));
const RULES_FILE = path.join(APP_DIR, 'sorter-rules.json');
const LEARNED_RULES_FILE = path.join(APP_DIR, 'sorter-learned.json');
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'onto', 'file',
  'copy', 'scan', 'page', 'pages', 'document', 'docs', 'new', 'final', 'draft',
  'luke', 'jade', 'laura', '2024', '2025', '2026'
]);

export const HIVE_ROOT = process.env.SORTER_HIVE_ROOT || process.env.HIVE_ROOT || mcpEnv.HIVE_ROOT || config.hiveRoot;
export const SORTER_DIR = process.env.SORTER_FOLDER || config.sorterFolder || '_sorter';
export const TRASH_DIR = process.env.TRASH_FOLDER || config.trashFolder || '_trash';
export const INDEX_REL = process.env.SORTER_INDEX_PATH || config.indexPath || '_system/Index/folder_index.json';

function rootPath() {
  return path.resolve(HIVE_ROOT);
}

function relFromRoot(full) {
  return path.relative(rootPath(), full).split(path.sep).join('/');
}

export function safeJoin(...parts) {
  const full = path.resolve(rootPath(), ...parts);
  if (!full.startsWith(rootPath())) throw new Error('Path escapes OrbitFS root');
  return full;
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/[_\-.]+/g, ' ');
}

function tokenize(s) {
  return [...new Set(
    norm(s)
      .split(/[^a-z0-9]+/)
      .map((part) => part.trim())
      .filter((part) => part.length >= 3 && !STOP_WORDS.has(part))
  )];
}

function defaultLearnedRules() {
  return { version: 1, extensionFolders: {}, tokenFolders: {} };
}

async function loadJson(filepath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filepath, 'utf8'));
  } catch {
    return fallback;
  }
}

async function saveJson(filepath, data) {
  await fs.writeFile(filepath, JSON.stringify(data, null, 2), 'utf8');
}

async function loadSorterRules() {
  return loadJson(RULES_FILE, []);
}

async function loadLearnedRules() {
  return loadJson(LEARNED_RULES_FILE, defaultLearnedRules());
}

async function walk(dir, out = { folders: [], files: [] }) {
  let entries = [];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    const rel = relFromRoot(full);
    if (ent.isDirectory()) {
      out.folders.push(rel);
      await walk(full, out);
    } else {
      const st = await fs.stat(full);
      out.files.push({ path: rel, name: ent.name, size: st.size, mtime: st.mtime.toISOString() });
    }
  }
  return out;
}

function isHiddenDestination(rel) {
  const parts = rel.split('/');
  return parts.includes(SORTER_DIR) || parts.includes(TRASH_DIR);
}

export async function buildFolderIndex() {
  const tree = await walk(rootPath());
  const folders = tree.folders
    .filter(p => !isHiddenDestination(p))
    .map(p => ({
      path: p,
      name: path.basename(p),
      meaning: norm(p),
      suggestable: true
    }));
  const index = { root: HIVE_ROOT, builtAt: new Date().toISOString(), folders };
  const indexPath = safeJoin(INDEX_REL);
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  await fs.writeFile(indexPath, JSON.stringify(index, null, 2), 'utf8');
  return index;
}

function scoreFolder(folder, terms, preferredFolders = []) {
  const text = folder.meaning;
  let score = terms.reduce((n, term) => n + (text.includes(norm(term)) ? 10 : 0), 0);
  for (const preferred of preferredFolders) {
    const normalizedPreferred = norm(preferred);
    const normalizedPath = norm(folder.path);
    const normalizedName = norm(folder.name);
    if (normalizedPath === normalizedPreferred || normalizedPath.startsWith(`${normalizedPreferred} `) || normalizedPath.startsWith(`${normalizedPreferred}/`)) score += 60;
    else if (normalizedName === normalizedPreferred || normalizedName.includes(normalizedPreferred)) score += 30;
  }
  return score;
}

function findPreferredFolder(index, preferredFolders = []) {
  for (const preferred of preferredFolders) {
    const wanted = norm(preferred);
    const exact = index.folders.find((folder) => norm(folder.path) === wanted || norm(folder.name) === wanted);
    if (exact) return exact.path;
  }
  return null;
}

function bestFolder(index, terms, preferredFolders = [], fallback = []) {
  let best = null;
  for (const folder of index.folders) {
    let score = scoreFolder(folder, terms, preferredFolders);
    if (!score && fallback.length) score = scoreFolder(folder, fallback, preferredFolders);
    if (!best || score > best.score) best = { folder, score };
  }
  if (best?.score > 0) return best.folder.path;
  return findPreferredFolder(index, preferredFolders);
}

function matchRule(file, rule) {
  const text = norm(`${file.path} ${file.name}`);
  const ext = path.extname(file.name).toLowerCase();
  const extensions = rule.extensions || [];
  const containsAny = rule.containsAny || [];
  const regexes = rule.regexes || [];
  if (extensions.length && !extensions.includes(ext)) return false;
  if (containsAny.length && !containsAny.some((term) => text.includes(norm(term)))) return false;
  if (regexes.length && !regexes.some((pattern) => new RegExp(pattern, 'i').test(text))) return false;
  return extensions.length || containsAny.length || regexes.length;
}

function builtInFallback(file) {
  const text = norm(`${file.path} ${file.name}`);
  const ext = path.extname(file.name).toLowerCase();
  if (['.mp3', '.wav', '.m4a'].includes(ext)) return { type: 'Audio', hints: ['audio', 'media'], preferredFolders: ['_media'] };
  if (['.mp4', '.mov', '.avi'].includes(ext)) return { type: 'Video', hints: ['video', 'media'], preferredFolders: ['_media'] };
  if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) return { type: 'Images', hints: ['photo', 'image', 'media'], preferredFolders: ['_media'] };
  if (/mental|wellbeing|session|mood|sleep|vent|therapy/.test(text)) {
    return { type: 'Wellbeing', hints: ['wellbeing', 'mental', 'notes'], preferredFolders: ['2. Wellbeing'] };
  }
  if (/statement|witness|victim|police|court|hearing|avo|charge|order|affidavit|mention|adjourn/.test(text)) {
    return { type: 'Legal', hints: ['legal', 'court', 'documents'], preferredFolders: ['1. Legal'] };
  }
  if (['.md', '.txt', '.doc', '.docx', '.pdf'].includes(ext)) {
    return { type: 'Documents', hints: ['documents', 'imports', 'notes'], preferredFolders: ['0. Core'] };
  }
  return { type: 'Needs Review', hints: ['imports', 'intake', 'notes'], preferredFolders: ['0. Core'] };
}

function bestLearnedFolder(index, learned, file) {
  const ext = path.extname(file.name).toLowerCase();
  const tokens = tokenize(file.name);
  const scores = new Map();
  const addScore = (folder, value) => scores.set(folder, (scores.get(folder) || 0) + value);

  if (ext && learned.extensionFolders?.[ext]) {
    for (const [folder, count] of Object.entries(learned.extensionFolders[ext])) addScore(folder, count * 20);
  }
  for (const token of tokens) {
    const tokenMap = learned.tokenFolders?.[token];
    if (!tokenMap) continue;
    for (const [folder, count] of Object.entries(tokenMap)) addScore(folder, count * 8);
  }

  let best = null;
  for (const folder of index.folders) {
    const score = scores.get(folder.path) || 0;
    if (!best || score > best.score) best = { path: folder.path, score };
  }
  return best?.score > 0 ? best.path : null;
}

function classify(file, index, rules, learned) {
  for (const rule of rules) {
    if (!matchRule(file, rule)) continue;
    const destinationFolder = bestFolder(index, rule.destinationHints || [], rule.preferredFolders || [], rule.fallbackHints || []);
    return {
      type: rule.classification || rule.name || 'Rule Match',
      destinationFolder,
      reason: `Rule matched: ${rule.name || rule.classification || 'custom rule'}`
    };
  }

  const learnedFolder = bestLearnedFolder(index, learned, file);
  if (learnedFolder) {
    return {
      type: 'Learned Match',
      destinationFolder: learnedFolder,
      reason: 'Learned from previous confirmed sorts'
    };
  }

  const fallback = builtInFallback(file);
  return {
    type: fallback.type,
    destinationFolder: bestFolder(index, fallback.hints, fallback.preferredFolders, ['imports', 'needs review']),
    reason: `Fallback matched: ${fallback.type}`
  };
}

function incrementNestedCounter(map, key, folder, amount = 1) {
  if (!map[key]) map[key] = {};
  map[key][folder] = (map[key][folder] || 0) + amount;
}

function recordLearnedDestination(learned, itemName, destinationPath) {
  const folder = path.posix.dirname(destinationPath).replace(/\\/g, '/');
  const ext = path.extname(itemName).toLowerCase();
  if (ext) incrementNestedCounter(learned.extensionFolders, ext, folder, 1);
  for (const token of tokenize(itemName)) incrementNestedCounter(learned.tokenFolders, token, folder, 1);
}
export async function startSorter() {
  const index = await buildFolderIndex();
  const rules = await loadSorterRules();
  const learned = await loadLearnedRules();
  const sorterTree = await walk(safeJoin(SORTER_DIR));
  const suggestions = sorterTree.files.map(file => {
    const cls = classify(file, index, rules, learned);
    const destFolder = cls.destinationFolder;
    const destination = destFolder ? `${destFolder}/${file.name}` : '';
    return {
      id: Buffer.from(file.path).toString('base64url'),
      source: file.path,
      name: file.name,
      classification: cls.type,
      reason: `Meaning matched: ${cls.type}`,
      selectedDestination: destination,
      approved: false,
      status: destination ? 'preview' : 'needs_destination'
    };
  });
  return { status: 'preview', safeMode: true, startedAt: new Date().toISOString(), items: suggestions, index };
}
async function uniqueDest(dest) {
  const parsed = path.parse(dest);
  let candidate = dest;
  let n = 1;
  while (true) {
    try { await fs.access(candidate); }
    catch { return candidate; }
    candidate = path.join(parsed.dir, `${parsed.name} (${n++})${parsed.ext}`);
  }
}

export async function confirmSorter(items) {
  const moved = [];
  const skipped = [];
  const learned = await loadLearnedRules();
  for (const item of items || []) {
    if (!item.approved) { skipped.push({ ...item, reason: 'not approved' }); continue; }
    if (!item.source?.startsWith(`${SORTER_DIR}/`)) { skipped.push({ ...item, reason: 'source not in sorter' }); continue; }
    if (!item.selectedDestination || isHiddenDestination(item.selectedDestination)) { skipped.push({ ...item, reason: 'blocked destination' }); continue; }
    const src = safeJoin(item.source);
    const dest = await uniqueDest(safeJoin(item.selectedDestination));
    await fs.rename(src, dest);
    recordLearnedDestination(learned, item.name, relFromRoot(dest));
    moved.push({ source: item.source, destination: relFromRoot(dest) });
  }
  await saveJson(LEARNED_RULES_FILE, learned);
  return { status: 'confirmed', confirmedAt: new Date().toISOString(), moved, skipped };
}

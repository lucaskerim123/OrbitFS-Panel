from pathlib import Path
p = Path(r'F:\OrbitFS Project\OrbitFS-Panel')
server = p/'server.js'
app = p/'public'/'app.js'
index = p/'public'/'index.html'

s = server.read_text(encoding='utf-8')
# add crypto import if missing
s = s.replace('import { Readable } from "stream";\n', 'import { Readable } from "stream";\nimport crypto from "crypto";\n')
# add share constants after localOps
anchor = 'const localOps = localOrbitFSRoot ? makeLocalOps(localOrbitFSRoot) : null;\n'
insert = '''const SHARE_LINKS_PATH = path.join(__dirname, "runtime", "share-links.json");
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
  const configured = String(process.env.PANEL_PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  if (configured) return configured;
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
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
  return { token, ...links[token], url: `${shareBaseUrl(req)}/share/${token}` };
}

'''
if insert not in s:
    s = s.replace(anchor, anchor + insert)
# add public route before /api/preview
route_anchor = '// View raw bytes in the panel under read permission without granting the\n'
share_routes = '''app.post("/api/share", express.json(), async (req, res) => {
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

app.get("/share/:token", async (req, res) => {
  try {
    const link = await getShareLink(req.params.token);
    if (!link) return res.status(404).send("Share link expired or not found.");
    res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OrbitFS shared file</title><style>body{margin:0;background:#0b1019;color:#edf3ff;font-family:Inter,system-ui,sans-serif;display:grid;min-height:100vh;place-items:center;padding:18px}.card{width:min(520px,100%);background:#141c29;border:1px solid #2b374c;border-radius:18px;padding:18px;box-shadow:0 18px 60px rgba(0,0,0,.35)}h1{font-size:1.1rem;margin:.2rem 0 .6rem}.path{overflow-wrap:anywhere;color:#aebbd0;font-size:.9rem}.btn{display:block;text-align:center;margin-top:16px;padding:13px;border-radius:12px;background:#3973c8;color:white;text-decoration:none;font-weight:800}.muted{color:#98a6bd;font-size:.8rem;margin-top:12px}</style></head><body><main class="card"><h1>OrbitFS shared file</h1><p class="path">${escapeHtml(link.path)}</p><a class="btn" href="/share/${req.params.token}/download">Download file</a><p class="muted">No account required. Link expires ${escapeHtml(new Date(link.expiresAt).toLocaleString())}.</p></main></body></html>`);
  } catch (err) {
    res.status(500).send("Share link failed.");
  }
});

app.get("/share/:token/download", async (req, res) => {
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
});

'''
if share_routes not in s:
    s = s.replace(route_anchor, share_routes + route_anchor)
server.write_text(s, encoding='utf-8')

js = app.read_text(encoding='utf-8')
# Add share button after export row button
old = '''    ex.addEventListener("click", (e) => { e.stopPropagation(); exportFile(full); });
    actions.appendChild(ex);
  }
'''
new = '''    ex.addEventListener("click", (e) => { e.stopPropagation(); exportFile(full); });
    actions.appendChild(ex);

    const sh = document.createElement("button");
    sh.className = "icon-btn";
    sh.textContent = "🔗";
    sh.title = "Create no-login share link";
    sh.addEventListener("click", (e) => { e.stopPropagation(); shareFile(full); });
    actions.appendChild(sh);
  }
'''
if old in js and new not in js:
    js = js.replace(old, new)
# toggle preview share button
old = '  document.getElementById("preview-export-btn").classList.toggle("hidden", !state.currentPermissions.download);\n'
new = old + '  document.getElementById("preview-share-btn")?.classList.toggle("hidden", !state.currentPermissions.download);\n'
if old in js and 'preview-share-btn")?.classList.toggle' not in js:
    js = js.replace(old, new)
# event listener
old = 'document.getElementById("preview-export-btn").addEventListener("click", () => state.previewFile && exportFile(state.previewFile));\n'
new = old + 'document.getElementById("preview-share-btn")?.addEventListener("click", () => state.previewFile && shareFile(state.previewFile));\n'
if old in js and 'preview-share-btn")?.addEventListener' not in js:
    js = js.replace(old, new)
# add shareFile before downloadFile
anchor = 'async function downloadFile(filepath) {\n'
func = '''async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.left = "-9999px";
  document.body.appendChild(area);
  area.focus();
  area.select();
  const ok = document.execCommand("copy");
  area.remove();
  return ok;
}

async function shareFile(filepath) {
  try {
    const daysRaw = prompt("Share link expires after how many days?", "7");
    if (daysRaw === null) return;
    const days = Math.max(1, Math.min(30, Number(daysRaw) || 7));
    const resp = await api("/api/share", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: filepath, days }),
    });
    const copied = await copyText(resp.url).catch(() => false);
    alert(copied ? `Share link copied. Expires: ${new Date(resp.expiresAt).toLocaleString()}` : `Share link:\n${resp.url}`);
  } catch (err) {
    alert(err.message);
  }
}

'''
if func not in js:
    js = js.replace(anchor, func + anchor)
app.write_text(js, encoding='utf-8')

html = index.read_text(encoding='utf-8')
old = '              <button id="preview-export-btn">Export</button>\n'
new = old + '              <button id="preview-share-btn">Share</button>\n'
if old in html and 'preview-share-btn' not in html:
    html = html.replace(old, new)
index.write_text(html, encoding='utf-8')
print('patched share links')

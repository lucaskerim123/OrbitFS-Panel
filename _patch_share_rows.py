from pathlib import Path
p = Path(r"F:\OrbitFS Project\OrbitFS-Panel\server.js")
s = p.read_text(encoding="utf-8")
s = s.replace(
'''function shareBaseUrl(req) {
  const configured = String(process.env.PANEL_PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL || "").trim().replace(/\\/+$/, "");
  if (configured) return configured;
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}
''',
'''function shareBaseUrl(req) {
  const configured = String(process.env.PANEL_PUBLIC_BASE_URL || "").trim().replace(/\\/+$/, "");
  if (configured) return configured;
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "https").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  return host ? `${proto}://${host}` : "";
}
''')
s = s.replace('''  return { token, ...links[token], url: `${shareBaseUrl(req)}/share/${token}` };''','''  const base = shareBaseUrl(req);
  return { token, ...links[token], url: `${base}/s/${token}`, legacyUrl: `${base}/share/${token}` };''')
old = '''app.get("/share/:token", async (req, res) => {
  try {
    const link = await getShareLink(req.params.token);
    if (!link) return res.status(404).send("Share link expired or not found.");
    res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OrbitFS shared file</title><style>body{margin:0;background:#07101d;color:#edf3ff;font-family:Inter,system-ui,sans-serif;min-height:100vh;display:grid;place-items:center;padding:18px;overflow:hidden}body:before{content:"";position:fixed;inset:-20%;background:radial-gradient(circle at 20% 20%,rgba(57,115,200,.24),transparent 32%),radial-gradient(circle at 85% 70%,rgba(69,205,180,.14),transparent 34%),linear-gradient(135deg,#07101d,#101827 55%,#07101d);z-index:-2}.promo-bg{position:fixed;left:0;right:0;bottom:0;padding:14px 18px;background:linear-gradient(90deg,rgba(57,115,200,.18),rgba(20,28,41,.86));border-top:1px solid rgba(120,168,255,.28);backdrop-filter:blur(10px);text-align:center;color:#cbd6e8;font-size:.92rem}.promo-bg a{color:#8bb5ff;font-weight:900;text-decoration:none}.card{width:min(520px,100%);background:rgba(20,28,41,.92);border:1px solid #2b374c;border-radius:18px;padding:18px;box-shadow:0 18px 60px rgba(0,0,0,.35);backdrop-filter:blur(14px)}h1{font-size:1.1rem;margin:.2rem 0 .6rem}.path{overflow-wrap:anywhere;color:#aebbd0;font-size:.9rem}.btn{display:block;text-align:center;margin-top:16px;padding:13px;border-radius:12px;background:#3973c8;color:white;text-decoration:none;font-weight:800}.muted{color:#98a6bd;font-size:.8rem;margin-top:12px}</style></head><body><main class="card"><h1>OrbitFS shared file</h1><p class="path">${escapeHtml(link.path)}</p><a class="btn" href="/share/${req.params.token}/download">Download file</a><p class="muted">No account required. Link expires ${escapeHtml(new Date(link.expiresAt).toLocaleString())}.</p></main><div class="promo-bg">Want your own workspace? Come check us out at <a href="${shareBaseUrl(req)}">${escapeHtml(shareBaseUrl(req))}</a></div></body></html>`);
  } catch (err) {
    res.status(500).send("Share link failed.");
  }
});

app.get("/share/:token/download", async (req, res) => {
'''
new = '''async function renderSharePage(req, res) {
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
'''
if old not in s:
    raise SystemExit('share page block not found')
s = s.replace(old,new)
s = s.replace('''app.get("/share/:token/download", async (req, res) => {
  try {
    const links = await pruneShareLinks(await readShareLinks());''','''app.get("/s/:token/download", downloadSharedFile);
app.get("/share/:token/download", downloadSharedFile);

async function downloadSharedFile(req, res) {
  try {
    const links = await pruneShareLinks(await readShareLinks());''')
s = s.replace('''  } catch (err) {
    res.status(404).send("File unavailable.");
  }
});

// View raw bytes''','''  } catch (err) {
    res.status(404).send("File unavailable.");
  }
}

// View raw bytes''',1)
p.write_text(s,encoding="utf-8")

p = Path(r"F:\OrbitFS Project\OrbitFS-Panel\public\app.js")
s = p.read_text(encoding="utf-8")
old = '''  if (entry.type === "file" && permissions.download) {
    const dl = document.createElement("button");
    dl.className = "icon-btn";
    dl.textContent = "⬇";
    dl.title = "Download";
    dl.addEventListener("click", (e) => { e.stopPropagation(); downloadFile(full); });
    actions.appendChild(dl);

    const ex = document.createElement("button");
    ex.className = "icon-btn";
    ex.textContent = "⇩";
    ex.title = "Export as DOCX/PDF/TXT/HTML/MD";
    ex.addEventListener("click", (e) => { e.stopPropagation(); exportFile(full); });
    actions.appendChild(ex);

    const sh = document.createElement("button");
    sh.className = "icon-btn";
    sh.textContent = "🔗";
    sh.title = "Create no-login share link";
    sh.addEventListener("click", (e) => { e.stopPropagation(); shareFile(full); });
    actions.appendChild(sh);
  }

  if (permissions.move && !protectedRoot) {
    const mv = document.createElement("button");
    mv.className = "icon-btn";
    mv.textContent = "↦";
    mv.title = "Move / rename";
    mv.addEventListener("click", (e) => { e.stopPropagation(); openMovePicker(full); });
    actions.appendChild(mv);
  }

  if (permissions.delete && !protectedRoot) {
    const del = document.createElement("button");
    del.className = "icon-btn danger";
    del.textContent = "🗑";
    del.title = "Move to trash";
    del.addEventListener("click", (e) => { e.stopPropagation(); trashPath(full); });
    actions.appendChild(del);
  }
'''
new = '''  if (entry.type === "file") {
    const open = document.createElement("button");
    open.className = "icon-btn";
    open.textContent = "Edit";
    open.title = "Open file";
    open.addEventListener("click", (e) => { e.stopPropagation(); isTextFile(entry.name) ? openFile(full) : openPreview(full, entry); });
    actions.appendChild(open);

    if (permissions.download) {
      const sh = document.createElement("button");
      sh.className = "icon-btn";
      sh.textContent = "Share";
      sh.title = "Create no-login share link";
      sh.addEventListener("click", (e) => { e.stopPropagation(); shareFile(full); });
      actions.appendChild(sh);
    }
  }

  if (entry.type === "dir" && permissions.move && !protectedRoot) {
    const rn = document.createElement("button");
    rn.className = "icon-btn";
    rn.textContent = "Rename";
    rn.title = "Rename folder";
    rn.addEventListener("click", (e) => { e.stopPropagation(); openMovePicker(full); });
    actions.appendChild(rn);
  }

  if (permissions.move && !protectedRoot) {
    const mv = document.createElement("button");
    mv.className = "icon-btn";
    mv.textContent = "↦";
    mv.title = entry.type === "dir" ? "Move folder" : "Move file";
    mv.addEventListener("click", (e) => { e.stopPropagation(); openMovePicker(full); });
    actions.appendChild(mv);
  }

  if (permissions.delete && !protectedRoot) {
    const del = document.createElement("button");
    del.className = "icon-btn danger";
    del.textContent = "🗑";
    del.title = "Move to trash";
    del.addEventListener("click", (e) => { e.stopPropagation(); trashPath(full); });
    actions.appendChild(del);
  }
'''
if old not in s:
    raise SystemExit('row action block not found')
s = s.replace(old,new)
p.write_text(s,encoding="utf-8")

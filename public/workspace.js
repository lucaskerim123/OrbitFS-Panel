(() => {
  if (window.__orbitWorkspaceLoaded) return;
  window.__orbitWorkspaceLoaded = true;

  const CONTEXT_KEY = "orbitfsPanelContextFiles";
  const SETTINGS_KEY = "orbitfsWorkspaceSettings";
  const ACTIVITY_KEY = "orbitfsWorkspaceActivity";
  const workspace = { uploadFiles: [], treeLoaded: false };

  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const joinPath = (...parts) => parts.filter(Boolean).join("/").replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
  const nameOf = (filepath) => String(filepath || "").replace(/\\/g, "/").split("/").filter(Boolean).pop() || "";
  const parentOf = (filepath) => String(filepath || "").replace(/\\/g, "/").split("/").filter(Boolean).slice(0, -1).join("/");
  const formatCount = (value) => new Intl.NumberFormat().format(Number(value || 0));

  function readJson(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); }
    catch { return fallback; }
  }

  function writeJson(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
  function contextFiles() { return readJson(CONTEXT_KEY, []); }
  function saveContextFiles(files) { writeJson(CONTEXT_KEY, files); }
  function settings() { return { project: "Mental", strength: "med", ...readJson(SETTINGS_KEY, {}) }; }

  function recordActivity(action, detail) {
    const items = readJson(ACTIVITY_KEY, []);
    items.unshift({ action, detail, at: new Date().toISOString(), user: state.username || "" });
    writeJson(ACTIVITY_KEY, items.slice(0, 50));
    renderActivity();
  }

  function renderActivity() {
    const host = document.getElementById("dashboard-activity");
    if (!host) return;
    const items = readJson(ACTIVITY_KEY, []).slice(0, 10);
    host.innerHTML = items.length ? items.map((item) => `
      <div><strong>${esc(item.action)}</strong><span>${esc(item.detail)}</span><time>${new Date(item.at).toLocaleString()}</time></div>
    `).join("") : '<p class="muted-text">No workspace activity yet.</p>';
  }

  function makeTab(name, label) {
    const button = document.createElement("button");
    button.className = "tab-btn workspace-tab-btn";
    button.dataset.tab = name;
    button.textContent = label;
    return button;
  }

  function injectWorkspace() {
    const tabs = document.querySelector("nav.tabs");
    const filesTab = tabs?.querySelector('[data-tab="files"]');
    if (!tabs || !filesTab || document.getElementById("tab-dashboard")) return;

    tabs.insertBefore(makeTab("dashboard", "▦ Dashboard"), filesTab);
    const sorterTab = tabs.querySelector('[data-tab="sorter"]');
    tabs.insertBefore(makeTab("upload", "⬆ Upload"), sorterTab);
    tabs.insertBefore(makeTab("context", "◉ Context"), sorterTab);
    tabs.insertBefore(makeTab("ai", "✦ AI Actions"), sorterTab);

    const filesPanel = document.getElementById("tab-files");
    filesPanel.insertAdjacentHTML("beforebegin", `
      <section id="tab-dashboard" class="tab-panel workspace-panel">
        <div class="workspace-heading"><div><h2>Dashboard</h2><p>Hive overview and quick controls</p></div><button id="dashboard-refresh">⟳ Refresh</button></div>
        <div class="metric-grid">
          <article class="metric-card"><span>Hive server</span><strong id="dash-hive">Checking…</strong><small id="dash-fallback"></small></article>
          <article class="metric-card"><span>Root items</span><strong id="dash-root-count">—</strong><small id="dash-root-detail"></small></article>
          <article class="metric-card"><span>Context files</span><strong id="dash-context-count">0</strong><small id="dash-context-detail">0 characters</small></article>
          <article class="metric-card"><span>Workspace</span><strong id="dash-project">Mental · MED</strong><small id="dash-user"></small></article>
        </div>
        <div class="dashboard-grid">
          <article class="workspace-card"><h3>Quick actions</h3><div class="quick-actions"><button data-go="files">Browse files</button><button data-go="upload">Upload</button><button data-go="context">Manage context</button><button data-go="ai">Run AI action</button></div></article>
          <article class="workspace-card"><h3>Recent activity</h3><div id="dashboard-activity" class="activity-list"></div></article>
        </div>
      </section>`);

    filesPanel.insertAdjacentHTML("afterend", `
      <section id="tab-upload" class="tab-panel workspace-panel">
        <div class="workspace-heading"><div><h2>Upload</h2><p>New files go to <code>_sorter</code> unless another folder is selected.</p></div></div>
        <div class="workspace-card upload-card">
          <div id="workspace-dropzone" class="dropzone" tabindex="0"><strong>Drop files here</strong><span>or click to choose files</span></div>
          <input id="workspace-upload-input" class="hidden" type="file" multiple />
          <div class="form-grid">
            <label>Destination folder<input id="workspace-upload-destination" value="_sorter" autocomplete="off" spellcheck="false" /></label>
            <label>Duplicate handling<select id="workspace-upload-duplicate"><option value="rename">Rename automatically</option><option value="overwrite">Overwrite</option><option value="skip">Skip</option></select></label>
            <label>Tags<input id="workspace-upload-tags" placeholder="optional, comma separated" /></label>
            <label class="check-label"><input id="workspace-upload-context" type="checkbox" /> Add uploaded files to context</label>
          </div>
          <div id="workspace-upload-queue" class="upload-queue"><p class="muted-text">No files selected.</p></div>
          <div class="panel-actions"><button id="workspace-upload-clear">Clear</button><button id="workspace-upload-start" class="primary">Upload files</button></div>
        </div>
      </section>
      <section id="tab-context" class="tab-panel workspace-panel">
        <div class="workspace-heading"><div><h2>Context</h2><p>Manage the files available to AI Actions.</p></div><button id="context-refresh">⟳ Refresh</button></div>
        <div class="workspace-card">
          <div class="form-grid compact">
            <label>Project<select id="context-project"><option>Master</option><option>Court</option><option>Mental</option><option>Media</option><option>Combined</option></select></label>
            <label>Startup strength<select id="context-strength"><option value="low">Low</option><option value="med">Medium</option><option value="high">High</option></select></label>
            <label class="path-load-label">File or folder path<input id="context-path" placeholder="Hive path" autocomplete="off" spellcheck="false" /></label>
          </div>
          <div class="panel-actions wrap"><button id="context-load-path" class="primary">Load path</button><button id="context-load-profiles">Load all profiles</button><button id="context-unload-selected">Unload selected</button><button id="context-unload-profiles">Unload all profiles</button><button id="context-clear">Clear context</button></div>
          <div class="context-meter"><div><strong id="context-file-count">0 files</strong><span id="context-char-count">0 characters</span></div><div><strong id="context-token-count">≈ 0 tokens</strong><span id="context-status">No truncation</span></div></div>
        </div>
        <div class="workspace-card"><div class="context-list-head"><label><input id="context-select-all" type="checkbox" /> Select all</label><span>Status</span></div><div id="context-list" class="context-list"></div></div>
      </section>
      <section id="tab-ai" class="tab-panel workspace-panel">
        <div class="workspace-heading"><div><h2>AI Actions</h2><p>Actions use files loaded in Context. Outputs remain drafts until explicitly saved.</p></div></div>
        <div class="ai-layout">
          <aside class="workspace-card ai-actions">
            <button data-ai-action="summary">Summarise</button><button data-ai-action="compare">Compare files</button><button data-ai-action="timeline">Extract timeline</button><button data-ai-action="people">Extract people</button><button data-ai-action="contradictions">Find contradictions</button><button data-ai-action="profile">Generate profile</button><button data-ai-action="incident">Generate incident entry</button><button data-ai-action="draft">Create draft</button>
            <label>Ask context<textarea id="ai-question" rows="3" placeholder="Ask a question about loaded files"></textarea></label><button id="ai-ask" class="primary">Ask context</button>
          </aside>
          <article class="workspace-card ai-output-card"><div class="ai-output-head"><div><h3>Draft output</h3><p id="ai-output-meta" class="muted-text">Run an action to generate a draft.</p></div><div><button id="ai-copy">Copy</button><button id="ai-download">Download</button></div></div><textarea id="ai-output" spellcheck="false" placeholder="Draft output appears here"></textarea><div class="save-draft-row"><input id="ai-save-path" value="_sorter/AI Draft.md" spellcheck="false" /><button id="ai-save" class="primary">Save draft to Hive</button></div></article>
        </div>
      </section>`);

    const actionBar = filesPanel.querySelector(".action-bar");
    const search = document.createElement("input");
    search.id = "workspace-file-search";
    search.type = "search";
    search.placeholder = "Filter this folder…";
    actionBar.appendChild(search);

    const layout = document.getElementById("files-layout");
    const tree = document.createElement("aside");
    tree.id = "workspace-file-tree";
    tree.className = "workspace-file-tree";
    tree.innerHTML = '<div class="tree-head"><strong>Folders</strong><button id="tree-refresh" title="Refresh folder tree">⟳</button></div><div id="tree-body" class="tree-body"></div>';
    layout.insertBefore(tree, document.getElementById("file-list"));

    const editorContext = document.createElement("button");
    editorContext.id = "editor-context-btn";
    editorContext.textContent = "Add to Context";
    document.querySelector("#editor .editor-toolbar")?.insertBefore(editorContext, document.getElementById("save-file-btn"));
    const previewContext = document.createElement("button");
    previewContext.id = "preview-context-btn";
    previewContext.textContent = "Add to Context";
    document.querySelector("#preview .preview-actions")?.prepend(previewContext);
  }

  async function refreshDashboard() {
    const config = settings();
    document.getElementById("dash-project").textContent = `${config.project} · ${config.strength.toUpperCase()}`;
    document.getElementById("dash-user").textContent = `${state.username || ""}${state.role ? ` · ${state.role}` : ""}`;
    try {
      const status = await api("/api/status");
      const hive = document.getElementById("dash-hive");
      hive.textContent = status.hive.ok ? "Online" : "Offline";
      hive.className = status.hive.ok ? "metric-ok" : "metric-down";
      document.getElementById("dash-fallback").textContent = status.localFallback?.active ? "Local read fallback active" : status.hive.url || "";
    } catch (err) { document.getElementById("dash-hive").textContent = "Unavailable"; }
    try {
      const { entries = [] } = await api("/api/files?subpath=");
      const folders = entries.filter((entry) => entry.type === "dir").length;
      document.getElementById("dash-root-count").textContent = formatCount(entries.length);
      document.getElementById("dash-root-detail").textContent = `${folders} folders · ${entries.length - folders} files`;
    } catch {}
    renderActivity();
    renderContextSummary();
  }

  function filterCurrentFolder() {
    const query = (document.getElementById("workspace-file-search")?.value || "").trim().toLowerCase();
    document.querySelectorAll("#file-list > li").forEach((row) => {
      const name = row.querySelector(".row-name")?.textContent?.toLowerCase() || "";
      row.classList.toggle("workspace-filtered", !!query && !name.includes(query));
    });
  }

  function selectTreePath() {
    document.querySelectorAll(".tree-row").forEach((row) => row.classList.toggle("selected", row.dataset.path === state.subpath));
  }

  function treeRow(filepath, label, root = false) {
    const row = document.createElement("div");
    row.className = "tree-row";
    row.dataset.path = filepath;
    row.innerHTML = `<button class="tree-expand">${filepath ? "▸" : "⌂"}</button><button class="tree-name">${esc(label)}</button>`;
    row.querySelector(".tree-name").addEventListener("click", () => {
      if (typeof confirmDiscardIfDirty === "function" && !confirmDiscardIfDirty()) return;
      if (typeof closeAllPanels === "function") closeAllPanels();
      state.subpath = filepath;
      switchTab("files");
      loadFiles();
      selectTreePath();
    });
    if (filepath) row.querySelector(".tree-expand").addEventListener("click", () => expandTreeRow(row));
    if (root) row.classList.add("expanded");
    return row;
  }

  async function expandTreeRow(row) {
    let children = row.nextElementSibling;
    if (children?.classList.contains("tree-children")) {
      const hidden = children.classList.toggle("hidden");
      row.classList.toggle("expanded", !hidden);
      row.querySelector(".tree-expand").textContent = hidden ? "▸" : "▾";
      return;
    }
    row.querySelector(".tree-expand").textContent = "…";
    try {
      const { entries = [] } = await api(`/api/files?subpath=${encodeURIComponent(row.dataset.path)}`);
      children = document.createElement("div");
      children.className = "tree-children";
      entries.filter((entry) => entry.type === "dir").sort((a, b) => a.name.localeCompare(b.name)).forEach((entry) => children.appendChild(treeRow(joinPath(row.dataset.path, entry.name), entry.name)));
      row.after(children);
      row.classList.add("expanded");
      row.querySelector(".tree-expand").textContent = "▾";
    } catch (err) {
      row.querySelector(".tree-expand").textContent = "!";
      row.title = err.message;
    }
  }

  async function loadFolderTree(force = false) {
    if (workspace.treeLoaded && !force) return selectTreePath();
    const host = document.getElementById("tree-body");
    if (!host) return;
    host.innerHTML = '<p class="muted-text">Loading…</p>';
    try {
      const { entries = [] } = await api("/api/files?subpath=");
      host.innerHTML = "";
      const root = treeRow("", "Hive root", true);
      host.appendChild(root);
      const children = document.createElement("div");
      children.className = "tree-children";
      entries.filter((entry) => entry.type === "dir").sort((a, b) => a.name.localeCompare(b.name)).forEach((entry) => children.appendChild(treeRow(entry.name, entry.name)));
      host.appendChild(children);
      workspace.treeLoaded = true;
      selectTreePath();
    } catch (err) { host.innerHTML = `<p class="error">${esc(err.message)}</p>`; }
  }

  async function addContextFile(filepath) {
    const existing = contextFiles();
    const current = existing.find((file) => file.path === filepath);
    const { content = "" } = await api(`/api/file?path=${encodeURIComponent(filepath)}`);
    const entry = { path: filepath, name: nameOf(filepath), characters: String(content).length, loadedAt: new Date().toISOString(), pinned: current?.pinned || false, profile: /master[_\s-]*profile/i.test(nameOf(filepath)) };
    saveContextFiles([entry, ...existing.filter((file) => file.path !== filepath)]);
    recordActivity("Context loaded", filepath);
    await renderContext();
  }

  async function listFolderFiles(folder, depth = 0, maxDepth = 8, output = []) {
    if (depth > maxDepth || output.length >= 300) return output;
    const { entries = [] } = await api(`/api/files?subpath=${encodeURIComponent(folder)}`);
    for (const entry of entries) {
      const full = joinPath(folder, entry.name);
      if (entry.type === "file") output.push(full);
      else await listFolderFiles(full, depth + 1, maxDepth, output);
      if (output.length >= 300) break;
    }
    return output;
  }

  async function loadContextPath(filepath) {
    const status = document.getElementById("context-status");
    status.textContent = "Loading…";
    try {
      await addContextFile(filepath);
    } catch (fileError) {
      const files = await listFolderFiles(filepath);
      if (!files.length) throw fileError;
      for (const file of files) {
        try { await addContextFile(file); } catch {}
      }
      recordActivity("Folder loaded", `${filepath} · ${files.length} files`);
    }
    status.textContent = "No truncation";
    await renderContext();
  }

  async function renderContext() {
    const files = contextFiles().sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.path.localeCompare(b.path));
    const host = document.getElementById("context-list");
    if (host) {
      host.innerHTML = files.length ? "" : '<p class="muted-text context-empty">No files loaded.</p>';
      files.forEach((file) => {
        const row = document.createElement("div");
        row.className = "context-row";
        row.dataset.path = file.path;
        row.innerHTML = `<label class="context-main"><input type="checkbox" class="context-select" /><span><strong>${esc(file.name)}</strong><small>${esc(file.path)}</small></span></label><span class="context-stats">${formatCount(file.characters)} chars<br><small>${new Date(file.loadedAt).toLocaleString()}</small></span><span class="context-actions"></span>`;
        const actions = row.querySelector(".context-actions");
        const button = (label, title, handler) => { const b = document.createElement("button"); b.textContent = label; b.title = title; b.addEventListener("click", handler); actions.appendChild(b); };
        button(file.pinned ? "★" : "☆", file.pinned ? "Unpin" : "Pin", () => { file.pinned = !file.pinned; saveContextFiles(files); renderContext(); });
        button("↻", "Reload", () => addContextFile(file.path).catch((err) => alert(err.message)));
        button("View", "Open source", () => { state.subpath = parentOf(file.path); switchTab("files"); loadFiles(); setTimeout(() => typeof isTextFile === "function" && isTextFile(file.path) ? openFile(file.path) : openPreview(file.path, { name: file.name, type: "file" }), 100); });
        button("Unload", "Unload from context", () => { saveContextFiles(files.filter((item) => item.path !== file.path)); recordActivity("Context unloaded", file.path); renderContext(); });
        host.appendChild(row);
      });
    }
    renderContextSummary(files);
  }

  function renderContextSummary(files = contextFiles()) {
    const chars = files.reduce((sum, file) => sum + Number(file.characters || 0), 0);
    const tokens = Math.ceil(chars / 4);
    const set = (id, value) => { const element = document.getElementById(id); if (element) element.textContent = value; };
    set("context-file-count", `${files.length} file${files.length === 1 ? "" : "s"}`);
    set("context-char-count", `${formatCount(chars)} characters`);
    set("context-token-count", `≈ ${formatCount(tokens)} tokens`);
    set("dash-context-count", formatCount(files.length));
    set("dash-context-detail", `${formatCount(chars)} characters`);
  }

  async function loadAllProfiles() {
    const status = document.getElementById("context-status");
    status.textContent = "Finding profiles…";
    const allFiles = await listFolderFiles("");
    const profiles = allFiles.filter((filepath) => /master[_\s-]*profile/i.test(nameOf(filepath)));
    for (const filepath of profiles) {
      try { await addContextFile(filepath); } catch {}
    }
    status.textContent = profiles.length ? `${profiles.length} profiles loaded` : "No profiles found";
    recordActivity("Profiles loaded", `${profiles.length} profiles`);
    await renderContext();
  }

  function unloadSelected() {
    const selected = new Set([...document.querySelectorAll(".context-row")].filter((row) => row.querySelector(".context-select")?.checked).map((row) => row.dataset.path));
    if (!selected.size) return;
    saveContextFiles(contextFiles().filter((file) => !selected.has(file.path)));
    recordActivity("Context unloaded", `${selected.size} selected files`);
    renderContext();
  }

  function unloadProfiles() {
    const files = contextFiles();
    const removed = files.filter((file) => file.profile || /master[_\s-]*profile/i.test(file.name));
    saveContextFiles(files.filter((file) => !removed.includes(file)));
    recordActivity("Profiles unloaded", `${removed.length} profiles`);
    renderContext();
  }

  function clearContext() {
    const files = contextFiles();
    const pinned = files.filter((file) => file.pinned);
    if (!confirm(pinned.length ? `Clear all unpinned context? ${pinned.length} pinned file(s) will remain.` : "Clear the entire context?")) return;
    saveContextFiles(pinned);
    recordActivity("Context cleared", pinned.length ? `${pinned.length} pinned files kept` : "All files unloaded");
    renderContext();
  }

  function renderUploadQueue() {
    const host = document.getElementById("workspace-upload-queue");
    if (!workspace.uploadFiles.length) { host.innerHTML = '<p class="muted-text">No files selected.</p>'; return; }
    host.innerHTML = workspace.uploadFiles.map((file, index) => `<div class="upload-row" data-index="${index}"><span><strong>${esc(file.name)}</strong><small>${typeof formatBytes === "function" ? formatBytes(file.size) : `${file.size} bytes`}</small></span><progress max="100" value="0"></progress><em>Queued</em><button data-remove="${index}">×</button></div>`).join("");
    host.querySelectorAll("[data-remove]").forEach((button) => button.addEventListener("click", () => { workspace.uploadFiles.splice(Number(button.dataset.remove), 1); renderUploadQueue(); }));
  }

  function queueUploadFiles(files) { workspace.uploadFiles.push(...files); renderUploadQueue(); }

  function uniqueName(filename, existing) {
    const dot = filename.lastIndexOf(".");
    const base = dot > 0 ? filename.slice(0, dot) : filename;
    const ext = dot > 0 ? filename.slice(dot) : "";
    let counter = 1;
    let candidate = filename;
    while (existing.has(candidate.toLowerCase())) candidate = `${base} (${counter++})${ext}`;
    existing.add(candidate.toLowerCase());
    return candidate;
  }

  function uploadOne(file, filepath, row) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/upload?path=${encodeURIComponent(filepath)}`);
      xhr.setRequestHeader("Authorization", `Bearer ${state.token}`);
      xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      xhr.upload.onprogress = (event) => { if (event.lengthComputable) row.querySelector("progress").value = Math.round(event.loaded / event.total * 100); };
      xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload failed: ${xhr.status}`));
      xhr.onerror = () => reject(new Error("Upload failed"));
      xhr.send(file);
    });
  }

  async function startUpload() {
    if (!workspace.uploadFiles.length) return;
    const destination = joinPath(document.getElementById("workspace-upload-destination").value || "_sorter");
    const duplicateMode = document.getElementById("workspace-upload-duplicate").value;
    const addToContext = document.getElementById("workspace-upload-context").checked;
    let existing = new Set();
    try { const result = await api(`/api/files?subpath=${encodeURIComponent(destination)}`); existing = new Set((result.entries || []).map((entry) => entry.name.toLowerCase())); } catch {}
    const rows = [...document.querySelectorAll(".upload-row")];
    const uploaded = [];
    for (let index = 0; index < workspace.uploadFiles.length; index += 1) {
      const file = workspace.uploadFiles[index];
      const row = rows[index];
      let filename = file.name;
      if (existing.has(filename.toLowerCase())) {
        if (duplicateMode === "skip") { row.querySelector("em").textContent = "Skipped"; continue; }
        if (duplicateMode === "rename") filename = uniqueName(filename, existing);
      } else existing.add(filename.toLowerCase());
      const filepath = joinPath(destination, filename);
      row.querySelector("em").textContent = "Uploading…";
      try {
        await uploadOne(file, filepath, row);
        row.querySelector("progress").value = 100;
        row.querySelector("em").textContent = "Uploaded";
        uploaded.push(filepath);
        recordActivity("Uploaded", filepath);
        if (addToContext) await addContextFile(filepath);
      } catch (err) { row.querySelector("em").textContent = err.message; row.classList.add("failed"); }
    }
    workspace.uploadFiles = [];
    if (uploaded.length && state.subpath === destination) loadFiles();
  }

  function sentences(text) { return String(text || "").replace(/\r/g, "").split(/(?<=[.!?])\s+|\n+/).map((line) => line.trim()).filter((line) => line.length > 25 && line.length < 700); }
  function words(text) { return (String(text || "").toLowerCase().match(/[a-z][a-z'-]{2,}/g) || []).filter((word) => !new Set(["the","and","that","this","with","from","have","were","was","for","you","your","but","not","are","they","their","there","been","into","about","when","what","which","would","could","should","then","than","also","just","had","has","his","her","she","him","our","out","all"]).has(word)); }

  async function hydrateContext() {
    const files = contextFiles();
    const hydrated = [];
    for (const file of files) {
      try { const { content = "" } = await api(`/api/file?path=${encodeURIComponent(file.path)}`); hydrated.push({ ...file, content: String(content) }); }
      catch { hydrated.push({ ...file, content: "" }); }
    }
    return hydrated;
  }

  function topSentences(files, limit = 10) {
    const frequency = new Map();
    files.forEach((file) => words(file.content).forEach((word) => frequency.set(word, (frequency.get(word) || 0) + 1)));
    const ranked = [];
    files.forEach((file) => sentences(file.content).forEach((sentence, index) => ranked.push({ sentence, path: file.path, score: words(sentence).reduce((sum, word) => sum + (frequency.get(word) || 0), 0) / Math.max(1, words(sentence).length) + (index < 4 ? 3 : 0) })));
    return ranked.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  function people(files) {
    const counts = new Map();
    const pattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b/g;
    files.forEach((file) => { for (const match of file.content.matchAll(pattern)) { const name = match[1]; if (!/^(New South Wales|Google Drive|Master Hive|Mental Health|Pure Vent|Chat GPT|Orbit FS)$/.test(name)) counts.set(name, (counts.get(name) || 0) + 1); } });
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }

  function buildAction(action, files, question = "") {
    const header = (title) => `# ${title}\n\nSources: ${files.map((file) => file.path).join(", ")}\n\n`;
    if (!files.length) return "No files are loaded in Context.";
    if (action === "summary") return header("Context Summary") + topSentences(files).map((item) => `- ${item.sentence}\n  _Source: ${item.path}_`).join("\n");
    if (action === "compare") return header("File Comparison") + files.map((file) => `## ${file.name}\n- Characters: ${formatCount(file.content.length)}\n- Key terms: ${[...new Set(words(file.content))].slice(0, 12).join(", ") || "None"}\n- Extract: ${sentences(file.content)[0] || "No extract available"}`).join("\n\n");
    if (action === "timeline") {
      const events = [];
      files.forEach((file) => sentences(file.content).forEach((sentence) => { const dates = sentence.match(DATE_RE); if (dates) dates.forEach((date) => events.push({ date, sentence, path: file.path })); }));
      return header("Extracted Timeline") + (events.length ? events.slice(0, 100).map((event) => `- **${event.date}** — ${event.sentence}\n  _Source: ${event.path}_`).join("\n") : "No dated events were found.");
    }
    if (action === "people") { const list = people(files); return header("People Extracted") + (list.length ? list.slice(0, 60).map(([name, count]) => `- ${name} — ${count} mention${count === 1 ? "" : "s"}`).join("\n") : "No full names were found."); }
    if (action === "contradictions") {
      const all = files.flatMap((file) => sentences(file.content).map((sentence) => ({ sentence, path: file.path })));
      const candidates = [];
      for (let i = 0; i < all.length; i += 1) for (let j = i + 1; j < Math.min(all.length, i + 250); j += 1) {
        const left = new Set(words(all[i].sentence));
        const overlap = words(all[j].sentence).filter((word) => left.has(word)).length;
        const leftNeg = /\b(no|not|never|didn't|wasn't|weren't|cannot|can't)\b/i.test(all[i].sentence);
        const rightNeg = /\b(no|not|never|didn't|wasn't|weren't|cannot|can't)\b/i.test(all[j].sentence);
        if (overlap >= 5 && leftNeg !== rightNeg) candidates.push([all[i], all[j]]);
        if (candidates.length >= 15) break;
      }
      return header("Potential Contradictions") + (candidates.length ? candidates.map(([left, right], index) => `## Candidate ${index + 1}\n- ${left.sentence} _(${left.path})_\n- ${right.sentence} _(${right.path})_`).join("\n\n") : "No likely contradiction pairs were found automatically. This does not prove none exist.");
    }
    if (action === "profile") return header("Profile Draft") + `## People\n${people(files).slice(0, 15).map(([name, count]) => `- ${name}: ${count} mentions`).join("\n") || "- None extracted"}\n\n## Key information\n${topSentences(files, 12).map((item) => `- ${item.sentence}`).join("\n")}\n\n## Source files\n${files.map((file) => `- ${file.path}`).join("\n")}`;
    if (action === "incident") return header("Incident Entry Draft") + `Date/time: [confirm]\nPeople: ${people(files).slice(0, 12).map(([name]) => name).join(", ") || "[confirm]"}\nLocation: [confirm]\n\n## What happened\n${topSentences(files, 8).map((item) => `- ${item.sentence}`).join("\n")}\n\nStatus: DRAFT — review against source files before saving.`;
    if (action === "draft") return header("Document Draft") + topSentences(files, 14).map((item) => item.sentence).join("\n\n") + "\n\n---\nDRAFT — generated from loaded Context files and not saved automatically.";
    if (action === "ask") {
      const queryWords = new Set(words(question));
      const matches = files.flatMap((file) => sentences(file.content).map((sentence) => ({ sentence, path: file.path, score: words(sentence).filter((word) => queryWords.has(word)).length }))).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 12);
      return header(`Context Answer: ${question || "Question"}`) + (matches.length ? `The most relevant source passages are:\n\n${matches.map((item) => `- ${item.sentence}\n  _Source: ${item.path}_`).join("\n")}` : "No matching passages were found in the loaded context.");
    }
    return "Unknown action.";
  }

  async function runAiAction(action, question = "") {
    const output = document.getElementById("ai-output");
    output.value = "Working…";
    const files = await hydrateContext();
    output.value = buildAction(action, files, question);
    document.getElementById("ai-output-meta").textContent = `${action} · ${files.length} source file${files.length === 1 ? "" : "s"} · ${new Date().toLocaleString()}`;
    document.getElementById("ai-save-path").value = `_sorter/${action.replace(/[^a-z0-9]+/gi, "-") || "AI"} Draft.md`;
    recordActivity("AI action", `${action} · ${files.length} files`);
  }

  function bindWorkspace() {
    document.querySelectorAll(".workspace-tab-btn").forEach((button) => button.addEventListener("click", () => {
      switchTab(button.dataset.tab);
      if (button.dataset.tab === "dashboard") refreshDashboard();
      if (button.dataset.tab === "context") renderContext();
      if (button.dataset.tab === "files") loadFolderTree();
    }));
    document.querySelectorAll("[data-go]").forEach((button) => button.addEventListener("click", () => { switchTab(button.dataset.go); if (button.dataset.go === "files") loadFolderTree(); if (button.dataset.go === "context") renderContext(); }));
    document.getElementById("dashboard-refresh").addEventListener("click", refreshDashboard);
    document.getElementById("tree-refresh").addEventListener("click", () => { workspace.treeLoaded = false; loadFolderTree(true); });
    document.getElementById("workspace-file-search").addEventListener("input", filterCurrentFolder);

    const dropzone = document.getElementById("workspace-dropzone");
    const uploadInput = document.getElementById("workspace-upload-input");
    dropzone.addEventListener("click", () => uploadInput.click());
    dropzone.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") uploadInput.click(); });
    dropzone.addEventListener("dragover", (event) => { event.preventDefault(); dropzone.classList.add("dragging"); });
    dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragging"));
    dropzone.addEventListener("drop", (event) => { event.preventDefault(); dropzone.classList.remove("dragging"); queueUploadFiles([...event.dataTransfer.files]); });
    uploadInput.addEventListener("change", () => { queueUploadFiles([...uploadInput.files]); uploadInput.value = ""; });
    document.getElementById("workspace-upload-clear").addEventListener("click", () => { workspace.uploadFiles = []; renderUploadQueue(); });
    document.getElementById("workspace-upload-start").addEventListener("click", () => startUpload().catch((err) => alert(err.message)));

    const config = settings();
    document.getElementById("context-project").value = config.project;
    document.getElementById("context-strength").value = config.strength;
    ["context-project", "context-strength"].forEach((id) => document.getElementById(id).addEventListener("change", () => { saveSettings(); refreshDashboard(); }));
    document.getElementById("context-refresh").addEventListener("click", renderContext);
    document.getElementById("context-load-path").addEventListener("click", () => { const filepath = document.getElementById("context-path").value.trim(); if (filepath) loadContextPath(filepath).catch((err) => { document.getElementById("context-status").textContent = err.message; }); });
    document.getElementById("context-load-profiles").addEventListener("click", () => loadAllProfiles().catch((err) => { document.getElementById("context-status").textContent = err.message; }));
    document.getElementById("context-unload-selected").addEventListener("click", unloadSelected);
    document.getElementById("context-unload-profiles").addEventListener("click", unloadProfiles);
    document.getElementById("context-clear").addEventListener("click", clearContext);
    document.getElementById("context-select-all").addEventListener("change", (event) => document.querySelectorAll(".context-select").forEach((input) => { input.checked = event.target.checked; }));
    document.getElementById("editor-context-btn").addEventListener("click", () => state.openFile && addContextFile(state.openFile).catch((err) => alert(err.message)));
    document.getElementById("preview-context-btn").addEventListener("click", () => state.previewFile && addContextFile(state.previewFile).catch((err) => alert(err.message)));

    document.querySelectorAll("[data-ai-action]").forEach((button) => button.addEventListener("click", () => runAiAction(button.dataset.aiAction).catch((err) => { document.getElementById("ai-output").value = err.message; })));
    document.getElementById("ai-ask").addEventListener("click", () => runAiAction("ask", document.getElementById("ai-question").value.trim()).catch((err) => { document.getElementById("ai-output").value = err.message; }));
    document.getElementById("ai-copy").addEventListener("click", () => navigator.clipboard.writeText(document.getElementById("ai-output").value));
    document.getElementById("ai-download").addEventListener("click", () => { const blob = new Blob([document.getElementById("ai-output").value], { type: "text/markdown" }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = nameOf(document.getElementById("ai-save-path").value) || "AI Draft.md"; link.click(); URL.revokeObjectURL(link.href); });
    document.getElementById("ai-save").addEventListener("click", async () => {
      const filepath = joinPath(document.getElementById("ai-save-path").value);
      const content = document.getElementById("ai-output").value;
      if (!filepath || !content) return;
      await api("/api/file", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: filepath, content }) });
      recordActivity("Draft saved", filepath);
      alert(`Saved ${filepath}`);
    });
  }

  function saveSettings() {
    writeJson(SETTINGS_KEY, { project: document.getElementById("context-project").value, strength: document.getElementById("context-strength").value });
  }

  injectWorkspace();
  bindWorkspace();
  renderUploadQueue();
  renderContext();
  loadFolderTree();

  const baseLoadFiles = loadFiles;
  loadFiles = async function loadFilesWithWorkspace() {
    await baseLoadFiles();
    filterCurrentFolder();
    selectTreePath();
  };

  const baseRenderRow = renderRow;
  renderRow = function renderRowWithContext(list, entry) {
    baseRenderRow(list, entry);
    if (entry.type !== "file") return;
    const row = list.lastElementChild;
    const actions = row?.querySelector(".row-actions");
    if (!actions) return;
    const filepath = joinPath(state.subpath, entry.name);
    const button = document.createElement("button");
    button.className = "icon-btn";
    button.textContent = "◉";
    button.title = "Add to Context";
    button.addEventListener("click", (event) => { event.stopPropagation(); addContextFile(filepath).catch((err) => alert(err.message)); });
    actions.prepend(button);
  };

  const baseShowApp = showApp;
  showApp = function showAppWithDashboard() {
    baseShowApp();
    switchTab("dashboard");
    refreshDashboard();
  };

  if (!document.getElementById("app").classList.contains("hidden")) {
    switchTab("dashboard");
    refreshDashboard();
  }
})();
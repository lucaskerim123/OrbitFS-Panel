const state = {
  token: localStorage.getItem("panelToken") || "",
  username: localStorage.getItem("panelUsername") || "",
  role: localStorage.getItem("panelRole") || "",
  subpath: "",
  openFile: null,
  previewFile: null,
  folderPermissions: null,
  currentPermissions: null,
};

const ALL_FILE_PERMISSIONS = Object.freeze({ read: true, write: true, download: true, move: true, delete: true, create: true });
function effectivePermissions(value) { return { ...ALL_FILE_PERMISSIONS, ...(value || {}) }; }

const TEXT_EXTENSIONS = new Set([
  "md", "txt", "json", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "yml", "yaml", "html",
  "htm", "css", "log", "xml", "sh", "ps1", "ini", "toml", "env",
  "java", "c", "h", "cpp", "hpp", "cs", "go", "rs", "rb", "php", "sql",
  "kt", "swift", "dart", "lua", "r", "pl", "vue", "graphql", "conf", "cfg",
]);

// Extensions mapped to a CodeMirror mode/mime, used for live syntax
// highlighting while editing. Anything text-editable but not listed here
// still opens in the editor, just without highlighting (plain monospace).
const CM_MODES = {
  js: "javascript", mjs: "javascript", cjs: "javascript",
  jsx: { name: "javascript", jsx: true },
  ts: "text/typescript",
  tsx: { name: "javascript", jsx: true, typescript: true },
  json: { name: "javascript", json: true },
  py: "python",
  html: "htmlmixed", htm: "htmlmixed", vue: "htmlmixed",
  css: "css",
  sh: "shell",
  ps1: "powershell",
  yml: "yaml", yaml: "yaml",
  xml: "xml",
  sql: "text/x-sql",
  java: "text/x-java",
  c: "text/x-csrc", h: "text/x-csrc",
  cpp: "text/x-c++src", hpp: "text/x-c++src",
  cs: "text/x-csharp",
  php: "application/x-httpd-php",
  rb: "ruby",
  go: "go",
  rs: "rust",
  md: "markdown",
};

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "m4v", "ogv"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "ogg", "m4a", "flac", "aac"]);
const SHEET_EXTENSIONS = new Set(["xlsx", "xls", "csv"]);
// TEMPORARILY EMPTY during the top-level folder redesign, matching
// mcp-hive-server/server.js. Restore the real list once the new structure
// is settled:
//   "_system", "_sorter", "_trash", "0. Core", "1. Legal",
//   "2. Wellbeing", "_media"
const PROTECTED_ROOT_FOLDERS = new Set([]);

function extOf(name) {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i + 1).toLowerCase();
}

function isTextFile(name) {
  return TEXT_EXTENSIONS.has(extOf(name));
}

function editorModeFor(name) {
  return extOf(name) === "md" ? "markdown" : "code";
}

function mediaKindFor(name) {
  const ext = extOf(name);
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (SHEET_EXTENSIONS.has(ext)) return "sheet";
  if (ext === "zip") return "zip";
  return null;
}

function isProtectedRootFolderPath(filepath, entryType = "") {
  const normalized = String(filepath || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return entryType === "dir" && PROTECTED_ROOT_FOLDERS.has(normalized);
}

function formatBytes(n) {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n;
  let u = -1;
  do { v /= 1024; u++; } while (v >= 1024 && u < units.length - 1);
  return `${v.toFixed(1)} ${units[u]}`;
}

function api(path, opts = {}) {
  return fetch(path, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: `Bearer ${state.token}` },
  }).then(async (resp) => {
    if (resp.status === 401) {
      logout();
      throw new Error("Unauthorized");
    }
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(body.error || `Request failed: ${resp.status}`);
    return body;
  });
}

function setSystemControlMessage(message, tone = "muted") {
  const el = document.getElementById("system-control-message");
  if (!el) return;
  el.textContent = message || "";
  el.style.whiteSpace = "pre-wrap";
  el.style.color = tone === "error" ? "var(--danger)" : tone === "success" ? "var(--ok)" : "";
}

function scheduleSystemRefresh(attempts = 5, delayMs = 2000) {
  let remaining = attempts;
  const tick = async () => {
    try {
      await loadSystem();
    } finally {
      remaining -= 1;
      if (remaining > 0) {
        setTimeout(tick, delayMs);
      }
    }
  };
  setTimeout(tick, delayMs);
}

function logout() {
  const token = state.token;
  localStorage.removeItem("panelToken");
  localStorage.removeItem("panelUsername");
  localStorage.removeItem("panelRole");
  state.token = "";
  state.username = "";
  state.role = "";
  document.getElementById("app").classList.add("hidden");
  document.getElementById("login").classList.remove("hidden");
  if (token) {
    fetch("/api/logout", { method: "POST", headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
  }
}

async function checkSorterAvailable() {
  let online = false;
  try {
    ({ online } = await api("/api/sorter-available"));
  } catch {
    // panel unreachable or check failed - treat as offline
  }
  // The Sorter tab only exists while the sorter service is actually answering.
  document.getElementById("tab-btn-sorter").classList.toggle("hidden", !online);
  // If the sorter dies while its tab is open, bounce back to Files.
  if (!online && document.getElementById("tab-sorter").classList.contains("active")) switchTab("files");
  // System-tab controls stay visible either way, so it can be started from there.
  document.getElementById("infra-item-sorter").classList.remove("hidden");
  document.getElementById("service-row-sorter").classList.remove("hidden");
  return online;
}

function showApp() {
  document.getElementById("login").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  document.getElementById("current-user").textContent = state.role
    ? `${state.username} · ${state.role}`
    : state.username;
  document.getElementById("tab-btn-system").classList.toggle("hidden", state.role !== "admin");
  refreshStatus();
  loadFiles();
  checkSorterAvailable();
}

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = document.getElementById("login-username").value.trim();
  const pin = document.getElementById("login-pin").value.trim();
  const errorEl = document.getElementById("login-error");
  errorEl.textContent = "";
  try {
    const resp = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, pin }),
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(body.error || "Login failed");
    state.token = body.token;
    state.username = body.username;
    state.role = body.role || "";
    localStorage.setItem("panelToken", state.token);
    localStorage.setItem("panelUsername", state.username);
    localStorage.setItem("panelRole", state.role);
    showApp();
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

document.getElementById("logout").addEventListener("click", logout);

document.getElementById("pin-toggle").addEventListener("click", () => {
  const pinInput = document.getElementById("login-pin");
  const btn = document.getElementById("pin-toggle");
  const showing = pinInput.type === "text";
  pinInput.type = showing ? "password" : "text";
  btn.textContent = showing ? "👁" : "🙈";
  btn.setAttribute("aria-label", showing ? "Show PIN" : "Hide PIN");
});

// --- Tabs --------------------------------------------------------------
function switchTab(tabName) {
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tabName));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${tabName}`));
  if (tabName === "system") loadSystem();
  if (tabName === "sorter") sorterLoad();
}

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const alreadyActive = btn.classList.contains("active");
    switchTab(btn.dataset.tab);
    // Re-clicking the already-active Files tab acts as a "go to root" shortcut.
    if (alreadyActive && btn.dataset.tab === "files" && confirmDiscardIfDirty()) {
      closeAllPanels();
      state.subpath = "";
      loadFiles();
    }
  });
});

// Header title doubles as a Home button: jump to the Files tab root folder.
document.getElementById("home-btn").addEventListener("click", () => {
  if (!confirmDiscardIfDirty()) return;
  closeAllPanels();
  state.subpath = "";
  switchTab("files");
  loadFiles();
});

// --- Status pill ---------------------------------------------------------
async function refreshStatus() {
  try {
    const status = await api("/api/status");
    setPill("status-hive", status.hive.ok);
  } catch {
    // handled via logout on 401; ignore transient errors otherwise
  }
}

function setPill(id, ok, text) {
  const el = document.getElementById(id);
  el.classList.remove("ok", "down", "unknown");
  if (ok === true) el.classList.add("ok");
  else if (ok === false) el.classList.add("down");
  else el.classList.add("unknown");
  if (text) el.textContent = text;
}

// --- File browser ---------------------------------------------------------
let previewObjectUrl = null;

function closeAllPanels() {
  document.getElementById("editor").classList.add("hidden");
  document.getElementById("preview").classList.add("hidden");
  document.getElementById("files-layout").classList.remove("editor-open");
  state.openFile = null;
  state.previewFile = null;
  savedGeneration = null;
  hideFindBar();
  updateDirtyIndicator();
  if (previewObjectUrl) {
    URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = null;
  }
  const mediaEl = document.getElementById("preview-media");
  if (mediaEl) mediaEl.innerHTML = "";
}

async function loadFiles() {
  document.getElementById("breadcrumb").textContent = `/${state.subpath}`;
  const list = document.getElementById("file-list");
  list.innerHTML = "<li>Loading…</li>";
  try {
    const { entries, folderPermissions } = await api(`/api/files?subpath=${encodeURIComponent(state.subpath)}`);
    state.folderPermissions = effectivePermissions(folderPermissions);
    document.getElementById("new-folder-btn").classList.toggle("hidden", !state.folderPermissions.create);
    document.getElementById("upload-btn").classList.toggle("hidden", !state.folderPermissions.create);
    list.innerHTML = "";
    if (state.subpath) {
      const up = document.createElement("li");
      up.className = "dir";
      up.innerHTML = `<span class="row-name">..</span>`;
      up.querySelector(".row-name").addEventListener("click", () => {
        state.subpath = state.subpath.split("/").slice(0, -1).join("/");
        loadFiles();
      });
      list.appendChild(up);
    }
    entries
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1))
      .forEach((entry) => renderRow(list, entry));
    if (!entries.length && !state.subpath) list.innerHTML = "<li>(empty)</li>";
  } catch (err) {
    list.innerHTML = `<li>${err.message}</li>`;
  }
}

function renderRow(list, entry) {
  const full = state.subpath ? `${state.subpath}/${entry.name}` : entry.name;
  const li = document.createElement("li");
  li.className = entry.type;

  const nameSpan = document.createElement("span");
  nameSpan.className = "row-name";
  nameSpan.textContent = entry.name;
  if (entry.type === "file" && entry.size != null) {
    const sizeSpan = document.createElement("span");
    sizeSpan.className = "row-size";
    sizeSpan.textContent = formatBytes(entry.size);
    nameSpan.appendChild(sizeSpan);
  }
  nameSpan.addEventListener("click", () => {
    if (entry.type === "dir") {
      state.subpath = full;
      loadFiles();
    } else if (isTextFile(entry.name)) {
      openFile(full);
    } else {
      openPreview(full, entry);
    }
  });
  li.appendChild(nameSpan);

  const actions = document.createElement("span");
  actions.className = "row-actions";

  // entry.permissions describes what a normal user may do so Admin can edit
  // that rule. It must never hide Admin's own controls.
  const permissions = state.role === "admin" ? { ...ALL_FILE_PERMISSIONS } : effectivePermissions(entry.permissions);
  if (entry.type === "file" && permissions.download) {
    const dl = document.createElement("button");
    dl.className = "icon-btn";
    dl.textContent = "⬇";
    dl.title = "Download";
    dl.addEventListener("click", (e) => { e.stopPropagation(); downloadFile(full); });
    actions.appendChild(dl);
  }

  if (permissions.move) {
    const mv = document.createElement("button");
    mv.className = "icon-btn";
    mv.textContent = "↦";
    mv.title = "Move / rename";
    mv.addEventListener("click", (e) => { e.stopPropagation(); openMovePicker(full); });
    actions.appendChild(mv);
  }
  if (isProtectedRootFolderPath(full, entry.type)) actions.querySelector(".icon-btn")?.remove();

  if (permissions.delete) {
    const del = document.createElement("button");
    del.className = "icon-btn danger";
    del.textContent = "🗑";
    del.title = "Move to trash";
    del.addEventListener("click", (e) => { e.stopPropagation(); trashPath(full); });
    actions.appendChild(del);
  }
  if (isProtectedRootFolderPath(full, entry.type)) actions.querySelector(".icon-btn.danger")?.remove();

  li.appendChild(actions);
  list.appendChild(li);
}

// Full editor, not just a textarea: line numbers + live syntax highlighting
// while typing, backed by CodeMirror. Created once, reused across files by
// swapping its content/mode.
let cm = null;
let savedGeneration = null;

function isEditorDirty() {
  return !!(cm && state.openFile && savedGeneration != null && !cm.isClean(savedGeneration));
}

// Guard before any navigation that would throw away the open file's buffer
// (switching files/folders, closing the panel, or leaving the page).
function confirmDiscardIfDirty() {
  if (!isEditorDirty()) return true;
  return confirm("You have unsaved changes. Discard them?");
}

window.addEventListener("beforeunload", (e) => {
  if (!isEditorDirty()) return;
  e.preventDefault();
  e.returnValue = "";
});

function updateDirtyIndicator() {
  const dot = document.getElementById("editor-dirty-dot");
  if (dot) dot.classList.toggle("hidden", !isEditorDirty());
}

function applyEditorFontPrefs() {
  const wrapper = cm ? cm.getWrapperElement() : null;
  if (!wrapper) return;
  const familySelect = document.getElementById("editor-font-family");
  const family = localStorage.getItem("panelEditorFontFamily") || familySelect.value;
  const size = parseInt(localStorage.getItem("panelEditorFontSize"), 10) || 13;
  wrapper.style.fontFamily = family;
  wrapper.style.fontSize = `${size}px`;
  if (familySelect.value !== family) familySelect.value = family;
  document.getElementById("editor-font-size-display").textContent = size;
}

function ensureCodeMirror() {
  if (cm) return cm;
  cm = CodeMirror.fromTextArea(document.getElementById("editor-content"), {
    lineNumbers: true,
    lineWrapping: true,
    theme: "material-darker",
    indentUnit: 2,
    tabSize: 2,
    viewportMargin: 500,
  });
  cm.on("changes", updateDirtyIndicator);
  applyEditorFontPrefs();
  return cm;
}

document.getElementById("editor-font-family").addEventListener("change", (e) => {
  localStorage.setItem("panelEditorFontFamily", e.target.value);
  applyEditorFontPrefs();
  if (cm) setTimeout(() => cm.refresh(), 30);
});

function stepEditorFontSize(delta) {
  const current = parseInt(localStorage.getItem("panelEditorFontSize"), 10) || 13;
  const next = Math.max(10, Math.min(22, current + delta));
  localStorage.setItem("panelEditorFontSize", next);
  applyEditorFontPrefs();
  if (cm) setTimeout(() => cm.refresh(), 30);
}
document.getElementById("editor-font-dec").addEventListener("click", () => stepEditorFontSize(-1));
document.getElementById("editor-font-inc").addEventListener("click", () => stepEditorFontSize(1));

async function openFile(filepath) {
  if (!confirmDiscardIfDirty()) return;
  try {
    const { content, permissions } = await api(`/api/file?path=${encodeURIComponent(filepath)}`);
    closeAllPanels();
    state.openFile = filepath;
    state.currentPermissions = effectivePermissions(permissions);
    state.editorMode = editorModeFor(filepath);
    state.editorViewing = "edit";
    document.getElementById("editor-path").textContent = filepath;

    const editor = ensureCodeMirror();
    editor.setOption("readOnly", !state.currentPermissions.write);
    editor.setValue(content);
    editor.setOption("mode", CM_MODES[extOf(filepath)] || null);
    editor.clearHistory();
    savedGeneration = editor.changeGeneration(true);
    updateDirtyIndicator();
    applyEditorFontPrefs();
    hideFindBar();

    document.getElementById("editor").classList.remove("hidden");
    document.getElementById("files-layout").classList.add("editor-open");
    renderEditorView();
    document.getElementById("editor-edit-btn").classList.toggle("hidden", !state.currentPermissions.write);
    document.getElementById("save-file-btn").classList.toggle("hidden", !state.currentPermissions.write);
    document.getElementById("editor-find-btn").classList.toggle("hidden", !state.currentPermissions.write);
    document.getElementById("editor-download-btn").classList.toggle("hidden", !state.currentPermissions.download);
    document.getElementById("move-file-btn").classList.toggle("hidden", !state.currentPermissions.move);
    document.getElementById("delete-file-btn").classList.toggle("hidden", !state.currentPermissions.delete);
    setTimeout(() => editor.refresh(), 30);
  } catch (err) {
    alert(err.message);
  }
}

// Edit/Read toggle works for every text file, not just Markdown: Markdown's
// Read view renders sanitized HTML; everything else's Read view is the same
// CodeMirror buffer (still syntax-highlighted) just switched to read-only,
// so there's one consistent toggle instead of a Markdown-only special case.
function renderEditorView() {
  const rendered = document.getElementById("editor-rendered");
  const toggle = document.getElementById("editor-view-toggle");
  const editBtn = document.getElementById("editor-edit-btn");
  const readBtn = document.getElementById("editor-read-btn");
  const cmWrapper = cm ? cm.getWrapperElement() : null;

  toggle.classList.remove("hidden");
  editBtn.classList.toggle("on", state.editorViewing === "edit");
  readBtn.classList.toggle("on", state.editorViewing === "read");

  if (state.editorMode === "markdown" && state.editorViewing === "read") {
    if (cmWrapper) cmWrapper.classList.add("hidden");
    rendered.classList.remove("hidden");
    const raw = window.marked ? marked.parse(cm.getValue()) : cm.getValue();
    rendered.innerHTML = window.DOMPurify ? DOMPurify.sanitize(raw) : raw;
    return;
  }

  rendered.classList.add("hidden");
  if (cmWrapper) cmWrapper.classList.remove("hidden");
  if (cm) cm.setOption("readOnly", state.editorViewing === "read" || !effectivePermissions(state.currentPermissions).write);
}

function setEditorViewing(mode) {
  if (state.editorViewing === mode) return;
  state.editorViewing = mode;
  renderEditorView();
  if (cm) setTimeout(() => cm.refresh(), 30);
}
document.getElementById("editor-edit-btn").addEventListener("click", () => setEditorViewing("edit"));
document.getElementById("editor-read-btn").addEventListener("click", () => setEditorViewing("read"));

// --- Find & replace (CodeMirror's searchcursor addon, custom-styled bar) --
function hideFindBar() {
  document.getElementById("editor-find-bar").classList.add("hidden");
  document.getElementById("editor-find-count").textContent = "";
}

function countMatches(query) {
  if (!cm || !query) return 0;
  const cursor = cm.getSearchCursor(query, null, { caseFold: true });
  let count = 0;
  while (cursor.findNext()) count++;
  return count;
}

function findStep(dir) {
  const query = document.getElementById("editor-find-input").value;
  const countEl = document.getElementById("editor-find-count");
  if (!cm || !query) {
    countEl.textContent = "";
    return;
  }
  const total = countMatches(query);
  if (!total) {
    countEl.textContent = "0 of 0";
    return;
  }
  const cursor = cm.getSearchCursor(query, cm.getCursor(dir > 0 ? "to" : "from"), { caseFold: true });
  const found = dir > 0 ? cursor.findNext() : cursor.findPrevious();
  if (!found) {
    // wrap around
    const wrapped = cm.getSearchCursor(query, dir > 0 ? { line: 0, ch: 0 } : { line: cm.lineCount() - 1, ch: 0 }, { caseFold: true });
    if (dir > 0 ? wrapped.findNext() : wrapped.findPrevious()) {
      cm.setSelection(wrapped.from(), wrapped.to());
      cm.scrollIntoView({ from: wrapped.from(), to: wrapped.to() }, 60);
    }
  } else {
    cm.setSelection(cursor.from(), cursor.to());
    cm.scrollIntoView({ from: cursor.from(), to: cursor.to() }, 60);
  }
  countEl.textContent = `${total} match${total === 1 ? "" : "es"}`;
}

document.getElementById("editor-find-btn").addEventListener("click", () => {
  const bar = document.getElementById("editor-find-bar");
  bar.classList.toggle("hidden");
  if (!bar.classList.contains("hidden")) document.getElementById("editor-find-input").focus();
});
document.getElementById("editor-find-close").addEventListener("click", hideFindBar);
document.getElementById("editor-find-next").addEventListener("click", () => findStep(1));
document.getElementById("editor-find-prev").addEventListener("click", () => findStep(-1));
document.getElementById("editor-find-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") findStep(e.shiftKey ? -1 : 1);
});
document.getElementById("editor-replace-all-btn").addEventListener("click", () => {
  const query = document.getElementById("editor-find-input").value;
  const replacement = document.getElementById("editor-replace-input").value;
  if (!cm || !query) return;
  const cursor = cm.getSearchCursor(query, null, { caseFold: true });
  let count = 0;
  cm.operation(() => {
    while (cursor.findNext()) {
      cursor.replace(replacement);
      count++;
    }
  });
  document.getElementById("editor-find-count").textContent = `Replaced ${count}`;
});

async function openPreview(filepath, entry) {
  if (!confirmDiscardIfDirty()) return;
  closeAllPanels();
  state.previewFile = filepath;
  state.currentPermissions = state.role === "admin" ? { ...ALL_FILE_PERMISSIONS } : effectivePermissions(entry.permissions);
  document.getElementById("preview-path").textContent = filepath;
  document.getElementById("preview").classList.remove("hidden");
  document.getElementById("files-layout").classList.add("editor-open");

  const mediaEl = document.getElementById("preview-media");
  const infoEl = document.getElementById("preview-info");
  mediaEl.classList.add("hidden");
  mediaEl.innerHTML = "";

  const kind = mediaKindFor(entry.name);
  document.getElementById("preview-download-btn").classList.toggle("hidden", !state.currentPermissions.download);
  document.getElementById("preview-move-btn").classList.toggle("hidden", !state.currentPermissions.move);
  document.getElementById("preview-delete-btn").classList.toggle("hidden", !state.currentPermissions.delete);
  if (!kind) {
    infoEl.textContent =
      entry.size != null ? `${formatBytes(entry.size)} — not previewable, use Download.` : "Not previewable.";
    return;
  }

  infoEl.textContent = "Loading preview…";
  try {
    const resp = await fetch(`/api/preview?path=${encodeURIComponent(filepath)}`, {
      headers: { Authorization: `Bearer ${state.token}` },
    });
    if (!resp.ok) throw new Error(`Preview failed: ${resp.status}`);
    const blob = await resp.blob();
    if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = URL.createObjectURL(blob);

    if (kind === "image") {
      const el = document.createElement("img");
      el.src = previewObjectUrl;
      mediaEl.appendChild(el);
      infoEl.textContent = entry.size != null ? formatBytes(entry.size) : "";
    } else if (kind === "video") {
      const el = document.createElement("video");
      el.src = previewObjectUrl;
      el.controls = true;
      mediaEl.appendChild(el);
      infoEl.textContent = entry.size != null ? formatBytes(entry.size) : "";
    } else if (kind === "audio") {
      const el = document.createElement("audio");
      el.src = previewObjectUrl;
      el.controls = true;
      mediaEl.appendChild(el);
      infoEl.textContent = entry.size != null ? formatBytes(entry.size) : "";
    } else if (kind === "pdf") {
      await renderPdfPreview(mediaEl, await blob.arrayBuffer());
      infoEl.textContent = entry.size != null ? `${formatBytes(entry.size)} · view only, download to edit` : "";
    } else if (kind === "docx") {
      await renderDocxPreview(mediaEl, await blob.arrayBuffer());
      infoEl.textContent = entry.size != null ? `${formatBytes(entry.size)} · view only, download to edit` : "";
    } else if (kind === "sheet") {
      await renderSheetPreview(mediaEl, blob, entry.name);
      infoEl.textContent = entry.size != null ? formatBytes(entry.size) : "";
    } else if (kind === "zip") {
      await renderZipPreview(mediaEl, blob);
      infoEl.textContent = entry.size != null ? formatBytes(entry.size) : "";
    }
    mediaEl.classList.remove("hidden");
  } catch (err) {
    infoEl.textContent = err.message;
  }
}

// --- PDF: real in-app viewer (pdf.js) instead of a bare browser iframe ----
if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

async function renderPdfPreview(container, arrayBuffer) {
  if (!window.pdfjsLib) {
    container.textContent = "PDF viewer failed to load.";
    return;
  }
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let currentPage = 1;

  const wrap = document.createElement("div");
  wrap.className = "pdf-viewer";
  const thumbs = document.createElement("div");
  thumbs.className = "pdf-thumbs";
  const pageArea = document.createElement("div");
  pageArea.className = "pdf-page";
  const canvas = document.createElement("canvas");
  pageArea.appendChild(canvas);
  wrap.append(thumbs, pageArea);

  const controls = document.createElement("div");
  controls.className = "pdf-controls";
  let zoom = 1.1;
  const prevBtn = Object.assign(document.createElement("button"), { textContent: "‹" });
  const pageLabel = document.createElement("span");
  const nextBtn = Object.assign(document.createElement("button"), { textContent: "›" });
  const zoomOutBtn = Object.assign(document.createElement("button"), { textContent: "–" });
  const zoomLabel = document.createElement("span");
  const zoomInBtn = Object.assign(document.createElement("button"), { textContent: "+" });
  controls.append(prevBtn, pageLabel, nextBtn, zoomOutBtn, zoomLabel, zoomInBtn);

  container.append(wrap, controls);

  async function renderPage(num) {
    currentPage = Math.max(1, Math.min(pdf.numPages, num));
    const page = await pdf.getPage(currentPage);
    const viewport = page.getViewport({ scale: zoom });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    pageLabel.textContent = `Page ${currentPage} / ${pdf.numPages}`;
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    thumbs.querySelectorAll(".pdf-thumb").forEach((t) => t.classList.toggle("current", Number(t.dataset.page) === currentPage));
  }

  prevBtn.addEventListener("click", () => renderPage(currentPage - 1));
  nextBtn.addEventListener("click", () => renderPage(currentPage + 1));
  zoomOutBtn.addEventListener("click", () => { zoom = Math.max(0.4, zoom - 0.15); renderPage(currentPage); });
  zoomInBtn.addEventListener("click", () => { zoom = Math.min(3, zoom + 0.15); renderPage(currentPage); });

  const thumbScale = 0.18;
  for (let i = 1; i <= pdf.numPages; i++) {
    const thumbBtn = document.createElement("button");
    thumbBtn.className = "pdf-thumb";
    thumbBtn.dataset.page = String(i);
    thumbBtn.textContent = String(i);
    thumbBtn.addEventListener("click", () => renderPage(i));
    thumbs.appendChild(thumbBtn);
    // Best-effort thumbnail render; page-number label is the fallback if this fails.
    pdf.getPage(i).then((page) => {
      const vp = page.getViewport({ scale: thumbScale });
      const tCanvas = document.createElement("canvas");
      tCanvas.width = vp.width;
      tCanvas.height = vp.height;
      return page.render({ canvasContext: tCanvas.getContext("2d"), viewport: vp }).promise.then(() => {
        thumbBtn.textContent = "";
        thumbBtn.appendChild(tCanvas);
      });
    }).catch(() => {});
  }

  await renderPage(1);
}

// --- DOCX: render via mammoth.js (already loaded, previously unused) -----
async function renderDocxPreview(container, arrayBuffer) {
  if (!window.mammoth) {
    container.textContent = "DOCX viewer failed to load.";
    return;
  }
  const banner = document.createElement("div");
  banner.className = "docx-banner";
  banner.textContent = "View only — download and edit in Word, then re-upload.";
  const page = document.createElement("div");
  page.className = "docx-page";
  try {
    const { value: html } = await mammoth.convertToHtml({ arrayBuffer });
    page.innerHTML = window.DOMPurify ? DOMPurify.sanitize(html) : html;
  } catch (err) {
    page.textContent = `Couldn't render this file: ${err.message}`;
  }
  container.append(banner, page);
}

// --- XLSX/CSV: read-only table via SheetJS --------------------------------
async function renderSheetPreview(container, blob, filename) {
  if (!window.XLSX) {
    container.textContent = "Spreadsheet viewer failed to load.";
    return;
  }
  const type = extOf(filename) === "csv" ? "string" : "array";
  const data = type === "string" ? await blob.text() : new Uint8Array(await blob.arrayBuffer());
  const workbook = XLSX.read(data, { type });

  const tableWrap = document.createElement("div");
  tableWrap.className = "table-wrap";
  const tabsEl = document.createElement("div");
  tabsEl.className = "sheet-tabs";

  function showSheet(name) {
    const sheet = workbook.Sheets[name];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false });
    const table = document.createElement("table");
    table.className = "data-table";
    if (rows.length) {
      const thead = document.createElement("thead");
      const headRow = document.createElement("tr");
      rows[0].forEach((cellVal) => {
        const th = document.createElement("th");
        th.textContent = cellVal ?? "";
        headRow.appendChild(th);
      });
      thead.appendChild(headRow);
      const tbody = document.createElement("tbody");
      rows.slice(1).forEach((row) => {
        const tr = document.createElement("tr");
        row.forEach((cellVal) => {
          const td = document.createElement("td");
          td.textContent = cellVal ?? "";
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.append(thead, tbody);
    }
    tableWrap.innerHTML = "";
    tableWrap.appendChild(table);
    tabsEl.querySelectorAll(".sheet-tab").forEach((t) => t.classList.toggle("on", t.textContent === name));
  }

  workbook.SheetNames.forEach((name) => {
    const tab = document.createElement("span");
    tab.className = "sheet-tab";
    tab.textContent = name;
    tab.addEventListener("click", () => showSheet(name));
    tabsEl.appendChild(tab);
  });

  container.append(tableWrap, tabsEl);
  if (workbook.SheetNames.length) showSheet(workbook.SheetNames[0]);
}

// --- ZIP: browse contents via JSZip, no extraction ------------------------
async function renderZipPreview(container, blob) {
  if (!window.JSZip) {
    container.textContent = "Archive viewer failed to load.";
    return;
  }
  const zip = await JSZip.loadAsync(blob);
  const list = document.createElement("div");
  list.className = "zip-list";
  const entries = Object.values(zip.files).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const row = document.createElement("div");
    const depth = (entry.name.match(/\//g) || []).length - (entry.dir ? 1 : 0);
    row.className = `zip-row${depth > 0 ? ` depth${Math.min(depth, 2)}` : ""}`;
    const icon = document.createElement("span");
    icon.className = "zi";
    icon.textContent = entry.dir ? "📂" : "📝";
    const name = document.createElement("span");
    name.className = "zn";
    name.textContent = entry.name.replace(/\/$/, "").split("/").pop() + (entry.dir ? "/" : "");
    const size = document.createElement("span");
    size.className = "zs";
    if (!entry.dir) {
      const raw = await entry.async("uint8array");
      size.textContent = formatBytes(raw.length);
    }
    row.append(icon, name, size);
    list.appendChild(row);
  }
  container.appendChild(list);
}

document.getElementById("back-to-list-btn").addEventListener("click", () => {
  if (confirmDiscardIfDirty()) closeAllPanels();
});
document.getElementById("preview-back-btn").addEventListener("click", closeAllPanels);

document.getElementById("save-file-btn").addEventListener("click", async () => {
  if (!state.openFile || !cm) return;
  const content = cm.getValue();
  try {
    await api("/api/file", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: state.openFile, content }),
    });
    savedGeneration = cm.changeGeneration(true);
    updateDirtyIndicator();
    loadFiles();
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById("editor-download-btn").addEventListener("click", () => state.openFile && downloadFile(state.openFile));
document.getElementById("delete-file-btn").addEventListener("click", () => state.openFile && trashPath(state.openFile, closeAllPanels));
document.getElementById("preview-delete-btn").addEventListener("click", () => state.previewFile && trashPath(state.previewFile, closeAllPanels));
document.getElementById("move-file-btn").addEventListener("click", () => state.openFile && openMovePicker(state.openFile, closeAllPanels));
document.getElementById("preview-move-btn").addEventListener("click", () => state.previewFile && openMovePicker(state.previewFile, closeAllPanels));
document.getElementById("preview-download-btn").addEventListener("click", () => state.previewFile && downloadFile(state.previewFile));

async function trashPath(filepath, onDone) {
  if (!confirm(`Move ${filepath} to _trash?`)) return;
  try {
    await api("/api/trash", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: filepath }),
    });
    onDone?.();
    loadFiles();
  } catch (err) {
    alert(err.message);
  }
}

const movePicker = { source: "", folder: "", onDone: null, folders: [], canCreate: true };

function movePickerDestination() {
  const name = document.getElementById("move-picker-name").value.trim();
  return movePicker.folder ? `${movePicker.folder}/${name}` : name;
}

function updateMovePickerDestination() {
  document.getElementById("move-picker-destination").textContent = `/${movePickerDestination()}`;
}

function renderMovePickerBreadcrumbs() {
  const wrap = document.getElementById("move-picker-breadcrumbs");
  wrap.innerHTML = "";
  const parts = movePicker.folder ? movePicker.folder.split("/") : [];
  const root = Object.assign(document.createElement("button"), { type: "button", textContent: "🏠 Hive" });
  root.addEventListener("click", () => loadMovePickerFolder(""));
  wrap.appendChild(root);
  parts.forEach((part, index) => {
    wrap.appendChild(Object.assign(document.createElement("span"), { textContent: "›" }));
    const button = Object.assign(document.createElement("button"), { type: "button", textContent: part });
    button.addEventListener("click", () => loadMovePickerFolder(parts.slice(0, index + 1).join("/")));
    wrap.appendChild(button);
  });
}

function renderMovePickerFolders() {
  const list = document.getElementById("move-picker-folders");
  const query = document.getElementById("move-picker-filter").value.trim().toLowerCase();
  const folders = movePicker.folders.filter((entry) => !query || entry.name.toLowerCase().includes(query));
  list.innerHTML = "";
  if (!folders.length) {
    list.appendChild(Object.assign(document.createElement("li"), { className: "empty", textContent: query ? "No matching folders." : "No folders here." }));
    return;
  }
  folders.forEach((entry) => {
    const li = document.createElement("li");
    const button = Object.assign(document.createElement("button"), { type: "button", textContent: `📁 ${entry.name}` });
    button.addEventListener("click", () => loadMovePickerFolder(movePicker.folder ? `${movePicker.folder}/${entry.name}` : entry.name));
    li.appendChild(button);
    list.appendChild(li);
  });
}

async function loadMovePickerFolder(folder) {
  movePicker.folder = folder;
  document.getElementById("move-picker-error").textContent = "";
  document.getElementById("move-picker-folders").innerHTML = '<li class="empty">Loading folders…</li>';
  renderMovePickerBreadcrumbs();
  updateMovePickerDestination();
  try {
    const { entries, folderPermissions } = await api(`/api/files?subpath=${encodeURIComponent(folder)}`);
    movePicker.canCreate = effectivePermissions(folderPermissions).create;
    document.getElementById("move-picker-confirm").disabled = !movePicker.canCreate;
    if (!movePicker.canCreate) document.getElementById("move-picker-error").textContent = "You can browse this folder, but you cannot move items into it.";
    movePicker.folders = entries.filter((entry) => entry.type === "dir").sort((a, b) => a.name.localeCompare(b.name));
    renderMovePickerFolders();
  } catch (err) {
    movePicker.folders = [];
    movePicker.canCreate = false;
    document.getElementById("move-picker-confirm").disabled = true;
    document.getElementById("move-picker-error").textContent = err.message;
    renderMovePickerFolders();
  }
}

function closeMovePicker() {
  document.getElementById("move-picker-overlay").classList.add("hidden");
  movePicker.source = "";
  movePicker.onDone = null;
}

function openMovePicker(filepath, onDone) {
  const parts = filepath.split("/");
  const name = parts.pop();
  movePicker.source = filepath;
  movePicker.onDone = onDone || null;
  document.getElementById("move-picker-source").textContent = `Moving: ${name}`;
  document.getElementById("move-picker-name").value = name;
  document.getElementById("move-picker-filter").value = "";
  document.getElementById("move-picker-overlay").classList.remove("hidden");
  loadMovePickerFolder(parts.join("/"));
}

document.getElementById("move-picker-up").addEventListener("click", () => {
  if (!movePicker.folder) return;
  loadMovePickerFolder(movePicker.folder.split("/").slice(0, -1).join("/"));
});
document.getElementById("move-picker-filter").addEventListener("input", renderMovePickerFolders);
document.getElementById("move-picker-name").addEventListener("input", updateMovePickerDestination);
document.getElementById("move-picker-cancel").addEventListener("click", closeMovePicker);
document.getElementById("move-picker-overlay").addEventListener("click", (event) => {
  if (event.target.id === "move-picker-overlay") closeMovePicker();
});
document.getElementById("move-picker-confirm").addEventListener("click", async () => {
  const destination = movePickerDestination();
  const error = document.getElementById("move-picker-error");
  if (!destination) return void (error.textContent = "Enter a file or folder name.");
  if (!movePicker.canCreate) return void (error.textContent = "You cannot move items into this folder.");
  if (destination === movePicker.source) return closeMovePicker();
  const button = document.getElementById("move-picker-confirm");
  button.disabled = true;
  error.textContent = "";
  try {
    await api("/api/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: movePicker.source, to: destination }),
    });
    const onDone = movePicker.onDone;
    closeMovePicker();
    onDone?.();
    loadFiles();
  } catch (err) {
    error.textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

async function downloadFile(filepath) {
  try {
    const resp = await fetch(`/api/download?path=${encodeURIComponent(filepath)}`, {
      headers: { Authorization: `Bearer ${state.token}` },
    });
    if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filepath.split("/").pop();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (err) {
    alert(err.message);
  }
}

document.getElementById("new-folder-btn").addEventListener("click", async () => {
  const name = prompt("New folder name:");
  if (!name) return;
  const full = state.subpath ? `${state.subpath}/${name}` : name;
  try {
    await api("/api/mkdir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: full }),
    });
    loadFiles();
  } catch (err) {
    alert(err.message);
  }
});

// --- Sorter tab -------------------------------------------------------------
// The addon sorter is a separate localhost service (MasterHiveSorter); the
// panel proxies its API at /api/sorter/* behind panel auth. This tab drives
// the whole preview -> edit -> confirm flow inline: items on the left,
// destination picker for the selected item on the right. Nothing moves on
// disk until Confirm.
const sorter = { session: null, folders: [], selected: -1, filter: "" };

function sorterApi(subpath, opts = {}) {
  return api(`/api/sorter${subpath}`, opts);
}

function sorterItems() {
  return sorter.session?.items || [];
}

function sorterSetStatus(text) {
  document.getElementById("sorter-status").textContent = text;
}

let sorterSaveTimer = null;
function sorterSaveSoon() {
  clearTimeout(sorterSaveTimer);
  sorterSaveTimer = setTimeout(() => {
    if (!sorter.session) return;
    sorterApi("/session", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sorter.session),
    }).catch(() => {});
  }, 400);
}

function sorterRenderItems() {
  const listEl = document.getElementById("sorter-items");
  const items = sorterItems();
  listEl.innerHTML = "";
  document.getElementById("sorter-items-empty").classList.toggle("hidden", items.length > 0);
  items.forEach((item, i) => {
    const li = document.createElement("li");
    li.className = `${i === sorter.selected ? "selected " : ""}${item.approved ? "approved" : ""}`;
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!item.approved;
    cb.addEventListener("click", (e) => e.stopPropagation());
    cb.addEventListener("change", () => {
      item.approved = cb.checked;
      sorterRenderItems();
      sorterRenderDetail();
      sorterSaveSoon();
    });
    const name = document.createElement("span");
    name.className = "sorter-item-name";
    name.textContent = item.name;
    const klass = document.createElement("span");
    klass.className = "sorter-item-class";
    klass.textContent = item.classification || "";
    li.append(cb, name, klass);
    li.addEventListener("click", () => {
      sorter.selected = i;
      sorterRenderItems();
      sorterRenderDetail();
    });
    listEl.appendChild(li);
  });
  const approved = items.filter((x) => x.approved).length;
  if (items.length) sorterSetStatus(`${items.length} item(s) in preview — ${approved} approved. Nothing moves until you confirm.`);
  document.getElementById("sorter-approve-all").checked = items.length > 0 && approved === items.length;
}

function sorterRenderDetail() {
  const item = sorterItems()[sorter.selected];
  document.getElementById("sorter-detail-empty").classList.toggle("hidden", !!item);
  document.getElementById("sorter-detail").classList.toggle("hidden", !item);
  if (!item) return;
  document.getElementById("sorter-detail-name").textContent = item.name;
  document.getElementById("sorter-detail-reason").textContent = [item.classification, item.reason].filter(Boolean).join(" — ");
  document.getElementById("sorter-detail-approve").checked = !!item.approved;
  document.getElementById("sorter-detail-dest").value = item.selectedDestination || "";
  const folderEl = document.getElementById("sorter-folders");
  folderEl.innerHTML = "";
  const filter = sorter.filter.toLowerCase();
  sorter.folders
    .filter((f) => !filter || f.toLowerCase().includes(filter))
    .forEach((f) => {
      const li = document.createElement("li");
      li.textContent = f;
      if (item.selectedDestination?.startsWith(`${f}/`)) li.classList.add("selected");
      li.addEventListener("click", () => {
        item.selectedDestination = `${f}/${item.name}`;
        item.approved = true; // picking a folder implies you want it moved
        sorterRenderItems();
        sorterRenderDetail();
        sorterSaveSoon();
      });
      folderEl.appendChild(li);
    });
}

async function sorterLoad() {
  try {
    const [session, foldersResp] = await Promise.all([
      sorterApi("/session"),
      sorterApi("/folders").catch(() => ({ folders: [] })),
    ]);
    sorter.session = session;
    sorter.folders = (foldersResp.folders || []).map((f) => f.path || f);
    if (sorter.selected >= sorterItems().length) sorter.selected = -1;
    sorterRenderItems();
    sorterRenderDetail();
    if (!sorterItems().length) {
      sorterSetStatus(session.status === "confirmed" ? "Last run confirmed. Load a new preview when ready." : "No preview loaded.");
    }
  } catch (err) {
    sorterSetStatus(err.message);
  }
}

document.getElementById("sorter-refresh-btn").addEventListener("click", sorterLoad);

document.getElementById("sorter-start-btn").addEventListener("click", async () => {
  sorterSetStatus("Scanning inbox…");
  try {
    sorter.session = await sorterApi("/startsorter", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    sorter.selected = sorterItems().length ? 0 : -1;
    sorterRenderItems();
    sorterRenderDetail();
    if (!sorterItems().length) sorterSetStatus("Inbox is empty — nothing to sort.");
  } catch (err) {
    sorterSetStatus(err.message);
  }
});

document.getElementById("sorter-stop-btn").addEventListener("click", async () => {
  try {
    sorter.session = await sorterApi("/stopsorter", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    sorter.selected = -1;
    sorterRenderItems();
    sorterRenderDetail();
    sorterSetStatus("Preview discarded. Nothing was moved.");
  } catch (err) {
    sorterSetStatus(err.message);
  }
});

document.getElementById("sorter-confirm-btn").addEventListener("click", async () => {
  const items = sorterItems();
  if (!items.length) return alert("Nothing to confirm — load a preview first.");
  const approved = items.filter((x) => x.approved);
  if (!approved.length) return alert("No items approved. Tick the ones you want moved.");
  if (!confirm(`Move ${approved.length} approved item(s) to their destinations?`)) return;
  try {
    // Flush pending edits so confirm sees the latest destinations.
    clearTimeout(sorterSaveTimer);
    await sorterApi("/session", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sorter.session) });
    const result = await sorterApi("/confirmsorter", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }) });
    sorter.selected = -1;
    await sorterLoad();
    sorterSetStatus(`Moved ${result.moved?.length ?? 0} item(s)${result.skipped?.length ? `, skipped ${result.skipped.length}` : ""}.`);
    loadFiles(); // moved files change the Files listing
  } catch (err) {
    sorterSetStatus(err.message);
  }
});

document.getElementById("sorter-approve-all").addEventListener("change", (e) => {
  sorterItems().forEach((x) => (x.approved = e.target.checked));
  sorterRenderItems();
  sorterRenderDetail();
  sorterSaveSoon();
});

document.getElementById("sorter-detail-approve").addEventListener("change", (e) => {
  const item = sorterItems()[sorter.selected];
  if (!item) return;
  item.approved = e.target.checked;
  sorterRenderItems();
  sorterSaveSoon();
});

document.getElementById("sorter-folder-filter").addEventListener("input", (e) => {
  sorter.filter = e.target.value;
  sorterRenderDetail();
});

document.getElementById("sorter-detail-dest").addEventListener("input", (e) => {
  const item = sorterItems()[sorter.selected];
  if (!item) return;
  item.selectedDestination = e.target.value;
  sorterSaveSoon();
});

const uploadState = { items: [], running: false };
const uploadPanel = document.getElementById("upload-panel");
const uploadInput = document.getElementById("upload-input");
const uploadQueue = document.getElementById("upload-queue");
const uploadDropzone = document.getElementById("upload-dropzone");

function uploadFormatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function uploadDestination(name = "") {
  return state.subpath ? `${state.subpath}/${name}` : name;
}

function renderUploadQueue() {
  document.getElementById("upload-destination").textContent = `Destination: /${state.subpath || ""}`;
  uploadQueue.innerHTML = "";
  for (const item of uploadState.items) {
    const li = document.createElement("li");
    li.className = `upload-item ${item.status || "queued"}`;
    li.innerHTML = '<div class="upload-item-row"><span class="upload-item-name"></span><span class="upload-item-size"></span><button class="upload-remove" type="button" aria-label="Remove">X</button></div><div class="upload-progress"><span></span></div><div class="upload-item-status"></div>';
    li.querySelector(".upload-item-name").textContent = item.file.name;
    li.querySelector(".upload-item-size").textContent = uploadFormatBytes(item.file.size);
    li.querySelector(".upload-progress span").style.width = `${item.progress || 0}%`;
    li.querySelector(".upload-item-status").textContent = item.message || (item.status === "done" ? "Uploaded" : item.status === "failed" ? "Failed" : "Ready");
    li.querySelector(".upload-remove").disabled = uploadState.running;
    li.querySelector(".upload-remove").addEventListener("click", () => { uploadState.items = uploadState.items.filter((x) => x !== item); renderUploadQueue(); });
    uploadQueue.appendChild(li);
  }
  const total = uploadState.items.reduce((sum, item) => sum + item.file.size, 0);
  const done = uploadState.items.filter((item) => item.status === "done").length;
  const failed = uploadState.items.filter((item) => item.status === "failed").length;
  document.getElementById("upload-summary").textContent = uploadState.items.length ? `${uploadState.items.length} file(s) - ${uploadFormatBytes(total)}${done ? ` - ${done} done` : ""}${failed ? ` - ${failed} failed` : ""}` : "No files selected";
  document.getElementById("upload-start-btn").disabled = uploadState.running || !uploadState.items.some((item) => item.status !== "done");
}

function addUploadFiles(files) {
  for (const file of files) {
    const duplicate = uploadState.items.some((item) => item.file.name === file.name && item.file.size === file.size);
    if (!duplicate) uploadState.items.push({ file, progress: 0, status: "queued", message: "Ready" });
  }
  uploadPanel.classList.remove("hidden");
  renderUploadQueue();
}

function uploadOne(item) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    const dest = uploadDestination(item.file.name);
    xhr.open("POST", `/api/upload?path=${encodeURIComponent(dest)}`);
    xhr.setRequestHeader("Authorization", `Bearer ${state.token}`);
    xhr.setRequestHeader("Content-Type", item.file.type || "application/octet-stream");
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) { item.progress = Math.round((event.loaded / event.total) * 100); renderUploadQueue(); } };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { item.status = "done"; item.progress = 100; item.message = `Uploaded to /${dest}`; }
      else { let message = `Upload failed: ${xhr.status}`; try { message = JSON.parse(xhr.responseText).error || message; } catch {} item.status = "failed"; item.message = message; }
      renderUploadQueue(); resolve();
    };
    xhr.onerror = () => { item.status = "failed"; item.message = "Network error"; renderUploadQueue(); resolve(); };
    item.status = "uploading"; item.message = "Uploading..."; renderUploadQueue(); xhr.send(item.file);
  });
}

document.getElementById("upload-btn").addEventListener("click", () => { uploadPanel.classList.toggle("hidden"); renderUploadQueue(); });
document.getElementById("upload-close-btn").addEventListener("click", () => uploadPanel.classList.add("hidden"));
document.getElementById("upload-clear-btn").addEventListener("click", () => { if (!uploadState.running) { uploadState.items = []; renderUploadQueue(); } });
uploadDropzone.addEventListener("click", () => uploadInput.click());
uploadInput.addEventListener("change", (event) => { addUploadFiles([...event.target.files]); event.target.value = ""; });
for (const eventName of ["dragenter", "dragover"]) uploadDropzone.addEventListener(eventName, (event) => { event.preventDefault(); uploadDropzone.classList.add("dragover"); });
for (const eventName of ["dragleave", "drop"]) uploadDropzone.addEventListener(eventName, (event) => { event.preventDefault(); uploadDropzone.classList.remove("dragover"); });
uploadDropzone.addEventListener("drop", (event) => addUploadFiles([...event.dataTransfer.files]));
document.getElementById("upload-start-btn").addEventListener("click", async () => {
  const overwrite = document.getElementById("upload-overwrite").checked;
  const existing = new Set([...document.querySelectorAll("#file-list .row-name")].map((el) => el.textContent.trim()));
  const conflicts = uploadState.items.filter((item) => item.status !== "done" && existing.has(item.file.name));
  if (conflicts.length && !overwrite) { alert(`${conflicts.length} file(s) already exist here. Enable Replace files with the same name to continue.`); return; }
  if (conflicts.length && overwrite && !confirm(`Replace ${conflicts.length} existing file(s)?`)) return;
  uploadState.running = true; renderUploadQueue();
  for (const item of uploadState.items.filter((item) => item.status !== "done")) await uploadOne(item);
  uploadState.running = false; renderUploadQueue(); await loadFiles();
});

// --- System tab ------------------------------------------------------------
document.getElementById("system-refresh-btn").addEventListener("click", loadSystem);

document.querySelectorAll(".control-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const target = btn.dataset.target;
    const action = btn.dataset.action;
    let confirmMsg = `${action[0].toUpperCase()}${action.slice(1)} ${target}?`;
    if (target === "panel" && action !== "restart") {
      confirmMsg += " This panel will become unreachable until it's started again some other way (RDP, or Start-Service MasterBrainPanel).";
    }
    if (!confirm(confirmMsg)) return;
    btn.disabled = true;
    setSystemControlMessage(`${action[0].toUpperCase()}${action.slice(1)} ${target}...`);
    try {
      const body = await api("/api/system/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target, action }),
      });
      setSystemControlMessage(body.note || `${target} ${action} request completed.`, "success");
      if (body.note) alert(body.note);
      scheduleSystemRefresh(target === "hive" && action !== "stop" ? 8 : 3, 2000);
    } catch (err) {
      setSystemControlMessage(err.message, "error");
      alert(err.message);
    } finally {
      btn.disabled = false;
    }
  });
});

function formatLogLine(line) {
  try {
    const entry = JSON.parse(line);
    if (!entry.event) return line;
    const { ts, event, ...fields } = entry;
    const details = Object.entries(fields)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .map(([key, value]) => `${key}=${value}`)
      .join(" ");
    return `[${ts || "-"}] ${event}${details ? ` ${details}` : ""}`;
  } catch {
    return line;
  }
}

function parseLogLine(line) {
  try {
    const entry = JSON.parse(line);
    return entry?.event ? entry : null;
  } catch {
    return null;
  }
}

document.querySelectorAll(".log-tab-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const group = btn.closest(".log-tabs");
    group.querySelectorAll(".log-tab-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const which = btn.dataset.log;
    const target = which.split("-")[0]; // hive | tunnel | panel
    try {
      const { lines } = await api(`/api/system/logs?which=${which}`);
      document.getElementById(`log-${target}`).textContent = lines.map(formatLogLine).join("\n") || "(empty)";
    } catch (err) {
      document.getElementById(`log-${target}`).textContent = err.message;
    }
  });
});

function classifyOauthClient(client) {
  if (client.flow === "chatgpt") return "codex";
  if (client.flow === "claude") return "claude";
  const redirects = client.redirectUris || [];
  if (redirects.some((uri) => uri.includes("chatgpt.com/connector/oauth"))) return "codex";
  if (redirects.some((uri) => uri.includes("claude.ai/api/mcp/auth_callback"))) return "claude";
  return "other";
}

function normalizeFlow(flow) {
  if (flow === "chatgpt" || flow === "codex") return "codex";
  if (flow === "claude") return "claude";
  return "shared";
}

function countFlowEvents(entries, flowKey, eventName) {
  return entries.filter((entry) => normalizeFlow(entry.flow) === flowKey && entry.event === eventName).length;
}

function renderFlowStats(entries, flowKey) {
  const writes = countFlowEvents(entries, flowKey, "file.change.write");
  const uploads = countFlowEvents(entries, flowKey, "file.change.upload");
  const moves = countFlowEvents(entries, flowKey, "file.change.move");
  const deletes = countFlowEvents(entries, flowKey, "file.change.delete");
  document.getElementById(`flow-${flowKey}-writes`).textContent = writes;
  document.getElementById(`flow-${flowKey}-uploads`).textContent = uploads;
  document.getElementById(`flow-${flowKey}-moves`).textContent = moves;
  document.getElementById(`flow-${flowKey}-deletes`).textContent = deletes;
}

function renderRecentFlowLog(entries) {
  const recent = entries
    .filter((entry) => entry.event?.startsWith("file.change.") || entry.event?.startsWith("oauth.") || entry.event?.startsWith("mcp."))
    .slice(-12)
    .map((entry) => formatLogLine(JSON.stringify(entry)));
  document.getElementById("flow-recent-log").textContent = recent.join("\n") || "(no recent connection events)";
}

function renderFlowStatus(hiveRunning, oauth, logEntries = []) {
  const clients = oauth?.clients || [];
  const flows = {
    codex: clients.filter((client) => classifyOauthClient(client) === "codex"),
    claude: clients.filter((client) => classifyOauthClient(client) === "claude"),
  };
  const accounts = [...new Set((oauth?.refreshTokens || []).map((token) => token.email))];
  const mcpEvents = logEntries.filter((entry) => entry.event?.startsWith("mcp.") || entry.event?.startsWith("tool.")).length;
  const allReady = hiveRunning && flows.codex.length > 0 && flows.claude.length > 0;
  setPill("flows-pill", allReady, allReady ? "ready" : "check");
  setPill("flow-shared-pill", hiveRunning, hiveRunning ? "online" : "offline");
  document.getElementById("flow-shared-detail").textContent = hiveRunning
    ? "Shared Hive MCP is reachable."
    : "Shared Hive MCP is offline.";
  document.getElementById("flow-shared-accounts").textContent = accounts.length;
  document.getElementById("flow-shared-events").textContent = mcpEvents;
  renderFlowStats(logEntries, "shared");

  [
    ["codex", "ChatGPT/Codex"],
    ["claude", "Claude"],
  ].forEach(([key, label]) => {
    const flowReady = hiveRunning && flows[key].length > 0;
    setPill(`flow-${key}-pill`, flowReady, flowReady ? "registered" : "missing");
    const detail = document.getElementById(`flow-${key}-detail`);
    const count = flows[key].length;
    const flowEvents = logEntries.filter((entry) => normalizeFlow(entry.flow) === key).length;
    const plural = count === 1 ? "client" : "clients";
    detail.textContent = hiveRunning
      ? `${count} ${label} OAuth ${plural} registered.`
      : "Hive server is stopped, so this flow is offline.";
    document.getElementById(`flow-${key}-clients`).textContent = count;
    document.getElementById(`flow-${key}-events`).textContent = flowEvents;
    renderFlowStats(logEntries, key);
  });
  renderRecentFlowLog(logEntries);
}

async function loadSystem() {
  let hiveRunning = false;
  try {
    const s = await api("/api/system/status");
    hiveRunning = s.hive.running === true;
    const hiveKnown = typeof s.hive.running === "boolean";
    setPill("svc-hive-pill", hiveKnown ? hiveRunning : null, hiveKnown ? (hiveRunning ? "running" : "stopped") : "unknown");
    setPill("svc-tunnel-pill", s.tunnel.running, s.tunnel.running ? "running" : "stopped");
    const panelOk = s.panel.status === "Running";
    setPill("svc-panel-pill", panelOk, s.panel.status);
    if (s.sorter) {
      const sorterKnown = typeof s.sorter.running === "boolean";
      setPill("svc-sorter-pill", sorterKnown ? s.sorter.running : null, sorterKnown ? (s.sorter.running ? "running" : "stopped") : "unknown");
    }

    const usedPct = Math.round((s.disk.usedGB / s.disk.totalGB) * 100);
    document.getElementById("disk-bar-fill").style.width = `${usedPct}%`;
    const diskText =
      `${s.disk.usedGB} GB used / ${s.disk.freeGB} GB free (${s.disk.totalGB} GB total)`;
    const diskTextEl = document.getElementById("disk-text");
    if (diskTextEl) diskTextEl.textContent = diskText;
    const diskSummaryEl = document.getElementById("disk-summary");
    if (diskSummaryEl) diskSummaryEl.textContent = `${s.disk.freeGB} GB free`;
  } catch (err) {
    console.error(err);
  }

  try {
    const oauth = await api("/api/system/oauth");
    const activityLog = await api("/api/system/logs?which=hive-events").catch(() => ({ lines: [] }));
    const logEntries = (activityLog.lines || []).map(parseLogLine).filter(Boolean);
    const body = document.getElementById("oauth-clients-body");
    body.innerHTML = "";
    oauth.clients.forEach((c) => {
      const host = (c.redirectUris[0] || "").match(/^https?:\/\/([^/]+)/)?.[1] || c.redirectUris[0] || "-";
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${c.id}</td><td>${host}</td>`;
      body.appendChild(tr);
    });
    const emailsEl = document.getElementById("oauth-emails");
    emailsEl.innerHTML = "";
    const uniqueEmails = [...new Set(oauth.refreshTokens.map((r) => r.email))];
    uniqueEmails.forEach((email) => {
      const li = document.createElement("li");
      li.textContent = email;
      emailsEl.appendChild(li);
    });
    if (!uniqueEmails.length) emailsEl.innerHTML = "<li>(none)</li>";
    renderFlowStatus(hiveRunning, oauth, logEntries);
  } catch (err) {
    console.error(err);
    renderFlowStatus(hiveRunning, { clients: [] });
  }

  if (state.role === "admin") loadTrashConfig();
  loadUsers();
}

async function loadTrashConfig() {
  try {
    const config = await api("/api/system/trash-config");
    document.getElementById("trash-retention-days").value = config.retentionDays;
    document.getElementById("trash-config-message").textContent = `Auto-empty after ${config.retentionDays} day${config.retentionDays === 1 ? "" : "s"}.`;
  } catch (err) {
    document.getElementById("trash-config-message").textContent = err.message;
  }
}

// --- Users (admin only) ---------------------------------------------------
async function loadUsers() {
  if (state.role !== "admin") return;
  try {
    const { users } = await api("/api/users");
    const body = document.getElementById("users-body");
    body.innerHTML = "";
    users.forEach((u) => {
      const tr = document.createElement("tr");
      const nameTd = document.createElement("td");
      nameTd.textContent = u.username;
      const roleTd = document.createElement("td");
      roleTd.textContent = u.role;
      const actionTd = document.createElement("td");
      const del = document.createElement("button");
      del.className = "icon-btn danger";
      del.textContent = "🗑";
      del.title = "Delete user";
      del.addEventListener("click", () => deleteUser(u.username));
      actionTd.appendChild(del);
      tr.append(nameTd, roleTd, actionTd);
      body.appendChild(tr);
    });
    if (!users.length) body.innerHTML = `<tr><td colspan="3">(none)</td></tr>`;
  } catch (err) {
    console.error(err);
  }
}

async function deleteUser(username) {
  if (!confirm(`Delete user '${username}'?`)) return;
  try {
    await api(`/api/users/${encodeURIComponent(username)}`, { method: "DELETE" });
    loadUsers();
  } catch (err) {
    alert(err.message);
  }
}

document.getElementById("user-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = document.getElementById("user-form-username").value.trim();
  const pin = document.getElementById("user-form-pin").value.trim();
  const role = document.getElementById("user-form-role").value;
  const errorEl = document.getElementById("user-form-error");
  errorEl.textContent = "";
  try {
    await api("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, pin, role }),
    });
    e.target.reset();
    loadUsers();
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

document.getElementById("trash-config-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const days = Number(document.getElementById("trash-retention-days").value);
  const messageEl = document.getElementById("trash-config-message");
  messageEl.textContent = "";
  try {
    const resp = await api("/api/system/trash-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retentionDays: days }),
    });
    messageEl.textContent = `Auto-empty set to ${resp.retentionDays} day${resp.retentionDays === 1 ? "" : "s"}.`;
  } catch (err) {
    messageEl.textContent = err.message;
  }
});

document.getElementById("empty-trash-btn").addEventListener("click", async () => {
  if (!confirm("Permanently delete everything in _trash?")) return;
  const messageEl = document.getElementById("trash-config-message");
  messageEl.textContent = "";
  try {
    const resp = await api("/api/trash/empty", { method: "POST" });
    messageEl.textContent = resp.deletedCount
      ? `Deleted ${resp.deletedCount} trash entr${resp.deletedCount === 1 ? "y" : "ies"}.`
      : "_trash is already empty.";
    if (state.subpath === "_trash" || state.subpath === "🗑 Trash") loadFiles();
  } catch (err) {
    messageEl.textContent = err.message;
  }
});

document.getElementById("guarded-hardstop-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const confirmText = document.getElementById("guarded-hardstop-confirm").value.trim();
  const password = document.getElementById("guarded-hardstop-password").value;
  const messageEl = document.getElementById("guarded-hardstop-message");
  const outputEl = document.getElementById("guarded-hardstop-output");
  const runBtn = document.getElementById("guarded-hardstop-run-btn");

  messageEl.textContent = "";
  if (confirmText !== "RUN HARDSTOP") {
    messageEl.textContent = "Type RUN HARDSTOP exactly.";
    return;
  }
  if (!password) {
    messageEl.textContent = "Hard-stop password is required.";
    return;
  }
  if (!confirm("Run hardstop.ps1 now?")) return;

  runBtn.disabled = true;
  outputEl.textContent = "(running...)";
  try {
    const resp = await api("/api/system/hardstop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmText, password }),
    });
    messageEl.textContent = "Script completed.";
    outputEl.textContent = [resp.stdout?.trim(), resp.stderr?.trim()]
      .filter(Boolean)
      .join("\n\n[stderr]\n") || "(no output)";
    document.getElementById("guarded-hardstop-confirm").value = "";
    document.getElementById("guarded-hardstop-password").value = "";
    loadSystem();
  } catch (err) {
    messageEl.textContent = err.message;
    outputEl.textContent = "(script failed)";
  } finally {
    runBtn.disabled = false;
  }
});

document.getElementById("setup-pin-toggle").addEventListener("click", () => {
  const pinInput = document.getElementById("setup-admin-pin");
  const btn = document.getElementById("setup-pin-toggle");
  const showing = pinInput.type === "text";
  pinInput.type = showing ? "password" : "text";
  btn.textContent = showing ? "👁" : "🙈";
  btn.setAttribute("aria-label", showing ? "Show PIN" : "Hide PIN");
});

document.getElementById("setup-oauth-toggle").addEventListener("click", () => {
  const fields = document.getElementById("setup-oauth-fields");
  const btn = document.getElementById("setup-oauth-toggle");
  const showing = !fields.classList.contains("hidden");
  fields.classList.toggle("hidden");
  btn.textContent = showing
    ? "▸ Advanced: OAuth login for Claude/ChatGPT (optional)"
    : "▾ Advanced: OAuth login for Claude/ChatGPT (optional)";
});

let setupLoginCreds = null;

document.getElementById("setup-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("setup-error");
  const statusEl = document.getElementById("setup-status");
  const submitBtn = e.target.querySelector("button[type=submit]");
  errorEl.textContent = "";

  const dataFolder = document.getElementById("setup-data-folder").value.trim();
  const hivePort = document.getElementById("setup-hive-port").value.trim() || "3939";
  const publicBaseUrl = document.getElementById("setup-public-url").value.trim();
  const cfClientId = document.getElementById("setup-cf-client-id").value.trim();
  const cfClientSecret = document.getElementById("setup-cf-client-secret").value.trim();
  const cfAuthorizeUrl = document.getElementById("setup-cf-authorize-url").value.trim();
  const cfTokenUrl = document.getElementById("setup-cf-token-url").value.trim();
  const adminUsername = document.getElementById("setup-admin-username").value.trim();
  const adminPin = document.getElementById("setup-admin-pin").value.trim();

  submitBtn.disabled = true;
  statusEl.textContent = "Setting up...";
  try {
    const resp = await fetch("/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dataFolder, hivePort, publicBaseUrl,
        cfClientId, cfClientSecret, cfAuthorizeUrl, cfTokenUrl,
        adminUsername, adminPin,
      }),
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(body.error || "Setup failed");

    setupLoginCreds = { username: adminUsername, pin: adminPin };
    document.getElementById("setup-done-url").value = body.mcpUrl || "";
    document.getElementById("setup-done-key").value = body.hiveApiKey || "";
    document.getElementById("setup-done-oauth-note").classList.toggle("hidden", !body.oauthConfigured);
    document.getElementById("setup-form").classList.add("hidden");
    document.getElementById("setup-done").classList.remove("hidden");
  } catch (err) {
    statusEl.textContent = "";
    errorEl.textContent = err.message;
  } finally {
    submitBtn.disabled = false;
  }
});

document.getElementById("setup-done-continue").addEventListener("click", async () => {
  if (!setupLoginCreds) return;
  try {
    const loginResp = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(setupLoginCreds),
    });
    const loginBody = await loginResp.json().catch(() => ({}));
    if (!loginResp.ok) throw new Error(loginBody.error || "Auto-login failed - log in below.");

    state.token = loginBody.token;
    state.username = loginBody.username;
    state.role = loginBody.role || "";
    localStorage.setItem("panelToken", state.token);
    localStorage.setItem("panelUsername", state.username);
    localStorage.setItem("panelRole", state.role);
    document.getElementById("setup").classList.add("hidden");
    showApp();
  } catch (err) {
    document.getElementById("setup").classList.add("hidden");
    document.getElementById("login").classList.remove("hidden");
    document.getElementById("login-error").textContent = err.message;
  }
});

async function bootstrap() {
  try {
    const resp = await fetch("/api/setup/status");
    const body = await resp.json().catch(() => ({}));
    if (body.needsSetup) {
      document.getElementById("setup").classList.remove("hidden");
      return;
    }
  } catch {
    // if the check itself fails, fall through to the normal login flow
  }
  if (state.token) {
    showApp();
  } else {
    document.getElementById("login").classList.remove("hidden");
  }
}

bootstrap();
setInterval(() => {
  refreshStatus();
  if (state.token) checkSorterAvailable(); // tab tracks the service coming and going
}, 30000);

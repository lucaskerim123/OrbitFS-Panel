const state = {
  token: localStorage.getItem("panelToken") || "",
  username: localStorage.getItem("panelUsername") || "",
  role: localStorage.getItem("panelRole") || "",
  subpath: "",
  openFile: null,
  previewFile: null,
};

const TEXT_EXTENSIONS = new Set([
  "md", "txt", "json", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "yml", "yaml", "html",
  "htm", "css", "csv", "log", "xml", "sh", "ps1", "ini", "toml", "env",
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
const PROTECTED_ROOT_FOLDERS = new Set([
  "_system",
  "_sorter",
  "🗑 Trash",
  "_trash",
  "0. Core Folder",
  "1. Master Court System",
  "2. Mental Health System",
  "3. Legal Charges - AVO",
  "Media",
]);

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

function showApp() {
  document.getElementById("login").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  document.getElementById("current-user").textContent = state.role
    ? `${state.username} · ${state.role}`
    : state.username;
  document.getElementById("tab-btn-system").classList.toggle("hidden", state.role !== "admin");
  refreshStatus();
  loadFiles();
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
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
    if (btn.dataset.tab === "system") loadSystem();
  });
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
    const { entries } = await api(`/api/files?subpath=${encodeURIComponent(state.subpath)}`);
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

  if (entry.type === "file") {
    const dl = document.createElement("button");
    dl.className = "icon-btn";
    dl.textContent = "⬇";
    dl.title = "Download";
    dl.addEventListener("click", (e) => { e.stopPropagation(); downloadFile(full); });
    actions.appendChild(dl);
  }

  const mv = document.createElement("button");
  mv.className = "icon-btn";
  mv.textContent = "↦";
  mv.title = "Move / rename";
  mv.addEventListener("click", (e) => { e.stopPropagation(); movePrompt(full); });
  actions.appendChild(mv);
  if (isProtectedRootFolderPath(full, entry.type)) actions.querySelector(".icon-btn")?.remove();

  const del = document.createElement("button");
  del.className = "icon-btn danger";
  del.textContent = "🗑";
    del.title = "Move to 🗑 Trash";
  del.addEventListener("click", (e) => { e.stopPropagation(); trashPath(full); });
  actions.appendChild(del);
  if (isProtectedRootFolderPath(full, entry.type)) actions.querySelector(".icon-btn.danger")?.remove();

  li.appendChild(actions);
  list.appendChild(li);
}

// Full editor, not just a textarea: line numbers + live syntax highlighting
// while typing, backed by CodeMirror. Created once, reused across files by
// swapping its content/mode.
let cm = null;
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
  return cm;
}

async function openFile(filepath) {
  try {
    const { content } = await api(`/api/file?path=${encodeURIComponent(filepath)}`);
    closeAllPanels();
    state.openFile = filepath;
    state.editorMode = editorModeFor(filepath);
    state.editorViewing = "edit";
    document.getElementById("editor-path").textContent = filepath;

    const editor = ensureCodeMirror();
    editor.setValue(content);
    editor.setOption("mode", CM_MODES[extOf(filepath)] || null);
    editor.clearHistory();

    document.getElementById("editor").classList.remove("hidden");
    document.getElementById("files-layout").classList.add("editor-open");
    renderEditorView();
    setTimeout(() => editor.refresh(), 30);
  } catch (err) {
    alert(err.message);
  }
}

function renderEditorView() {
  const rendered = document.getElementById("editor-rendered");
  const modeBtn = document.getElementById("editor-mode-btn");
  const cmWrapper = cm ? cm.getWrapperElement() : null;

  if (state.editorMode !== "markdown") {
    modeBtn.classList.add("hidden");
    rendered.classList.add("hidden");
    if (cmWrapper) cmWrapper.classList.remove("hidden");
    return;
  }

  modeBtn.classList.remove("hidden");
  if (state.editorViewing === "edit") {
    modeBtn.textContent = "Preview";
    rendered.classList.add("hidden");
    if (cmWrapper) cmWrapper.classList.remove("hidden");
    return;
  }

  modeBtn.textContent = "Edit";
  if (cmWrapper) cmWrapper.classList.add("hidden");
  rendered.classList.remove("hidden");
  const raw = window.marked ? marked.parse(cm.getValue()) : cm.getValue();
  rendered.innerHTML = window.DOMPurify ? DOMPurify.sanitize(raw) : raw;
}

document.getElementById("editor-mode-btn").addEventListener("click", () => {
  state.editorViewing = state.editorViewing === "edit" ? "rendered" : "edit";
  renderEditorView();
  if (state.editorViewing === "edit" && cm) setTimeout(() => cm.refresh(), 30);
});

async function openPreview(filepath, entry) {
  closeAllPanels();
  state.previewFile = filepath;
  document.getElementById("preview-path").textContent = filepath;
  document.getElementById("preview").classList.remove("hidden");
  document.getElementById("files-layout").classList.add("editor-open");

  const mediaEl = document.getElementById("preview-media");
  const infoEl = document.getElementById("preview-info");
  mediaEl.classList.add("hidden");
  mediaEl.innerHTML = "";

  const kind = mediaKindFor(entry.name);
  if (!kind) {
    infoEl.textContent =
      entry.size != null ? `${formatBytes(entry.size)} — not previewable, use Download.` : "Not previewable.";
    return;
  }

  infoEl.textContent = "Loading preview…";
  try {
    const resp = await fetch(`/api/download?path=${encodeURIComponent(filepath)}`, {
      headers: { Authorization: `Bearer ${state.token}` },
    });
    if (!resp.ok) throw new Error(`Preview failed: ${resp.status}`);
    const blob = await resp.blob();
    if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = URL.createObjectURL(blob);

    let el;
    if (kind === "image") {
      el = document.createElement("img");
      el.src = previewObjectUrl;
    } else if (kind === "video") {
      el = document.createElement("video");
      el.src = previewObjectUrl;
      el.controls = true;
    } else if (kind === "audio") {
      el = document.createElement("audio");
      el.src = previewObjectUrl;
      el.controls = true;
    } else if (kind === "pdf") {
      el = document.createElement("iframe");
      el.src = previewObjectUrl;
      el.className = "preview-pdf";
    }
    mediaEl.appendChild(el);
    mediaEl.classList.remove("hidden");
    infoEl.textContent = entry.size != null ? formatBytes(entry.size) : "";
  } catch (err) {
    infoEl.textContent = err.message;
  }
}

document.getElementById("back-to-list-btn").addEventListener("click", closeAllPanels);
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
    loadFiles();
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById("editor-download-btn").addEventListener("click", () => state.openFile && downloadFile(state.openFile));
document.getElementById("delete-file-btn").addEventListener("click", () => state.openFile && trashPath(state.openFile, closeAllPanels));
document.getElementById("preview-delete-btn").addEventListener("click", () => state.previewFile && trashPath(state.previewFile, closeAllPanels));
document.getElementById("move-file-btn").addEventListener("click", () => state.openFile && movePrompt(state.openFile, closeAllPanels));
document.getElementById("preview-move-btn").addEventListener("click", () => state.previewFile && movePrompt(state.previewFile, closeAllPanels));
document.getElementById("preview-download-btn").addEventListener("click", () => state.previewFile && downloadFile(state.previewFile));

async function trashPath(filepath, onDone) {
  if (!confirm(`Move ${filepath} to 🗑 Trash?`)) return;
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

async function movePrompt(filepath, onDone) {
  const dest = prompt("Move / rename to:", filepath);
  if (!dest || dest === filepath) return;
  try {
    await api("/api/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: filepath, to: dest }),
    });
    onDone?.();
    loadFiles();
  } catch (err) {
    alert(err.message);
  }
}

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

// Sort is preview-then-confirm: /api/sort/preview only asks the model where
// things would go, nothing moves until the user reviews/edits the modal and
// hits "Move selected", which calls /api/sort/apply with exactly what they
// approved (not necessarily what the model originally proposed).
function closeSortModal() {
  document.getElementById("sort-modal-overlay").classList.add("hidden");
  document.getElementById("sort-modal-list").innerHTML = "";
  document.getElementById("sort-modal-errors").classList.add("hidden");
}

function renderSortProposals(proposals) {
  const list = document.getElementById("sort-modal-list");
  list.innerHTML = "";
  proposals.forEach((p, i) => {
    const row = document.createElement("div");
    row.className = "sort-modal-row" + (p.isNewFolder ? " new-folder" : "");
    row.dataset.item = p.item;

    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = true;
    check.id = `sort-check-${i}`;
    row.appendChild(check);

    const name = document.createElement("span");
    name.className = "sort-item-name";
    name.textContent = p.item;
    name.title = p.reason || "";
    row.appendChild(name);

    const arrow = document.createElement("span");
    arrow.className = "sort-arrow";
    arrow.textContent = "→";
    row.appendChild(arrow);

    const dest = document.createElement("input");
    dest.type = "text";
    dest.value = p.destination;
    dest.className = "sort-dest-input";
    row.appendChild(dest);

    if (p.isNewFolder) {
      const badge = document.createElement("span");
      badge.className = "sort-dest-badge";
      badge.textContent = "new";
      row.appendChild(badge);
    }

    list.appendChild(row);
  });
}

document.getElementById("sort-inbox-btn").addEventListener("click", async () => {
  const btn = document.getElementById("sort-inbox-btn");
  btn.disabled = true;
  btn.textContent = "🧹 Checking…";
  try {
    const { proposals, errors, note } = await api("/api/sort/preview", { method: "POST" });
    if (note) {
      alert(note);
      return;
    }
    if (!proposals || !proposals.length) {
      const msg = (errors || []).length
        ? `Nothing could be classified:\n${errors.map((e) => `${e.item}: ${e.error}`).join("\n")}`
        : "Nothing in _sorter to sort.";
      alert(msg);
      return;
    }
    renderSortProposals(proposals);
    const errEl = document.getElementById("sort-modal-errors");
    if ((errors || []).length) {
      errEl.textContent = `Could not classify: ${errors.map((e) => `${e.item} (${e.error})`).join(", ")}`;
      errEl.classList.remove("hidden");
    }
    document.getElementById("sort-modal-overlay").classList.remove("hidden");
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "🧹 Sort";
  }
});

document.getElementById("sort-modal-cancel-btn").addEventListener("click", closeSortModal);

document.getElementById("sort-modal-confirm-btn").addEventListener("click", async () => {
  const rows = [...document.querySelectorAll("#sort-modal-list .sort-modal-row")];
  const moves = rows
    .filter((row) => row.querySelector('input[type="checkbox"]').checked)
    .map((row) => ({
      item: row.dataset.item,
      destination: row.querySelector(".sort-dest-input").value.trim(),
    }))
    .filter((m) => m.destination);

  if (!moves.length) {
    closeSortModal();
    return;
  }

  const btn = document.getElementById("sort-modal-confirm-btn");
  btn.disabled = true;
  btn.textContent = "Moving…";
  try {
    const { moved, errors } = await api("/api/sort/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ moves }),
    });
    closeSortModal();
    const lines = (moved || []).map((m) => `${m.item} -> ${m.to}`);
    if ((errors || []).length) lines.push("", "Errors:", ...errors.map((e) => `${e.item}: ${e.error}`));
    alert(lines.length ? lines.join("\n") : "Nothing moved.");
    loadFiles();
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Move selected";
  }
});

document.getElementById("upload-btn").addEventListener("click", () => {
  document.getElementById("upload-input").click();
});

document.getElementById("upload-input").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  for (const file of files) {
    const dest = state.subpath ? `${state.subpath}/${file.name}` : file.name;
    try {
      const resp = await fetch(`/api/upload?path=${encodeURIComponent(dest)}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${state.token}`,
          "Content-Type": file.type || "application/octet-stream",
        },
        body: file,
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body.error || `Upload failed: ${resp.status}`);
      }
    } catch (err) {
      alert(`${file.name}: ${err.message}`);
    }
  }
  loadFiles();
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
    try {
      const body = await api("/api/system/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target, action }),
      });
      if (body.note) alert(body.note);
      setTimeout(loadSystem, 3000);
    } catch (err) {
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
  if (!confirm("Permanently delete everything in 🗑 Trash?")) return;
  const messageEl = document.getElementById("trash-config-message");
  messageEl.textContent = "";
  try {
    const resp = await api("/api/trash/empty", { method: "POST" });
    messageEl.textContent = resp.deletedCount
      ? `Deleted ${resp.deletedCount} trash entr${resp.deletedCount === 1 ? "y" : "ies"}.`
      : "🗑 Trash is already empty.";
    if (state.subpath === "🗑 Trash" || state.subpath === "_trash") loadFiles();
  } catch (err) {
    messageEl.textContent = err.message;
  }
});

if (state.token) showApp();
setInterval(refreshStatus, 30000);

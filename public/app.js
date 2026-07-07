const state = {
  token: localStorage.getItem("panelToken") || "",
  username: localStorage.getItem("panelUsername") || "",
  node: "pc",
  subpath: "",
  openFile: null,
};

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
  state.token = "";
  state.username = "";
  document.getElementById("app").classList.add("hidden");
  document.getElementById("login").classList.remove("hidden");
  if (token) {
    fetch("/api/logout", { method: "POST", headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
  }
}

function showApp() {
  document.getElementById("login").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  document.getElementById("current-user").textContent = state.username;
  refreshStatus();
  loadFiles();
  loadConfig();
  loadHistory();
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
    localStorage.setItem("panelToken", state.token);
    localStorage.setItem("panelUsername", state.username);
    showApp();
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

document.getElementById("logout").addEventListener("click", logout);

// --- Tabs ---
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
  });
});

// --- Status pills ---
async function refreshStatus() {
  try {
    const status = await api("/api/status");
    setPill("status-pc", status.pc.ok);
    setPill("status-vps", status.vps.ok);
  } catch {
    // handled via logout on 401; ignore transient errors otherwise
  }
}

function setPill(id, ok) {
  const el = document.getElementById(id);
  el.classList.remove("ok", "down");
  el.classList.add(ok ? "ok" : "down");
}

// --- File browser ---
const nodeSelect = document.getElementById("node-select");
nodeSelect.addEventListener("change", () => {
  state.node = nodeSelect.value;
  state.subpath = "";
  closeEditor();
  loadFiles();
});

async function loadFiles() {
  document.getElementById("breadcrumb").textContent = `/${state.subpath}`;
  const list = document.getElementById("file-list");
  list.innerHTML = "<li>Loading…</li>";
  try {
    const { entries } = await api(
      `/api/files?node=${state.node}&subpath=${encodeURIComponent(state.subpath)}`
    );
    list.innerHTML = "";
    if (state.subpath) {
      const up = document.createElement("li");
      up.className = "dir";
      up.textContent = "..";
      up.addEventListener("click", () => {
        state.subpath = state.subpath.split("/").slice(0, -1).join("/");
        loadFiles();
      });
      list.appendChild(up);
    }
    entries
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1))
      .forEach((entry) => {
        const li = document.createElement("li");
        li.className = entry.type;
        li.textContent = entry.name;
        li.addEventListener("click", () => {
          const full = state.subpath ? `${state.subpath}/${entry.name}` : entry.name;
          if (entry.type === "dir") {
            state.subpath = full;
            loadFiles();
          } else {
            openFile(full);
          }
        });
        list.appendChild(li);
      });
    if (!entries.length && !state.subpath) list.innerHTML = "<li>(empty)</li>";
  } catch (err) {
    list.innerHTML = `<li>${err.message}</li>`;
  }
}

async function openFile(filepath) {
  try {
    const { content } = await api(`/api/file?node=${state.node}&path=${encodeURIComponent(filepath)}`);
    state.openFile = filepath;
    document.getElementById("editor-path").textContent = filepath;
    document.getElementById("editor-content").value = content;
    document.getElementById("editor").classList.remove("hidden");
    document.getElementById("files-layout").classList.add("editor-open");
  } catch (err) {
    alert(err.message);
  }
}

function closeEditor() {
  state.openFile = null;
  document.getElementById("editor").classList.add("hidden");
  document.getElementById("files-layout").classList.remove("editor-open");
}

document.getElementById("back-to-list-btn").addEventListener("click", closeEditor);

document.getElementById("save-file-btn").addEventListener("click", async () => {
  if (!state.openFile) return;
  const content = document.getElementById("editor-content").value;
  try {
    await api("/api/file", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ node: state.node, path: state.openFile, content }),
    });
    loadFiles();
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById("delete-file-btn").addEventListener("click", async () => {
  if (!state.openFile) return;
  if (!confirm(`Delete ${state.openFile}?`)) return;
  try {
    await api(`/api/file?node=${state.node}&path=${encodeURIComponent(state.openFile)}`, {
      method: "DELETE",
    });
    closeEditor();
    loadFiles();
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById("new-file-btn").addEventListener("click", async () => {
  const name = document.getElementById("new-name").value.trim();
  if (!name) return;
  const full = state.subpath ? `${state.subpath}/${name}` : name;
  try {
    await api("/api/file", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ node: state.node, path: full, content: "" }),
    });
    document.getElementById("new-name").value = "";
    loadFiles();
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById("new-folder-btn").addEventListener("click", async () => {
  const name = document.getElementById("new-name").value.trim();
  if (!name) return;
  const full = (state.subpath ? `${state.subpath}/${name}` : name).replace(/\/+$/, "") + "/.keep";
  try {
    await api("/api/file", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ node: state.node, path: full, content: "" }),
    });
    document.getElementById("new-name").value = "";
    loadFiles();
  } catch (err) {
    alert(err.message);
  }
});

// --- Sync ---
document.getElementById("sync-now-btn").addEventListener("click", async () => {
  const statusText = document.getElementById("sync-status-text");
  statusText.textContent = "Syncing…";
  try {
    const { results } = await api("/api/sync/run", { method: "POST" });
    statusText.textContent = `Done — ${results.length} change(s) at ${new Date().toLocaleTimeString()}`;
    loadHistory();
  } catch (err) {
    statusText.textContent = `Error: ${err.message}`;
  }
});

async function loadConfig() {
  const cfg = await api("/api/sync/config");
  document.getElementById("cfg-direction").value = cfg.direction;
  document.getElementById("cfg-interval").value = cfg.intervalMinutes;
  document.getElementById("cfg-include").value = (cfg.include || []).join("\n");
  document.getElementById("cfg-exclude").value = (cfg.exclude || []).join("\n");
}

document.getElementById("config-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {
    direction: document.getElementById("cfg-direction").value,
    intervalMinutes: Number(document.getElementById("cfg-interval").value) || 0,
    include: document.getElementById("cfg-include").value.split("\n").map((s) => s.trim()).filter(Boolean),
    exclude: document.getElementById("cfg-exclude").value.split("\n").map((s) => s.trim()).filter(Boolean),
  };
  try {
    await api("/api/sync/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    alert(err.message);
  }
});

async function loadHistory() {
  const { entries } = await api("/api/sync/history?limit=100");
  const body = document.getElementById("history-body");
  body.innerHTML = "";
  entries.forEach((e) => {
    const tr = document.createElement("tr");
    const direction = e.type === "copy" ? `${e.from} → ${e.to}` : `delete on ${e.on}`;
    tr.innerHTML = `<td>${new Date(e.timestamp).toLocaleString()}</td><td>${e.type}</td><td>${e.path}</td><td>${direction}</td><td>${e.result}${e.error ? `: ${e.error}` : ""}</td>`;
    body.appendChild(tr);
  });
}

if (state.token) showApp();
setInterval(refreshStatus, 30000);

(() => {
  if (window.__orbitWorkspaceUiLoaded) return;
  window.__orbitWorkspaceUiLoaded = true;

  state.workspaceId = localStorage.getItem("panelWorkspaceId") || "";
  state.workspaces = [];

  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const url = typeof input === "string" ? input : input?.url || "";
    if (url.startsWith("/api/") && state.workspaceId) {
      const headers = new Headers(init.headers || (typeof input !== "string" ? input.headers : undefined) || {});
      headers.set("X-Workspace-Id", state.workspaceId);
      init = { ...init, headers };
    }
    return nativeFetch(input, init);
  };

  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__orbitApiRequest = typeof url === "string" && url.startsWith("/api/");
    return xhrOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function(body) {
    if (this.__orbitApiRequest && state.workspaceId) this.setRequestHeader("X-Workspace-Id", state.workspaceId);
    return xhrSend.call(this, body);
  };

  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = "workspace-ui.css";
  document.head.appendChild(css);
})();
function workspaceFormatBytes(value) {
  const n = Number(value || 0);
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = n;
  let i = -1;
  do { size /= 1024; i += 1; } while (size >= 1024 && i < units.length - 1);
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[i]}`;
}

function currentWorkspace() {
  return state.workspaces.find((item) => String(item.id) === String(state.workspaceId))
    || state.workspaces.find((item) => item.is_main)
    || state.workspaces[0]
    || null;
}

function ensureWorkspaceBar() {
  if (document.getElementById("workspace-bar")) return;
  const user = document.getElementById("current-user");
  if (!user) return;
  const bar = document.createElement("section");
  bar.id = "workspace-bar";
  bar.className = "workspace-bar";
  bar.innerHTML = `
    <div class="workspace-picker"><label for="workspace-select">Workspace</label><select id="workspace-select"></select></div>
    <div class="workspace-status"><strong id="workspace-role"></strong><span id="workspace-storage"></span></div>
    <button id="workspace-create-btn" type="button" class="primary">+ Workspace</button>
    <div class="workspace-meter"><span id="workspace-meter-fill"></span></div>`;
  user.insertAdjacentElement("afterend", bar);
  document.getElementById("workspace-select").addEventListener("change", switchWorkspace);
  document.getElementById("workspace-create-btn").addEventListener("click", openWorkspaceDialog);
}

function renderWorkspaceBar() {
  ensureWorkspaceBar();
  const select = document.getElementById("workspace-select");
  if (!select) return;
  select.innerHTML = "";
  for (const workspace of state.workspaces) {
    const option = document.createElement("option");
    option.value = workspace.id;
    option.textContent = workspace.is_main ? `Main Workspace — ${workspace.name}` : workspace.name;
    select.appendChild(option);
  }
  select.value = state.workspaceId;
  const workspace = currentWorkspace();
  if (!workspace) return;
  document.getElementById("workspace-role").textContent = workspace.is_main ? "Main" : (workspace.permission || "viewer");
  const storage = document.getElementById("workspace-storage");
  const fill = document.getElementById("workspace-meter-fill");
  if (workspace.storage_quota_mode === "unlimited" || workspace.storage_quota_bytes == null) {
    storage.textContent = "Unlimited storage";
    fill.style.width = "0%";
  } else {
    const used = Number(workspace.storage_used_bytes || 0);
    const quota = Number(workspace.storage_quota_bytes || 0);
    storage.textContent = `${workspaceFormatBytes(used)} of ${workspaceFormatBytes(quota)}`;
    fill.style.width = `${quota ? Math.min(100, used / quota * 100) : 0}%`;
  }
}

async function loadOrbitWorkspaces(preferredId = state.workspaceId) {
  if (!state.token) return;
  ensureWorkspaceBar();
  try {
    const response = await api("/api/workspaces");
    state.workspaces = response.workspaces || [];
    const selected = state.workspaces.find((item) => String(item.id) === String(preferredId))
      || state.workspaces.find((item) => item.is_main)
      || state.workspaces[0];
    state.workspaceId = selected ? String(selected.id) : "";
    if (state.workspaceId) localStorage.setItem("panelWorkspaceId", state.workspaceId);
    renderWorkspaceBar();
    renderWorkspaceAdmin();
  } catch (error) {
    const storage = document.getElementById("workspace-storage");
    if (storage) storage.textContent = error.message;
  }
}
window.loadOrbitWorkspaces = loadOrbitWorkspaces;

function switchWorkspace(event) {
  if (typeof confirmDiscardIfDirty === "function" && !confirmDiscardIfDirty()) {
    event.target.value = state.workspaceId;
    return;
  }
  state.workspaceId = event.target.value;
  localStorage.setItem("panelWorkspaceId", state.workspaceId);
  state.subpath = "";
  if (typeof closeAllPanels === "function") closeAllPanels();
  renderWorkspaceBar();
  loadFiles();
}

function ensureWorkspaceDialog() {
  if (document.getElementById("workspace-dialog")) return;
  const overlay = document.createElement("div");
  overlay.id = "workspace-dialog";
  overlay.className = "modal-overlay hidden";
  overlay.innerHTML = `
    <form id="workspace-form" class="modal-box workspace-dialog-box">
      <h2>Create workspace</h2>
      <label class="field-label" for="workspace-name">Name</label>
      <input id="workspace-name" type="text" maxlength="80" required autocomplete="off" />
      <label class="field-label" for="workspace-description">Description</label>
      <textarea id="workspace-description" rows="4" maxlength="500"></textarea>
      <p class="field-hint">2.5 GB default quota. Storage can later be moved to another drive.</p>
      <p id="workspace-form-error" class="error"></p>
      <div class="modal-actions"><button id="workspace-cancel" type="button">Cancel</button><button type="submit" class="primary">Create</button></div>
    </form>`;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (event) => { if (event.target === overlay) closeWorkspaceDialog(); });
  document.getElementById("workspace-cancel").addEventListener("click", closeWorkspaceDialog);
  document.getElementById("workspace-form").addEventListener("submit", createWorkspaceFromDialog);
}

function openWorkspaceDialog() {
  ensureWorkspaceDialog();
  document.getElementById("workspace-dialog").classList.remove("hidden");
  document.getElementById("workspace-name").focus();
}

function closeWorkspaceDialog() {
  const dialog = document.getElementById("workspace-dialog");
  if (!dialog) return;
  dialog.classList.add("hidden");
  document.getElementById("workspace-form").reset();
  document.getElementById("workspace-form-error").textContent = "";
}

async function createWorkspaceFromDialog(event) {
  event.preventDefault();
  const error = document.getElementById("workspace-form-error");
  const submit = event.target.querySelector('button[type="submit"]');
  error.textContent = "";
  submit.disabled = true;
  try {
    const result = await api("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: document.getElementById("workspace-name").value.trim(),
        description: document.getElementById("workspace-description").value.trim(),
      }),
    });
    closeWorkspaceDialog();
    await loadOrbitWorkspaces(result.workspace.id);
    state.subpath = "";
    if (typeof closeAllPanels === "function") closeAllPanels();
    loadFiles();
  } catch (err) {
    error.textContent = err.message;
  } finally {
    submit.disabled = false;
  }
}

function ensureWorkspaceAdmin() {
  if (state.role !== "admin" || document.getElementById("workspace-admin-list")) return;
  const zone = document.querySelector(".sys-zone-admin");
  if (!zone) return;
  const card = document.createElement("details");
  card.className = "card";
  card.open = true;
  card.innerHTML = `
    <summary>Workspace manager</summary>
    <p id="workspace-admin-summary" class="muted-text"></p>
    <div id="workspace-admin-list" class="workspace-admin-list"></div>`;
  const label = zone.querySelector(".sys-zone-label");
  label.insertAdjacentElement("afterend", card);
}

function workspaceQuotaText(workspace) {
  if (workspace.storage_quota_mode === "unlimited" || workspace.storage_quota_bytes == null) return "Unlimited";
  return `${workspaceFormatBytes(workspace.storage_used_bytes)} / ${workspaceFormatBytes(workspace.storage_quota_bytes)}`;
}

function renderWorkspaceAdmin() {
  if (state.role !== "admin") return;
  ensureWorkspaceAdmin();
  const list = document.getElementById("workspace-admin-list");
  const summary = document.getElementById("workspace-admin-summary");
  if (!list || !summary) return;
  const total = state.workspaces.reduce((sum, item) => sum + Number(item.storage_used_bytes || 0), 0);
  summary.textContent = `${state.workspaces.length} workspace${state.workspaces.length === 1 ? "" : "s"} · ${workspaceFormatBytes(total)} tracked`;
  list.innerHTML = "";
  for (const workspace of state.workspaces) list.appendChild(buildWorkspaceAdminCard(workspace));
}

function buildWorkspaceAdminCard(workspace) {
  const card = document.createElement("article");
  card.className = "workspace-admin-card";
  card.innerHTML = `
    <div class="workspace-admin-head">
      <div><strong>${escapeWorkspaceHtml(workspace.name)}</strong><span>${workspace.is_main ? "Main Workspace" : escapeWorkspaceHtml(workspace.status)}</span></div>
      <button type="button" class="workspace-open-btn">Open</button>
    </div>
    <dl>
      <div><dt>Owner</dt><dd>${escapeWorkspaceHtml(workspace.owner_username || "—")}</dd></div>
      <div><dt>Role</dt><dd>${escapeWorkspaceHtml(workspace.permission || "admin")}</dd></div>
      <div><dt>Storage</dt><dd>${escapeWorkspaceHtml(workspaceQuotaText(workspace))}</dd></div>
      <div><dt>Root</dt><dd>${escapeWorkspaceHtml(workspace.filesystem_root || "—")}</dd></div>
    </dl>
    <div class="workspace-admin-actions">
      <button type="button" class="workspace-members-btn">Members</button>
      ${workspace.is_main ? "" : '<button type="button" class="workspace-edit-btn">Settings</button>'}
    </div>
    <div class="workspace-admin-detail hidden"></div>`;
  card.querySelector(".workspace-open-btn").addEventListener("click", () => {
    state.workspaceId = String(workspace.id);
    localStorage.setItem("panelWorkspaceId", state.workspaceId);
    state.subpath = "";
    renderWorkspaceBar();
    switchTab("files");
    loadFiles();
  });
  card.querySelector(".workspace-members-btn").addEventListener("click", () => showWorkspaceMembers(workspace, card));
  card.querySelector(".workspace-edit-btn")?.addEventListener("click", () => showWorkspaceSettings(workspace, card));
  return card;
}

function escapeWorkspaceHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;",
  })[char]);
}

async function showWorkspaceMembers(workspace, card) {
  const detail = card.querySelector(".workspace-admin-detail");
  detail.classList.remove("hidden");
  detail.innerHTML = "Loading members…";
  try {
    const { members } = await api(`/api/workspaces/${encodeURIComponent(workspace.id)}/members`);
    detail.innerHTML = `
      <div class="workspace-member-list"></div>
      <form class="workspace-member-form">
        <input name="username" type="text" placeholder="Username" required autocomplete="off" />
        <select name="permission"><option value="viewer">Viewer</option><option value="contributor">Contributor</option><option value="editor">Editor</option><option value="owner">Owner</option></select>
        <button type="submit" class="primary">Add / update</button>
      </form>
      <p class="error workspace-detail-error"></p>`;
    renderWorkspaceMembers(detail.querySelector(".workspace-member-list"), members, workspace, card);
    detail.querySelector(".workspace-member-form").addEventListener("submit", (event) => saveWorkspaceMember(event, workspace, card));
  } catch (error) {
    detail.textContent = error.message;
  }
}

function renderWorkspaceMembers(container, members, workspace, card) {
  container.innerHTML = "";
  for (const member of members) {
    const row = document.createElement("div");
    row.className = "workspace-member-row";
    row.innerHTML = `<span><strong>${escapeWorkspaceHtml(member.username)}</strong><small>${escapeWorkspaceHtml(member.permission)}</small></span>${member.permission === "owner" ? "" : '<button type="button" class="danger">Remove</button>'}`;
    row.querySelector("button")?.addEventListener("click", async () => {
      try {
        await api(`/api/workspaces/${encodeURIComponent(workspace.id)}/members/${encodeURIComponent(member.user_id)}`, { method: "DELETE" });
        await showWorkspaceMembers(workspace, card);
        await loadOrbitWorkspaces(workspace.id);
      } catch (error) { alert(error.message); }
    });
    container.appendChild(row);
  }
}

async function saveWorkspaceMember(event, workspace, card) {
  event.preventDefault();
  const form = event.currentTarget;
  const username = form.elements.username.value.trim();
  const permission = form.elements.permission.value;
  const error = form.parentElement.querySelector(".workspace-detail-error");
  error.textContent = "";
  try {
    await api(`/api/workspaces/${encodeURIComponent(workspace.id)}/members/${encodeURIComponent(username)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ permission }),
    });
    form.reset();
    await showWorkspaceMembers(workspace, card);
    await loadOrbitWorkspaces(workspace.id);
  } catch (err) { error.textContent = err.message; }
}

function showWorkspaceSettings(workspace, card) {
  const detail = card.querySelector(".workspace-admin-detail");
  detail.classList.remove("hidden");
  detail.innerHTML = `
    <form class="workspace-settings-form">
      <input name="name" type="text" value="${escapeWorkspaceHtml(workspace.name)}" required />
      <input name="quota" type="number" min="0" step="1048576" value="${Number(workspace.storage_quota_bytes || 0)}" title="Quota in bytes" />
      <input name="root" type="text" value="${escapeWorkspaceHtml(workspace.filesystem_root || "")}" title="Filesystem root" />
      <select name="status"><option value="active">Active</option><option value="suspended">Suspended</option><option value="archived">Archived</option></select>
      <button type="submit" class="primary">Save</button>
    </form>
    <p class="error workspace-detail-error"></p>`;
  detail.querySelector('[name="status"]').value = workspace.status;
  detail.querySelector("form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const error = detail.querySelector(".workspace-detail-error");
    error.textContent = "";
    try {
      await api(`/api/workspaces/${encodeURIComponent(workspace.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.elements.name.value.trim(),
          storageQuotaBytes: Number(form.elements.quota.value || 0),
          filesystemRoot: form.elements.root.value.trim(),
          status: form.elements.status.value,
        }),
      });
      await loadOrbitWorkspaces(workspace.id);
    } catch (err) { error.textContent = err.message; }
  });
}

const originalShowApp = showApp;
showApp = function() {
  originalShowApp();
  setTimeout(() => loadOrbitWorkspaces(), 0);
};

const originalLoadSystem = loadSystem;
loadSystem = async function() {
  await originalLoadSystem();
  await loadOrbitWorkspaces(state.workspaceId);
};

ensureWorkspaceDialog();
if (state.token) setTimeout(() => loadOrbitWorkspaces(), 0);

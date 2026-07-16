(() => {
  if (window.__orbitWorkspaceUiLoaded) return;
  window.__orbitWorkspaceUiLoaded = true;

  state.workspaceId = localStorage.getItem("panelWorkspaceId") || "";
  state.workspaces = [];
  state.workspaceSettings = { maxWorkspacesPerUser: 1, ownedCount: 0, workspaceModeEnabled: false };

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
  css.href = "/addon-assets/workspaces/workspace-ui.css?v=20260716-mcplink2";
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


function workspaceStoragePercent(workspace) {
  const quota = Number(workspace.storage_quota_bytes || 0);
  if (!quota || workspace.storage_quota_mode === "unlimited") return null;
  return Math.max(0, Number(workspace.storage_used_bytes || 0) / quota * 100);
}

function workspaceStorageState(percent) {
  if (percent == null) return "unlimited";
  if (percent >= 100) return "full";
  if (percent >= 90) return "critical";
  if (percent >= 75) return "warning";
  return "normal";
}

function workspaceStorageSummary(workspace) {
  const used = Number(workspace.storage_used_bytes || 0);
  const quota = Number(workspace.storage_quota_bytes || 0);
  if (!quota || workspace.storage_quota_mode === "unlimited") return `${workspaceFormatBytes(used)} used  /  Unlimited`;
  const free = Math.max(0, quota - used);
  const percent = workspaceStoragePercent(workspace);
  return `${workspaceFormatBytes(used)} of ${workspaceFormatBytes(quota)}  /  ${workspaceFormatBytes(free)} free  /  ${percent.toFixed(1)}%`;
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
  const bar = document.getElementById("workspace-bar");
  if (bar) bar.classList.toggle("hidden", state.workspaceSettings?.workspaceModeEnabled === false);
  const select = document.getElementById("workspace-select");
  if (!select) return;
  select.innerHTML = "";
  for (const workspace of state.workspaces) {
    const option = document.createElement("option");
    option.value = workspace.id;
    const offline = !workspace.is_main && workspace.drive_state === "offline";
    option.textContent = workspace.is_main ? `Main Workspace  -  ${workspace.name}` : `${workspace.name}${offline ? "  -  Drive offline" : (workspace.status === "suspended" ? "  -  Suspended" : "")}`;
    option.disabled = offline || (workspace.status === "suspended" && state.role !== "admin");
    select.appendChild(option);
  }
  select.value = state.workspaceId;
  const createButton = document.getElementById("workspace-create-btn");
  const max = Number(state.workspaceSettings?.maxWorkspacesPerUser ?? 1);
  const owned = Number(state.workspaceSettings?.ownedCount ?? 0);
  const reached = state.role !== "admin" && max > 0 && owned >= max;
  if (createButton) { createButton.disabled = reached; createButton.title = reached ? `Workspace limit reached (${max})` : `${owned} of ${max || "unlimited"} workspaces used`; }
  const workspace = currentWorkspace();
  if (!workspace) return;
  document.getElementById("workspace-role").textContent = workspace.is_main ? "Main" : (workspace.permission || "viewer");
  const storage = document.getElementById("workspace-storage");
  const fill = document.getElementById("workspace-meter-fill");
  const percent = workspaceStoragePercent(workspace);
  storage.textContent = workspaceStorageSummary(workspace);
  fill.style.width = `${percent == null ? 0 : Math.min(100, percent)}%`;
  fill.parentElement.dataset.state = workspaceStorageState(percent);
}

async function loadOrbitWorkspaces(preferredId = state.workspaceId) {
  if (!state.token) return;
  ensureWorkspaceBar();
  try {
    const response = await api("/api/workspaces");
    state.workspaces = response.workspaces || [];
    state.workspaceSettings = { ...response.settings, maxWorkspacesPerUser: Number(response.settings?.maxWorkspacesPerUser ?? 1), ownedCount: Number(response.ownedCount ?? 0) };
    const workspaceModeEnabled = state.workspaceSettings.workspaceModeEnabled !== false;
    const selected = (!workspaceModeEnabled ? state.workspaces.find((item) => item.is_main) : null)
      || state.workspaces.find((item) => String(item.id) === String(preferredId))
      || state.workspaces.find((item) => item.is_main)
      || state.workspaces[0];
    state.workspaceId = selected ? String(selected.id) : "";
    if (state.workspaceId) localStorage.setItem("panelWorkspaceId", state.workspaceId);
    renderWorkspaceBar();
    if (typeof applyWorkspaceModeUi === "function") applyWorkspaceModeUi();
    if (typeof sorterRenderWorkspaceSelector === "function") sorterRenderWorkspaceSelector();
    if (typeof refreshSorterHeader === "function") refreshSorterHeader();
    if (typeof refreshSorterAccessUi === "function") refreshSorterAccessUi();
    renderWorkspaceAdmin();
    renderAdminStorageOverview();
    renderCompactWorkspaceTrashList();
    loadWorkspaceInvitations();
    loadWorkspaceStorageRequests();
    loadWorkspaceRestoreRequests();
    loadWorkspaceTransferRequests();
  } catch (error) {
    const storage = document.getElementById("workspace-storage");
    if (storage) storage.textContent = error.message;
  }
}
window.loadOrbitWorkspaces = loadOrbitWorkspaces;


let workspaceFileLoadGeneration = 0;

function resetWorkspaceView() {
  workspaceFileLoadGeneration += 1;
  state.subpath = "";
  if (typeof closeAllPanels === "function") closeAllPanels();
  const list = document.getElementById("file-list");
  if (list) list.innerHTML = "<li>Loading workspace...</li>";
  const breadcrumb = document.getElementById("breadcrumb");
  if (breadcrumb) breadcrumb.textContent = "/";
  const uploadPanel = document.getElementById("upload-panel");
  if (uploadPanel) uploadPanel.classList.add("hidden");
}

async function activateWorkspace(workspaceId, { openFiles = true } = {}) {
  if (typeof confirmDiscardIfDirty === "function" && !confirmDiscardIfDirty()) return false;
  state.workspaceId = String(workspaceId || "");
  if (state.workspaceId) localStorage.setItem("panelWorkspaceId", state.workspaceId);
  else localStorage.removeItem("panelWorkspaceId");
  resetWorkspaceView();
  renderWorkspaceBar();
  if (openFiles) switchTab("files");
  await loadFiles();
  return true;
}

loadFiles = async function workspaceAwareLoadFiles() {
  const generation = ++workspaceFileLoadGeneration;
  const workspaceId = String(state.workspaceId || "");
  const subpath = String(state.subpath || "");
  const list = document.getElementById("file-list");
  document.getElementById("breadcrumb").textContent = `/${subpath}`;
  list.innerHTML = "<li>Loading...</li>";
  try {
    const { entries, folderPermissions } = await api(`/api/files?subpath=${encodeURIComponent(subpath)}`);
    if (generation !== workspaceFileLoadGeneration || workspaceId !== String(state.workspaceId || "") || subpath !== String(state.subpath || "")) return;
    state.folderPermissions = effectivePermissions(folderPermissions);
    document.getElementById("new-folder-btn").classList.toggle("hidden", !state.folderPermissions.create);
    document.getElementById("upload-btn").classList.toggle("hidden", !state.folderPermissions.create);
    list.innerHTML = "";
    if (subpath) {
      const up = document.createElement("li");
      up.className = "dir";
      up.innerHTML = `<span class="row-name">..</span>`;
      up.querySelector(".row-name").addEventListener("click", () => {
        state.subpath = state.subpath.split("/").slice(0, -1).join("/");
        loadFiles();
      });
      list.appendChild(up);
    }
    entries.sort((a,b)=>(a.type===b.type?a.name.localeCompare(b.name):a.type==="dir"?-1:1)).forEach((entry)=>renderRow(list,entry));
    if (!entries.length && !subpath) list.innerHTML = "<li>(empty)</li>";
  } catch (err) {
    if (generation === workspaceFileLoadGeneration && workspaceId === String(state.workspaceId || "")) list.innerHTML = `<li>${escapeWorkspaceHtml(err.message)}</li>`;
  }
};

async function switchWorkspace(event) {
  const previous = state.workspaceId;
  const changed = await activateWorkspace(event.target.value);
  if (!changed) event.target.value = previous;
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
      <p id="workspace-limit-hint" class="field-hint">2.5 GB default quota. Storage can later be moved to another drive.</p>
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
  const max = Number(state.workspaceSettings?.maxWorkspacesPerUser ?? 1);
  const owned = Number(state.workspaceSettings?.ownedCount ?? 0);
  if (state.role !== "admin" && max > 0 && owned >= max) return alert(`Workspace limit reached (${max})`);
  const hint = document.getElementById("workspace-limit-hint");
  if (hint) hint.textContent = `2.5 GB default quota  /  ${owned} of ${max || "unlimited"} workspaces used.`;
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
  const host = document.getElementById("workspace-manager-settings-host");
  if (!host) return;
  if (state.role !== "admin") {
    host.innerHTML = "";
    host.classList.add("hidden");
    return;
  }
  host.classList.remove("hidden");
  if (document.getElementById("workspace-manager-settings-card")) return;
  const card = document.createElement("details");
  card.id = "workspace-manager-settings-card";
  card.className = "card workspace-manager-card";
  card.innerHTML = `
    <summary><span>Workspace Manager</span><small>Admin only</small></summary>
    <p class="muted-text">Global limits and lifecycle rules. Users cannot see these controls.</p>
    <details class="workspace-setting-group">
      <summary>Workspace limits</summary>
      <form id="workspace-limit-form" class="workspace-limit-form">
        <label for="workspace-max-per-user">Maximum workspaces per user</label>
        <input id="workspace-max-per-user" type="number" min="0" max="1000" step="1" required />
        <button type="submit" class="primary">Save limit</button>
        <small>0 = unlimited. Main Workspace is not counted.</small>
        <p id="workspace-limit-message" class="error"></p>
      </form>
    </details>
    <details class="workspace-setting-group">
      <summary>Lifecycle rules</summary>
      <form id="workspace-lifecycle-form" class="workspace-limit-form workspace-lifecycle-form">
        <label>Inactive before offline<input name="inactiveDays" type="number" min="1" max="3650" required /><span>days</span></label>
        <label>Offline warning<input name="offlineWarningDays" type="number" min="1" max="3650" required /><span>days</span></label>
        <label>Delete after offline<input name="deleteAfterOfflineDays" type="number" min="1" max="3650" required /><span>days</span></label>
        <label>Deletion warning<input name="deleteWarningDays" type="number" min="1" max="3650" required /><span>days</span></label>
        <button type="submit" class="primary">Save lifecycle</button>
        <small>Main Workspace is excluded. Offline workspaces keep files but release their quota allocation.</small>
        <p id="workspace-lifecycle-message" class="error"></p>
      </form>
    </details>`;
  host.appendChild(card);
  document.getElementById("workspace-limit-form")?.addEventListener("submit", saveWorkspaceLimit);
  document.getElementById("workspace-lifecycle-form")?.addEventListener("submit", saveWorkspaceLifecycle);
}

async function saveWorkspaceLimit(event) {
  event.preventDefault();
  const input = document.getElementById("workspace-max-per-user");
  const message = document.getElementById("workspace-limit-message");
  const button = event.currentTarget.querySelector('button[type="submit"]');
  message.textContent = ""; button.disabled = true;
  try {
    const result = await api("/api/workspace-settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ maxWorkspacesPerUser: Number(input.value) }) });
    state.workspaceSettings.maxWorkspacesPerUser = result.maxWorkspacesPerUser;
    message.className = "muted-text"; message.textContent = "Saved.";
    renderWorkspaceBar();
    if (typeof sorterRenderWorkspaceSelector === "function") sorterRenderWorkspaceSelector();
    renderWorkspaceAdmin();
  } catch (error) { message.className = "error"; message.textContent = error.message; }
  finally { button.disabled = false; }
}


async function saveWorkspaceLifecycle(event) {
  event.preventDefault();
  const form=event.currentTarget;
  const message=document.getElementById("workspace-lifecycle-message");
  const body=Object.fromEntries(new FormData(form));
  for(const key of Object.keys(body)) body[key]=Number(body[key]);
  try {
    const result=await api("/api/workspace-lifecycle-settings",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    Object.assign(state.workspaceSettings,result);
    message.className="muted-text"; message.textContent="Saved.";
  } catch(error){ message.className="error"; message.textContent=error.message; }
}

function workspaceQuotaText(workspace) {
  if (workspace.storage_quota_mode === "unlimited" || workspace.storage_quota_bytes == null) return "Unlimited";
  return `${workspaceFormatBytes(workspace.storage_used_bytes)} / ${workspaceFormatBytes(workspace.storage_quota_bytes)}`;
}


function renderAdminStorageOverview() {
  if (state.role !== "admin") return;
  const panel = document.getElementById("tab-system");
  if (!panel) return;
  let card = document.getElementById("workspace-system-storage");
  if (!card) {
    card = document.createElement("details");
    card.id = "workspace-system-storage";
    card.className = "card";
    card.open = true;
    const header = panel.querySelector(".sys-header");
    if (header) header.insertAdjacentElement("afterend",card); else panel.prepend(card);
  }
  const total = state.workspaces.reduce((sum,w)=>sum+Number(w.storage_used_bytes||0),0);
  const branched = state.workspaces.filter(w=>!w.is_main).reduce((sum,w)=>sum+Number(w.storage_used_bytes||0),0);
  const rows = state.workspaces.map(w=>`<div class="workspace-system-storage-row"><strong>${escapeWorkspaceHtml(w.name)}</strong><span>${escapeWorkspaceHtml(w.owner_username||" - ")}</span><span>${workspaceStorageSummary(w)}</span></div>`).join("");
  card.innerHTML = `<summary>Workspace storage</summary><p class="muted-text">${workspaceFormatBytes(total)} tracked  /  ${workspaceFormatBytes(branched)} branched</p><div class="workspace-system-storage-list">${rows}</div>`;
}

function renderWorkspaceAdmin() {
  ensureWorkspaceAdmin();
  const list = document.getElementById("workspace-admin-list");
  const summary = document.getElementById("workspace-admin-summary");
  if (!list || !summary) return;
  const total = state.workspaces.reduce((sum, item) => sum + Number(item.storage_used_bytes || 0), 0);
  const max = Number(state.workspaceSettings?.maxWorkspacesPerUser ?? 1);
  summary.textContent = `${state.workspaces.length} visible workspace${state.workspaces.length === 1 ? "" : "s"}  /  ${workspaceFormatBytes(total)} tracked  /  user limit ${max || "unlimited"}`;
  const input = document.getElementById("workspace-max-per-user");
  if (input) input.value = String(max);
  const lifecycleForm=document.getElementById("workspace-lifecycle-form");
  if(lifecycleForm){
    for(const key of ["inactiveDays","offlineWarningDays","deleteAfterOfflineDays","deleteWarningDays"]){
      if(lifecycleForm.elements[key]) lifecycleForm.elements[key].value=String(state.workspaceSettings?.[key] ?? "");
    }
  }
  list.innerHTML = "";
  for (const workspace of state.workspaces) list.appendChild(buildWorkspaceAdminCard(workspace));
}

function toggleWorkspaceDetail(card, view, render) {
  if (typeof card.expandWorkspaceCard === "function") card.expandWorkspaceCard();
  const detail = card.querySelector(".workspace-admin-detail");
  if (!detail) return;
  if (!detail.classList.contains("hidden") && detail.dataset.view === view) {
    detail.classList.add("hidden");
    detail.innerHTML = "";
    delete detail.dataset.view;
    return;
  }
  detail.dataset.view = view;
  Promise.resolve(render()).finally(() => {
    if (detail.classList.contains("hidden") || detail.dataset.view !== view || detail.querySelector(":scope > .workspace-detail-collapse")) return;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "workspace-detail-collapse";
    close.textContent = "Hide";
    close.addEventListener("click", () => {
      detail.classList.add("hidden");
      detail.innerHTML = "";
      delete detail.dataset.view;
    });
    detail.prepend(close);
  });
}
window.toggleWorkspaceDetail = toggleWorkspaceDetail;

function buildWorkspaceAdminCard(workspace) {
  const isOwner = workspace.permission === "owner";
  const isAdmin = state.role === "admin";
  const management = workspace.management_permissions || {};
  const canManageMembers = isAdmin || isOwner || management.manage_members;
  const canViewSettings = isAdmin || isOwner || management.view_settings;
  const canEditSettings = isAdmin || isOwner || management.edit_settings;
  const canLeave = !workspace.is_main && !isOwner && !isAdmin;
  const isSuspended = workspace.status === "suspended";
  const mainOffline = workspace.is_main && workspace.is_visible === false;
  const branchOffline = !workspace.is_main && workspace.drive_state === "offline";
  const canOpen = !branchOffline && (!isSuspended || isAdmin) && (!mainOffline || isOwner || isAdmin);
  const statusText = workspace.is_main ? "Main" : branchOffline ? "Offline" : isSuspended ? "Suspended" : "Active";
  const card = document.createElement("article");
  card.dataset.workspaceId = workspace.id;
  card.className = `workspace-admin-card workspace-card-collapsed${isSuspended ? " workspace-suspended" : ""}`;
  card.innerHTML = `
    <div class="workspace-admin-head workspace-card-summary">
      <button type="button" class="workspace-card-toggle" aria-expanded="false">
        <span class="workspace-card-title"><strong>${escapeWorkspaceHtml(workspace.name)} <span class="workspace-state-badge" data-state="${statusText.toLowerCase()}">${statusText}</span></strong><small>${workspace.is_main ? "Simple Mode / shared filesystem" : "Workspace Mode / private to members"}</small></span>
        <span class="workspace-card-summary-meta"><small>${escapeWorkspaceHtml(workspace.owner_username || "--")}</small><span aria-hidden="true">&gt;</span></span>
      </button>
      <button type="button" class="workspace-open-btn" ${canOpen ? "" : "disabled"}>Open</button>
    </div>
    <div class="workspace-card-body hidden">
      ${workspace.description ? `<p class="workspace-card-description">${escapeWorkspaceHtml(workspace.description)}</p>` : ""}
      ${isSuspended && (isOwner || isAdmin) && workspace.suspension_reason ? `<div class="workspace-suspension-reason"><strong>Suspension reason</strong><p>${escapeWorkspaceHtml(workspace.suspension_reason)}</p></div>` : ""}
      <div class="workspace-card-meta">
        <span><small>Owner</small><strong>${escapeWorkspaceHtml(workspace.owner_username || "--")}</strong></span>
        <span><small>Your role</small><strong>${escapeWorkspaceHtml(workspace.permission || (isAdmin ? "admin" : "viewer"))}</strong></span>
        <span><small>Storage</small><strong>${workspaceFormatBytes(workspace.storage_used_bytes || 0)}</strong></span>
      </div>
      <div class="workspace-card-meter" data-state="${workspaceStorageState(workspaceStoragePercent(workspace))}"><span style="width:${Math.min(100,workspaceStoragePercent(workspace)||0)}%"></span></div>
      ${workspace.lifecycle_notice ? `<p class="workspace-suspension-note">${escapeWorkspaceHtml(workspace.lifecycle_notice)}</p>` : ""}
      <div class="workspace-admin-actions">
        <button type="button" class="workspace-storage-btn">Storage</button>
        ${canManageMembers ? '<button type="button" class="workspace-members-btn">Members</button>' : ""}
        ${workspace.is_main && (isAdmin || isOwner) ? `<button type="button" class="workspace-visibility-btn">${mainOffline ? "Bring online" : "Hide drive"}</button>` : ""}
        ${!workspace.is_main && canEditSettings ? `<button type="button" class="workspace-drive-state-btn">${branchOffline ? "Bring online" : "Take offline"}</button>` : ""}
        ${!workspace.is_main && canViewSettings ? '<button type="button" class="workspace-edit-btn">Settings</button>' : ""}
        ${!workspace.is_main && isAdmin ? `<button type="button" class="workspace-mcp-enable-btn">${workspace.mcp_ui_enabled ? "Disable MCP" : "Enable MCP"}</button>` : ""}
        ${canViewSettings ? '<button type="button" class="workspace-mcp-link-btn">MCP Link</button>' : ""}
        ${canLeave ? '<button type="button" class="danger workspace-leave-btn">Leave workspace</button>' : ""}
      </div>
      <div class="workspace-admin-detail hidden"></div>
    </div>`;
  const body = card.querySelector(".workspace-card-body");
  const toggle = card.querySelector(".workspace-card-toggle");
  const setExpanded = (expanded) => {
    body.classList.toggle("hidden", !expanded);
    card.classList.toggle("workspace-card-collapsed", !expanded);
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.querySelector(".workspace-card-summary-meta span").textContent = expanded ? "v" : ">";
  };
  toggle.addEventListener("click", () => setExpanded(toggle.getAttribute("aria-expanded") !== "true"));
  card.querySelector(".workspace-open-btn").addEventListener("click", () => activateWorkspace(workspace.id));
  card.querySelector(".workspace-storage-btn")?.addEventListener("click", () => { setExpanded(true); toggleWorkspaceDetail(card,"storage",() => showWorkspaceStorage(workspace, card)); });
  card.querySelector(".workspace-members-btn")?.addEventListener("click", () => { setExpanded(true); toggleWorkspaceDetail(card,"members",() => showWorkspaceMembers(workspace, card)); });
  card.querySelector(".workspace-visibility-btn")?.addEventListener("click", async () => {
    try { await api(`/api/workspaces/${encodeURIComponent(workspace.id)}/visibility`, {method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({visible:mainOffline})}); await loadOrbitWorkspaces(workspace.id); }
    catch (error) { alert(error.message); }
  });
  card.querySelector(".workspace-drive-state-btn")?.addEventListener("click", async () => {
    const nextOnline = branchOffline;
    if(!confirm(nextOnline ? "Bring this workspace drive online?" : "Take this workspace drive offline?")) return;
    try { await api(`/api/workspaces/${encodeURIComponent(workspace.id)}/drive-state`, {method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({online:nextOnline})}); await loadOrbitWorkspaces(workspace.id); }
    catch(error){ alert(error.message); }
  });
  card.querySelector(".workspace-edit-btn")?.addEventListener("click", () => { setExpanded(true); toggleWorkspaceDetail(card,"settings",() => showWorkspaceSettings(workspace, card)); });
  card.querySelector(".workspace-mcp-enable-btn")?.addEventListener("click", async () => {
    const nextEnabled = !workspace.mcp_ui_enabled;
    if (!nextEnabled && !confirm("Disable MCP for this workspace? This revokes every member's MCP access immediately.")) return;
    try {
      const result = await api(`/api/workspaces/${encodeURIComponent(workspace.id)}/mcp-enabled`, { method:"PATCH", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ enabled: nextEnabled }) });
      if (result.cascade?.failed?.length) alert(`MCP disabled, but Cloudflare access couldn't be revoked for: ${result.cascade.failed.join(", ")}. Remove them manually in the Cloudflare dashboard.`);
      await loadOrbitWorkspaces(workspace.id);
    } catch (error) { alert(error.message); }
  });
  card.querySelector(".workspace-mcp-link-btn")?.addEventListener("click", () => { setExpanded(true); toggleWorkspaceDetail(card,"mcplink",() => showWorkspaceMcpLink(workspace, card)); });
  card.querySelector(".workspace-leave-btn")?.addEventListener("click", async () => {
    if (!confirm(`Leave workspace "${workspace.name}"? You will lose access until invited again.`)) return;
    const wasActive = String(state.workspaceId) === String(workspace.id);
    try {
      await api(`/api/workspaces/${encodeURIComponent(workspace.id)}/leave`, { method:"DELETE" });
      const main = state.workspaces.find((item) => item.is_main);
      const nextId = wasActive && main ? String(main.id) : state.workspaceId;
      if (wasActive) {
        state.workspaceId = nextId || "";
        state.subpath = "";
        if (state.workspaceId) localStorage.setItem("panelWorkspaceId", state.workspaceId);
        else localStorage.removeItem("panelWorkspaceId");
        if (typeof closeAllPanels === "function") closeAllPanels();
      }
      await loadOrbitWorkspaces(nextId);
      if (wasActive && typeof loadFiles === "function") await loadFiles();
    } catch (error) { alert(error.message); }
  });
  card.expandWorkspaceCard = () => setExpanded(true);
  return card;
}

function escapeWorkspaceHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;",
  })[char]);
}


async function showWorkspaceStorage(workspace, card) {
  const detail = card.querySelector(".workspace-admin-detail");
  detail.classList.remove("hidden");
  detail.innerHTML = "Refreshing storage...";
  try {
    const result = await api(`/api/workspaces/${encodeURIComponent(workspace.id)}/storage?refresh=true`);
    const updated = result.workspace;
    const canEmpty = !updated.is_main && (state.role === "admin" || updated.permission === "owner");
    detail.innerHTML = `<div class="workspace-storage-grid">
      <div><span>Used</span><strong>${workspaceFormatBytes(updated.storage_used_bytes)}</strong></div>
      <div><span>Quota</span><strong>${updated.storage_quota_mode === "unlimited" ? "Unlimited" : workspaceFormatBytes(updated.storage_quota_bytes)}</strong></div>
      <div><span>Free</span><strong>${updated.storage_quota_mode === "unlimited" ? " - " : workspaceFormatBytes(Math.max(0,Number(updated.storage_quota_bytes||0)-Number(updated.storage_used_bytes||0)))}</strong></div>
      <div><span>Files</span><strong>${Number(updated.file_count||0).toLocaleString()}</strong></div>
      <div><span>Folders</span><strong>${Number(updated.folder_count||0).toLocaleString()}</strong></div>
      <div><span>Trash</span><strong>${workspaceFormatBytes(updated.trash_used_bytes||0)}</strong></div>
    </div>
    <p class="muted-text">Last scanned: ${updated.storage_last_scanned_at ? new Date(updated.storage_last_scanned_at).toLocaleString() : "Not yet scanned"}</p>
    <div class="workspace-storage-actions"><button type="button" class="workspace-refresh-storage">Refresh</button>${!updated.is_main ? '<button type="button" class="workspace-view-trash">View trash</button>' : ""}${canEmpty ? '<button type="button" class="danger workspace-empty-trash">Empty trash</button>' : ""}</div>
    <div class="workspace-trash-view hidden"></div>
    <p class="error workspace-detail-error"></p>`;
    detail.querySelector(".workspace-refresh-storage").addEventListener("click",()=>showWorkspaceStorage(updated,card));
    detail.querySelector(".workspace-view-trash")?.addEventListener("click",()=>loadWorkspaceTrash(updated,detail));
    detail.querySelector(".workspace-empty-trash")?.addEventListener("click",async()=>{
      const errorHost=detail.querySelector(".workspace-detail-error");
      try {
        const trash=await api(`/api/workspaces/${encodeURIComponent(updated.id)}/trash`);
        const count=trash.items?.length||0;
        if(!count){ errorHost.textContent="Workspace trash is empty."; return; }
        if(!confirm(`Permanently delete ${count} trash item${count===1?"":"s"}? Review the trash list first if needed.`)) return;
        await api(`/api/workspaces/${encodeURIComponent(updated.id)}/trash`,{method:"DELETE"});
        await loadOrbitWorkspaces(updated.id); await showWorkspaceStorage(updated,card);
      } catch(error){ errorHost.textContent=error.message; }
    });
    const index=state.workspaces.findIndex(item=>String(item.id)===String(updated.id));
    if(index>=0) state.workspaces[index]=updated;
    renderWorkspaceBar();
  } catch(error) { detail.innerHTML=`<p class="error">${escapeWorkspaceHtml(error.message)}</p>`; }
}

async function loadWorkspaceTrash(workspace, detail) {
  const host=detail.querySelector(".workspace-trash-view");
  if(!host) return;
  host.classList.remove("hidden");
  host.innerHTML='<p class="muted-text">Loading workspace trash...</p>';
  try {
    const result=await api(`/api/workspaces/${encodeURIComponent(workspace.id)}/trash`);
    const items=result.items||[];
    if(!items.length){ host.innerHTML='<p class="muted-text">Workspace trash is empty.</p>'; return; }
    host.innerHTML=`<div class="workspace-trash-head"><strong>${items.length} trash item${items.length===1?"":"s"}</strong><span>Review before permanently emptying.</span></div><div class="workspace-trash-list">${items.map(item=>`
      <article class="workspace-trash-row">
        <div><strong>${escapeWorkspaceHtml(item.item_name||item.name||"Unknown item")}</strong><small>${escapeWorkspaceHtml(item.original_path||"Original path unavailable")}</small></div>
        <div><span>${escapeWorkspaceHtml(item.item_type||item.type||"item")}</span><span>${workspaceFormatBytes(item.sizeBytes||item.size_bytes||0)}</span></div>
        <div><span>Deleted by ${escapeWorkspaceHtml(item.deleted_by_username||"Unknown")}</span><time>${item.deleted_at?new Date(item.deleted_at).toLocaleString():"Unknown time"}</time></div>
      </article>`).join("")}</div>`;
  } catch(error){ host.innerHTML=`<p class="error">${escapeWorkspaceHtml(error.message)}</p>`; }
}

async function showWorkspaceMembers(workspace, card) {
  const detail = card.querySelector(".workspace-admin-detail");
  detail.classList.remove("hidden");
  detail.innerHTML = "Loading members...";
  try {
    const { members } = await api(`/api/workspaces/${encodeURIComponent(workspace.id)}/members`);
    const canManage = state.role === "admin" || workspace.permission === "owner" || !!workspace.management_permissions?.manage_members;
    const canGrantMcp = workspace.mcp_ui_enabled && (state.role === "admin" || workspace.permission === "owner");
    let mcpGrantedUserIds = new Set();
    if (canGrantMcp) {
      try { mcpGrantedUserIds = new Set((await api(`/api/workspaces/${encodeURIComponent(workspace.id)}/mcp-grants`)).grants.map((g) => String(g.user_id))); }
      catch { /* non-fatal - MCP column just won't render */ }
    }
    detail.innerHTML = `
      <div class="workspace-member-list"></div>
      ${canManage ? `<form class="workspace-member-form">
        <input name="username" type="text" placeholder="Username" required autocomplete="off" />
        <select name="permission"><option value="viewer">Viewer</option><option value="contributor">Contributor</option><option value="editor">Editor</option></select>
        <button type="submit" class="primary">Send invite</button>
      </form>` : ""}
      <p class="error workspace-detail-error"></p>`;
    renderWorkspaceMembers(detail.querySelector(".workspace-member-list"), members, workspace, card, canManage, canGrantMcp, mcpGrantedUserIds);
    detail.querySelector(".workspace-member-form")?.addEventListener("submit", (event) => inviteWorkspaceMember(event, workspace, card));
  } catch (error) {
    detail.textContent = error.message;
  }
}

function renderWorkspaceMembers(container, members, workspace, card, canManage, canGrantMcp, mcpGrantedUserIds) {
  container.innerHTML = "";
  for (const member of members) {
    const row = document.createElement("div");
    row.className = "workspace-member-row";
    const canEditRole = canManage && member.permission !== "owner";
    // Unlike role changes, MCP access is legitimately self-grantable: a
    // regular user who owns their own (non-Main) workspace isn't a system
    // admin, so they don't auto-get unrestricted MCP access the way Main's
    // owner does - they need an actual grant like anyone else, and they're
    // the only one who can grant it for their own workspace. Main's owner
    // never reaches this UI at all (mcp_ui_enabled can't be turned on for
    // Main), so this never redundantly offers a no-op grant to an admin.
    const showMcpToggle = canGrantMcp;
    const mcpGranted = mcpGrantedUserIds?.has(String(member.user_id));
    row.innerHTML = `
      <span class="workspace-member-identity"><strong>${escapeWorkspaceHtml(member.username)}</strong><small>${escapeWorkspaceHtml(member.permission)}</small></span>
      <div class="workspace-member-controls">
        ${showMcpToggle ? `<span class="workspace-state-badge" data-state="${mcpGranted ? "active" : "offline"}">${mcpGranted ? "MCP on" : "MCP off"}</span><button type="button" class="${mcpGranted ? "danger" : "primary"} workspace-member-mcp-toggle">${mcpGranted ? "Revoke MCP" : "Grant MCP"}</button>` : ""}
        ${canEditRole ? `
        <select class="workspace-member-role" aria-label="Role for ${escapeWorkspaceHtml(member.username)}">
          <option value="viewer">Viewer</option>
          <option value="contributor">Contributor</option>
          <option value="editor">Editor</option>
        </select>
        <button type="button" class="primary workspace-member-save">Save role</button>
        <button type="button" class="danger workspace-member-remove">Remove</button>` : ""}
      </div>`;
    const roleSelect = row.querySelector(".workspace-member-role");
    if (roleSelect) roleSelect.value = member.permission;
    row.querySelector(".workspace-member-mcp-toggle")?.addEventListener("click", async () => {
      const button = row.querySelector(".workspace-member-mcp-toggle");
      button.disabled = true;
      try {
        await api(`/api/workspaces/${encodeURIComponent(workspace.id)}/mcp-grants/${encodeURIComponent(member.user_id)}`, { method: mcpGranted ? "DELETE" : "PUT" });
        await showWorkspaceMembers(workspace, card);
      } catch (error) { alert(error.message); button.disabled = false; }
    });
    row.querySelector(".workspace-member-save")?.addEventListener("click", async () => {
      const button = row.querySelector(".workspace-member-save");
      button.disabled = true;
      try {
        await api(`/api/workspaces/${encodeURIComponent(workspace.id)}/members/${encodeURIComponent(member.username)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ permission: roleSelect.value }),
        });
        await showWorkspaceMembers(workspace, card);
        await loadOrbitWorkspaces(workspace.id);
      } catch (error) { alert(error.message); }
      finally { button.disabled = false; }
    });
    row.querySelector(".workspace-member-remove")?.addEventListener("click", async () => {
      try {
        await api(`/api/workspaces/${encodeURIComponent(workspace.id)}/members/${encodeURIComponent(member.user_id)}`, { method: "DELETE" });
        await showWorkspaceMembers(workspace, card);
        await loadOrbitWorkspaces(workspace.id);
      } catch (error) { alert(error.message); }
    });
    container.appendChild(row);
  }
}


async function inviteWorkspaceMember(event, workspace, card) {
  event.preventDefault();
  const form = event.currentTarget;
  const error = form.parentElement.querySelector(".workspace-detail-error");
  error.textContent = "";
  try {
    await api(`/api/workspaces/${encodeURIComponent(workspace.id)}/invitations`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: form.elements.username.value.trim(), permission: form.elements.permission.value }),
    });
    form.reset();
    error.className = "muted-text workspace-detail-error";
    error.textContent = "Invitation sent.";
  } catch (err) { error.className = "error workspace-detail-error"; error.textContent = err.message; }
}

async function loadWorkspaceInvitations() {
  const list = document.getElementById("workspace-invitations-list");
  if (!list || !state.token) return;
  try {
    const { invitations } = await api("/api/workspace-invitations");
    list.innerHTML = "";
    if (!invitations.length) { list.innerHTML = '<p class="muted-text">No pending invitations.</p>'; return; }
    for (const invite of invitations) {
      const row = document.createElement("div");
      row.className = "workspace-invite-row";
      row.innerHTML = `<span><strong>${escapeWorkspaceHtml(invite.workspace_name)}</strong><small>${escapeWorkspaceHtml(invite.permission)}  /  from ${escapeWorkspaceHtml(invite.owner_username || invite.invited_by_username || "owner")}</small></span><div><button data-decision="accept" class="primary">Accept</button><button data-decision="decline">Decline</button></div>`;
      row.querySelectorAll("button").forEach((button) => button.addEventListener("click", async () => {
        await api(`/api/workspace-invitations/${encodeURIComponent(invite.id)}/respond`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: button.dataset.decision }) });
        await loadOrbitWorkspaces();
        await loadWorkspaceInvitations();
      }));
      list.appendChild(row);
    }
  } catch (error) { list.innerHTML = `<p class="error">${escapeWorkspaceHtml(error.message)}</p>`; }
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

async function showWorkspaceMcpLink(workspace, card) {
  const detail = card.querySelector(".workspace-admin-detail");
  detail.classList.remove("hidden");
  detail.innerHTML = "Loading...";
  try {
    const me = await api(`/api/workspaces/${encodeURIComponent(workspace.id)}/mcp-grants/me`);
    if (!me.mcpEnabled) {
      detail.innerHTML = `<p class="muted-text">MCP access isn't enabled for this workspace yet. An admin needs to turn it on before anyone can be granted access.</p>`;
      return;
    }
    const canManage = state.role === "admin" || workspace.permission === "owner";
    const parts = [];
    if (me.granted) {
      parts.push(`
        <div class="workspace-mcp-pairing">
          <span class="workspace-state-badge" data-state="active">MCP access granted</span>
          <label>Connection URL
            <div class="workspace-mcp-code-row">
              <code class="workspace-mcp-code">${escapeWorkspaceHtml(me.connectUrl)}</code>
              <button type="button" class="workspace-mcp-copy-btn">Copy</button>
            </div>
          </label>
          <small class="muted-text">Add this as a custom connector in Claude or ChatGPT. You'll sign in with the same email this account uses (Cloudflare Access), then land in a scoped OrbitFS UI for &ldquo;${escapeWorkspaceHtml(workspace.name)}&rdquo;.</small>
        </div>`);
    } else {
      parts.push(`<p class="muted-text">You don't have MCP access on this workspace${canManage ? " yet. Grant it to yourself or a member from the Members panel." : ". Ask the workspace owner to grant it to you."}</p>`);
    }
    if (canManage) parts.push(`<p class="muted-text">Manage who has MCP access in the <strong>Members</strong> panel above.</p>`);
    detail.innerHTML = parts.join("");
    detail.querySelector(".workspace-mcp-copy-btn")?.addEventListener("click", async () => {
      const btn = detail.querySelector(".workspace-mcp-copy-btn");
      try { await navigator.clipboard.writeText(me.connectUrl); btn.textContent = "Copied"; }
      catch { btn.textContent = "Copy failed"; }
      setTimeout(() => { if (btn.isConnected) btn.textContent = "Copy"; }, 1200);
    });
  } catch (error) {
    detail.innerHTML = `<p class="error">${escapeWorkspaceHtml(error.message)}</p>`;
  }
}

async function showWorkspaceSettings(workspace, card) {
  const detail = card.querySelector(".workspace-admin-detail");
  const isAdmin = state.role === "admin";
  const management = workspace.management_permissions || {};
  const canView = isAdmin || workspace.permission === "owner" || management.view_settings;
  const canEdit = isAdmin || workspace.permission === "owner" || management.edit_settings;
  const canDelete = isAdmin || workspace.permission === "owner" || management.delete_workspace;
  if (!canView) { detail.classList.remove("hidden"); detail.innerHTML = `<p class="error">Workspace settings access denied.</p>`; return; }
  const editDisabled = canEdit ? "" : "disabled";
  detail.classList.remove("hidden");
  detail.innerHTML = "Loading settings...";
  let directory = [];
  if (isAdmin || workspace.permission === "owner") {
    try { directory = (await api("/api/workspace-user-directory")).users || []; }
    catch (error) { detail.innerHTML = `<p class="error">${escapeWorkspaceHtml(error.message)}</p>`; return; }
  }
  const userOptions = directory.map((user)=>`<option value="${escapeWorkspaceHtml(user.username)}">${escapeWorkspaceHtml(user.username)}${user.email ? `  -  ${escapeWorkspaceHtml(user.email)}` : ""}</option>`).join("");
  detail.innerHTML = `
    <form class="workspace-settings-form">
      <label>Name<input name="name" type="text" value="${escapeWorkspaceHtml(workspace.name)}" required ${editDisabled} /></label>
      <label>Description<textarea name="description" rows="3" ${editDisabled}>${escapeWorkspaceHtml(workspace.description || "")}</textarea></label>
      ${isAdmin ? `<label>Quota (GB)<input name="quotaGb" type="number" min="0" step="0.1" value="${(Number(workspace.storage_quota_bytes || 0)/1073741824).toFixed(2)}" /></label>
      <label>Trash limit (MB)<input name="trashLimitMb" type="number" min="0" step="1" value="${Math.round(Number(workspace.trash_limit_bytes || 209715200)/1048576)}" /></label>
      <label>Workspace owner<select name="ownerUsername">${userOptions}</select></label>
      <label>Filesystem root<input name="root" type="text" value="${escapeWorkspaceHtml(workspace.filesystem_root || "")}" /></label>
      <label>Status<select name="status"><option value="active">Active</option><option value="suspended">Suspended</option><option value="archived">Archived</option></select></label>
      <label>Suspension reason<textarea name="suspensionReason" rows="3" maxlength="500">${escapeWorkspaceHtml(workspace.suspension_reason || "")}</textarea></label>` : ""}
      ${canEdit ? `<button type="submit" class="primary">Save</button>` : `<p class="muted-text">View only. This role cannot edit workspace settings.</p>`}
      ${workspace.permission === "owner" && !isAdmin ? `<label>Request ownership transfer<select name="transferUsername"><option value="">Select user</option>${userOptions}</select></label><button type="button" class="workspace-transfer-request-btn">Request transfer</button>` : ""}
      ${canDelete ? `<button type="button" class="danger workspace-delete-btn">Delete workspace</button>` : ""}
    </form>
    <p class="error workspace-detail-error"></p>`;
  if (isAdmin) {
    detail.querySelector('[name="status"]').value = workspace.status;
    detail.querySelector('[name="ownerUsername"]').value = workspace.owner_username || "--";
  }
  detail.querySelector("form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!canEdit) return;
    const form = event.currentTarget;
    const error = detail.querySelector(".workspace-detail-error");
    const body = { name: form.elements.name.value.trim(), description: form.elements.description.value.trim() };
    if (isAdmin) {
      body.storageQuotaBytes = Math.round(Number(form.elements.quotaGb.value || 0) * 1073741824);
      body.trashLimitBytes = Math.round(Number(form.elements.trashLimitMb.value || 0) * 1048576);
      body.filesystemRoot = form.elements.root.value.trim();
      body.status = form.elements.status.value;
      body.suspensionReason = form.elements.suspensionReason.value.trim();
    }
    try {
      await api(`/api/workspaces/${encodeURIComponent(workspace.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (isAdmin && form.elements.ownerUsername.value.trim() && form.elements.ownerUsername.value.trim().toLowerCase() !== String(workspace.owner_username || "--").toLowerCase()) {
        await api(`/api/workspaces/${encodeURIComponent(workspace.id)}/owner`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: form.elements.ownerUsername.value.trim() }) });
      }
      await loadOrbitWorkspaces(workspace.id);
    } catch (err) { error.textContent = err.message; }
  });
  detail.querySelector(".workspace-transfer-request-btn")?.addEventListener("click", async () => {
    const form = detail.querySelector("form");
    const error = detail.querySelector(".workspace-detail-error");
    const username = form.elements.transferUsername.value;
    if (!username) { error.textContent = "Select a user first"; return; }
    try {
      await api(`/api/workspaces/${encodeURIComponent(workspace.id)}/transfer-request`, {
        method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({username}),
      });
      error.className = "muted-text workspace-detail-error";
      error.textContent = "Transfer request sent for admin approval.";
      await loadWorkspaceTransferRequests();
    } catch (err) { error.className = "error workspace-detail-error"; error.textContent = err.message; }
  });
  detail.querySelector(".workspace-delete-btn")?.addEventListener("click", async () => {
    if (!confirm(`Delete workspace "${workspace.name}" and all files permanently?`)) return;
    try {
      await api(`/api/workspaces/${encodeURIComponent(workspace.id)}`, { method: "DELETE" });
      state.workspaceId = "";
      localStorage.removeItem("panelWorkspaceId");
      await loadOrbitWorkspaces();
    } catch (err) { detail.querySelector(".workspace-detail-error").textContent = err.message; }
  });
}


async function loadWorkspaceStorageRequests() {
  const host = document.getElementById("workspace-storage-requests");
  if (!host || !state.token) return;
  try {
    const { requests } = await api("/api/workspace-storage-requests");
    const owned = state.workspaces.filter((workspace) => !workspace.is_main && workspace.permission === "owner");
    const canRequest = owned.length > 0;
    host.innerHTML = `<h3>Storage change requests</h3>
      ${canRequest ? `<form class="workspace-storage-request-inline">
        <label>Workspace<select name="workspaceId">${owned.map((workspace) => `<option value="${escapeWorkspaceHtml(workspace.id)}">${escapeWorkspaceHtml(workspace.name)} · ${workspaceStorageSummary(workspace)}</option>`).join("")}</select></label>
        <label>Requested size (GB)<input name="quotaGb" type="number" min="0" step="0.1" required /></label>
        <label>Message to admin<textarea name="message" rows="2" maxlength="1000" placeholder="Upgrade/downgrade reason"></textarea></label>
        <button type="submit" class="primary">Request storage change</button>
        <small>Admin manually changes storage, then approves or denies with a message.</small>
      </form>` : `<p class="muted-text">${state.role === "admin" ? "Admin request queue." : "Storage requests appear here when you own a workspace."}</p>`}
      <div class="workspace-storage-request-list"></div>`;
    host.querySelector(".workspace-storage-request-inline")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      try {
        await api(`/api/workspaces/${encodeURIComponent(form.elements.workspaceId.value)}/storage-request`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestedQuotaBytes: Math.round(Number(form.elements.quotaGb.value || 0) * 1073741824), message: form.elements.message.value.trim() }),
        });
        form.reset();
        await loadWorkspaceStorageRequests();
      } catch (error) { alert(error.message); }
      finally { button.disabled = false; }
    });
    const list = host.querySelector(".workspace-storage-request-list");
    if (!requests.length) { list.innerHTML = '<p class="muted-text">No storage requests yet.</p>'; return; }
    for (const request of requests) {
      const row = document.createElement("div");
      row.className = "workspace-transfer-row workspace-storage-request-row";
      row.innerHTML = `<span><strong>${escapeWorkspaceHtml(request.workspace_name)}</strong><small>${escapeWorkspaceHtml(request.status)} · ${escapeWorkspaceHtml(request.request_type)} · ${workspaceFormatBytes(request.current_quota_bytes || 0)} → ${workspaceFormatBytes(request.requested_quota_bytes)} · ${escapeWorkspaceHtml(request.requested_by_username || "owner")}</small>${request.message ? `<small>${escapeWorkspaceHtml(request.message)}</small>` : ""}${request.admin_message ? `<small>Admin: ${escapeWorkspaceHtml(request.admin_message)}</small>` : ""}</span><div></div>`;
      const actions = row.lastElementChild;
      if (state.role === "admin" && request.status === "pending") {
        for (const decision of ["approve","deny"]) {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = decision === "approve" ? "Approve" : "Deny";
          if (decision === "approve") button.className = "primary";
          button.addEventListener("click", async () => {
            const message = prompt(decision === "approve" ? "Approval message to owner" : "Denial message to owner", "");
            if (message === null) return;
            await api(`/api/workspace-storage-requests/${encodeURIComponent(request.id)}/respond`, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ decision, message }) });
            await loadOrbitWorkspaces();
          });
          actions.appendChild(button);
        }
      } else if (request.status === "pending") {
        const cancel = document.createElement("button");
        cancel.type = "button"; cancel.textContent = "Cancel request";
        cancel.addEventListener("click", async () => { await api(`/api/workspace-storage-requests/${encodeURIComponent(request.id)}`, { method:"DELETE" }); await loadWorkspaceStorageRequests(); });
        actions.appendChild(cancel);
      }
      list.appendChild(row);
    }
  } catch (error) { host.innerHTML = `<p class="error">${escapeWorkspaceHtml(error.message)}</p>`; }
}

async function loadWorkspaceRestoreRequests() {
  const host = document.getElementById("workspace-restore-requests");
  if (!host || !state.token) return;
  try {
    const [{ requests }, { workspaces: archived }] = await Promise.all([
      api("/api/workspace-restore-requests"),
      state.role === "admin" ? Promise.resolve({ workspaces: [] }) : api("/api/workspaces/archived"),
    ]);
    const pendingWorkspaceIds = new Set(requests.filter((request) => request.status === "pending").map((request) => String(request.workspace_id)));
    const requestable = archived.filter((workspace) => !pendingWorkspaceIds.has(String(workspace.id)));
    const canRequest = requestable.length > 0;
    host.innerHTML = `<h3>Archived workspace restores</h3>
      ${canRequest ? `<form class="workspace-storage-request-inline workspace-restore-request-inline">
        <label>Archived workspace<select name="workspaceId">${requestable.map((workspace) => `<option value="${escapeWorkspaceHtml(workspace.id)}">${escapeWorkspaceHtml(workspace.name)}</option>`).join("")}</select></label>
        <label>Message to admin<textarea name="message" rows="2" maxlength="1000" placeholder="Why you need it back"></textarea></label>
        <button type="submit" class="primary">Request restore</button>
        <small>Admin approves or denies with a message. Nothing was deleted when it was archived - approval just re-enables it.</small>
      </form>` : `<p class="muted-text">${state.role === "admin" ? "Admin request queue." : archived?.length ? "Restore already requested for your archived workspace(s)." : "Archived workspaces you own will appear here so you can request they be restored."}</p>`}
      <div class="workspace-storage-request-list workspace-restore-request-list"></div>`;
    host.querySelector(".workspace-restore-request-inline")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      try {
        await api(`/api/workspaces/${encodeURIComponent(form.elements.workspaceId.value)}/restore-request`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: form.elements.message.value.trim() }),
        });
        form.reset();
        await loadWorkspaceRestoreRequests();
      } catch (error) { alert(error.message); }
      finally { button.disabled = false; }
    });
    const list = host.querySelector(".workspace-restore-request-list");
    if (!requests.length) { list.innerHTML = '<p class="muted-text">No restore requests yet.</p>'; return; }
    for (const request of requests) {
      const row = document.createElement("div");
      row.className = "workspace-transfer-row workspace-storage-request-row workspace-restore-request-row";
      row.innerHTML = `<span><strong>${escapeWorkspaceHtml(request.workspace_name)}</strong><small>${escapeWorkspaceHtml(request.status)} · requested by ${escapeWorkspaceHtml(request.requested_by_username || "owner")}</small>${request.message ? `<small>${escapeWorkspaceHtml(request.message)}</small>` : ""}${request.admin_message ? `<small>Admin: ${escapeWorkspaceHtml(request.admin_message)}</small>` : ""}</span><div></div>`;
      const actions = row.lastElementChild;
      if (state.role === "admin" && request.status === "pending") {
        for (const decision of ["approve","deny"]) {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = decision === "approve" ? "Approve" : "Deny";
          if (decision === "approve") button.className = "primary";
          button.addEventListener("click", async () => {
            const message = prompt(decision === "approve" ? "Approval message to owner" : "Denial message to owner", "");
            if (message === null) return;
            await api(`/api/workspace-restore-requests/${encodeURIComponent(request.id)}/respond`, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ decision, message }) });
            await loadOrbitWorkspaces();
          });
          actions.appendChild(button);
        }
      } else if (request.status === "pending") {
        const cancel = document.createElement("button");
        cancel.type = "button"; cancel.textContent = "Cancel request";
        cancel.addEventListener("click", async () => { await api(`/api/workspace-restore-requests/${encodeURIComponent(request.id)}`, { method:"DELETE" }); await loadWorkspaceRestoreRequests(); });
        actions.appendChild(cancel);
      }
      list.appendChild(row);
    }
  } catch (error) { host.innerHTML = `<p class="error">${escapeWorkspaceHtml(error.message)}</p>`; }
}

async function loadWorkspaceTransferRequests() {
  const host = document.getElementById("workspace-transfer-requests");
  if (!host || !state.token) return;
  try {
    const { requests } = await api("/api/workspace-transfer-requests");
    if (!requests.length) { host.innerHTML = ""; return; }
    host.innerHTML = `<h3>Ownership transfer requests</h3>`;
    for (const request of requests) {
      const row = document.createElement("div");
      row.className = "workspace-transfer-row";
      row.innerHTML = `<span><strong>${escapeWorkspaceHtml(request.workspace_name)}</strong><small>${escapeWorkspaceHtml(request.requested_by_username)}  ->  ${escapeWorkspaceHtml(request.target_username)}${request.target_email ? `  /  ${escapeWorkspaceHtml(request.target_email)}` : ""}</small></span><div></div>`;
      const actions = row.lastElementChild;
      if (state.role === "admin") {
        for (const decision of ["approve","decline"]) {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = decision === "approve" ? "Approve" : "Decline";
          if (decision === "approve") button.className = "primary";
          button.addEventListener("click", async()=>{
            await api(`/api/workspace-transfer-requests/${encodeURIComponent(request.id)}/respond`, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({decision})});
            await loadOrbitWorkspaces();
          });
          actions.appendChild(button);
        }
      } else {
        const cancel = document.createElement("button");
        cancel.type = "button"; cancel.textContent = "Cancel request";
        cancel.addEventListener("click", async()=>{ await api(`/api/workspace-transfer-requests/${encodeURIComponent(request.id)}`,{method:"DELETE"}); await loadWorkspaceTransferRequests(); });
        actions.appendChild(cancel);
      }
      host.appendChild(row);
    }
  } catch (error) { host.innerHTML = `<p class="error">${escapeWorkspaceHtml(error.message)}</p>`; }
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
document.getElementById("workspace-page-create")?.addEventListener("click", openWorkspaceDialog);
if (state.token) setTimeout(() => loadOrbitWorkspaces(), 0);

function ensureCompactWorkspaceTrashList() {
  const retention = document.getElementById("trash-retention-days");
  const card = retention?.closest("details.card");
  if (!card) return null;
  let host = document.getElementById("workspace-trash-compact");
  if (!host) {
    host = document.createElement("section");
    host.id = "workspace-trash-compact";
    host.className = "workspace-trash-compact";
  }
  if (!host.querySelector("#workspace-trash-rows")) {
    host.innerHTML = '<div class="workspace-trash-compact-head"><div><strong>Workspace trash usage</strong><span>Updated automatically</span></div></div><div id="workspace-trash-rows" class="workspace-trash-compact-rows"></div>';
  }
  if (host.parentElement !== card) card.appendChild(host);
  return host;
}

function renderCompactWorkspaceTrashList() {
  ensureCompactWorkspaceTrashList();
  const rows = document.getElementById("workspace-trash-rows");
  if (!rows) return;
  const items = (state.workspaces || []).filter((w) => w.is_main || w.is_visible !== false);
  rows.innerHTML = items.map((w) => {
    const used = Number(w.trash_used_bytes || 0);
    const limit = Number(w.trash_limit_bytes || 0);
    const pct = limit > 0 ? Math.min(100, used / limit * 100) : 0;
    const max = limit > 0 ? workspaceFormatBytes(limit) : "Unlimited";
    return `<article class="workspace-trash-compact-row"><div class="workspace-trash-compact-line"><strong>${escapeWorkspaceHtml(w.name || "Workspace")}</strong><span>${workspaceFormatBytes(used)} / ${max}</span></div><div class="workspace-trash-compact-meter" aria-label="Trash usage ${pct.toFixed(1)} percent"><span style="width:${pct}%"></span></div></article>`;
  }).join("") || '<p class="muted-text">No workspaces available.</p>';
}

async function refreshCompactWorkspaceTrashList() {
  if (!state.token || state.role !== "admin") return;
  try {
    const refreshed = await Promise.all((state.workspaces || []).map(async (w) => {
      try {
        const result = await api(`/api/workspaces/${encodeURIComponent(w.id)}/storage?refresh=true`);
        return result.workspace || w;
      } catch { return w; }
    }));
    state.workspaces = refreshed;
    renderCompactWorkspaceTrashList();
  } catch {}
}

window.addEventListener("load", () => {
  setTimeout(refreshCompactWorkspaceTrashList, 2500);
  setInterval(refreshCompactWorkspaceTrashList, 30000);
});

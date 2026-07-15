(() => {
  if (window.__orbitWorkspaceUiLoaded) return;
  window.__orbitWorkspaceUiLoaded = true;

  state.workspaceId = localStorage.getItem("panelWorkspaceId") || "";
  state.workspaces = [];
  state.workspaceSettings = { maxWorkspacesPerUser: 1, ownedCount: 0 };

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
  if (!quota || workspace.storage_quota_mode === "unlimited") return `${workspaceFormatBytes(used)} used · Unlimited`;
  const free = Math.max(0, quota - used);
  const percent = workspaceStoragePercent(workspace);
  return `${workspaceFormatBytes(used)} of ${workspaceFormatBytes(quota)} · ${workspaceFormatBytes(free)} free · ${percent.toFixed(1)}%`;
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
    const offline = !workspace.is_main && workspace.drive_state === "offline";
    option.textContent = workspace.is_main ? `Main Workspace — ${workspace.name}` : `${workspace.name}${offline ? " — Drive offline" : (workspace.status === "suspended" ? " — Suspended" : "")}`;
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
    const selected = state.workspaces.find((item) => String(item.id) === String(preferredId))
      || state.workspaces.find((item) => item.is_main)
      || state.workspaces[0];
    state.workspaceId = selected ? String(selected.id) : "";
    if (state.workspaceId) localStorage.setItem("panelWorkspaceId", state.workspaceId);
    renderWorkspaceBar();
    if (typeof sorterRenderWorkspaceSelector === "function") sorterRenderWorkspaceSelector();
    renderWorkspaceAdmin();
    renderAdminStorageOverview();
    renderCompactWorkspaceTrashList();
    loadWorkspaceInvitations();
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
  if (list) list.innerHTML = "<li>Loading workspace…</li>";
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
  list.innerHTML = "<li>Loading…</li>";
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
  if (hint) hint.textContent = `2.5 GB default quota · ${owned} of ${max || "unlimited"} workspaces used.`;
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
  if (document.getElementById("workspace-admin-list")) return;
  const host = document.getElementById("workspace-manager-host");
  if (!host) return;
  const card = document.createElement("details");
  card.className = "card workspace-manager-card";
  card.open = true;
  card.innerHTML = `
    <summary>Workspace manager</summary>
    <p id="workspace-admin-summary" class="muted-text"></p>
    <div id="workspace-transfer-requests" class="workspace-transfer-requests"></div>
    ${state.role === "admin" ? `<form id="workspace-limit-form" class="workspace-limit-form">
      <label for="workspace-max-per-user">Maximum workspaces per user</label>
      <input id="workspace-max-per-user" type="number" min="0" max="1000" step="1" required />
      <button type="submit" class="primary">Save limit</button>
      <small>0 = unlimited. Main Workspace is not counted.</small>
      <p id="workspace-limit-message" class="error"></p>
    </form>
    <form id="workspace-lifecycle-form" class="workspace-limit-form">
      <label>Inactive before offline (days)<input name="inactiveDays" type="number" min="1" max="3650" required /></label>
      <label>Offline warning (days)<input name="offlineWarningDays" type="number" min="1" max="3650" required /></label>
      <label>Delete after offline (days)<input name="deleteAfterOfflineDays" type="number" min="1" max="3650" required /></label>
      <label>Deletion warning (days)<input name="deleteWarningDays" type="number" min="1" max="3650" required /></label>
      <button type="submit" class="primary">Save lifecycle</button>
      <small>Main Workspace is excluded. Offline workspaces keep files but release their quota allocation.</small>
      <p id="workspace-lifecycle-message" class="error"></p>
    </form>` : ""}
    <div id="workspace-admin-list" class="workspace-admin-list"></div>`;
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
  const rows = state.workspaces.map(w=>`<div class="workspace-system-storage-row"><strong>${escapeWorkspaceHtml(w.name)}</strong><span>${escapeWorkspaceHtml(w.owner_username||"—")}</span><span>${workspaceStorageSummary(w)}</span></div>`).join("");
  card.innerHTML = `<summary>Workspace storage</summary><p class="muted-text">${workspaceFormatBytes(total)} tracked · ${workspaceFormatBytes(branched)} branched</p><div class="workspace-system-storage-list">${rows}</div>`;
}

function renderWorkspaceAdmin() {
  ensureWorkspaceAdmin();
  const list = document.getElementById("workspace-admin-list");
  const summary = document.getElementById("workspace-admin-summary");
  if (!list || !summary) return;
  const total = state.workspaces.reduce((sum, item) => sum + Number(item.storage_used_bytes || 0), 0);
  const max = Number(state.workspaceSettings?.maxWorkspacesPerUser ?? 1);
  summary.textContent = `${state.workspaces.length} visible workspace${state.workspaces.length === 1 ? "" : "s"} · ${workspaceFormatBytes(total)} tracked · user limit ${max || "unlimited"}`;
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

function buildWorkspaceAdminCard(workspace) {
  const isOwner = workspace.permission === "owner";
  const canManage = workspace.is_main ? isOwner : (state.role === "admin" || isOwner);
  const isSuspended = workspace.status === "suspended";
  const mainOffline = workspace.is_main && workspace.is_visible === false;
  const branchOffline = !workspace.is_main && workspace.drive_state === "offline";
  const canOpen = !branchOffline && (!isSuspended || state.role === "admin") && (!mainOffline || isOwner);
  const card = document.createElement("article");
  card.className = `workspace-admin-card${isSuspended ? " workspace-suspended" : ""}`;
  card.innerHTML = `
    <div class="workspace-admin-head">
      <div><strong>${escapeWorkspaceHtml(workspace.name)}</strong><span>${workspace.is_main ? (mainOffline ? "Drive offline" : "Main Workspace") : (branchOffline ? "Drive offline" : escapeWorkspaceHtml(workspace.status))}</span></div>
      <button type="button" class="workspace-open-btn" ${canOpen ? "" : "disabled"}>${branchOffline ? "Drive offline" : (mainOffline && !isOwner ? "Drive offline" : (isSuspended && state.role !== "admin" ? "Suspended" : "Open"))}</button>
    </div>
    <dl>
      <div><dt>Owner</dt><dd>${escapeWorkspaceHtml(workspace.owner_username || "—")}</dd></div>
      <div><dt>Role</dt><dd>${escapeWorkspaceHtml(workspace.permission || "admin")}</dd></div>
      <div><dt>Storage</dt><dd>${escapeWorkspaceHtml(workspaceStorageSummary(workspace))}</dd></div>
      <div><dt>Allocated</dt><dd>${workspaceFormatBytes(workspace.allocated_bytes || 0)}</dd></div>
      <div><dt>Trash</dt><dd>${workspaceFormatBytes(workspace.trash_used_bytes || 0)} / ${workspaceFormatBytes(workspace.trash_limit_bytes || 209715200)}</dd></div>
      <div><dt>Files</dt><dd>${Number(workspace.file_count || 0).toLocaleString()}</dd></div>
      <div><dt>Folders</dt><dd>${Number(workspace.folder_count || 0).toLocaleString()}</dd></div>
    </dl>
    <div class="workspace-card-meter" data-state="${workspaceStorageState(workspaceStoragePercent(workspace))}"><span style="width:${Math.min(100,workspaceStoragePercent(workspace)||0)}%"></span></div>
    ${isSuspended ? `<p class="workspace-suspension-note"><strong>Suspended</strong>${workspace.suspension_reason ? ` — ${escapeWorkspaceHtml(workspace.suspension_reason)}` : ""}</p>` : ""}
    ${workspace.lifecycle_notice ? `<p class="workspace-suspension-note"><strong>Lifecycle notice</strong> — ${escapeWorkspaceHtml(workspace.lifecycle_notice)}</p>` : ""}
    <div class="workspace-admin-actions">
      <button type="button" class="workspace-storage-btn">Storage details</button>
      ${canManage ? '<button type="button" class="workspace-members-btn">Members</button>' : ""}
      ${workspace.is_main && isOwner ? `<button type="button" class="workspace-visibility-btn">${mainOffline ? "Bring drive online" : "Hide drive"}</button>` : ""}
      ${!workspace.is_main && canManage ? `<button type="button" class="workspace-drive-state-btn">${branchOffline ? "Bring drive online" : "Take drive offline"}</button>` : ""}
      ${!workspace.is_main && canManage ? '<button type="button" class="workspace-edit-btn">Settings</button>' : ""}
    </div>
    <div class="workspace-admin-detail hidden"></div>`;
  card.querySelector(".workspace-open-btn").addEventListener("click", () => {
    activateWorkspace(workspace.id);
  });
  card.querySelector(".workspace-storage-btn")?.addEventListener("click", () => showWorkspaceStorage(workspace, card));
  card.querySelector(".workspace-members-btn")?.addEventListener("click", () => showWorkspaceMembers(workspace, card));
  card.querySelector(".workspace-visibility-btn")?.addEventListener("click", async () => {
    try {
      await api(`/api/workspaces/${encodeURIComponent(workspace.id)}/visibility`, {
        method:"PATCH", headers:{"Content-Type":"application/json"}, body:JSON.stringify({visible:mainOffline}),
      });
      await loadOrbitWorkspaces(workspace.id);
    } catch (error) { alert(error.message); }
  });
  card.querySelector(".workspace-drive-state-btn")?.addEventListener("click", async () => {
    const nextOnline = branchOffline;
    const action = nextOnline ? "bring this drive online" : "take this drive offline and release its quota allocation";
    if(!confirm(`Are you sure you want to ${action}?`)) return;
    try {
      await api(`/api/workspaces/${encodeURIComponent(workspace.id)}/drive-state`, {
        method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({online:nextOnline}),
      });
      await loadOrbitWorkspaces(workspace.id);
    } catch(error){ alert(error.message); }
  });
  card.querySelector(".workspace-edit-btn")?.addEventListener("click", () => showWorkspaceSettings(workspace, card));
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
  detail.innerHTML = "Refreshing storage…";
  try {
    const result = await api(`/api/workspaces/${encodeURIComponent(workspace.id)}/storage?refresh=true`);
    const updated = result.workspace;
    const canEmpty = !updated.is_main && (state.role === "admin" || updated.permission === "owner");
    detail.innerHTML = `<div class="workspace-storage-grid">
      <div><span>Used</span><strong>${workspaceFormatBytes(updated.storage_used_bytes)}</strong></div>
      <div><span>Quota</span><strong>${updated.storage_quota_mode === "unlimited" ? "Unlimited" : workspaceFormatBytes(updated.storage_quota_bytes)}</strong></div>
      <div><span>Free</span><strong>${updated.storage_quota_mode === "unlimited" ? "—" : workspaceFormatBytes(Math.max(0,Number(updated.storage_quota_bytes||0)-Number(updated.storage_used_bytes||0)))}</strong></div>
      <div><span>Files</span><strong>${Number(updated.file_count||0).toLocaleString()}</strong></div>
      <div><span>Folders</span><strong>${Number(updated.folder_count||0).toLocaleString()}</strong></div>
      <div><span>Trash</span><strong>${workspaceFormatBytes(updated.trash_used_bytes||0)}</strong></div>
    </div>
    <p class="muted-text">Last scanned: ${updated.storage_last_scanned_at ? new Date(updated.storage_last_scanned_at).toLocaleString() : "Not yet scanned"}</p>
    <div class="workspace-storage-actions"><button type="button" class="workspace-refresh-storage">Refresh</button>${canEmpty ? '<button type="button" class="danger workspace-empty-trash">Empty trash</button>' : ""}</div>
    <p class="error workspace-detail-error"></p>`;
    detail.querySelector(".workspace-refresh-storage").addEventListener("click",()=>showWorkspaceStorage(updated,card));
    detail.querySelector(".workspace-empty-trash")?.addEventListener("click",async()=>{
      if(!confirm("Permanently empty this workspace trash?")) return;
      try { await api(`/api/workspaces/${encodeURIComponent(updated.id)}/trash`,{method:"DELETE"}); await loadOrbitWorkspaces(updated.id); await showWorkspaceStorage(updated,card); }
      catch(error){ detail.querySelector(".workspace-detail-error").textContent=error.message; }
    });
    const index=state.workspaces.findIndex(item=>String(item.id)===String(updated.id));
    if(index>=0) state.workspaces[index]=updated;
    renderWorkspaceBar();
  } catch(error) { detail.innerHTML=`<p class="error">${escapeWorkspaceHtml(error.message)}</p>`; }
}

async function showWorkspaceMembers(workspace, card) {
  const detail = card.querySelector(".workspace-admin-detail");
  detail.classList.remove("hidden");
  detail.innerHTML = "Loading members…";
  try {
    const { members } = await api(`/api/workspaces/${encodeURIComponent(workspace.id)}/members`);
    const canManage = state.role === "admin" || workspace.permission === "owner";
    detail.innerHTML = `
      <div class="workspace-member-list"></div>
      ${canManage ? `<form class="workspace-member-form">
        <input name="username" type="text" placeholder="Username" required autocomplete="off" />
        <select name="permission"><option value="viewer">Viewer</option><option value="contributor">Contributor</option><option value="editor">Editor</option></select>
        <button type="submit" class="primary">Send invite</button>
      </form>` : ""}
      <p class="error workspace-detail-error"></p>`;
    renderWorkspaceMembers(detail.querySelector(".workspace-member-list"), members, workspace, card, canManage);
    detail.querySelector(".workspace-member-form")?.addEventListener("submit", (event) => inviteWorkspaceMember(event, workspace, card));
  } catch (error) {
    detail.textContent = error.message;
  }
}

function renderWorkspaceMembers(container, members, workspace, card, canManage) {
  container.innerHTML = "";
  for (const member of members) {
    const row = document.createElement("div");
    row.className = "workspace-member-row";
    const canEditRole = canManage && member.permission !== "owner";
    row.innerHTML = `
      <span class="workspace-member-identity"><strong>${escapeWorkspaceHtml(member.username)}</strong><small>${escapeWorkspaceHtml(member.permission)}</small></span>
      ${canEditRole ? `<div class="workspace-member-controls">
        <select class="workspace-member-role" aria-label="Role for ${escapeWorkspaceHtml(member.username)}">
          <option value="viewer">Viewer</option>
          <option value="contributor">Contributor</option>
          <option value="editor">Editor</option>
        </select>
        <button type="button" class="primary workspace-member-save">Save role</button>
        <button type="button" class="danger workspace-member-remove">Remove</button>
      </div>` : ""}`;
    const roleSelect = row.querySelector(".workspace-member-role");
    if (roleSelect) roleSelect.value = member.permission;
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
      row.innerHTML = `<span><strong>${escapeWorkspaceHtml(invite.workspace_name)}</strong><small>${escapeWorkspaceHtml(invite.permission)} · from ${escapeWorkspaceHtml(invite.owner_username || invite.invited_by_username || "owner")}</small></span><div><button data-decision="accept" class="primary">Accept</button><button data-decision="decline">Decline</button></div>`;
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

async function showWorkspaceSettings(workspace, card) {
  const detail = card.querySelector(".workspace-admin-detail");
  const isAdmin = state.role === "admin";
  detail.classList.remove("hidden");
  detail.innerHTML = "Loading settings…";
  let directory = [];
  try { directory = (await api("/api/workspace-user-directory")).users || []; }
  catch (error) { detail.innerHTML = `<p class="error">${escapeWorkspaceHtml(error.message)}</p>`; return; }
  const userOptions = directory.map((user)=>`<option value="${escapeWorkspaceHtml(user.username)}">${escapeWorkspaceHtml(user.username)}${user.email ? ` — ${escapeWorkspaceHtml(user.email)}` : ""}</option>`).join("");
  detail.innerHTML = `
    <form class="workspace-settings-form">
      <label>Name<input name="name" type="text" value="${escapeWorkspaceHtml(workspace.name)}" required /></label>
      <label>Description<textarea name="description" rows="3">${escapeWorkspaceHtml(workspace.description || "")}</textarea></label>
      ${isAdmin ? `<label>Quota (GB)<input name="quotaGb" type="number" min="0" step="0.1" value="${(Number(workspace.storage_quota_bytes || 0)/1073741824).toFixed(2)}" /></label>
      <label>Trash limit (MB)<input name="trashLimitMb" type="number" min="0" step="1" value="${Math.round(Number(workspace.trash_limit_bytes || 209715200)/1048576)}" /></label>
      <label>Workspace owner<select name="ownerUsername">${userOptions}</select></label>
      <label>Filesystem root<input name="root" type="text" value="${escapeWorkspaceHtml(workspace.filesystem_root || "")}" /></label>
      <label>Status<select name="status"><option value="active">Active</option><option value="suspended">Suspended</option><option value="archived">Archived</option></select></label>
      <label>Suspension reason<textarea name="suspensionReason" rows="3" maxlength="500">${escapeWorkspaceHtml(workspace.suspension_reason || "")}</textarea></label>` : ""}
      <button type="submit" class="primary">Save</button>
      ${!isAdmin ? `<label>Request ownership transfer<select name="transferUsername"><option value="">Select user</option>${userOptions}</select></label><button type="button" class="workspace-transfer-request-btn">Request transfer</button>` : ""}
      <button type="button" class="danger workspace-delete-btn">Delete workspace</button>
    </form>
    <p class="error workspace-detail-error"></p>`;
  if (isAdmin) {
    detail.querySelector('[name="status"]').value = workspace.status;
    detail.querySelector('[name="ownerUsername"]').value = workspace.owner_username || "";
  }
  detail.querySelector("form").addEventListener("submit", async (event) => {
    event.preventDefault();
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
      if (isAdmin && form.elements.ownerUsername.value.trim() && form.elements.ownerUsername.value.trim().toLowerCase() !== String(workspace.owner_username || "").toLowerCase()) {
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
  detail.querySelector(".workspace-delete-btn").addEventListener("click", async () => {
    if (!confirm(`Delete workspace "${workspace.name}" and all files permanently?`)) return;
    try {
      await api(`/api/workspaces/${encodeURIComponent(workspace.id)}`, { method: "DELETE" });
      state.workspaceId = "";
      localStorage.removeItem("panelWorkspaceId");
      await loadOrbitWorkspaces();
    } catch (err) { detail.querySelector(".workspace-detail-error").textContent = err.message; }
  });
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
      row.innerHTML = `<span><strong>${escapeWorkspaceHtml(request.workspace_name)}</strong><small>${escapeWorkspaceHtml(request.requested_by_username)} → ${escapeWorkspaceHtml(request.target_username)}${request.target_email ? ` · ${escapeWorkspaceHtml(request.target_email)}` : ""}</small></span><div></div>`;
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
  if (document.getElementById("workspace-trash-compact")) return;
  const retention = document.getElementById("trash-retention-days");
  const card = retention?.closest("details.card");
  if (!card) return;
  const host = document.createElement("div");
  host.id = "workspace-trash-compact";
  host.className = "workspace-trash-compact";
  host.innerHTML = '<div class="workspace-trash-head"><strong>Workspace trash</strong><span>Auto refresh</span></div><div id="workspace-trash-rows"></div>';
  card.querySelector("#trash-config-message")?.insertAdjacentElement("afterend", host);
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
    return `<div class="workspace-trash-row"><div class="workspace-trash-line"><strong>${escapeWorkspaceHtml(w.name || "Workspace")}</strong><span>${workspaceFormatBytes(used)} / ${max}</span></div><div class="workspace-trash-meter"><span style="width:${pct}%"></span></div></div>`;
  }).join("") || '<p class="muted-text">No workspaces.</p>';
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

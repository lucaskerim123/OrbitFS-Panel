const FILE_PERMISSION_ACTIONS = ["read", "write", "download", "move", "delete", "create"];
const FILE_PERMISSION_LABELS = {
  read: "View / read",
  write: "Edit / write",
  download: "Download",
  move: "Move / rename",
  delete: "Delete / trash",
  create: "Create / upload",
};

function isAdminUser() {
  return state.role === "admin";
}

function isBranchedWorkspaceMode() {
  const workspace = typeof currentWorkspace === "function" ? currentWorkspace() : null;
  return state.workspaceSettings?.workspaceModeEnabled !== false && !!workspace && !workspace.is_main;
}

function canManageCurrentPermissions() {
  const workspace = typeof currentWorkspace === "function" ? currentWorkspace() : null;
  return isBranchedWorkspaceMode() ? (isAdminUser() || workspace?.permission === "owner") : isAdminUser();
}

function openCurrentPermissionEditor(filepath, current = null) {
  if (isBranchedWorkspaceMode() && typeof openWorkspacePermissionForPath === "function") {
    openWorkspacePermissionForPath(filepath);
    return;
  }
  openPermissionEditor(filepath, current);
}

function permissionSummary(permissions = {}) {
  const allowed = FILE_PERMISSION_ACTIONS.filter((action) => permissions[action]);
  if (allowed.length === FILE_PERMISSION_ACTIONS.length) return "All user actions";
  if (!allowed.length) return "Admin only";
  return allowed.map((action) => FILE_PERMISSION_LABELS[action]).join(", ");
}

async function loadPermissions() {
  if (!isAdminUser()) return;
  try {
    const { rules } = await api("/api/file-permissions");
    const body = document.getElementById("permissions-body");
    if (!body) return;
    body.innerHTML = "";
    rules.forEach((rule) => {
      const tr = document.createElement("tr");
      const pathTd = document.createElement("td");
      pathTd.textContent = rule.path || "/";
      const permissionTd = document.createElement("td");
      permissionTd.className = "permission-summary-cell";
      permissionTd.textContent = permissionSummary(rule.permissions);
      const actionTd = document.createElement("td");
      const edit = Object.assign(document.createElement("button"), { className: "icon-btn", textContent: "⚙", title: "Edit permissions" });
      edit.addEventListener("click", () => openPermissionEditor(rule.path, rule.permissions));
      const clear = Object.assign(document.createElement("button"), { className: "icon-btn", textContent: "↺", title: "Restore inherited permissions" });
      clear.addEventListener("click", async () => {
        if (!confirm(`Remove the custom permission rule for '${rule.path || "/"}' and inherit from its parent?`)) return;
        await api(`/api/file-permissions?path=${encodeURIComponent(rule.path)}`, { method: "DELETE" });
        await loadPermissions();
        await loadFiles();
      });
      actionTd.append(edit, clear);
      tr.append(pathTd, permissionTd, actionTd);
      body.appendChild(tr);
    });
    if (!rules.length) body.innerHTML = `<tr><td colspan="3">(no overrides — users can perform all actions)</td></tr>`;
  } catch (err) {
    console.error(err);
  }
}

function ensurePermissionEditor() {
  let overlay = document.getElementById("permission-editor-overlay");
  if (overlay) return overlay;
  overlay = document.createElement("div");
  overlay.id = "permission-editor-overlay";
  overlay.className = "modal-overlay hidden";
  overlay.innerHTML = `
    <div class="modal-box permission-editor-box" role="dialog" aria-modal="true" aria-labelledby="permission-editor-title">
      <h2 id="permission-editor-title">User permissions</h2>
      <p id="permission-editor-path" class="muted-text"></p>
      <p class="muted-text">Folder permissions automatically apply to everything inside unless a more specific file or subfolder rule overrides them. Admin always has every action.</p>
      <div id="permission-editor-actions" class="permission-action-grid"></div>
      <p id="permission-editor-error" class="error"></p>
      <div class="modal-actions">
        <button type="button" id="permission-preset-read">Read only</button>
        <button type="button" id="permission-preset-none">Admin only</button>
        <button type="button" id="permission-editor-cancel">Cancel</button>
        <button type="button" id="permission-editor-save" class="primary">Save permissions</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (event) => { if (event.target === overlay) overlay.classList.add("hidden"); });
  overlay.querySelector("#permission-editor-cancel").addEventListener("click", () => overlay.classList.add("hidden"));
  overlay.querySelector("#permission-preset-read").addEventListener("click", () => setEditorChecks({ read: true }));
  overlay.querySelector("#permission-preset-none").addEventListener("click", () => setEditorChecks({}));
  overlay.querySelector("#permission-editor-save").addEventListener("click", savePermissionEditor);
  return overlay;
}

function setEditorChecks(allowed = {}) {
  FILE_PERMISSION_ACTIONS.forEach((action) => {
    const input = document.getElementById(`permission-action-${action}`);
    if (input) input.checked = !!allowed[action];
  });
}

async function openPermissionEditor(filepath, current = null) {
  if (!isAdminUser()) return;
  const overlay = ensurePermissionEditor();
  overlay.dataset.path = filepath;
  overlay.querySelector("#permission-editor-path").textContent = filepath || "/ (OrbitFS root)";
  overlay.querySelector("#permission-editor-error").textContent = "";
  overlay.classList.remove("hidden");
  if (!current) {
    try {
      const result = await api(`/api/file-permissions/effective?path=${encodeURIComponent(filepath)}`);
      current = result.permissions;
    } catch (err) {
      overlay.querySelector("#permission-editor-error").textContent = err.message;
      return;
    }
  }
  const actions = overlay.querySelector("#permission-editor-actions");
  actions.innerHTML = "";
  FILE_PERMISSION_ACTIONS.forEach((action) => {
    const label = document.createElement("label");
    label.className = "permission-action-row";
    const input = Object.assign(document.createElement("input"), { type: "checkbox", id: `permission-action-${action}` });
    input.checked = current ? !!current[action] : true;
    label.append(input, document.createTextNode(FILE_PERMISSION_LABELS[action]));
    actions.appendChild(label);
  });
}

async function savePermissionEditor() {
  const overlay = ensurePermissionEditor();
  const permissions = Object.fromEntries(FILE_PERMISSION_ACTIONS.map((action) => [action, document.getElementById(`permission-action-${action}`).checked]));
  const error = overlay.querySelector("#permission-editor-error");
  try {
    await api("/api/file-permissions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: overlay.dataset.path || "", permissions }),
    });
    overlay.classList.add("hidden");
    await loadPermissions();
    await loadFiles();
  } catch (err) {
    error.textContent = err.message;
  }
}

function setPermissionPrompt(filepath) {
  openPermissionEditor(filepath);
}

function addPermissionButton(container, filepath, permissions) {
  if (!isAdminUser() || !container) return;
  const btn = Object.assign(document.createElement("button"), { className: "icon-btn", textContent: "⚙", title: "Customize user permissions" });
  btn.addEventListener("click", (event) => { event.stopPropagation(); openPermissionEditor(filepath, permissions); });
  container.appendChild(btn);
}

const baseRenderRow = renderRow;
renderRow = function renderRowWithPermissions(list, entry) {
  baseRenderRow(list, entry);
  if (!isAdminUser() || isBranchedWorkspaceMode()) return;
  const li = list.lastElementChild;
  const actions = li?.querySelector(".row-actions");
  const full = state.subpath ? `${state.subpath}/${entry.name}` : entry.name;
  addPermissionButton(actions, full, entry.permissions);
};

const baseLoadSystem = loadSystem;
loadSystem = async function loadSystemWithPermissions() {
  await baseLoadSystem();
  await loadPermissions();
};

document.getElementById("editor-permission-btn")?.addEventListener("click", () => state.openFile && openCurrentPermissionEditor(state.openFile));
document.getElementById("preview-permission-btn")?.addEventListener("click", () => state.previewFile && openCurrentPermissionEditor(state.previewFile));

const baseOpenFile = openFile;
openFile = async function openFileWithPermissionButton(filepath) {
  await baseOpenFile(filepath);
  document.getElementById("editor-permission-btn")?.classList.toggle("hidden", !canManageCurrentPermissions());
};

const baseOpenPreview = openPreview;
openPreview = async function openPreviewWithPermissionButton(filepath, entry) {
  await baseOpenPreview(filepath, entry);
  document.getElementById("preview-permission-btn")?.classList.toggle("hidden", !canManageCurrentPermissions());
};

if (isAdminUser()) loadPermissions();

const docxViewerStyle = document.createElement("link");
docxViewerStyle.rel = "stylesheet";
docxViewerStyle.href = "docx-viewer.css";
document.head.appendChild(docxViewerStyle);
const docxViewerScript = document.createElement("script");
docxViewerScript.src = "docx-viewer.js";
docxViewerScript.async = false;
document.body.appendChild(docxViewerScript);

const startupPickerScript = document.createElement("script");
startupPickerScript.src = "startup-picker.js";
startupPickerScript.async = false;
document.body.appendChild(startupPickerScript);

const layoutTweaksScript = document.createElement("script");
layoutTweaksScript.src = "layout-tweaks.js?v=20260715-notifications";
layoutTweaksScript.async = false;
document.body.appendChild(layoutTweaksScript);
(() => {
  if (window.__orbitWorkspacePermissionEditorLoaded) return;
  window.__orbitWorkspacePermissionEditorLoaded = true;

  const ACTIONS = ["read", "write", "download", "move", "delete", "create"];
  const ROLES = ["editor", "contributor", "viewer"];
  const DEFAULTS = {
    editor: { read:true, write:true, download:true, move:true, delete:true, create:true },
    contributor: { read:true, write:true, download:true, move:true, delete:false, create:true },
    viewer: { read:true, write:false, download:true, move:false, delete:false, create:false },
  };

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;",
    })[char]);
  }

  function modeEnabled() {
    return state.workspaceSettings?.workspaceModeEnabled !== false;
  }

  function canManage(workspace) {
    return !!workspace && (state.role === "admin" || workspace.permission === "owner");
  }
  function ensureStyles() {
    if (document.getElementById("workspace-permission-editor-style")) return;
    const style = document.createElement("style");
    style.id = "workspace-permission-editor-style";
    style.textContent = `
      .workspace-mode-card{border-color:color-mix(in srgb,var(--accent) 45%,var(--border))}
      .workspace-mode-row{display:flex;align-items:center;justify-content:space-between;gap:12px}
      .workspace-mode-row label{display:flex;align-items:center;gap:8px;font-weight:700}
      .workspace-scope-note{margin:.45rem 0 0;font-size:.76rem;color:var(--muted)}
      .workspace-permission-form{display:grid;gap:10px;margin-top:12px}
      .workspace-permission-form .perm-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
      .workspace-permission-form .perm-grid label{display:flex;align-items:center;gap:7px;padding:9px;border:1px solid var(--border);border-radius:9px}
      .workspace-permission-list{display:grid;gap:8px;margin-top:12px}
      .workspace-permission-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;padding:10px;border:1px solid var(--border);border-radius:10px}
      .workspace-permission-row small{display:block;color:var(--muted);margin-top:3px}
      .workspace-permission-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
      .workspace-mode-disabled .workspace-create-btn,.workspace-mode-disabled #workspace-page-create{display:none!important}
      @media(max-width:650px){.workspace-mode-row{align-items:flex-start;flex-direction:column}.workspace-permission-form .perm-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.workspace-permission-row{grid-template-columns:1fr}}
    `;
    document.head.appendChild(style);
  }
  function ensureModeCard() {
    if (state.role !== "admin") return;
    const host = document.getElementById("workspace-manager-host");
    if (!host || document.getElementById("workspace-mode-card")) return;
    const card = document.createElement("section");
    card.id = "workspace-mode-card";
    card.className = "card workspace-mode-card";
    card.innerHTML = `
      <div class="workspace-mode-row">
        <div><strong>Workspace Mode</strong><p class="workspace-scope-note">Main Workspace stays on the existing Simple Mode permissions. Branched workspaces use member roles and path overrides.</p></div>
        <label><input id="workspace-mode-toggle" type="checkbox"> Attached</label>
      </div>
      <p id="workspace-mode-message" class="muted-text"></p>`;
    host.prepend(card);
    card.querySelector("#workspace-mode-toggle").addEventListener("change", saveWorkspaceMode);
  }

  async function saveWorkspaceMode(event) {
    const input = event.currentTarget;
    const message = document.getElementById("workspace-mode-message");
    input.disabled = true;
    try {
      const result = await api("/api/workspace-mode", {
        method:"PATCH", headers:{"Content-Type":"application/json"},
        body:JSON.stringify({ enabled:input.checked }),
      });
      state.workspaceSettings.workspaceModeEnabled = result.workspaceModeEnabled;
      if (!result.workspaceModeEnabled && typeof currentWorkspace === "function" && !currentWorkspace()?.is_main) {
        const main = state.workspaces.find((workspace) => workspace.is_main);
        if (main && typeof activateWorkspace === "function") await activateWorkspace(main.id, { openFiles:false });
      }
      if (message) message.textContent = result.workspaceModeEnabled ? "Workspace Mode attached." : "Workspace Mode detached. Main Workspace remains available.";
      applyWorkspaceModeUi();
    } catch (error) {
      input.checked = !input.checked;
      if (message) message.textContent = error.message;
    } finally { input.disabled = false; }
  }
  function applyWorkspaceModeUi() {
    const enabled = modeEnabled();
    document.body.classList.toggle("workspace-mode-disabled", !enabled);
    const toggle = document.getElementById("workspace-mode-toggle");
    if (toggle) toggle.checked = enabled;

    const picker = document.getElementById("workspace-select");
    if (picker) {
      for (const option of picker.options) {
        const workspace = state.workspaces.find((item) => String(item.id) === String(option.value));
        if (!workspace?.is_main) {
          option.hidden = !enabled;
          option.disabled = !enabled || option.disabled;
        }
      }
    }

    const cards = [...document.querySelectorAll("#workspace-admin-list .workspace-admin-card")];
    cards.forEach((card, index) => {
      const workspace = state.workspaces[index];
      if (!workspace) return;
      card.dataset.workspaceId = workspace.id;
      card.dataset.mainWorkspace = String(!!workspace.is_main);
      card.hidden = !enabled && !workspace.is_main && state.role !== "admin";
      const open = card.querySelector(".workspace-open-btn");
      if (open && !workspace.is_main) open.disabled = !enabled || open.disabled;
    });
  }

  function permissionSummary(permissions) {
    return ACTIONS.filter((action) => permissions?.[action]).join(", ") || "no access";
  }

  function findWorkspaceCard(workspace) {
    return [...document.querySelectorAll("#workspace-admin-list .workspace-admin-card")]
      .find((card) => card.dataset.workspaceId === String(workspace.id));
  }
  async function showPermissionEditor(workspace, card, initialPath = "") {
    if (!workspace || workspace.is_main || !canManage(workspace)) return;
    const detail = card.querySelector(".workspace-admin-detail");
    detail.classList.remove("hidden");
    detail.innerHTML = "Loading workspace permissions…";
    try {
      const { overrides } = await api(`/api/workspaces/${encodeURIComponent(workspace.id)}/permission-overrides`);
      detail.innerHTML = `
        <div><strong>Workspace permission editor</strong><p class="workspace-scope-note">Private to the owner and invited members. A more specific path overrides the workspace role default.</p></div>
        <form class="workspace-permission-form">
          <label>Role<select name="role"><option value="editor">Editor</option><option value="contributor">Contributor</option><option value="viewer">Viewer</option></select></label>
          <label>File or folder path<input name="path" type="text" value="${esc(initialPath)}" placeholder="Root workspace" autocomplete="off"></label>
          <div class="workspace-permission-actions"><button type="button" class="permission-current-folder">Use current folder</button><button type="button" class="permission-role-defaults">Use role defaults</button></div>
          <div class="perm-grid">${ACTIONS.map((action) => `<label><input type="checkbox" name="${action}"> ${action}</label>`).join("")}</div>
          <button type="submit" class="primary">Save override</button>
          <p class="workspace-permission-message muted-text"></p>
        </form>
        <div class="workspace-permission-list"></div>`;
      const form = detail.querySelector("form");
      const list = detail.querySelector(".workspace-permission-list");
      const applyDefaults = () => {
        const values = DEFAULTS[form.elements.role.value];
        ACTIONS.forEach((action) => { form.elements[action].checked = !!values[action]; });
      };
      form.elements.role.addEventListener("change", applyDefaults);
      detail.querySelector(".permission-role-defaults").addEventListener("click", applyDefaults);
      detail.querySelector(".permission-current-folder").addEventListener("click", () => {
        form.elements.path.value = String(state.workspaceId) === String(workspace.id) ? state.subpath || "" : "";
      });
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const message = form.querySelector(".workspace-permission-message");
        const permissions = Object.fromEntries(ACTIONS.map((action) => [action, !!form.elements[action].checked]));
        try {
          await api(`/api/workspaces/${encodeURIComponent(workspace.id)}/permission-overrides`, {
            method:"PUT", headers:{"Content-Type":"application/json"},
            body:JSON.stringify({ role:form.elements.role.value, path:form.elements.path.value.trim(), permissions }),
          });
          message.textContent = "Permission override saved.";
          await showPermissionEditor(workspace, card, form.elements.path.value.trim());
        } catch (error) { message.textContent = error.message; }
      });
      renderOverrideRows(list, overrides, workspace, card, form);
      applyDefaults();
    } catch (error) { detail.innerHTML = `<p class="error">${esc(error.message)}</p>`; }
  }

  function renderOverrideRows(list, overrides, workspace, card, form) {
    list.innerHTML = overrides.length ? "" : '<p class="muted-text">No overrides. Workspace role defaults are active.</p>';
    for (const item of overrides) {
      const row = document.createElement("div");
      row.className = "workspace-permission-row";
      row.innerHTML = `<div><strong>${esc(item.path || "/")}</strong><small>${esc(item.role)} · ${esc(permissionSummary(item.permissions))}</small></div><div class="workspace-permission-actions"><button type="button" class="permission-edit">Edit</button><button type="button" class="danger permission-remove">Remove</button></div>`;
      row.querySelector(".permission-edit").addEventListener("click", () => {
        form.elements.role.value = item.role;
        form.elements.path.value = item.path;
        ACTIONS.forEach((action) => { form.elements[action].checked = !!item.permissions[action]; });
        form.scrollIntoView({ behavior:"smooth", block:"nearest" });
      });
      row.querySelector(".permission-remove").addEventListener("click", async () => {
        if (!confirm(`Remove the ${item.role} override for ${item.path || "/"}?`)) return;
        try {
          await api(`/api/workspaces/${encodeURIComponent(workspace.id)}/permission-overrides?path=${encodeURIComponent(item.path)}&role=${encodeURIComponent(item.role)}`, { method:"DELETE" });
          await showPermissionEditor(workspace, card);
        } catch (error) { alert(error.message); }
      });
      list.appendChild(row);
    }
  }

  function openSimplePermissions() {
    switchTab("admin");
    setTimeout(() => document.getElementById("permissions-table")?.closest("details")?.scrollIntoView({ behavior:"smooth", block:"start" }), 50);
  }

  function decorateWorkspaceCards() {
    const cards = [...document.querySelectorAll("#workspace-admin-list .workspace-admin-card")];
    cards.forEach((card, index) => {
      const workspace = state.workspaces[index];
      if (!workspace) return;
      card.dataset.workspaceId = workspace.id;
      const head = card.querySelector(".workspace-admin-head > div");
      if (head && !head.querySelector(".workspace-mode-label")) {
        const note = document.createElement("small");
        note.className = "workspace-mode-label workspace-scope-note";
        note.textContent = workspace.is_main ? "Simple Mode · shared filesystem" : "Workspace Mode · private to members";
        head.appendChild(note);
      }
      const actions = card.querySelector(".workspace-admin-actions");
      if (!actions || actions.querySelector(".workspace-permissions-btn")) return;
      if (workspace.is_main && state.role === "admin") {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "workspace-permissions-btn";
        button.textContent = "Simple permissions";
        button.addEventListener("click", openSimplePermissions);
        actions.appendChild(button);
      } else if (!workspace.is_main && canManage(workspace)) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "workspace-permissions-btn";
        button.textContent = "Permissions";
        button.addEventListener("click", () => showPermissionEditor(workspace, card));
        actions.appendChild(button);
      }
    });
  }

  window.addWorkspacePermissionAction = function(actions, filepath) {
    const workspace = typeof currentWorkspace === "function" ? currentWorkspace() : null;
    if (!workspace || workspace.is_main || !canManage(workspace)) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "icon-btn workspace-file-permission-btn";
    button.textContent = "Access";
    button.title = "Workspace permissions for this path";
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      switchTab("workspaces");
      setTimeout(() => {
        decorateWorkspaceCards();
        const card = findWorkspaceCard(workspace);
        if (card) showPermissionEditor(workspace, card, filepath);
      }, 30);
    });
    actions.appendChild(button);
  };
  function refreshUi() {
    ensureModeCard();
    decorateWorkspaceCards();
    applyWorkspaceModeUi();
  }

  function install() {
    ensureStyles();
    refreshUi();
    const observer = new MutationObserver(() => refreshUi());
    observer.observe(document.body, { childList:true, subtree:true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once:true });
  } else install();
})();

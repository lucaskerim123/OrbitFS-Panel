(() => {
  if (window.__orbitWorkspacePermissionEditorLoaded) return;
  window.__orbitWorkspacePermissionEditorLoaded = true;

  const ACTIONS = ["read", "write", "download", "move", "delete", "create"];
  const ADMIN_ACTIONS = ["view_settings", "edit_settings", "manage_members", "manage_permissions", "send_messages", "use_sorter", "manage_sorter_settings", "delete_workspace"];
  const ADMIN_LABELS = { view_settings:"View workspace settings", edit_settings:"Edit workspace settings", manage_members:"Manage members", manage_permissions:"Manage permissions", send_messages:"Send workspace messages", use_sorter:"Use Sorter", manage_sorter_settings:"Access Sorter settings", delete_workspace:"Delete workspace" };
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
  function canManagePermissions(workspace) {
    return !!workspace && (canManage(workspace) || !!workspace.management_permissions?.manage_permissions);
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
      .workspace-permission-target{display:grid;gap:4px;padding:10px;border:1px solid var(--border);border-radius:10px;background:var(--bg)}
      .workspace-permission-target small{color:var(--muted);overflow-wrap:anywhere}
      .workspace-permission-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
      .workspace-mode-disabled .workspace-create-btn,.workspace-mode-disabled #workspace-page-create,.workspace-mode-disabled #workspace-bar,.workspace-mode-disabled #tab-btn-workspaces,.workspace-mode-disabled #tab-workspaces{display:none!important}
      @media(max-width:650px){.workspace-mode-row{align-items:flex-start;flex-direction:column}.workspace-permission-form .perm-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
    `;
    document.head.appendChild(style);
  }
  function ensureModeCard() {
    if (state.role !== "admin") return;
    const host = document.getElementById("admin-zone-host");
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

    const managerPanel = document.getElementById("tab-workspaces");
    if (!enabled && managerPanel?.classList.contains("active")) switchTab("files");

    const picker = document.getElementById("workspace-select");
    if (picker) {
      for (const option of picker.options) {
        const workspace = state.workspaces.find((item) => String(item.id) === String(option.value));
        if (!workspace?.is_main) {
          const unavailable = workspace?.drive_state === "offline" || (workspace?.status === "suspended" && state.role !== "admin");
          option.hidden = !enabled;
          option.disabled = !enabled || unavailable;
        }
      }
    }
  }

  function permissionSummary(permissions) {
    return ACTIONS.filter((action) => permissions?.[action]).join(", ") || "no access";
  }

  function findWorkspaceCard(workspace) {
    return [...document.querySelectorAll("#workspace-admin-list .workspace-admin-card")]
      .find((card) => card.dataset.workspaceId === String(workspace.id));
  }
  async function showPermissionEditor(workspace, card, initialPath = null, forceOpen = false) {
    if (!workspace || workspace.is_main || !canManagePermissions(workspace)) return;
    if (typeof card.expandWorkspaceCard === "function") card.expandWorkspaceCard();
    const detail = card.querySelector(".workspace-admin-detail");
    const targetPath = initialPath == null
      ? (String(state.workspaceId) === String(workspace.id) ? String(state.subpath || "") : "")
      : String(initialPath || "").replace(/\\/g,"/").replace(/^\/+|\/+$/g,"");
    const combinedView = initialPath == null && canManage(workspace);
    const viewKey = `permissions:${targetPath}:${combinedView ? "combined" : "file"}`;
    if (!forceOpen && detail.dataset.view === viewKey && !detail.classList.contains("hidden")) {
      detail.classList.add("hidden"); detail.innerHTML = ""; delete detail.dataset.view; return;
    }
    detail.dataset.view = viewKey;
    detail.classList.remove("hidden");
    detail.innerHTML = "Loading workspace permissions...";
    try {
      const { overrides } = await api(`/api/workspaces/${encodeURIComponent(workspace.id)}/permission-overrides`);
      const adminResult = combinedView ? await api(`/api/workspaces/${encodeURIComponent(workspace.id)}/admin-permissions`) : null;
      const exact = new Map((overrides || []).filter((item) => String(item.path || "") === targetPath).map((item) => [item.role,item]));
      const protectedSorter = targetPath === "_sorter";
      detail.innerHTML = `
        <div class="workspace-detail-heading"><div><strong>Edit permissions</strong><p class="workspace-scope-note">${protectedSorter ? "Protected sorter inbox - the folder cannot be moved or deleted." : "Change file access or workspace administration."}</p></div><button type="button" class="workspace-detail-close">Hide</button></div>
        ${combinedView ? '<div class="workspace-permission-tabs"><button type="button" class="active" data-permission-view="files">Files & folders</button><button type="button" data-permission-view="administration">Workspace settings</button></div>' : ""}
        <section class="workspace-permission-pane" data-permission-pane="files">
          <div class="workspace-permission-target"><strong>${targetPath ? "Selected path" : "Workspace root"}</strong><small>/${esc(targetPath)}</small></div>
          <form class="workspace-permission-form workspace-file-permission-form">
            <label>Role<select name="role"><option value="editor">Editor</option><option value="contributor">Contributor</option><option value="viewer">Viewer</option></select></label>
            <div class="perm-grid">${ACTIONS.map((action) => `<label class="${protectedSorter && (action === "move" || action === "delete") ? "permission-locked" : ""}"><input type="checkbox" name="${action}" ${protectedSorter && (action === "move" || action === "delete") ? "disabled" : ""}> ${action}</label>`).join("")}</div>
            <div class="workspace-permission-actions"><button type="button" class="permission-role-defaults">Use role defaults</button><button type="submit" class="primary">Save file access</button><button type="button" class="danger permission-remove hidden">Remove override</button></div>
            <p class="workspace-permission-message muted-text"></p>
          </form>
        </section>
        ${combinedView ? `<section class="workspace-permission-pane hidden" data-permission-pane="administration">
          <div class="workspace-permission-target"><strong>Workspace administration</strong><small>Controls who can manage this workspace, separate from file access.</small></div>
          <form class="workspace-permission-form workspace-admin-permission-form">
            <label>Role<select name="role"><option value="editor">Editor</option><option value="contributor">Contributor</option><option value="viewer">Viewer</option></select></label>
            <div class="workspace-admin-permission-grid">${ADMIN_ACTIONS.map(action=>`<label><span><strong>${ADMIN_LABELS[action]}</strong><small>${action.replaceAll("_"," ")}</small></span><input type="checkbox" name="${action}"></label>`).join("")}</div>
            <div class="workspace-permission-actions"><button type="button" class="admin-permission-defaults">Use role defaults</button><button type="submit" class="primary">Save workspace access</button></div>
            <p class="workspace-admin-permission-message muted-text"></p>
          </form>
        </section>` : ""}`;
      detail.querySelector(".workspace-detail-close").addEventListener("click", () => { detail.classList.add("hidden"); detail.innerHTML = ""; delete detail.dataset.view; });
      detail.querySelectorAll("[data-permission-view]").forEach(button=>button.addEventListener("click",()=>{
        detail.querySelectorAll("[data-permission-view]").forEach(item=>item.classList.toggle("active",item===button));
        detail.querySelectorAll("[data-permission-pane]").forEach(pane=>pane.classList.toggle("hidden",pane.dataset.permissionPane!==button.dataset.permissionView));
      }));
      const form = detail.querySelector(".workspace-file-permission-form");
      const message = form.querySelector(".workspace-permission-message");
      const removeButton = form.querySelector(".permission-remove");
      const applyValues = values => ACTIONS.forEach(action => { if (!form.elements[action].disabled) form.elements[action].checked = !!values[action]; });
      const loadRole = () => {
        const existing = exact.get(form.elements.role.value);
        applyValues(existing?.permissions || DEFAULTS[form.elements.role.value]);
        if (protectedSorter) { form.elements.move.checked=false; form.elements.delete.checked=false; }
        removeButton.classList.toggle("hidden", !existing);
        message.textContent = existing ? "Current override loaded for this path." : "Role defaults are shown.";
      };
      form.elements.role.addEventListener("change",loadRole);
      form.querySelector(".permission-role-defaults").addEventListener("click",()=>{applyValues(DEFAULTS[form.elements.role.value]); if(protectedSorter){form.elements.move.checked=false;form.elements.delete.checked=false;} message.textContent="Role defaults loaded.";});
      form.addEventListener("submit",async event=>{event.preventDefault(); const permissions=Object.fromEntries(ACTIONS.map(action=>[action,!!form.elements[action].checked])); try{await api(`/api/workspaces/${encodeURIComponent(workspace.id)}/permission-overrides`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({role:form.elements.role.value,path:targetPath,permissions})}); await showPermissionEditor(workspace,card,initialPath,true);}catch(error){message.textContent=error.message;}});
      removeButton.addEventListener("click",async()=>{const role=form.elements.role.value; try{await api(`/api/workspaces/${encodeURIComponent(workspace.id)}/permission-overrides?path=${encodeURIComponent(targetPath)}&role=${encodeURIComponent(role)}`,{method:"DELETE"}); await showPermissionEditor(workspace,card,initialPath,true);}catch(error){message.textContent=error.message;}});
      loadRole();
      if (combinedView) {
        const adminForm=detail.querySelector(".workspace-admin-permission-form");
        const adminMessage=adminForm.querySelector(".workspace-admin-permission-message");
        const syncSorterPermissionDependency=()=>{const use=adminForm.elements.use_sorter; const settings=adminForm.elements.manage_sorter_settings; if(!use||!settings)return; if(!use.checked) settings.checked=false; settings.disabled=!use.checked;};
        const loadAdminRole=()=>{const role=adminForm.elements.role.value; const values=adminResult.permissions?.[role]||adminResult.defaults?.[role]||{}; ADMIN_ACTIONS.forEach(action=>adminForm.elements[action].checked=!!values[action]); syncSorterPermissionDependency(); adminMessage.textContent="Current workspace administration permissions loaded.";};
        adminForm.elements.role.addEventListener("change",loadAdminRole);
        adminForm.elements.use_sorter?.addEventListener("change",syncSorterPermissionDependency);
        adminForm.elements.manage_sorter_settings?.addEventListener("change",()=>{if(adminForm.elements.manage_sorter_settings.checked) adminForm.elements.use_sorter.checked=true; syncSorterPermissionDependency();});
        adminForm.querySelector(".admin-permission-defaults").addEventListener("click",()=>{const values=adminResult.defaults?.[adminForm.elements.role.value]||{}; ADMIN_ACTIONS.forEach(action=>adminForm.elements[action].checked=!!values[action]); syncSorterPermissionDependency(); adminMessage.textContent="Defaults loaded. Save to apply.";});
        adminForm.addEventListener("submit",async event=>{event.preventDefault(); const permissions=Object.fromEntries(ADMIN_ACTIONS.map(action=>[action,!!adminForm.elements[action].checked])); try{const result=await api(`/api/workspaces/${encodeURIComponent(workspace.id)}/admin-permissions`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({role:adminForm.elements.role.value,permissions})}); adminResult.permissions[adminForm.elements.role.value]=result.permissions; adminMessage.textContent="Workspace permissions saved."; await loadOrbitWorkspaces(workspace.id);}catch(error){adminMessage.textContent=error.message;}});
        loadAdminRole();
      }
    } catch (error) { detail.innerHTML = `<p class="error">${esc(error.message)}</p>`; }
  }

  function openSimplePermissions() {
    switchTab("admin");
    setTimeout(() => document.getElementById("permissions-table")?.closest("details")?.scrollIntoView({ behavior:"smooth", block:"start" }), 50);
  }

  function decorateWorkspaceCards() {
    const cards = [...document.querySelectorAll("#workspace-admin-list .workspace-admin-card")];
    cards.forEach((card) => {
      const workspace = state.workspaces.find(item=>String(item.id)===String(card.dataset.workspaceId));
      if (!workspace) return;
      const actions = card.querySelector(".workspace-admin-actions");
      if (!actions || actions.querySelector(".workspace-permissions-btn")) return;
      if (workspace.is_main && state.role === "admin") {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "workspace-permissions-btn";
        button.textContent = "Permissions";
        button.addEventListener("click", openSimplePermissions);
        actions.appendChild(button);
      } else if (!workspace.is_main && canManagePermissions(workspace)) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "workspace-permissions-btn";
        button.textContent = "Permissions";
        button.addEventListener("click", () => showPermissionEditor(workspace, card, null));
        actions.appendChild(button);
      }
    });
  }

  window.openWorkspacePermissionForPath = function(filepath) {
    const workspace = typeof currentWorkspace === "function" ? currentWorkspace() : null;
    if (!workspace || workspace.is_main || !canManagePermissions(workspace) || !modeEnabled()) return false;
    switchTab("workspaces");
    setTimeout(() => {
      decorateWorkspaceCards();
      const card = findWorkspaceCard(workspace);
      if (card) showPermissionEditor(workspace, card, filepath, true);
    }, 30);
    return true;
  };

  window.addWorkspacePermissionAction = function(actions, filepath) {
    const workspace = typeof currentWorkspace === "function" ? currentWorkspace() : null;
    if (!workspace || workspace.is_main || !canManagePermissions(workspace) || !modeEnabled()) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "icon-btn workspace-file-permission-btn";
    button.textContent = "Access";
    button.title = "Workspace permissions for this path";
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      window.openWorkspacePermissionForPath(filepath);
    });
    actions.appendChild(button);
  };
  window.applyWorkspaceModeUi = applyWorkspaceModeUi;

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

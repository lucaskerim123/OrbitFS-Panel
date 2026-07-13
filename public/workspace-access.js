(() => {
  if (window.__orbitWorkspaceAccessLoaded) return;
  window.__orbitWorkspaceAccessLoaded = true;

  const CONFIG_PATH = "_system/Config/tab-access.json";
  const DEFAULT_TAB_ACCESS = {
    sorter: { owner: true, editor: true, contributor: true, viewer: false },
  };
  let tabAccess = structuredClone(DEFAULT_TAB_ACCESS);
  let currentUser = null;

  const roleInfo = {
    owner: {
      title: "Owner",
      text: "Full workspace control. Can manage members, roles, settings, storage, ownership and all files.",
    },
    editor: {
      title: "Editor",
      text: "Can view, upload, create, edit, move, rename, download and delete files. Cannot manage workspace members, ownership or workspace settings.",
    },
    contributor: {
      title: "Contributor",
      text: "Can view, upload, create, edit, move, rename and download files. Cannot delete files or manage workspace settings and members.",
    },
    viewer: {
      title: "Viewer",
      text: "Read-only access. Can view and download files but cannot upload, edit, move, rename or delete them.",
    },
  };

  function escapeHtml(value) {
    return String(value || "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  function mainWorkspace() {
    return state.workspaces?.find((workspace) => workspace.is_main) || null;
  }

  async function withMainWorkspace(callback) {
    const main = mainWorkspace();
    if (!main) throw new Error("Main Workspace is unavailable");
    const previous = state.workspaceId;
    state.workspaceId = String(main.id);
    try {
      return await callback();
    } finally {
      state.workspaceId = previous;
    }
  }

  async function loadTabAccess() {
    try {
      const result = await withMainWorkspace(() => api(`/api/file?path=${encodeURIComponent(CONFIG_PATH)}`));
      const parsed = JSON.parse(result.content || "{}");
      tabAccess = {
        ...structuredClone(DEFAULT_TAB_ACCESS),
        ...parsed,
        sorter: { ...DEFAULT_TAB_ACCESS.sorter, ...(parsed.sorter || {}) },
      };
    } catch {
      tabAccess = structuredClone(DEFAULT_TAB_ACCESS);
    }
    applyTabAccess();
    renderTabAccessForm();
  }

  async function saveTabAccess(event) {
    event?.preventDefault();
    const form = document.getElementById("tab-access-form");
    const message = document.getElementById("tab-access-message");
    if (!form || state.role !== "admin") return;
    const next = structuredClone(DEFAULT_TAB_ACCESS);
    for (const role of Object.keys(roleInfo)) {
      next.sorter[role] = !!form.elements[`sorter-${role}`]?.checked;
    }
    try {
      await withMainWorkspace(() => api("/api/file", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: CONFIG_PATH, content: JSON.stringify(next, null, 2) }),
      }));
      tabAccess = next;
      if (message) {
        message.className = "muted-text";
        message.textContent = "Tab access saved.";
      }
      applyTabAccess();
    } catch (error) {
      if (message) {
        message.className = "error";
        message.textContent = error.message;
      }
    }
  }

  function workspaceRole() {
    if (state.role === "admin") return "admin";
    return currentWorkspace?.()?.permission || "viewer";
  }

  function applyTabAccess() {
    const button = document.getElementById("tab-btn-sorter");
    const panel = document.getElementById("tab-sorter");
    if (!button) return;
    const role = workspaceRole();
    const allowed = role === "admin" || tabAccess.sorter?.[role] !== false;
    button.dataset.roleAllowed = String(allowed);
    if (!allowed) {
      button.classList.add("restricted-tab-hidden");
      panel?.classList.remove("active");
      if (button.classList.contains("active")) switchTab("files");
    } else {
      button.classList.remove("restricted-tab-hidden");
    }
  }

  function ensureRoleDefinitions() {
    const host = document.getElementById("workspace-manager-host");
    if (!host || document.getElementById("workspace-role-definitions")) return;
    const card = document.createElement("details");
    card.id = "workspace-role-definitions";
    card.className = "card workspace-role-definitions";
    card.open = false;
    card.innerHTML = `
      <summary>Workspace role permissions</summary>
      <div class="workspace-role-grid">
        ${Object.entries(roleInfo).map(([role, info]) => `<article><strong>${escapeHtml(info.title)}</strong><p>${escapeHtml(info.text)}</p></article>`).join("")}
      </div>`;
    host.prepend(card);
  }

  function ensureTabAccessCard() {
    if (state.role !== "admin") return;
    const host = document.getElementById("admin-zone-host") || document.getElementById("workspace-manager-host");
    if (!host || document.getElementById("tab-access-card")) return;
    const card = document.createElement("details");
    card.id = "tab-access-card";
    card.className = "card tab-access-card";
    card.open = false;
    card.innerHTML = `
      <summary>Tab access</summary>
      <p class="muted-text">Admin access is always retained. Restrictions apply according to a user's role in the workspace they currently have open.</p>
      <form id="tab-access-form">
        <div class="tab-access-heading"><strong>Sorter</strong><span>Choose which workspace roles can open the Sorter tab.</span></div>
        <div class="tab-access-role-grid">
          ${Object.keys(roleInfo).map((role) => `<label><input type="checkbox" name="sorter-${role}"> ${roleInfo[role].title}</label>`).join("")}
        </div>
        <button type="submit" class="primary">Save tab access</button>
        <p id="tab-access-message" class="muted-text"></p>
      </form>`;
    host.prepend(card);
    document.getElementById("tab-access-form").addEventListener("submit", saveTabAccess);
    renderTabAccessForm();
  }

  function renderTabAccessForm() {
    const form = document.getElementById("tab-access-form");
    if (!form) return;
    for (const role of Object.keys(roleInfo)) {
      const input = form.elements[`sorter-${role}`];
      if (input) input.checked = tabAccess.sorter?.[role] !== false;
    }
  }

  async function getCurrentUser() {
    if (currentUser) return currentUser;
    const result = await api("/api/me");
    currentUser = result.user;
    return currentUser;
  }

  async function leaveWorkspace(workspace) {
    if (!workspace || workspace.is_main || workspace.permission === "owner") return;
    if (!confirm(`Leave workspace “${workspace.name}”? You will lose access until invited again.`)) return;
    try {
      const user = await getCurrentUser();
      if (!user?.id) throw new Error("Current user ID is unavailable");
      await api(`/api/workspaces/${encodeURIComponent(workspace.id)}/members/${encodeURIComponent(user.id)}`, { method: "DELETE" });
      const main = mainWorkspace();
      await loadOrbitWorkspaces(main?.id || "");
      if (main) await activateWorkspace(main.id, { openFiles: false });
      switchTab("workspaces");
    } catch (error) {
      alert(error.message);
    }
  }

  function attachLeaveButtons() {
    const list = document.getElementById("workspace-admin-list");
    if (!list || !state.workspaces?.length) return;
    const cards = [...list.querySelectorAll(".workspace-admin-card")];
    cards.forEach((card, index) => {
      const workspace = state.workspaces[index];
      if (!workspace || workspace.is_main || workspace.permission === "owner") return;
      const actions = card.querySelector(".workspace-admin-actions");
      if (!actions || actions.querySelector(".workspace-leave-btn")) return;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "workspace-leave-btn danger";
      button.textContent = "Leave workspace";
      button.addEventListener("click", () => leaveWorkspace(workspace));
      actions.appendChild(button);
    });
  }

  function injectStyles() {
    if (document.getElementById("workspace-access-style")) return;
    const style = document.createElement("style");
    style.id = "workspace-access-style";
    style.textContent = `
      .restricted-tab-hidden{display:none!important}
      .workspace-role-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:12px}
      .workspace-role-grid article{padding:12px;border:1px solid var(--border,#30384a);border-radius:10px;background:rgba(0,0,0,.12)}
      .workspace-role-grid p{margin:6px 0 0;color:var(--muted,#9aa3b2);font-size:13px;line-height:1.45}
      .tab-access-heading{display:grid;gap:3px;margin:10px 0}.tab-access-heading span{color:var(--muted,#9aa3b2);font-size:13px}
      .tab-access-role-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:10px 0 12px}
      .tab-access-role-grid label{display:flex;align-items:center;gap:8px;padding:10px;border:1px solid var(--border,#30384a);border-radius:9px}
      .workspace-leave-btn{margin-left:auto}
      @media(max-width:650px){.workspace-role-grid,.tab-access-role-grid{grid-template-columns:1fr}}
    `;
    document.head.appendChild(style);
  }

  function install() {
    injectStyles();
    ensureRoleDefinitions();
    ensureTabAccessCard();
    loadTabAccess();

    const observer = new MutationObserver(() => {
      ensureRoleDefinitions();
      ensureTabAccessCard();
      attachLeaveButtons();
      applyTabAccess();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    document.querySelectorAll(".tab-btn").forEach((button) => {
      button.addEventListener("click", () => setTimeout(applyTabAccess, 0));
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
})();
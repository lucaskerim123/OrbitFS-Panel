(() => {
  if (window.__orbitWorkspaceExtrasLoaded) return;
  window.__orbitWorkspaceExtrasLoaded = true;

  const ROLE_DETAILS = [
    {
      role: "Viewer",
      summary: "Read-only access",
      permissions: "Can open, preview and download files. Cannot upload, create, edit, rename, move or delete anything.",
    },
    {
      role: "Contributor",
      summary: "Add and update content",
      permissions: "Can upload, create folders, edit files, rename and move items. Cannot delete files or manage members and workspace settings.",
    },
    {
      role: "Editor",
      summary: "Full file control",
      permissions: "Can upload, create, edit, download, rename, move and delete files. Cannot manage members, ownership, workspace settings or delete the workspace.",
    },
    {
      role: "Owner",
      summary: "Full workspace control",
      permissions: "Has full file control and can manage members, roles, workspace settings, ownership, storage controls and workspace deletion.",
    },
  ];

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[char]);
  }

  function ensureRoleGuide() {
    const host = document.getElementById("workspace-manager-host");
    if (!host || document.getElementById("workspace-role-guide")) return;
    const card = document.createElement("details");
    card.id = "workspace-role-guide";
    card.className = "card workspace-role-guide";
    card.open = false;
    card.innerHTML = `
      <summary>Workspace role permissions</summary>
      <div class="workspace-role-grid">
        ${ROLE_DETAILS.map((item) => `
          <article class="workspace-role-item">
            <div><strong>${escapeHtml(item.role)}</strong><span>${escapeHtml(item.summary)}</span></div>
            <p>${escapeHtml(item.permissions)}</p>
          </article>`).join("")}
      </div>`;
    host.prepend(card);
  }

  function addRoleHints() {
    document.querySelectorAll('.workspace-member-form select[name="permission"],.workspace-member-role').forEach((select) => {
      if (select.dataset.roleHintWired) return;
      select.dataset.roleHintWired = "1";
      select.title = "Viewer: read/download only. Contributor: edit/upload/move but no delete. Editor: full file control.";
    });
  }

  async function leaveWorkspace(workspace) {
    if (!workspace || workspace.is_main || workspace.permission === "owner") return;
    if (!confirm(`Leave workspace "${workspace.name}"? You will lose access unless invited again.`)) return;
    try {
      await api(`/api/workspaces/${encodeURIComponent(workspace.id)}/leave`, { method: "DELETE" });
      if (String(state.workspaceId) === String(workspace.id)) {
        state.workspaceId = "";
        localStorage.removeItem("panelWorkspaceId");
      }
      await loadOrbitWorkspaces();
      if (typeof loadFiles === "function") await loadFiles();
    } catch (error) {
      alert(error.message);
    }
  }

  function addLeaveButtons() {
    const cards = [...document.querySelectorAll(".workspace-admin-card")];
    for (const card of cards) {
      if (card.querySelector(".workspace-leave-btn")) continue;
      const title = card.querySelector(".workspace-admin-head strong")?.textContent?.trim();
      const workspace = state.workspaces.find((item) => item.name === title);
      if (!workspace || workspace.is_main || workspace.permission === "owner") continue;
      const actions = card.querySelector(".workspace-admin-actions");
      if (!actions) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "danger workspace-leave-btn";
      button.textContent = "Leave workspace";
      button.addEventListener("click", () => leaveWorkspace(workspace));
      actions.appendChild(button);
    }
  }

  function installStyles() {
    const style = document.createElement("style");
    style.textContent = `
      .workspace-role-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:12px}
      .workspace-role-item{padding:12px;border:1px solid var(--border,#30384a);border-radius:10px;background:rgba(255,255,255,.025)}
      .workspace-role-item>div{display:flex;justify-content:space-between;gap:8px;align-items:start}
      .workspace-role-item span{font-size:12px;color:var(--muted,#9aa3b2);text-align:right}
      .workspace-role-item p{margin:8px 0 0;font-size:13px;line-height:1.45;color:var(--muted,#b2bbca)}
      @media(max-width:650px){.workspace-role-grid{grid-template-columns:1fr}.workspace-role-item>div{display:grid}.workspace-role-item span{text-align:left}}
    `;
    document.head.appendChild(style);
  }

  function refreshWorkspaceExtras() {
    ensureRoleGuide();
    addRoleHints();
    addLeaveButtons();
  }
  window.refreshWorkspaceExtras = refreshWorkspaceExtras;

  function install() {
    installStyles();
    refreshWorkspaceExtras();
    const observer = new MutationObserver(refreshWorkspaceExtras);
    const host = document.getElementById("tab-workspaces") || document.body;
    observer.observe(host, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
})();
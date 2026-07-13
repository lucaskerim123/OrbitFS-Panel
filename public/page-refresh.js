(() => {
  if (window.__orbitPageRefreshLoaded) return;
  window.__orbitPageRefreshLoaded = true;

  const pageRefreshers = {
    files: async () => {
      if (typeof loadFiles === "function") await loadFiles();
      if (typeof refreshStatus === "function") await refreshStatus();
    },
    workspaces: async () => {
      if (typeof loadOrbitWorkspaces === "function") await loadOrbitWorkspaces(state.workspaceId);
    },
    account: async () => {
      if (typeof loadAccountPanel === "function") await loadAccountPanel();
    },
    sorter: async () => {
      if (typeof sorterLoad === "function") await sorterLoad();
    },
    system: async () => {
      if (typeof loadSystem === "function") await loadSystem();
    },
    admin: async () => {
      if (typeof loadSystem === "function") await loadSystem();
      if (typeof loadOrbitWorkspaces === "function") await loadOrbitWorkspaces(state.workspaceId);
    },
  };

  function makeRefreshButton(tabName) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "page-refresh-btn";
    button.dataset.refreshTab = tabName;
    button.innerHTML = '<span aria-hidden="true">⟳</span> Refresh';
    button.addEventListener("click", async () => {
      if (button.disabled) return;
      button.disabled = true;
      button.classList.add("refreshing");
      const original = button.innerHTML;
      button.innerHTML = '<span aria-hidden="true">⟳</span> Refreshing…';
      try {
        await pageRefreshers[tabName]?.();
      } catch (error) {
        console.error(`Failed to refresh ${tabName}`, error);
      } finally {
        button.innerHTML = original;
        button.classList.remove("refreshing");
        button.disabled = false;
      }
    });
    return button;
  }

  function addToHeader(tabName, selector) {
    const panel = document.getElementById(`tab-${tabName}`);
    const header = panel?.querySelector(selector);
    if (!header || header.querySelector(`[data-refresh-tab="${tabName}"]`)) return;
    header.appendChild(makeRefreshButton(tabName));
  }

  function installFilesRefresh() {
    const panel = document.getElementById("tab-files");
    const toolbar = panel?.querySelector(".toolbar:first-of-type");
    if (!toolbar || toolbar.querySelector('[data-refresh-tab="files"]')) return;
    toolbar.appendChild(makeRefreshButton("files"));
  }

  function hideDuplicateBuiltInRefreshes() {
    const systemBuiltIn = document.getElementById("system-refresh-btn");
    const adminBuiltIn = document.getElementById("admin-refresh-btn");
    if (systemBuiltIn) systemBuiltIn.classList.add("page-refresh-btn");
    if (adminBuiltIn) adminBuiltIn.classList.add("page-refresh-btn");
  }

  function install() {
    installFilesRefresh();
    addToHeader("workspaces", ".workspace-page-header");
    addToHeader("account", ".workspace-page-header");
    hideDuplicateBuiltInRefreshes();

    const style = document.createElement("style");
    style.textContent = `
      .page-refresh-btn{margin-left:auto;display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:40px;white-space:nowrap}
      .page-refresh-btn.refreshing span{display:inline-block;animation:orbit-refresh-spin .8s linear infinite}
      #tab-files>.toolbar:first-of-type{display:flex;align-items:center;gap:10px}
      #tab-files>.toolbar:first-of-type .breadcrumb{min-width:0;flex:1}
      @keyframes orbit-refresh-spin{to{transform:rotate(360deg)}}
      @media(max-width:600px){
        .workspace-page-header{align-items:flex-start;gap:8px}
        .workspace-page-header .page-refresh-btn{flex:0 0 auto;min-height:38px;padding:8px 10px}
        #tab-files>.toolbar:first-of-type .page-refresh-btn{min-height:38px;padding:8px 10px}
      }
    `;
    document.head.appendChild(style);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
})();
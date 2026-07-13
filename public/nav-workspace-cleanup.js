(() => {
  if (window.__orbitNavWorkspaceCleanupLoaded) return;
  window.__orbitNavWorkspaceCleanupLoaded = true;

  const q = (selector, root = document) => root.querySelector(selector);
  const qa = (selector, root = document) => [...root.querySelectorAll(selector)];

  function activeTab() {
    return q(".tab-btn.active")?.dataset?.tab || "files";
  }

  function renameTabs() {
    const system = q('.tab-btn[data-tab="system"]');
    const config = q('.tab-btn[data-tab="config"]');
    const admin = q('.tab-btn[data-tab="admin"]');
    if (system) system.textContent = "Systems";
    if (config) config.textContent = "Config";
    if (admin) admin.textContent = "Admin";

    const systemTitle = q("#tab-system .sys-title");
    const configTitle = q("#tab-config .sys-title");
    const adminTitle = q("#tab-admin .sys-title");
    if (systemTitle) systemTitle.textContent = "Systems";
    if (configTitle) configTitle.textContent = "Config";
    if (adminTitle) adminTitle.textContent = "Admin";
  }

  function removeSystemWorkspaceStorage() {
    q("#workspace-system-storage")?.remove();
    const system = q("#tab-system");
    if (!system) return;

    qa("details.card,article.card,section.card,.card,.infra-item", system).forEach((item) => {
      const heading = q("summary,h2,h3,strong,.infra-name,span:first-child", item)?.textContent?.trim().toLowerCase() || "";
      if (heading === "workspace storage" || heading === "workspace usage" || heading === "workspace disk usage") {
        item.remove();
      }
    });
  }

  function syncWorkspaceSelector() {
    const bar = q("#workspace-bar");
    if (!bar) return;
    bar.classList.toggle("workspace-selector-hidden", activeTab() !== "files");
    bar.classList.add("workspace-selector-compact");
  }

  function apply() {
    renameTabs();
    removeSystemWorkspaceStorage();
    syncWorkspaceSelector();
  }

  function install() {
    const style = document.createElement("style");
    style.textContent = `
      #workspace-bar.workspace-selector-hidden{display:none!important}
      #workspace-bar.workspace-selector-compact{padding:6px 8px!important;margin:4px 0 8px!important;min-height:0!important;gap:6px!important}
      #workspace-bar.workspace-selector-compact select{min-height:34px!important;height:34px!important;padding:4px 28px 4px 8px!important;font-size:13px!important}
      #workspace-bar.workspace-selector-compact button{min-height:34px!important;height:34px!important;padding:4px 9px!important;font-size:12px!important}
      #workspace-bar.workspace-selector-compact .workspace-meta,
      #workspace-bar.workspace-selector-compact .workspace-storage,
      #workspace-bar.workspace-selector-compact .workspace-description{display:none!important}
      #tab-system #workspace-system-storage{display:none!important}
      @media(max-width:600px){
        #workspace-bar.workspace-selector-compact{display:flex;flex-wrap:nowrap;align-items:center;overflow:hidden}
        #workspace-bar.workspace-selector-compact select{min-width:0;flex:1}
      }
    `;
    document.head.appendChild(style);

    apply();
    qa(".tab-btn").forEach((button) => {
      if (button.dataset.workspaceCleanupWired) return;
      button.dataset.workspaceCleanupWired = "1";
      button.addEventListener("click", () => requestAnimationFrame(apply));
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
})();
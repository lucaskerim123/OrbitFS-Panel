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
    if (system) system.textContent = "\u{1F5A5}\uFE0F Systems";
    if (config) config.textContent = "\u2699\uFE0F Config";
    if (admin) admin.textContent = "\u{1F6E1}\uFE0F Admin";

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
      if (["workspace storage", "workspace usage", "workspace disk usage"].includes(heading)) item.remove();
    });
  }

  function compactWorkspaceBar(bar) {
    bar.classList.add("workspace-selector-compact");

    qa("button", bar).forEach((button) => {
      const text = button.textContent.trim().toLowerCase();
      button.classList.toggle("workspace-mobile-extra", text.includes("workspace"));
    });

    qa("h1,h2,h3,h4,label,strong,span,p,small,div", bar).forEach((item) => {
      if (item.querySelector("select") || item.closest("button")) return;
      const text = item.textContent.replace(/\s+/g, " ").trim().toLowerCase();
      if (text === "workspace" || text.includes(" used") || text.includes("unlimited")) {
        item.classList.add("workspace-mobile-extra");
      }
    });
  }

  function syncWorkspaceSelector() {
    const bar = q("#workspace-bar");
    const nav = q("nav.tabs");
    if (!bar) return;

    bar.classList.toggle("workspace-selector-hidden", activeTab() !== "files");
    compactWorkspaceBar(bar);

    if (nav && bar.parentElement === nav.parentElement && nav.nextElementSibling !== bar) {
      bar.parentElement.insertBefore(nav, bar);
    }
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
      #tab-system #workspace-system-storage{display:none!important}

      @media(max-width:700px){
        nav.tabs{margin:2px 0 8px!important;border-bottom:1px solid var(--border,#2a2f3a)}
        #workspace-bar.workspace-selector-compact{
          display:flex!important;
          align-items:center!important;
          gap:6px!important;
          min-height:46px!important;
          padding:6px!important;
          margin:0 0 10px!important;
          border-radius:12px!important;
          overflow:hidden!important;
        }
        #workspace-bar.workspace-selector-hidden{display:none!important}
        #workspace-bar.workspace-selector-compact .workspace-mobile-extra,
        #workspace-bar.workspace-selector-compact .workspace-meta,
        #workspace-bar.workspace-selector-compact .workspace-storage,
        #workspace-bar.workspace-selector-compact .workspace-description{display:none!important}
        #workspace-bar.workspace-selector-compact select{
          flex:1 1 auto!important;
          width:100%!important;
          min-width:0!important;
          max-width:none!important;
          min-height:34px!important;
          height:34px!important;
          padding:4px 30px 4px 10px!important;
          font-size:13px!important;
          border-radius:9px!important;
        }
        #workspace-bar.workspace-selector-compact button:not(.workspace-mobile-extra){
          flex:0 0 auto!important;
          min-height:34px!important;
          height:34px!important;
          padding:4px 8px!important;
          font-size:12px!important;
        }
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
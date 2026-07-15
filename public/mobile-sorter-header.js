(() => {
  if (window.__orbitMobileSorterHeaderLoaded) return;
  window.__orbitMobileSorterHeaderLoaded = true;

  let checking = false;
  let lastOnline = false;
  let lastAllowed = false;

  function ensureButton() {
    const statusArea = document.querySelector("header .status-pills");
    const hive = document.getElementById("status-hive");
    if (!statusArea || !hive) return null;
    let button = document.getElementById("status-sorter");
    if (!button) {
      button = document.createElement("button");
      button.id = "status-sorter";
      button.type = "button";
      button.className = "pill status-sorter-button hidden";
      button.textContent = "Sorter";
      button.setAttribute("aria-label", "Open Sorter");
      hive.insertAdjacentElement("afterend", button);
      button.addEventListener("click", () => {
        if (!lastOnline || !lastAllowed) return;
        if (typeof switchTab === "function") switchTab("sorter");
      });
    }
    return button;
  }

  function renderButton() {
    const button = ensureButton();
    if (!button) return;
    const visible = lastOnline && lastAllowed;
    button.classList.toggle("hidden", !visible);
    button.classList.toggle("ok", visible);
    button.classList.remove("down", "unknown");
  }

  async function refreshSorterHeader() {
    if (checking || !state?.token) return;
    checking = true;
    try {
      const [status, access] = await Promise.all([
        api("/api/status"),
        api("/api/sorter-access"),
      ]);
      lastOnline = status?.sorter?.ok === true;
      lastAllowed = access?.useSorter === true;
      state.sorterAccess = access || { useSorter:false, accessSorterSettings:false };
      if ((!lastOnline || !lastAllowed) && document.getElementById("tab-sorter")?.classList.contains("active")) switchTab("files");
    } catch {
      lastOnline = false;
      lastAllowed = false;
    } finally {
      checking = false;
      renderButton();
      if (typeof refreshSorterAccessUi === "function") refreshSorterAccessUi();
    }
  }

  function installStyles() {
    const style = document.createElement("style");
    style.id = "orbit-mobile-first-navigation";
    style.textContent = `
      #status-sorter:not(.hidden){display:inline-flex!important;align-items:center;justify-content:center}
      header{gap:7px;padding-left:10px;padding-right:10px}
      header .header-title{flex:1;min-width:0;overflow:hidden}
      header .header-title h1{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      header .status-pills{display:flex;align-items:center;gap:5px;flex:0 0 auto}
      #status-hive,#status-sorter{min-height:34px;height:34px;padding:5px 9px;font-size:12px;white-space:nowrap}
      nav.tabs{display:grid!important;grid-template-columns:repeat(auto-fit,minmax(84px,1fr));gap:5px;overflow:visible;padding:5px 7px;border-bottom:1px solid var(--border)}
      nav.tabs .tab-btn{width:100%;min-width:0;min-height:39px;padding:7px 5px;font-size:12px;line-height:1.15;white-space:normal;border-radius:7px;border-bottom:2px solid transparent}
      nav.tabs .tab-btn.active{background:color-mix(in srgb,var(--accent) 10%,transparent);border-bottom-color:var(--accent)}
      @media(max-width:420px){
        header{padding-top:9px;padding-bottom:6px}
        header .brand-mark.small{font-size:16px}
        header .header-title h1{font-size:14px}
        #status-hive,#status-sorter{height:32px;min-height:32px;padding:4px 7px;font-size:11px}
        nav.tabs{grid-template-columns:repeat(3,minmax(0,1fr));gap:4px;padding:4px 6px}
        nav.tabs .tab-btn{min-height:38px;padding:6px 3px;font-size:11px}
      }
      @media(max-width:330px){nav.tabs{grid-template-columns:repeat(2,minmax(0,1fr))}}
      #tab-system .sys-header,#tab-config .sys-header,#tab-admin .sys-header{display:flex;align-items:flex-start;gap:8px}
      #tab-system .sys-header-text,#tab-config .sys-header-text,#tab-admin .sys-header-text{min-width:0;flex:1}
      #tab-system .sys-title,#tab-config .sys-title,#tab-admin .sys-title{font-size:20px;margin:0}
      #tab-system .sys-subtitle,#tab-config .sys-subtitle,#tab-admin .sys-subtitle{font-size:12px;line-height:1.35;margin-top:3px}
      #tab-system .sys-refresh-btn,#tab-config .sys-refresh-btn,#tab-admin .sys-refresh-btn{flex:0 0 auto;min-height:36px;padding:7px 9px;font-size:12px}
    `;
    document.head.appendChild(style);
  }

  function install() {
    installStyles();
    ensureButton();
    refreshSorterHeader();
    document.getElementById("status-hive")?.addEventListener("click", () => setTimeout(refreshSorterHeader, 0));
    document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshSorterHeader(); });
    window.addEventListener("focus", refreshSorterHeader);
    setInterval(refreshSorterHeader, 30000);
  }

  window.refreshSorterHeader = refreshSorterHeader;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
})();

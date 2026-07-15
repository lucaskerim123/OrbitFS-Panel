(() => {
  if (window.__orbitMobileSorterHeaderLoaded) return;
  window.__orbitMobileSorterHeaderLoaded = true;

  let checking = false;
  let lastOnline = false;

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
        if (!lastOnline) return;
        if (typeof switchTab === "function") switchTab("sorter");
      });
    }
    return button;
  }

  function showOnline(online) {
    lastOnline = !!online;
    const button = ensureButton();
    if (!button) return;
    button.classList.toggle("hidden", !online);
    button.classList.toggle("ok", !!online);
    button.classList.remove("down", "unknown");
  }

  async function refreshSorterHeader() {
    if (checking || !state?.token) return;
    checking = true;
    try {
      const status = await api("/api/status");
      showOnline(status?.sorter?.ok === true);
    } catch {
      showOnline(false);
    } finally {
      checking = false;
    }
  }

  function installStyles() {
    const style = document.createElement("style");
    style.textContent = `
      #status-sorter{cursor:pointer;display:none}
      @media(max-width:700px),(orientation:landscape) and (max-height:600px) and (hover:none) and (pointer:coarse){
        #status-sorter:not(.hidden){display:inline-flex!important;align-items:center;justify-content:center}
        header{gap:8px}
        header .status-pills{display:flex;align-items:center;gap:6px;flex:0 0 auto}
        #status-hive,#status-sorter{min-height:34px;height:34px;padding:5px 9px;font-size:12px}
        nav.tabs{display:flex!important;gap:6px;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;padding-bottom:3px;overscroll-behavior-x:contain;-webkit-overflow-scrolling:touch}
        nav.tabs::-webkit-scrollbar{display:none}
        nav.tabs .tab-btn{flex:0 0 auto;min-width:auto;min-height:38px;padding:7px 10px;font-size:12px;white-space:nowrap}
        nav.tabs #tab-btn-sorter{display:none!important}
        #tab-system .sys-header,#tab-config .sys-header,#tab-admin .sys-header{display:flex;align-items:flex-start;gap:8px}
        #tab-system .sys-header-text,#tab-config .sys-header-text,#tab-admin .sys-header-text{min-width:0;flex:1}
        #tab-system .sys-title,#tab-config .sys-title,#tab-admin .sys-title{font-size:20px;margin:0}
        #tab-system .sys-subtitle,#tab-config .sys-subtitle,#tab-admin .sys-subtitle{font-size:12px;line-height:1.35;margin-top:3px}
        #tab-system .sys-refresh-btn,#tab-config .sys-refresh-btn,#tab-admin .sys-refresh-btn{flex:0 0 auto;min-height:36px;padding:7px 9px;font-size:12px}
      }
    `;
    document.head.appendChild(style);
  }

  function install() {
    installStyles();
    ensureButton();
    refreshSorterHeader();

    document.getElementById("status-hive")?.addEventListener("click", () => setTimeout(refreshSorterHeader, 0));
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) refreshSorterHeader();
    });
    window.addEventListener("focus", refreshSorterHeader);
    setInterval(refreshSorterHeader, 30000);
  }

  window.refreshSorterHeader = refreshSorterHeader;

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
})();
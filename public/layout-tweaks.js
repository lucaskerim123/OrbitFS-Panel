(() => {
  if (window.__orbitLayoutTweaksLoaded) return;
  window.__orbitLayoutTweaksLoaded = true;

  function loadScriptOnce(src, marker) {
    if (document.querySelector(`script[${marker}="1"]`)) return;
    const script = document.createElement("script");
    script.src = src;
    script.async = false;
    script.setAttribute(marker, "1");
    document.body.appendChild(script);
  }

  function install() {
    loadScriptOnce("drive-upload.js?v=20260715-silentreconnect", "data-orbit-drive-upload");
    loadScriptOnce("page-refresh.js", "data-orbit-page-refresh");
    loadScriptOnce("stable-admin-layout.js?v=20260715-addons4", "data-orbit-stable-admin-layout");
    loadScriptOnce("nav-workspace-cleanup.js?v=20260715-notifications", "data-orbit-nav-workspace-cleanup");
    loadScriptOnce("mobile-sorter-header.js?v=20260715-addons2", "data-orbit-mobile-sorter-header");
    loadScriptOnce("addon-manager.js?v=20260716-config", "data-orbit-addon-manager");
    loadScriptOnce("maintenance-banner.js?v=20260715-final", "data-orbit-maintenance-banner");
    loadScriptOnce("sorter-settings-ui.js?v=20260715-addons2", "data-orbit-sorter-settings-ui");
    loadScriptOnce("startup-config-cleanup.js", "data-orbit-startup-config-cleanup");
    loadScriptOnce("hive-health-ui.js", "data-orbit-hive-health-ui");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
})();
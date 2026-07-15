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
    loadScriptOnce("drive-upload.js", "data-orbit-drive-upload");
    loadScriptOnce("page-refresh.js", "data-orbit-page-refresh");
    loadScriptOnce("stable-admin-layout.js?v=20260715-notifications", "data-orbit-stable-admin-layout");
    loadScriptOnce("nav-workspace-cleanup.js?v=20260715-notifications", "data-orbit-nav-workspace-cleanup");
    loadScriptOnce("mobile-sorter-header.js", "data-orbit-mobile-sorter-header");
    loadScriptOnce("workspace-permission-editor.js?v=20260715-notifications", "data-orbit-workspace-permission-editor");
    loadScriptOnce("sorter-settings-ui.js", "data-orbit-sorter-settings-ui");
    loadScriptOnce("startup-config-cleanup.js", "data-orbit-startup-config-cleanup");
    loadScriptOnce("hive-health-ui.js", "data-orbit-hive-health-ui");
    loadScriptOnce("notification-center.js?v=20260715-source", "data-orbit-notification-center");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
})();
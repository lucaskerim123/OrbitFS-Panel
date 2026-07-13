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
    loadScriptOnce("stable-admin-layout.js", "data-orbit-stable-admin-layout");
    loadScriptOnce("nav-workspace-cleanup.js", "data-orbit-nav-workspace-cleanup");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
})();
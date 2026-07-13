(() => {
  if (window.__orbitLayoutTweaksLoaded) return;
  window.__orbitLayoutTweaksLoaded = true;

  function activeTabName() {
    return document.querySelector(".tab-btn.active")?.dataset?.tab || "files";
  }

  function syncWorkspaceBarVisibility() {
    const bar = document.getElementById("workspace-bar");
    if (!bar) return;
    bar.classList.toggle("hidden", activeTabName() !== "files");
  }

  function groupSystemMonitorAndControls() {
    const system = document.getElementById("tab-system");
    const telemetryZone = system?.querySelector(".sys-zone-telemetry");
    const controlsZone = system?.querySelector(".sys-zone-controls");
    if (!telemetryZone || !controlsZone) return;

    const serverControls = [...controlsZone.querySelectorAll("details.card")]
      .find((card) => card.querySelector("summary")?.textContent.trim() === "Server controls");
    if (!serverControls) return;

    serverControls.classList.add("system-server-controls-inline");
    telemetryZone.appendChild(serverControls);
  }

  function install() {
    groupSystemMonitorAndControls();
    syncWorkspaceBarVisibility();

    document.querySelectorAll(".tab-btn").forEach((button) => {
      button.addEventListener("click", () => requestAnimationFrame(syncWorkspaceBarVisibility));
    });

    const observer = new MutationObserver(() => {
      syncWorkspaceBarVisibility();
      groupSystemMonitorAndControls();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    const style = document.createElement("style");
    style.textContent = `
      #workspace-bar.hidden{display:none!important}
      .sys-zone-telemetry>.system-server-controls-inline{margin-top:12px}
      .sys-zone-controls:empty{display:none}
    `;
    document.head.appendChild(style);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
})();
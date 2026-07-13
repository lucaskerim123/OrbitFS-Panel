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

  function keepSingleStartupControl() {
    const system = document.getElementById("tab-system");
    if (!system) return;

    const forms = [...document.querySelectorAll('[id="startup-config-form"]')];
    if (!forms.length) return;

    let keep = forms.find((form) => system.contains(form)) || forms[0];
    const keepCard = keep.closest(".card, details, .sys-zone") || keep.parentElement;

    if (!system.contains(keepCard)) {
      const controlsZone = system.querySelector(".sys-zone-controls") || system;
      controlsZone.appendChild(keepCard);
    }

    for (const form of forms) {
      if (form === keep) continue;
      const duplicateCard = form.closest(".card, details") || form.parentElement;
      duplicateCard?.remove();
    }

    const pickers = [...document.querySelectorAll('[id="startup-picker-shell"], [id="startup-picker"]')];
    let keptPicker = null;
    for (const picker of pickers) {
      if (keepCard?.contains(picker) && !keptPicker) {
        keptPicker = picker;
        continue;
      }
      if (picker !== keptPicker) picker.remove();
    }
  }

  function loadScriptOnce(src, marker) {
    if (document.querySelector(`script[${marker}="1"]`)) return;
    const script = document.createElement("script");
    script.src = src;
    script.async = false;
    script.setAttribute(marker, "1");
    document.body.appendChild(script);
  }

  function install() {
    groupSystemMonitorAndControls();
    keepSingleStartupControl();
    syncWorkspaceBarVisibility();
    loadScriptOnce("drive-upload.js", "data-orbit-drive-upload");
    loadScriptOnce("page-refresh.js", "data-orbit-page-refresh");

    document.querySelectorAll(".tab-btn").forEach((button) => {
      button.addEventListener("click", () => requestAnimationFrame(() => {
        syncWorkspaceBarVisibility();
        keepSingleStartupControl();
      }));
    });

    const observer = new MutationObserver(() => {
      syncWorkspaceBarVisibility();
      groupSystemMonitorAndControls();
      keepSingleStartupControl();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    const style = document.createElement("style");
    style.textContent = `
      #workspace-bar.hidden{display:none!important}
      .sys-zone-telemetry>.system-server-controls-inline{margin-top:12px}
      .sys-zone-controls:empty{display:none}
      #tab-admin [id="startup-config-form"],#tab-admin [id="startup-picker-shell"],#tab-admin [id="startup-picker"]{display:none!important}
    `;
    document.head.appendChild(style);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
})();
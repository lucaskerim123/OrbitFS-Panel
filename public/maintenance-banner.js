(() => {
  if (window.__orbitMaintenanceBannerLoaded) return;
  window.__orbitMaintenanceBannerLoaded = true;

  const DEFAULT_MESSAGE = "OrbitFS is in maintenance mode while Main Workspace files are being changed. Do not edit or upload files. Data changed during maintenance may be lost; OrbitFS is not responsible for changes made while this warning is active.";
  let pollTimer = null;

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;",
    })[char]);
  }

  function ensureStyles() {
    if (document.querySelector('link[data-orbit-maintenance-style="1"]')) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "maintenance-banner.css?v=20260715-maintenance";
    link.dataset.orbitMaintenanceStyle = "1";
    document.head.appendChild(link);
  }

  function ensureBanner() {
    let banner = document.getElementById("orbit-maintenance-banner");
    if (banner) return banner;
    banner = document.createElement("section");    banner.id = "orbit-maintenance-banner";
    banner.className = "orbit-maintenance-banner hidden";
    banner.setAttribute("role", "alert");
    document.getElementById("current-user")?.insertAdjacentElement("afterend", banner);
    return banner;
  }

  function ensureAdminControl() {
    if (state.role !== "admin") return null;
    const system = document.getElementById("tab-system");
    if (!system) return null;
    let card = document.getElementById("maintenance-control-card");
    if (card) return card;
    card = document.createElement("details");
    card.id = "maintenance-control-card";
    card.className = "card maintenance-control-card";
    card.innerHTML = `
      <summary>Maintenance mode</summary>
      <p class="muted-text">Shows a large warning to every signed-in user while Main Workspace files are being changed.</p>
      <form id="maintenance-control-form">
        <label class="maintenance-toggle"><span><strong>Maintenance banner</strong><small>Advisory only. It does not block uploads or edits.</small></span><input name="enabled" type="checkbox"></label>
        <label>Banner message<textarea name="message" rows="4" maxlength="2000"></textarea></label>
        <button type="submit" class="primary">Save maintenance mode</button>
        <p class="maintenance-control-message muted-text"></p>
      </form>`;
    const serverControls = [...system.querySelectorAll("details.card")].find((item) => item.querySelector("summary")?.textContent.trim() === "Server controls");
    if (serverControls) serverControls.insertAdjacentElement("afterend", card);
    else system.querySelector(".sys-header")?.insertAdjacentElement("afterend", card);    card.querySelector("form").addEventListener("submit", saveMaintenance);
    return card;
  }

  function render(status) {
    ensureStyles();
    const banner = ensureBanner();
    document.body.classList.toggle("orbit-maintenance-active", !!status.enabled);
    banner.classList.toggle("hidden", !status.enabled);
    if (status.enabled) {
      banner.innerHTML = `<div class="orbit-maintenance-icon" aria-hidden="true">!</div><div class="orbit-maintenance-copy"><span>MAINTENANCE MODE</span><strong>Main Workspace files are being changed</strong><p>${esc(status.message || DEFAULT_MESSAGE)}</p></div>`;
    }
    const card = ensureAdminControl();
    const form = card?.querySelector("form");
    if (form) {
      form.elements.enabled.checked = !!status.enabled;
      if (document.activeElement !== form.elements.message) form.elements.message.value = status.message || DEFAULT_MESSAGE;
      card.open = !!status.enabled || card.open;
      card.dataset.active = String(!!status.enabled);
    }
  }

  async function refreshMaintenance() {
    if (!state?.token) return;
    try {
      const status = await api("/api/maintenance-status");
      render(status);
    } catch {}
  }

  async function saveMaintenance(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const resultHost = form.querySelector(".maintenance-control-message");
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    resultHost.textContent = "Saving...";    try {
      const status = await api("/api/system/maintenance", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: form.elements.enabled.checked,
          message: form.elements.message.value.trim() || DEFAULT_MESSAGE,
        }),
      });
      render(status);
      resultHost.textContent = status.enabled ? "Maintenance banner is active." : "Maintenance mode is off.";
    } catch (error) {
      resultHost.className = "maintenance-control-message error";
      resultHost.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  function start() {
    ensureStyles();
    ensureBanner();
    ensureAdminControl();
    refreshMaintenance();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(refreshMaintenance, 30000);
  }

  const baseShowApp = window.showApp;
  if (typeof baseShowApp === "function") {
    window.showApp = showApp = function maintenanceAwareShowApp() {
      baseShowApp();
      setTimeout(start, 0);
    };
  }

  window.refreshMaintenanceBanner = refreshMaintenance;  document.querySelectorAll(".tab-btn").forEach((button) => button.addEventListener("click", () => {
    if (button.dataset.tab === "system") setTimeout(() => { ensureAdminControl(); refreshMaintenance(); }, 0);
  }));
  window.addEventListener("focus", refreshMaintenance);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshMaintenance(); });

  if (state?.token) setTimeout(start, 0);
})();

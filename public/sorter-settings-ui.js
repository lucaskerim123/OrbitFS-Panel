(() => {
  if (window.__orbitSorterSettingsLoaded) return;
  window.__orbitSorterSettingsLoaded = true;

  const byId = (id) => document.getElementById(id);
  const sorterApiUi = (path, options = {}) => api(`/api/sorter${path}`, options);

  function selectedWorkspace() {
    return state.workspaces?.find((workspace) => String(workspace.id) === String(state.workspaceId)) || null;
  }

  function canUse() {
    const workspace = selectedWorkspace();
    if (typeof window.sorterWorkspaceCanUse === "function") return window.sorterWorkspaceCanUse(workspace);
    return state.role === "admin" || workspace?.permission === "owner" || workspace?.is_main || !!workspace?.management_permissions?.use_sorter;
  }

  function canManage() {
    const workspace = selectedWorkspace();
    if (typeof window.sorterWorkspaceCanManageSettings === "function") return window.sorterWorkspaceCanManageSettings(workspace);
    return state.role === "admin" || workspace?.permission === "owner" || !!workspace?.management_permissions?.manage_sorter_settings;
  }

  function switchSorterView(view) {
    if (view === "settings" && !canManage()) view = "inbox";
    document.querySelectorAll("[data-sorter-view]").forEach((button) => button.classList.toggle("active", button.dataset.sorterView === view));
    byId("sorter-view-inbox")?.classList.toggle("hidden", view !== "inbox");
    byId("sorter-view-settings")?.classList.toggle("hidden", view !== "settings");
    if (view === "settings") loadSorterSettings();
  }
  function applySettingsAccess(settings) {
    const editable = canManage();
    const settingsButton = document.querySelector('[data-sorter-view="settings"]');
    settingsButton?.classList.toggle("hidden", !editable);
    if (!editable && byId("sorter-view-settings") && !byId("sorter-view-settings").classList.contains("hidden")) switchSorterView("inbox");
    const workspace = selectedWorkspace();
    const note = byId("sorter-settings-access-note");
    if (note) note.textContent = editable
      ? `You can change sorter behaviour for ${workspace?.name || "this workspace"}.`
      : "Sorter settings access is controlled by the workspace permission editor.";

    for (const id of ["sorter-mode-select", "sorter-suggestion-threshold", "sorter-auto-threshold", "sorter-content-scanning", "sorter-settings-save", "sorter-reset-learning"]) {
      const element = byId(id);
      if (element) element.disabled = !editable;
    }
    const automatic = byId("sorter-mode-select")?.querySelector('option[value="automatic"]');
    if (automatic) automatic.disabled = !settings?.allowAutomatic;
    const scan = byId("sorter-content-scanning");
    if (scan) scan.disabled = !editable || !settings?.allowContentScanning;
  }

  async function loadSorterSettings() {
    const message = byId("sorter-settings-message");
    if (!canManage()) { applySettingsAccess({}); if (message) message.textContent = "Sorter settings access is not enabled for this workspace role."; return; }
    try {
      const settings = await sorterApiUi("/settings");
      byId("sorter-mode-select").value = settings.mode || "confirm";
      byId("sorter-suggestion-threshold").value = Math.round(Number(settings.suggestion_threshold || 0.6) * 100);
      byId("sorter-auto-threshold").value = Math.round(Number(settings.auto_threshold || 0.9) * 100);
      byId("sorter-content-scanning").checked = !!settings.content_scanning;
      applySettingsAccess(settings);
      if (message) message.textContent = "";
      if (state.role === "admin") await loadSorterPolicy();
    } catch (error) {
      if (message) message.textContent = error.message;
    }
  }
  window.loadSorterSettings = loadSorterSettings;
  async function saveSorterSettings(event) {
    event.preventDefault();
    const message = byId("sorter-settings-message");
    if (!canManage()) return;
    try {
      const settings = await sorterApiUi("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: byId("sorter-mode-select").value,
          suggestionThreshold: Number(byId("sorter-suggestion-threshold").value) / 100,
          autoThreshold: Number(byId("sorter-auto-threshold").value) / 100,
          contentScanning: byId("sorter-content-scanning").checked,
        }),
      });
      applySettingsAccess(settings);
      if (message) message.textContent = "Workspace sorter settings saved.";
    } catch (error) {
      if (message) message.textContent = error.message;
    }
  }

  async function resetLearning() {
    const workspace = selectedWorkspace();
    if (!workspace || !canManage()) return;
    if (!confirm(`Reset all learned sorter choices for ${workspace.name}?`)) return;
    const message = byId("sorter-learning-message");
    try {
      await sorterApiUi("/learning", { method: "DELETE" });
      if (message) message.textContent = "Workspace sorter learning reset.";
    } catch (error) {
      if (message) message.textContent = error.message;
    }
  }
  async function loadSorterPolicy() {
    const card = byId("sorter-admin-policy-card");
    if (state.role !== "admin") return card?.classList.add("hidden");
    card?.classList.remove("hidden");
    const message = byId("sorter-policy-message");
    try {
      const policy = await sorterApiUi("/policy");
      byId("sorter-policy-auto").checked = !!policy.allowAutomatic;
      byId("sorter-policy-content").checked = !!policy.allowContentScanning;
      if (message) message.textContent = "";
    } catch (error) {
      if (message) message.textContent = error.message;
    }
  }

  async function saveSorterPolicy(event) {
    event.preventDefault();
    const message = byId("sorter-policy-message");
    try {
      await sorterApiUi("/policy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          allowAutomatic: byId("sorter-policy-auto").checked,
          allowContentScanning: byId("sorter-policy-content").checked,
        }),
      });
      if (message) message.textContent = "Admin sorter policy saved.";
      await loadSorterSettings();
    } catch (error) {
      if (message) message.textContent = error.message;
    }
  }
  function refreshSorterAccessUi() {
    applySettingsAccess({});
    if (!canUse() && document.getElementById("tab-sorter")?.classList.contains("active")) switchTab("files");
  }
  window.refreshSorterAccessUi = refreshSorterAccessUi;

  function install() {
    document.querySelectorAll("[data-sorter-view]").forEach((button) => {
      button.addEventListener("click", () => switchSorterView(button.dataset.sorterView));
    });
    byId("sorter-settings-form")?.addEventListener("submit", saveSorterSettings);
    byId("sorter-reset-learning")?.addEventListener("click", resetLearning);
    byId("sorter-policy-form")?.addEventListener("submit", saveSorterPolicy);
    byId("sorter-workspace-select")?.addEventListener("change", () => setTimeout(loadSorterSettings, 0));
    document.getElementById("tab-btn-sorter")?.addEventListener("click", () => setTimeout(loadSorterSettings, 0));
    refreshSorterAccessUi();
    if (canManage()) loadSorterSettings();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else install();
})();

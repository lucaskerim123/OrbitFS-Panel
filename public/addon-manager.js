(() => {
  if (window.__orbitAddonManagerLoaded) return;
  window.__orbitAddonManagerLoaded = true;

  const scripts = new Map();
  let refreshPromise = null;
  let pollTimer = null;

  function byId(id) { return document.getElementById(id); }
  function addon(id) { return state.addons?.[id] || null; }
  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;",
    })[char]);
  }

  function loadScript(src, key) {
    if (scripts.has(key)) return scripts.get(key);
    const promise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.async = false;
      script.dataset.orbitAddonAsset = key;
      script.onload = resolve;
      script.onerror = () => reject(new Error(`Failed to load ${key}`));
      document.body.appendChild(script);
    });
    scripts.set(key, promise);
    return promise;
  }
  async function loadWorkspaceAddonAssets() {
    await loadScript(
      "/addon-assets/workspaces/workspace-ui.js?v=20260716-reachfix",
      "workspaces-ui"
    );
    await loadScript(
      "/addon-assets/workspaces/workspace-expand-fix.js?v=20260716-reachfix",
      "workspaces-expand-fix"
    );
    await loadScript(
      "/addon-assets/workspaces/workspace-permission-editor.js?v=20260716-config",
      "workspaces-permissions"
    );
    await loadScript(
      "/addon-assets/workspaces/notification-center.js?v=20260715-final",
      "workspaces-notifications"
    );
  }

  function applyWorkspaceAvailability(info) {
    const enabled = info?.attached === true;
    const button = byId("tab-btn-workspaces");
    const panel = byId("tab-workspaces");
    button?.classList.toggle("hidden", !enabled);
    panel?.classList.toggle("addon-unavailable", !enabled);
    panel?.classList.toggle("hidden", !enabled);
    if (!enabled) {
      byId("workspace-bar")?.classList.add("hidden");
      byId("notification-button")?.classList.add("hidden");
      byId("notification-overlay")?.classList.add("hidden");
      byId("notification-critical-banner")?.remove();
      if (panel?.classList.contains("active")) switchTab("files");
      state.workspaceId = "";
      state.workspaces = [];
      localStorage.removeItem("panelWorkspaceId");
    } else {
      byId("notification-button")?.classList.remove("hidden");
    }
  }

  function applySorterAvailability(info) {
    const enabled = info?.attached === true;
    if (!enabled && byId("tab-sorter")?.classList.contains("active")) switchTab("files");
    if (typeof refreshSorterHeader === "function") refreshSorterHeader();
  }
  function ensureStyles() {
    if (byId("orbit-addon-manager-style")) return;
    const style = document.createElement("style");
    style.id = "orbit-addon-manager-style";
    style.textContent = `
      .addon-manager-card>summary{display:flex;align-items:center;justify-content:space-between;gap:8px}
      .addon-manager-grid{display:grid;gap:10px;margin-top:10px}
      .addon-item{border:1px solid var(--border);border-radius:11px;padding:11px;background:var(--bg)}
      .addon-item-head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
      .addon-item-title{display:grid;gap:3px;min-width:0}.addon-item-title strong{font-size:.9rem}.addon-item-title small{color:var(--muted);line-height:1.35}
      .addon-status{border:1px solid var(--border);border-radius:999px;padding:3px 7px;font-size:.64rem;text-transform:uppercase;letter-spacing:.04em}
      .addon-status[data-state="attached"]{color:var(--ok);border-color:var(--ok)}
      .addon-status[data-state="detached"]{color:#e0a63b;border-color:#e0a63b}
      .addon-status[data-state="uninstalled"]{color:var(--danger);border-color:var(--danger)}
      .addon-folder{display:block;margin:9px 0 0;color:var(--muted);font:11px ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}
      .addon-runtime{margin:5px 0 0;color:var(--muted);font-size:.72rem}
      .addon-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}.addon-actions button{min-height:34px;padding:5px 9px;font-size:.74rem}
      .addon-safety-note{margin:8px 0 0;color:var(--muted);font-size:.7rem;line-height:1.4}
      #addon-manager-message{margin-top:8px}
      @media(max-width:520px){.addon-item{padding:9px}.addon-item-head{align-items:center}.addon-actions button{flex:1}}
    `;
    document.head.appendChild(style);
  }

  function ensureCard() {
    if (state.role !== "admin") return null;
    const host = byId("config-zone-main");
    if (!host) return null;
    let card = byId("addon-manager-card");
    if (card) return card;
    card = document.createElement("details");
    card.id = "addon-manager-card";
    card.className = "card addon-manager-card";
    card.open = true;
    card.innerHTML = `<summary><span>Addons</span><small>Attach / detach safely</small></summary><p class="muted-text">Detach an addon, then move its folder into <code>plugins\Not Installed</code>. OrbitFS never scans, serves or loads anything stored in that folder. Move the addon back into the main <code>plugins</code> folder before attaching it again.</p><div id="addon-manager-grid" class="addon-manager-grid"></div><p id="addon-manager-message" class="muted-text"></p>`;
    host.prepend(card);
    return card;
  }
  function renderAddonManager() {
    const card = ensureCard();
    const grid = byId("addon-manager-grid");
    if (!card || !grid) return;
    const items = Object.values(state.addons || {});
    grid.innerHTML = items.map((item) => {
      const sorterBlocked = item.id === "sorter" && item.online;
      const attachDisabled = item.status === "uninstalled" || item.attached;
      const detachDisabled = !item.attached || sorterBlocked;
      const runtime = item.id === "sorter"
        ? `Service: ${item.online ? "Online" : "Offline"}`
        : `Workspace Mode: ${item.attached ? "Available" : "Unavailable"}`;
      const note = item.status === "uninstalled"
        ? item.parked
          ? `Parked in Not Installed and fully ignored. Move "${item.folderName}" back into the main plugins folder, then press Attach.`
          : `Folder not detected. Put "${item.folderName}" directly in the main plugins folder, then press Attach.`
        : sorterBlocked
          ? "Stop Sorter in Systems before detaching it."
          : item.attached
            ? "Detach before moving this addon folder. Data is preserved."
            : "Detached. Move the folder into Not Installed to park it safely, or press Attach to enable it again.";
      return `<article class="addon-item" data-addon-id="${esc(item.id)}">
        <div class="addon-item-head"><div class="addon-item-title"><strong>${esc(item.name)}</strong><small>${esc(item.description)}</small></div><span class="addon-status" data-state="${esc(item.status)}">${esc(item.status)}</span></div>
        <code class="addon-folder">Installed location: ${esc(item.folderPath || item.folderName)}</code>
        <code class="addon-folder">Safe parking: ${esc(item.parkedFolderPath || "plugins\Not Installed")}</code>
        ${item.storageRoot ? `<code class="addon-folder">Workspace storage: ${esc(item.storageRoot)}</code>` : ""}
        <p class="addon-runtime">${esc(runtime)}</p>
        <div class="addon-actions"><button type="button" data-addon-action="attach" ${attachDisabled ? "disabled" : ""}>Attach</button><button type="button" class="danger" data-addon-action="detach" ${detachDisabled ? "disabled" : ""}>Detach</button></div>
        <p class="addon-safety-note">${esc(note)}</p>
      </article>`;
    }).join("");
    grid.querySelectorAll("[data-addon-action]").forEach((button) => {
      button.addEventListener("click", () => changeAddon(button.closest("[data-addon-id]").dataset.addonId, button.dataset.addonAction));
    });
  }

  function updateSystemControls() {
    const sorter = addon("sorter");
    const row = byId("service-row-sorter");
    if (!row || !sorter) return;
    row.classList.toggle("hidden", sorter.status === "uninstalled");
    row.dataset.addonStatus = sorter.status;
    row.querySelectorAll('[data-target="sorter"]').forEach((button) => {
      if (button.dataset.action === "stop") return;
      button.disabled = !sorter.attached;
      button.title = sorter.attached ? "" : "Attach the Sorter addon in Config first";
    });
    row.querySelector(".addon-system-note")?.remove();
  }
  async function changeAddon(id, action) {
    const message = byId("addon-manager-message");
    if (message) {
      message.className = "muted-text";
      message.textContent = `${action === "attach" ? "Attaching" : "Detaching"} addon...`;
    }
    try {
      await api(`/api/addons/${encodeURIComponent(id)}/${action}`, { method:"POST" });
      if (message) message.textContent = `${id === "workspaces" ? "Workspaces" : "Sorter"} ${action === "attach" ? "attached" : "detached"}. Reloading panel...`;
      await refreshAddonManager(true);
      setTimeout(() => location.reload(), 250);
    } catch (error) {
      if (message) {
        message.className = "error";
        message.textContent = error.message;
      }
    }
  }

  async function refreshAddonManager(force = false) {
    if (!state.token) return;
    if (refreshPromise && !force) return refreshPromise;
    refreshPromise = (async () => {
      const result = await api(state.role === "admin" ? "/api/addons" : "/api/addons/status");
      state.addons = Object.fromEntries((result.addons || []).map((item) => [item.id, item]));
      const workspaces = addon("workspaces");
      const sorter = addon("sorter");
      applyWorkspaceAvailability(workspaces);
      applySorterAvailability(sorter);
      if (workspaces?.attached && !window.__orbitWorkspaceUiLoaded) {
        await loadWorkspaceAddonAssets();
        applyWorkspaceAvailability(workspaces);
      }
      renderAddonManager();
      updateSystemControls();
      return state.addons;
    })().catch((error) => {
      const message = byId("addon-manager-message");
      if (message) {
        message.className = "error";
        message.textContent = error.message;
      }
      throw error;
    }).finally(() => { refreshPromise = null; });
    return refreshPromise;
  }

  window.refreshAddonManager = refreshAddonManager;
  function install() {
    ensureStyles();
    const originalShowApp = window.showApp;
    if (typeof originalShowApp === "function" && !originalShowApp.__addonWrapped) {
      const wrapped = function(...args) {
        const result = originalShowApp.apply(this, args);
        setTimeout(() => refreshAddonManager().catch(() => {}), 0);
        return result;
      };
      wrapped.__addonWrapped = true;
      window.showApp = wrapped;
      showApp = wrapped;
    }
    const observer = new MutationObserver(() => {
      if (state.role !== "admin") return;
      if (ensureCard()) {
        observer.disconnect();
        renderAddonManager();
        updateSystemControls();
      }
    });
    observer.observe(document.body, { childList:true, subtree:true });
    if (state.token) refreshAddonManager().catch(() => {});
    setTimeout(() => { ensureCard(); renderAddonManager(); updateSystemControls(); }, 800);
    setTimeout(() => { ensureCard(); renderAddonManager(); updateSystemControls(); }, 2500);
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (state.token && !document.hidden) refreshAddonManager().catch(() => {});
    }, 15000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once:true });
  else install();
})();

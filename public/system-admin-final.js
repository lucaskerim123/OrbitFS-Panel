(() => {
  if (window.__orbitSystemAdminFinalLoaded) return;
  window.__orbitSystemAdminFinalLoaded = true;

  const q = (selector, root = document) => root.querySelector(selector);
  const qa = (selector, root = document) => [...root.querySelectorAll(selector)];
  const cardTitle = (card) => q("summary,h2,h3,strong", card)?.textContent?.trim().toLowerCase() || "";

  function findCard(title, root = document) {
    const wanted = String(title).trim().toLowerCase();
    return qa("details.card,article.card,section.card,.card", root).find((card) => cardTitle(card) === wanted) || null;
  }

  function ensureConfigTab() {
    const nav = q("nav");
    const systemButton = q('.tab-btn[data-tab="system"]');
    if (!nav || !systemButton) return null;

    let button = q('.tab-btn[data-tab="config"]');
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "tab-btn";
      button.dataset.tab = "config";
      button.textContent = "⚙️ Configuration";
      nav.insertBefore(button, systemButton);
      button.addEventListener("click", () => {
        if (typeof switchTab === "function") switchTab("config");
        refreshConfiguration();
      });
    }

    let panel = q("#tab-config");
    if (!panel) {
      panel = document.createElement("section");
      panel.id = "tab-config";
      panel.className = "tab-panel sys-panel";
      panel.innerHTML = `
        <div class="sys-header config-header">
          <div class="sys-header-text"><h2 class="sys-title">Configuration</h2><p class="sys-subtitle">Startup and system behaviour settings</p></div>
          <button id="config-refresh-btn" class="sys-refresh-btn" type="button">⟳ Refresh</button>
        </div>
        <div id="config-zone-main" class="sys-zone">
          <div class="sys-zone-label"><span class="sys-zone-dot"></span>Configuration</div>
        </div>`;
      const adminPanel = q("#tab-admin");
      adminPanel?.parentElement?.insertBefore(panel, adminPanel);
      q("#config-refresh-btn", panel)?.addEventListener("click", refreshConfiguration);
    }
    return panel;
  }

  function ensureLicenceTab() {
    const nav = q("nav");
    const configButton = q('.tab-btn[data-tab="config"]') || q('.tab-btn[data-tab="system"]');
    if (!nav || !configButton) return null;
    let button = q('.tab-btn[data-tab="licence"]');
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "tab-btn";
      button.dataset.tab = "licence";
      button.textContent = "🔐 Licence";
      configButton.insertAdjacentElement("afterend", button);
      button.addEventListener("click", () => {
        if (typeof switchTab === "function") switchTab("licence");
        if (typeof loadLicensePanel === "function") loadLicensePanel(true);
      });
    }
    let panel = q("#tab-licence");
    if (!panel) {
      panel = document.createElement("section");
      panel.id = "tab-licence";
      panel.className = "tab-panel sys-panel";
      panel.innerHTML = `<div class="sys-header licence-header"><div class="sys-header-text"><h2 class="sys-title">Licence</h2><p class="sys-subtitle">Entitlements decide what can run. Configuration lives in Config.</p></div><button id="licence-refresh-btn" class="sys-refresh-btn" type="button">⟳ Refresh</button></div><div id="licence-zone-main" class="sys-zone"><div class="sys-zone-label"><span class="sys-zone-dot"></span>Entitlements</div></div>`;
      const configPanel = q("#tab-config");
      configPanel?.insertAdjacentElement("afterend", panel);
      q("#licence-refresh-btn", panel)?.addEventListener("click", () => loadLicensePanel(true));
    }
    return panel;
  }

  function moveLicenceCard() {
    const panel = ensureLicenceTab();
    const host = q("#licence-zone-main", panel);
    const card = q("#system-license-card");
    if (host && card && card.parentElement !== host) host.appendChild(card);
  }

  function ensureRuntimeConfigCard() {
    const panel = ensureConfigTab();
    const host = q("#config-zone-main", panel);
    if (!host || q("#runtime-config-card", host)) return;
    const card = document.createElement("details");
    card.id = "runtime-config-card";
    card.className = "card runtime-config-card";
    card.open = true;
    card.innerHTML = `<summary><span>Runtime configuration</span><small>Paths, ports and service names</small></summary><p class="muted-text">Configuration controls where components are installed and how they run. Licensing only controls whether they are allowed to run.</p><div id="runtime-config-grid" class="runtime-config-grid"><p class="muted-text">Loading configuration…</p></div>`;
    host.prepend(card);
  }

  function escapeConfig(value) {
    const div = document.createElement("div");
    div.textContent = String(value ?? "");
    return div.innerHTML;
  }

  async function refreshRuntimeConfig() {
    ensureRuntimeConfigCard();
    const grid = q("#runtime-config-grid");
    if (!grid || typeof api !== "function") return;
    try {
      const result = await api("/api/config/runtime");
      const config = result.config || {};
      grid.innerHTML = Object.entries(config).map(([id, item]) => {
        const fields = Object.entries(item || {}).filter(([, value]) => value !== undefined && value !== null && value !== "");
        return `<article class="runtime-config-item"><strong>${escapeConfig(id)}</strong>${fields.map(([key, value]) => `<div><span>${escapeConfig(key)}</span><code>${escapeConfig(value)}</code></div>`).join("")}</article>`;
      }).join("") || '<p class="muted-text">No runtime configuration found.</p>';
    } catch (error) {
      grid.innerHTML = `<p class="muted-text">${escapeConfig(error.message)}</p>`;
    }
  }

  function moveConfigurationCards() {
    const panel = ensureConfigTab();
    const host = q("#config-zone-main", panel);
    if (!host) return;

    const startup = findCard("Startup Load Control");
    if (startup && startup.parentElement !== host) host.appendChild(startup);

    const startupLoading = findCard("Startup Loading");
    if (startupLoading && startupLoading !== startup) startupLoading.remove();

    const trash = findCard("Trash settings");
    if (trash && trash.parentElement !== host) host.appendChild(trash);
    ensureRuntimeConfigCard();
  }

  function renameSharedMcpCard() {
    const system = q("#tab-system");
    if (!system) return;
    qa(".flow-card", system).forEach((card) => {
      const heading = q(".flow-heading strong", card);
      if (heading?.textContent.trim() === "Shared MCP") heading.textContent = "Web Panel Usage";
    });
  }

  function ensureServiceMeta() {
    const primary = q("#tab-system .primary-system-card");
    if (!primary || q("#system-service-meta", primary)) return;
    const meta = document.createElement("div");
    meta.id = "system-service-meta";
    meta.className = "system-service-meta";
    meta.innerHTML = `
      <div><span>Service uptime</span><strong id="system-uptime">—</strong></div>
      <div><span>Last checked</span><strong id="system-last-checked">—</strong></div>`;
    const flowGrid = q(".flow-grid", primary);
    flowGrid?.insertAdjacentElement("beforebegin", meta);
  }

  function formatDuration(seconds) {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value < 0) return "Unavailable";
    const days = Math.floor(value / 86400);
    const hours = Math.floor((value % 86400) / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    return [days ? `${days}d` : "", hours ? `${hours}h` : "", `${minutes}m`].filter(Boolean).join(" ");
  }

  async function refreshServiceMeta() {
    ensureServiceMeta();
    const uptime = q("#system-uptime");
    const checked = q("#system-last-checked");
    try {
      const status = await api("/api/system/status");
      const seconds = status?.uptimeSeconds ?? status?.panel?.uptimeSeconds ?? status?.services?.panel?.uptimeSeconds;
      if (uptime) uptime.textContent = formatDuration(seconds);
      if (checked) checked.textContent = new Date(status?.checkedAt || Date.now()).toLocaleTimeString();
    } catch {
      if (uptime) uptime.textContent = "Unavailable";
      if (checked) checked.textContent = new Date().toLocaleTimeString();
    }
  }

  function ensureSystemSessionsZone() {
    const system = q("#tab-system");
    if (!system) return null;
    let zone = q("#system-sessions-clients", system);
    if (!zone) {
      zone = document.createElement("div");
      zone.id = "system-sessions-clients";
      zone.className = "sys-zone";
      zone.innerHTML = '<div class="sys-zone-label"><span class="sys-zone-dot"></span>Sessions and clients</div>';
      const diagnostics = q(".sys-zone-diagnostics", system);
      system.insertBefore(zone, diagnostics || null);
    }

    const oauth = findCard("Connected MCP clients");
    if (oauth && oauth.parentElement !== zone) zone.appendChild(oauth);

    if (!q("#active-session-card", zone)) {
      const card = document.createElement("details");
      card.id = "active-session-card";
      card.className = "card";
      card.open = true;
      card.innerHTML = `
        <summary>Active sessions</summary>
        <p class="muted-text">View active Panel sessions and revoke access.</p>
        <div id="active-session-list" class="compact-admin-list"><p class="muted-text">Loading sessions…</p></div>`;
      zone.prepend(card);
    }
    return zone;
  }

  async function refreshSessions() {
    ensureSystemSessionsZone();
    const list = q("#active-session-list");
    if (!list) return;
    try {
      const result = await api("/api/admin/sessions");
      const sessions = result.sessions || [];
      list.innerHTML = "";
      for (const session of sessions) {
        const row = document.createElement("div");
        row.className = "compact-admin-row";
        row.innerHTML = `<div><strong>${session.username || "Unknown"}</strong><small>${session.ip || "IP unavailable"} · ${session.lastSeenAt ? new Date(session.lastSeenAt).toLocaleString() : "No activity time"}</small></div><button type="button" class="danger">Revoke</button>`;
        q("button", row).addEventListener("click", async () => {
          if (!confirm(`Revoke this session for ${session.username || "this user"}?`)) return;
          await api(`/api/admin/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
          refreshSessions();
        });
        list.appendChild(row);
      }
      if (!sessions.length) list.innerHTML = '<p class="muted-text">No active sessions.</p>';
    } catch (error) {
      list.innerHTML = `<p class="muted-text">${error.message}</p>`;
    }
  }

  function consolidateLogs() {
    const system = q("#tab-system");
    if (!system) return;
    let zone = q("#system-logs-zone", system);
    if (!zone) {
      zone = document.createElement("div");
      zone.id = "system-logs-zone";
      zone.className = "sys-zone system-logs-zone";
      zone.innerHTML = '<div class="sys-zone-label"><span class="sys-zone-dot"></span>Logs</div><details class="card" open id="all-system-logs"><summary>System logs</summary><div id="all-system-logs-host"></div></details>';
      system.appendChild(zone);
    }
    const host = q("#all-system-logs-host", zone);
    if (!host) return;

    const candidates = [];
    const hiveActivity = qa("#tab-system details").find((detail) => q("summary", detail)?.textContent.trim() === "OrbitFS activity logs");
    if (hiveActivity) candidates.push(hiveActivity);
    const diagnostics = q("#tab-system .sys-zone-diagnostics");
    if (diagnostics) candidates.push(...qa(":scope > details.card", diagnostics));
    for (const item of candidates) {
      if (!host.contains(item)) host.appendChild(item);
    }
    diagnostics?.remove();
  }

  function placeHardStop() {
    const system = q("#tab-system");
    const hardStop = findCard("Heavily guarded: Hard stop");
    if (!system || !hardStop) return;
    let zone = q("#system-hard-stop-zone", system);
    if (!zone) {
      zone = document.createElement("div");
      zone.id = "system-hard-stop-zone";
      zone.className = "sys-zone danger-zone";
      zone.innerHTML = '<div class="sys-zone-label"><span class="sys-zone-dot"></span>Emergency control</div>';
      const logs = q("#system-logs-zone", system);
      system.insertBefore(zone, logs || null);
    }
    if (hardStop.parentElement !== zone) zone.appendChild(hardStop);
  }

  function ensureAdminRoleDefinitions() {
    const host = q("#admin-zone-host");
    if (!host || q("#system-role-definitions")) return;
    const card = document.createElement("details");
    card.id = "system-role-definitions";
    card.className = "card";
    card.innerHTML = `
      <summary>System role definitions</summary>
      <div class="role-definition-grid">
        <article><strong>User</strong><p>Uses assigned workspaces and only the tabs, files and actions allowed by administrators.</p></article>
        <article><strong>Admin</strong><p>Manages users, account status, restrictions, file permissions, system configuration and infrastructure controls.</p></article>
      </div>`;
    host.prepend(card);
  }

  function ensureAdminSecurityCards() {
    q("#admin-login-security")?.remove();
    q("#admin-audit-log")?.remove();
  }

  async function refreshAdminSecurity() {
    ensureAdminSecurityCards();
    const securityList = q("#admin-login-security-list");
    const auditList = q("#admin-audit-list");
    if (!securityList && !auditList) return;
    try {
      const result = await api("/api/admin/users-security");
      const users = result.users || [];
      securityList.innerHTML = users.map((user) => `<div class="compact-admin-row"><div><strong>${user.username}</strong><small>${user.lastIp || "No IP"} · ${user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : "No login recorded"}</small></div><span class="pill">${user.status || "active"}</span></div>`).join("") || '<p class="muted-text">No users found.</p>';
    } catch (error) {
      if (securityList) securityList.innerHTML = `<p class="muted-text">${error.message}</p>`;
    }
    try {
      const result = await api("/api/admin/audit?types=connection,admin");
      const events = result.events || [];
      auditList.innerHTML = events.map((event) => `<div class="compact-admin-row"><div><strong>${event.action || event.type || "Activity"}</strong><small>${event.username || "System"} · ${event.createdAt ? new Date(event.createdAt).toLocaleString() : ""}</small></div></div>`).join("") || '<p class="muted-text">No connection or admin events.</p>';
    } catch (error) {
      if (auditList) auditList.innerHTML = `<p class="muted-text">${error.message}</p>`;
    }
  }

  function progressivePermissionControls() {
    const card = findCard("File permissions");
    if (!card) return;
    card.classList.add("progressive-permissions");
    const table = q("#permissions-table", card);
    if (!table || table.dataset.progressiveWired) return;
    table.dataset.progressiveWired = "1";
    table.addEventListener("click", (event) => {
      const row = event.target.closest("tbody tr");
      if (!row) return;
      qa("tbody tr", table).forEach((item) => item.classList.toggle("permission-selected", item === row));
      card.classList.add("permission-item-selected");
    });
  }

  function installConfigFeedback() {
    const panel = q("#tab-config");
    if (!panel) return;
    qa("form", panel).forEach((form) => {
      if (form.dataset.configFeedback) return;
      form.dataset.configFeedback = "1";
      form.addEventListener("submit", () => {
        let status = q(".config-save-feedback", form);
        if (!status) {
          status = document.createElement("p");
          status.className = "muted-text config-save-feedback";
          form.appendChild(status);
        }
        status.textContent = "Saving…";
        setTimeout(() => { status.textContent = `Last saved ${new Date().toLocaleTimeString()}`; }, 900);
      });
    });
  }

  async function refreshConfiguration() {
    const button = q("#config-refresh-btn");
    if (button) { button.disabled = true; button.textContent = "⟳ Refreshing…"; }
    try {
      moveConfigurationCards();
      if (typeof loadStartupConfig === "function") await loadStartupConfig();
      await refreshRuntimeConfig();
      installConfigFeedback();
    } finally {
      if (button) { button.disabled = false; button.textContent = "⟳ Refresh"; }
    }
  }
  window.refreshConfiguration = refreshConfiguration;

  async function refreshFinalSystem() {
    renameSharedMcpCard();
    ensureServiceMeta();
    ensureSystemSessionsZone();
    consolidateLogs();
    placeHardStop();
    moveLicenceCard();
    await Promise.allSettled([refreshServiceMeta(), refreshSessions()]);
  }
  window.refreshFinalSystem = refreshFinalSystem;

  async function refreshFinalAdmin() {
    ensureAdminRoleDefinitions();
    ensureAdminSecurityCards();
    progressivePermissionControls();
    await refreshAdminSecurity();
  }
  window.refreshFinalAdmin = refreshFinalAdmin;

  function wireRefreshButtons() {
    const systemRefresh = q("#system-refresh-btn");
    if (systemRefresh && !systemRefresh.dataset.finalRefresh) {
      systemRefresh.dataset.finalRefresh = "1";
      systemRefresh.addEventListener("click", () => setTimeout(refreshFinalSystem, 0));
    }
    const adminRefresh = q("#admin-refresh-btn");
    if (adminRefresh && !adminRefresh.dataset.finalRefresh) {
      adminRefresh.dataset.finalRefresh = "1";
      adminRefresh.addEventListener("click", () => setTimeout(refreshFinalAdmin, 0));
    }
  }

  function installStyles() {
    if (q("#system-admin-final-style")) return;
    const style = document.createElement("style");
    style.id = "system-admin-final-style";
    style.textContent = `
      .system-service-meta{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:10px 0}
      .runtime-config-grid{display:grid;gap:9px;margin-top:10px}.runtime-config-item{display:grid;gap:6px;padding:10px;border:1px solid var(--border,#30384a);border-radius:10px}.runtime-config-item>div{display:grid;grid-template-columns:minmax(90px,.35fr) 1fr;gap:8px;align-items:start}.runtime-config-item span{color:var(--muted,#9aa3b2);font-size:12px}.runtime-config-item code{white-space:normal;overflow-wrap:anywhere;font-size:11px}
      .system-service-meta>div{display:grid;gap:3px;padding:9px;border:1px solid var(--border,#30384a);border-radius:9px;background:rgba(255,255,255,.025)}
      .system-service-meta span{font-size:12px;color:var(--muted,#9aa3b2)}
      .compact-admin-list{display:grid;gap:8px;margin-top:10px}.compact-admin-row{display:flex;justify-content:space-between;gap:10px;align-items:center;padding:9px;border:1px solid var(--border,#30384a);border-radius:9px}.compact-admin-row>div{display:grid;gap:2px}.compact-admin-row small{color:var(--muted,#9aa3b2)}
      .role-definition-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:10px}.role-definition-grid article{padding:10px;border:1px solid var(--border,#30384a);border-radius:9px}.role-definition-grid p{margin:6px 0 0;color:var(--muted,#9aa3b2);font-size:13px}
      #all-system-logs-host{display:grid;gap:8px}.system-logs-zone{order:999}.danger-zone .sys-zone-dot{background:var(--danger,#ff6b6b)}
      .progressive-permissions #permissions-table tbody tr:not(.permission-selected) button,.progressive-permissions #permissions-table tbody tr:not(.permission-selected) select,.progressive-permissions #permissions-table tbody tr:not(.permission-selected) input[type="checkbox"]{display:none!important}
      .progressive-permissions #permissions-table tbody tr{cursor:pointer}.progressive-permissions #permissions-table tbody tr.permission-selected{background:rgba(91,140,255,.08)}
      @media(max-width:650px){.system-service-meta,.role-definition-grid{grid-template-columns:1fr}.compact-admin-row{align-items:flex-start;flex-direction:column}}
    `;
    document.head.appendChild(style);
  }

  function applyLayout() {
    ensureConfigTab();
    ensureLicenceTab();
    moveConfigurationCards();
    moveLicenceCard();
    renameSharedMcpCard();
    ensureServiceMeta();
    ensureSystemSessionsZone();
    consolidateLogs();
    placeHardStop();
    ensureAdminRoleDefinitions();
    ensureAdminSecurityCards();
    progressivePermissionControls();
    installConfigFeedback();
    wireRefreshButtons();
  }

  function install() {
    installStyles();
    applyLayout();
    refreshRuntimeConfig();
    refreshFinalSystem();
    if (state?.role === "admin") refreshFinalAdmin();
    const observer = new MutationObserver(() => requestAnimationFrame(applyLayout));
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
})();
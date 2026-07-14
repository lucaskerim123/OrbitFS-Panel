(() => {
  if (window.__orbitStableAdminLayoutLoaded) return;
  window.__orbitStableAdminLayoutLoaded = true;

  const q = (selector, root = document) => root.querySelector(selector);
  const qa = (selector, root = document) => [...root.querySelectorAll(selector)];

  function titleOf(card) {
    return q("summary,h2,h3,strong", card)?.textContent?.trim().toLowerCase() || "";
  }

  function findCard(title) {
    const wanted = String(title).trim().toLowerCase();
    return qa("details.card,article.card,section.card,.card").find((card) => titleOf(card) === wanted) || null;
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
      });
    }

    let panel = q("#tab-config");
    if (!panel) {
      panel = document.createElement("section");
      panel.id = "tab-config";
      panel.className = "tab-panel sys-panel";
      panel.innerHTML = `
        <div class="sys-header">
          <div class="sys-header-text"><h2 class="sys-title">Configuration</h2><p class="sys-subtitle">Startup and system behaviour settings</p></div>
          <button id="config-refresh-btn" class="sys-refresh-btn" type="button">⟳ Refresh</button>
        </div>
        <div id="config-zone-main" class="sys-zone"></div>`;
      const admin = q("#tab-admin");
      admin?.parentElement?.insertBefore(panel, admin);
    }
    return panel;
  }

  function moveConfiguration() {
    const panel = ensureConfigTab();
    const host = q("#config-zone-main", panel);
    if (!host) return;

    const startup = findCard("Startup Load Control");
    if (startup && startup.parentElement !== host) host.appendChild(startup);

    const duplicate = findCard("Startup Loading");
    if (duplicate && duplicate !== startup) duplicate.remove();

    const trash = findCard("Trash settings");
    if (trash && trash.parentElement !== host) host.appendChild(trash);
  }

  function arrangeSystem() {
    const system = q("#tab-system");
    if (!system) return;

    qa(".flow-card", system).forEach((card) => {
      const heading = q(".flow-heading strong", card);
      if (heading?.textContent.trim() === "Shared MCP") heading.textContent = "Web Panel Usage";
    });

    const telemetry = q(".sys-zone-telemetry", system);
    const serverControls = findCard("Server controls");
    if (telemetry && serverControls && serverControls.parentElement !== telemetry) {
      serverControls.classList.add("system-server-controls-inline");
      telemetry.appendChild(serverControls);
    }

    if (!q("#service-meta", system) && telemetry) {
      const meta = document.createElement("details");
      meta.id = "service-meta";
      meta.className = "card";
      meta.open = false;
      meta.innerHTML = `<summary>Service timing</summary><div class="service-meta-grid"><div><span>Uptime</span><strong id="service-uptime">—</strong></div><div><span>Last checked</span><strong id="service-last-checked">—</strong></div></div>`;
      telemetry.appendChild(meta);
    }

    let sessions = q("#system-sessions-clients", system);
    if (!sessions) {
      sessions = document.createElement("details");
      sessions.id = "system-sessions-clients";
      sessions.className = "card";
      sessions.open = false;
      sessions.innerHTML = `<summary>Sessions and connected clients</summary><div id="system-sessions-host"></div>`;
      system.appendChild(sessions);
    }

    const sessionsHost = q("#system-sessions-host", sessions);
    const clients = findCard("Connected MCP clients");
    if (clients && sessionsHost && clients.parentElement !== sessionsHost) sessionsHost.appendChild(clients);
    if (sessionsHost && !q("#active-session-summary", sessionsHost)) {
      const active = document.createElement("details");
      active.id = "active-session-summary";
      active.className = "card nested-card";
      active.innerHTML = `<summary>Active Panel sessions</summary><p class="muted-text">Session controls load from the System refresh action.</p><div id="active-session-list"></div>`;
      sessionsHost.prepend(active);
    }

    let emergency = q("#system-emergency", system);
    if (!emergency) {
      emergency = document.createElement("details");
      emergency.id = "system-emergency";
      emergency.className = "card hazard-card";
      emergency.open = false;
      emergency.innerHTML = `<summary>Emergency control</summary><div id="system-emergency-host"></div>`;
      system.appendChild(emergency);
    }
    const hardStop = findCard("Heavily guarded: Hard stop");
    const emergencyHost = q("#system-emergency-host", emergency);
    if (hardStop && emergencyHost && hardStop.parentElement !== emergencyHost) emergencyHost.appendChild(hardStop);

    let logs = q("#system-all-logs", system);
    if (!logs) {
      logs = document.createElement("details");
      logs.id = "system-all-logs";
      logs.className = "card";
      logs.open = false;
      logs.innerHTML = `<summary>System logs</summary><div id="system-all-logs-host"></div>`;
      system.appendChild(logs);
    }
    const logsHost = q("#system-all-logs-host", logs);
    const hiveLogs = qa("#tab-system details").find((item) => q("summary", item)?.textContent.trim() === "OrbitFS activity logs");
    if (hiveLogs && logsHost && !logsHost.contains(hiveLogs)) logsHost.appendChild(hiveLogs);
    const diagnostics = q(".sys-zone-diagnostics", system);
    if (diagnostics && logsHost) {
      qa(":scope > details.card", diagnostics).forEach((card) => logsHost.appendChild(card));
      diagnostics.remove();
    }
  }

  function arrangeAdmin() {
    const host = q("#admin-zone-host");
    if (!host) return;

    if (!q("#system-role-definitions", host)) {
      const roles = document.createElement("details");
      roles.id = "system-role-definitions";
      roles.className = "card";
      roles.open = false;
      roles.innerHTML = `<summary>System role definitions</summary><div class="role-definition-grid"><article><strong>User</strong><p>Uses assigned tabs, files and actions.</p></article><article><strong>Admin</strong><p>Manages users, permissions, restrictions, configuration and infrastructure.</p></article></div>`;
      host.prepend(roles);
    }

    if (!q("#admin-login-security", host)) {
      const card = document.createElement("details");
      card.id = "admin-login-security";
      card.className = "card";
      card.open = false;
      card.innerHTML = `<summary>User status, login and IP</summary><div id="admin-login-security-list"><p class="muted-text">Use Admin refresh to load account details.</p></div>`;
      host.appendChild(card);
    }

    if (!q("#admin-audit-log", host)) {
      const card = document.createElement("details");
      card.id = "admin-audit-log";
      card.className = "card";
      card.open = false;
      card.innerHTML = `<summary>Connection and admin audit log</summary><div id="admin-audit-list"><p class="muted-text">Connection and administrator actions only.</p></div>`;
      host.appendChild(card);
    }

    const permissions = findCard("File permissions");
    if (permissions) {
      permissions.classList.add("progressive-permissions");
      const table = q("#permissions-table", permissions);
      if (table && !table.dataset.progressiveWired) {
        table.dataset.progressiveWired = "1";
        table.addEventListener("click", (event) => {
          const row = event.target.closest("tbody tr");
          if (!row) return;
          qa("tbody tr", table).forEach((item) => item.classList.toggle("permission-selected", item === row));
        });
      }
    }
  }

  async function refreshSystemExtra() {
    const checked = q("#service-last-checked");
    const uptime = q("#service-uptime");
    try {
      const status = await api("/api/system/status");
      const seconds = Number(status?.uptimeSeconds ?? status?.panel?.uptimeSeconds ?? status?.services?.panel?.uptimeSeconds);
      if (uptime) {
        const hours = Number.isFinite(seconds) ? Math.floor(seconds / 3600) : null;
        uptime.textContent = hours == null ? "Unavailable" : `${hours}h`;
      }
      if (checked) checked.textContent = new Date().toLocaleTimeString();
    } catch {
      if (checked) checked.textContent = new Date().toLocaleTimeString();
      if (uptime) uptime.textContent = "Unavailable";
    }
  }

  function wireRefresh() {
    const config = q("#config-refresh-btn");
    if (config && !config.dataset.wired) {
      config.dataset.wired = "1";
      config.addEventListener("click", async () => {
        config.disabled = true;
        config.textContent = "⟳ Refreshing…";
        try {
          if (typeof loadStartupConfig === "function") await loadStartupConfig();
          if (typeof loadSystem === "function") await loadSystem();
        } finally {
          config.disabled = false;
          config.textContent = "⟳ Refresh";
        }
      });
    }

    const system = q("#system-refresh-btn");
    if (system && !system.dataset.stableExtra) {
      system.dataset.stableExtra = "1";
      system.addEventListener("click", () => setTimeout(refreshSystemExtra, 0));
    }
  }

  function installStyles() {
    const style = document.createElement("style");
    style.textContent = `
      .system-server-controls-inline{margin-top:12px}
      .service-meta-grid,.role-definition-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:10px}
      .service-meta-grid>div,.role-definition-grid article{padding:10px;border:1px solid var(--border,#30384a);border-radius:9px;background:rgba(255,255,255,.025)}
      .service-meta-grid span,.role-definition-grid p{color:var(--muted,#9aa3b2);font-size:13px}
      .nested-card{margin-top:8px}
      .progressive-permissions #permissions-table tbody tr:not(.permission-selected) button,
      .progressive-permissions #permissions-table tbody tr:not(.permission-selected) select,
      .progressive-permissions #permissions-table tbody tr:not(.permission-selected) input[type="checkbox"]{display:none!important}
      .progressive-permissions #permissions-table tbody tr{cursor:pointer}
      .progressive-permissions #permissions-table tbody tr.permission-selected{background:rgba(91,140,255,.08)}
      #tab-system>details.card,#tab-admin details.card,#tab-config details.card{margin-bottom:10px}
      @media(max-width:650px){.service-meta-grid,.role-definition-grid{grid-template-columns:1fr}}
    `;
    document.head.appendChild(style);
  }

  function apply() {
    moveConfiguration();
    arrangeSystem();
    arrangeAdmin();
    wireRefresh();
  }

  function install() {
    installStyles();
    apply();
    refreshSystemExtra();
    document.querySelectorAll(".tab-btn").forEach((button) => {
      if (button.dataset.stableAdminWired) return;
      button.dataset.stableAdminWired = "1";
      button.addEventListener("click", () => requestAnimationFrame(apply));
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
})();
(() => {
  if (window.__orbitNotificationCenterLoaded) return;
  window.__orbitNotificationCenterLoaded = true;

  const CATEGORY_LABELS = {
    workspace_invites: "Workspace invitations",
    membership_changes: "Membership changes",
    role_changes: "Role changes",
    workspace_status: "Workspace status",
    workspace_messages: "Workspace messages",
    global_messages: "Global messages",
    lifecycle_warnings: "Lifecycle warnings",
    ownership_changes: "Ownership changes",
  };
  const CATEGORY_HELP = {
    workspace_invites: "Invitations, declines and revoked invitations.",
    membership_changes: "Joins, leaves, additions and removals.",
    role_changes: "Changes to your role inside a workspace.",
    workspace_status: "Workspace suspension and restoration.",
    workspace_messages: "Messages sent by a workspace owner or delegated manager.",
    global_messages: "Platform-wide messages sent by system administrators.",
    lifecycle_warnings: "Offline, inactivity and scheduled deletion warnings.",
    ownership_changes: "Workspace ownership transfers and decisions.",
  };
  let currentView = "all";
  let notifications = [];
  let pollTimer = null;

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;",
    })[char]);
  }

  function relativeTime(value) {
    const ms = Date.now() - new Date(value).getTime();
    const minutes = Math.max(0, Math.floor(ms / 60000));
    if (minutes < 1) return "Just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(value).toLocaleDateString();
  }

  function ensureStyles() {
    if (document.querySelector('link[data-orbit-notification-style="1"]')) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "notification-center.css?v=20260715-critical";
    link.dataset.orbitNotificationStyle = "1";
    document.head.appendChild(link);
  }

  function ensureUi() {
    ensureStyles();
    const status = document.querySelector(".status-pills");
    if (status && !document.getElementById("notification-button")) {
      const button = document.createElement("button");
      button.id = "notification-button";
      button.type = "button";
      button.className = "notification-button";
      button.setAttribute("aria-label", "Notifications");
      button.innerHTML = `<span class="notification-button-icon" aria-hidden="true">${String.fromCodePoint(0x1f514)}</span><span id="notification-badge" class="notification-badge hidden">0</span>`;
      status.insertBefore(button, document.getElementById("logout"));
      button.addEventListener("click", openDrawer);
    }
    if (!document.getElementById("notification-overlay")) {
      const overlay = document.createElement("div");
      overlay.id = "notification-overlay";
      overlay.className = "notification-overlay hidden";
      overlay.innerHTML = `
        <aside class="notification-drawer" role="dialog" aria-modal="true" aria-label="Notifications">
          <div class="notification-drawer-head"><div><h2>Notifications</h2><p id="notification-summary">Loading...</p></div><button id="notification-read-all" type="button">Read all</button><button id="notification-close" type="button">Close</button></div>
          <div class="notification-tabs"><button type="button" class="active" data-notification-view="all">All</button><button type="button" data-notification-view="unread">Unread</button><button type="button" data-notification-view="settings">Settings</button></div>
          <div id="notification-view-all" class="notification-view"><div id="notification-list" class="notification-list"></div></div>
          <div id="notification-view-settings" class="notification-view hidden"><form id="notification-preferences" class="notification-preferences"></form></div>
        </aside>`;
      document.body.appendChild(overlay);
      overlay.addEventListener("click", (event) => { if (event.target === overlay) closeDrawer(); });
      document.getElementById("notification-close").addEventListener("click", closeDrawer);
      document.getElementById("notification-read-all").addEventListener("click", markAllRead);
      overlay.querySelectorAll("[data-notification-view]").forEach((button) => button.addEventListener("click", () => switchNotificationView(button.dataset.notificationView)));
    }
  }

  async function openDrawer() {
    ensureUi();
    document.getElementById("notification-overlay").classList.remove("hidden");
    await loadNotifications();
    if (currentView === "settings") await loadPreferences();
  }

  function closeDrawer() {
    document.getElementById("notification-overlay")?.classList.add("hidden");
  }

  async function switchNotificationView(view) {
    currentView = view;
    document.querySelectorAll("[data-notification-view]").forEach((button) => button.classList.toggle("active", button.dataset.notificationView === view));
    document.getElementById("notification-view-all")?.classList.toggle("hidden", view === "settings");
    document.getElementById("notification-view-settings")?.classList.toggle("hidden", view !== "settings");
    if (view === "settings") await loadPreferences();
    else await loadNotifications();
  }

  async function loadNotifications() {
    if (!state.token) return;
    try {
      const result = await api(`/api/notifications?limit=100&unreadOnly=${currentView === "unread"}`);
      notifications = result.notifications || [];
      renderNotifications(result.unreadCount || 0);
    } catch (error) {
      const list = document.getElementById("notification-list");
      if (list) list.innerHTML = `<p class="error">${esc(error.message)}</p>`;
    }
  }

  function updateBadge(unreadCount) {
    const badge = document.getElementById("notification-badge");
    if (!badge) return;
    badge.textContent = unreadCount > 99 ? "99+" : String(unreadCount || 0);
    badge.classList.toggle("hidden", !unreadCount);
    document.getElementById("notification-button")?.setAttribute("aria-label", unreadCount ? `Notifications, ${unreadCount} unread` : "Notifications");
  }

  function notificationSource(item) {
    const manualMessage = item?.event_type === "global_message" || item?.event_type === "workspace_message";
    if (manualMessage && item?.actor_username) return item.actor_username;
    return "OrbitFS System";
  }

  function renderNotifications(unreadCount) {
    updateBadge(unreadCount);
    const summary = document.getElementById("notification-summary");
    if (summary) summary.textContent = unreadCount ? `${unreadCount} unread` : "You're all caught up";
    const list = document.getElementById("notification-list");
    if (!list) return;
    if (!notifications.length) {
      list.innerHTML = `<div class="notification-empty">${currentView === "unread" ? "No unread notifications." : "No notifications yet."}</div>`;
      renderCriticalBanner([]);
      return;
    }
    list.innerHTML = notifications.map((item) => `
      <article class="notification-item ${item.read_at ? "" : "unread"}" data-notification-id="${esc(item.id)}" data-severity="${esc(item.severity)}">
        <button type="button" class="notification-dismiss" aria-label="Dismiss">x</button>
        <div class="notification-item-head"><strong>${esc(item.title)}</strong><time datetime="${esc(item.created_at)}">${esc(relativeTime(item.created_at))}</time></div>
        <p>${esc(item.message)}</p>
        <div class="notification-item-meta"><span>${esc(CATEGORY_LABELS[item.category] || item.category)}</span>${item.workspace_name ? `<span>${esc(item.workspace_name)}</span>` : ""}<span>From ${esc(notificationSource(item))}</span></div>
        <div class="notification-item-actions">${item.workspace_id ? `<button type="button" class="notification-open-workspace">Open workspace</button>` : ""}${!item.read_at ? `<button type="button" class="notification-mark-read">Mark read</button>` : ""}</div>
      </article>`).join("");
    list.querySelectorAll(".notification-item").forEach((card) => wireNotificationCard(card));
    renderCriticalBanner(notifications);
  }

  function wireNotificationCard(card) {
    const id = card.dataset.notificationId;
    card.querySelector(".notification-mark-read")?.addEventListener("click", () => markRead(id));
    card.querySelector(".notification-dismiss")?.addEventListener("click", () => dismissNotificationItem(id));
    card.querySelector(".notification-open-workspace")?.addEventListener("click", async () => {
      const item = notifications.find((entry) => String(entry.id) === String(id));
      if (!item?.workspace_id) return;
      await markRead(id, false);
      closeDrawer();
      if (typeof activateWorkspace === "function") await activateWorkspace(item.workspace_id, { openFiles: false });
      if (typeof switchTab === "function") switchTab("workspaces");
    });
  }

  function renderCriticalBanner(items) {
    let banner = document.getElementById("notification-critical-banner");
    const critical = items.find((item) => item.severity === "critical" && !item.read_at);
    if (!critical) { banner?.remove(); return; }
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "notification-critical-banner";
      banner.className = "notification-critical-banner";
      banner.setAttribute("role", "alert");
      document.getElementById("current-user")?.insertAdjacentElement("afterend", banner);
    }
    banner.innerHTML = `<div class="notification-critical-copy"><span class="notification-critical-label">CRITICAL ALERT</span><strong>${esc(critical.title)}</strong><p>${esc(critical.message)}</p></div><button type="button">Open alert</button>`;
    banner.querySelector("button").addEventListener("click", async () => {
      await openDrawer();
      const card = document.querySelector(`[data-notification-id="${CSS.escape(String(critical.id))}"]`);
      card?.scrollIntoView({ block: "center" });
    });
  }

  async function markRead(id, reload = true) {
    try {
      await api(`/api/notifications/${encodeURIComponent(id)}/read`, { method: "PATCH" });
      if (reload) await loadNotifications(); else await refreshUnreadCount();
    } catch (error) { console.error(error); }
  }

  async function markAllRead() {
    try {
      await api("/api/notifications/read-all", { method: "POST" });
      await loadNotifications();
    } catch (error) { console.error(error); }
  }

  async function dismissNotificationItem(id) {
    try {
      await api(`/api/notifications/${encodeURIComponent(id)}`, { method: "DELETE" });
      await loadNotifications();
    } catch (error) { console.error(error); }
  }

  async function refreshUnreadCount() {
    if (!state.token) return;
    try {
      const result = await api("/api/notifications/unread-count");
      updateBadge(result.unreadCount || 0);
      if (result.unreadCount) {
        const criticalResult = await api("/api/notifications?limit=10&unreadOnly=true");
        renderCriticalBanner(criticalResult.notifications || []);
      } else renderCriticalBanner([]);
    } catch {}
  }

  async function loadPreferences() {
    const form = document.getElementById("notification-preferences");
    if (!form || !state.token) return;
    form.innerHTML = '<p class="muted-text">Loading preferences...</p>';
    try {
      const { preferences } = await api("/api/notification-preferences");
      form.innerHTML = Object.keys(CATEGORY_LABELS).map((category) => `
        <label class="notification-preference-row">
          <span><strong>${esc(CATEGORY_LABELS[category])}</strong><small>${esc(CATEGORY_HELP[category])}</small></span>
          <input type="checkbox" name="${esc(category)}" ${preferences?.[category] !== false ? "checked" : ""}>
        </label>`).join("") + '<p class="muted-text">Critical administrator alerts and deletion warnings cannot be disabled.</p>';
      form.querySelectorAll('input[type="checkbox"]').forEach((input) => input.addEventListener("change", async () => {
        input.disabled = true;
        try {
          await api("/api/notification-preferences", {
            method: "PATCH", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ [input.name]: input.checked }),
          });
        } catch (error) {
          input.checked = !input.checked;
          alert(error.message);
        } finally { input.disabled = false; }
      }));
    } catch (error) {
      form.innerHTML = `<p class="error">${esc(error.message)}</p>`;
    }
  }

  function ensureAdminComposer() {
    const host = document.getElementById("admin-zone-host");
    if (!host || state.role !== "admin") return;
    if (document.getElementById("notification-admin-card")) return;
    const card = document.createElement("details");
    card.id = "notification-admin-card";
    card.className = "card notification-admin-card";
    card.innerHTML = `
      <summary>Global alerts and messages</summary>
      <p class="muted-text">Send a notification to all users, users only, or administrators. Critical alerts bypass user preferences.</p>
      <form id="notification-global-form">
        <div class="notification-admin-grid"><label>Audience<select name="audience"><option value="all">Everyone</option><option value="users">Users only</option><option value="admins">Admins only</option></select></label><label>Type<select name="severity"><option value="info">Message</option><option value="warning">Warning</option><option value="critical">Critical alert</option></select></label></div>
        <label>Title<input name="title" type="text" maxlength="160" required></label>
        <label>Message<textarea name="message" maxlength="2000" required></textarea></label>
        <button type="submit" class="primary">Send notification</button><p class="notification-global-message muted-text"></p>
      </form>
      <div id="notification-admin-history" class="notification-admin-history"></div>`;
    host.prepend(card);
    card.querySelector("form").addEventListener("submit", sendGlobalMessage);
    loadAdminMessageHistory();
  }

  async function sendGlobalMessage(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const message = form.querySelector(".notification-global-message");
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true; message.textContent = "Sending...";
    try {
      const result = await api("/api/admin/notifications/global", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audience: form.elements.audience.value,
          severity: form.elements.severity.value,
          title: form.elements.title.value.trim(),
          message: form.elements.message.value.trim(),
        }),
      });
      form.reset();
      message.textContent = `Sent to ${result.delivered} account${result.delivered === 1 ? "" : "s"}.`;
      await loadAdminMessageHistory();
      await refreshUnreadCount();
    } catch (error) { message.textContent = error.message; }
    finally { submit.disabled = false; }
  }

  async function loadAdminMessageHistory() {
    const host = document.getElementById("notification-admin-history");
    if (!host || state.role !== "admin") return;
    try {
      const { messages } = await api("/api/admin/notification-messages?limit=20");
      host.innerHTML = messages.length ? messages.map((item) => `
        <article><strong>${esc(item.title)}</strong><p>${esc(item.body)}</p><small>${esc(item.audience_type === "workspace" ? item.workspace_name || "Workspace" : item.audience_filter || "Global")} · ${esc(item.severity)} · ${esc(relativeTime(item.created_at))}</small></article>`).join("") : '<p class="muted-text">No messages sent yet.</p>';
    } catch (error) { host.innerHTML = `<p class="error">${esc(error.message)}</p>`; }
  }

  function ensureWorkspaceComposer() {
    if (document.getElementById("workspace-message-overlay")) return;
    const overlay = document.createElement("div");
    overlay.id = "workspace-message-overlay";
    overlay.className = "workspace-message-overlay hidden";
    overlay.innerHTML = `
      <div class="workspace-message-box" role="dialog" aria-modal="true">
        <h2>Message workspace</h2><p id="workspace-message-target"></p>
        <form id="workspace-message-form" class="workspace-message-form">
          <label>Type<select name="severity"><option value="info">Message</option><option value="warning">Warning</option></select></label>
          <label>Title<input name="title" type="text" maxlength="160" required></label>
          <label>Message<textarea name="message" maxlength="2000" required></textarea></label>
          <div class="workspace-message-actions"><button type="button" class="workspace-message-cancel">Cancel</button><button type="submit" class="primary">Send</button></div>
          <p class="workspace-message-result muted-text"></p>
        </form>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (event) => { if (event.target === overlay) closeWorkspaceComposer(); });
    overlay.querySelector(".workspace-message-cancel").addEventListener("click", closeWorkspaceComposer);
    overlay.querySelector("form").addEventListener("submit", sendWorkspaceMessage);
  }

  function openWorkspaceComposer(workspace) {
    ensureWorkspaceComposer();
    const overlay = document.getElementById("workspace-message-overlay");
    overlay.dataset.workspaceId = workspace.id;
    document.getElementById("workspace-message-target").textContent = `Send to members of ${workspace.name}.`;
    const severity = overlay.querySelector('[name="severity"]');
    if (state.role === "admin" && !severity.querySelector('[value="critical"]')) {
      severity.appendChild(Object.assign(document.createElement("option"), { value: "critical", textContent: "Critical alert" }));
    }
    overlay.querySelector("form").reset();
    overlay.querySelector(".workspace-message-result").textContent = "";
    overlay.classList.remove("hidden");
    overlay.querySelector('[name="title"]').focus();
  }

  function closeWorkspaceComposer() {
    document.getElementById("workspace-message-overlay")?.classList.add("hidden");
  }

  async function sendWorkspaceMessage(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const overlay = document.getElementById("workspace-message-overlay");
    const resultHost = form.querySelector(".workspace-message-result");
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true; resultHost.textContent = "Sending...";
    try {
      const result = await api(`/api/workspaces/${encodeURIComponent(overlay.dataset.workspaceId)}/messages`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          severity: form.elements.severity.value,
          title: form.elements.title.value.trim(),
          message: form.elements.message.value.trim(),
        }),
      });
      resultHost.textContent = `Sent to ${result.delivered} member${result.delivered === 1 ? "" : "s"}.`;
      setTimeout(closeWorkspaceComposer, 700);
      await loadAdminMessageHistory();
    } catch (error) { resultHost.textContent = error.message; }
    finally { submit.disabled = false; }
  }

  function decorateWorkspaceMessageButtons() {
    document.querySelectorAll("#workspace-admin-list .workspace-admin-card").forEach((card) => {
      if (card.querySelector(".workspace-message-btn")) return;
      const workspace = (state.workspaces || []).find((item) => String(item.id) === String(card.dataset.workspaceId));
      if (!workspace) return;
      const allowed = state.role === "admin" || workspace.permission === "owner" || workspace.management_permissions?.send_messages;
      if (!allowed) return;
      const actions = card.querySelector(".workspace-admin-actions");
      if (!actions) return;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "workspace-message-btn";
      button.textContent = "Message";
      button.addEventListener("click", () => openWorkspaceComposer(workspace));
      actions.appendChild(button);
    });
  }

  function watchWorkspaceCards() {
    const host = document.getElementById("workspace-admin-list");
    if (!host || host.dataset.notificationWatch === "1") return;
    host.dataset.notificationWatch = "1";
    new MutationObserver(() => decorateWorkspaceMessageButtons()).observe(host, { childList: true, subtree: true });
    decorateWorkspaceMessageButtons();
  }

  function startNotificationCenter() {
    ensureUi();
    ensureWorkspaceComposer();
    ensureAdminComposer();
    watchWorkspaceCards();
    decorateWorkspaceMessageButtons();
    refreshUnreadCount();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(refreshUnreadCount, 30000);
  }

  const baseShowApp = window.showApp;
  if (typeof baseShowApp === "function") {
    window.showApp = showApp = function notificationAwareShowApp() {
      baseShowApp();
      setTimeout(startNotificationCenter, 0);
    };
  }

  document.querySelectorAll(".tab-btn").forEach((button) => button.addEventListener("click", () => {
    if (button.dataset.tab === "admin") setTimeout(() => { ensureAdminComposer(); loadAdminMessageHistory(); }, 0);
    if (button.dataset.tab === "workspaces") setTimeout(decorateWorkspaceMessageButtons, 0);
  }));
  window.addEventListener("focus", refreshUnreadCount);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshUnreadCount(); });
  window.openWorkspaceNotificationComposer = openWorkspaceComposer;

  if (state.token) setTimeout(startNotificationCenter, 0);
})();

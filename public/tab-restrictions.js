(() => {
  if (window.__orbitTabRestrictionsLoaded) return;
  window.__orbitTabRestrictionsLoaded = true;

  async function loadMyRestrictions() {
    try {
      const result = await api("/api/tab-restrictions/me");
      const restricted = new Set(result.tabs || []);
      document.querySelectorAll(".tab-btn[data-tab]").forEach((button) => {
        const blocked = restricted.has(button.dataset.tab);
        button.classList.toggle("hidden", blocked);
        button.dataset.tabRestricted = blocked ? "1" : "0";
        const panel = document.getElementById(`tab-${button.dataset.tab}`);
        if (panel) panel.dataset.tabRestricted = blocked ? "1" : "0";
        if (blocked && button.classList.contains("active")) {
          document.querySelector('.tab-btn[data-tab="files"]')?.click();
        }
      });
    } catch (error) {
      console.error("Failed to load tab restrictions", error);
    }
  }

  function ensureAdminCard() {
    if (state.role !== "admin") return null;
    const host = document.getElementById("admin-zone-host");
    if (!host) return null;
    let card = document.getElementById("tab-restriction-admin");
    if (card) return card;
    card = document.createElement("details");
    card.id = "tab-restriction-admin";
    card.className = "card";
    card.open = true;
    card.innerHTML = `
      <summary>Tab access restrictions</summary>
      <p class="muted-text">Disable selected Panel tabs for individual users. Admin accounts always keep access.</p>
      <div id="tab-restriction-list" class="tab-restriction-list"></div>
      <p id="tab-restriction-message" class="muted-text"></p>`;
    host.appendChild(card);
    return card;
  }

  async function saveUserRestrictions(userId, tabs, button) {
    const original = button?.textContent;
    if (button) {
      button.disabled = true;
      button.textContent = "Saving…";
    }
    try {
      await api(`/api/tab-restrictions/${encodeURIComponent(userId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tabs }),
      });
      const message = document.getElementById("tab-restriction-message");
      if (message) message.textContent = "Saved.";
      setTimeout(() => { if (message) message.textContent = ""; }, 900);
    } catch (error) {
      alert(error.message);
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = original;
      }
    }
  }

  async function refreshAdmin() {
    if (state.role !== "admin") return;
    const card = ensureAdminCard();
    const list = card?.querySelector("#tab-restriction-list");
    if (!list) return;
    list.innerHTML = '<div class="tab-restriction-empty">Loading users…</div>';
    try {
      const result = await api("/api/tab-restrictions");
      const users = result.users || [];
      list.innerHTML = "";
      for (const user of users) {
        const row = document.createElement("div");
        row.className = "tab-restriction-row";
        const identity = document.createElement("div");
        identity.className = "tab-restriction-identity";
        identity.innerHTML = `<strong>${String(user.username || "")}</strong><small>${user.role === "admin" ? "Admin — unrestricted" : "User"}</small>`;
        const controls = document.createElement("div");
        controls.className = "tab-restriction-controls";
        if (user.role === "admin") {
          controls.textContent = "All tabs enabled";
        } else {
          const label = document.createElement("label");
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.checked = (user.tabs || []).includes("sorter");
          label.append(checkbox, document.createTextNode(" Restrict Sorter"));
          const save = document.createElement("button");
          save.type = "button";
          save.className = "primary";
          save.textContent = "Save";
          save.addEventListener("click", () => saveUserRestrictions(user.id, checkbox.checked ? ["sorter"] : [], save));
          controls.append(label, save);
        }
        row.append(identity, controls);
        list.appendChild(row);
      }
      if (!users.length) list.innerHTML = '<div class="tab-restriction-empty">No users found.</div>';
    } catch (error) {
      list.innerHTML = `<div class="tab-restriction-empty error">${error.message}</div>`;
    }
  }
  window.refreshTabRestrictionAdmin = refreshAdmin;

  function guardRestrictedTabs() {
    document.querySelectorAll(".tab-btn[data-tab]").forEach((button) => {
      if (button.dataset.restrictionGuard) return;
      button.dataset.restrictionGuard = "1";
      button.addEventListener("click", (event) => {
        if (button.dataset.tabRestricted !== "1") return;
        event.preventDefault();
        event.stopImmediatePropagation();
      }, true);
    });
  }

  function installStyles() {
    const style = document.createElement("style");
    style.textContent = `
      .tab-restriction-list{display:grid;gap:8px;margin-top:12px}
      .tab-restriction-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center;padding:11px;border:1px solid var(--border,#30384a);border-radius:10px;background:rgba(255,255,255,.025)}
      .tab-restriction-identity{display:grid;gap:2px}.tab-restriction-identity small{color:var(--muted,#9aa3b2)}
      .tab-restriction-controls{display:flex;gap:9px;align-items:center;flex-wrap:wrap;justify-content:flex-end}
      .tab-restriction-empty{padding:14px;text-align:center;color:var(--muted,#9aa3b2)}
      @media(max-width:600px){.tab-restriction-row{grid-template-columns:1fr}.tab-restriction-controls{justify-content:flex-start}}
    `;
    document.head.appendChild(style);
  }

  function install() {
    installStyles();
    guardRestrictedTabs();
    loadMyRestrictions();
    if (state.role === "admin") refreshAdmin();
    const observer = new MutationObserver(() => {
      guardRestrictedTabs();
      if (state.role === "admin") ensureAdminCard();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
})();
(() => {
  if (window.__orbitHiveHealthUiLoaded) return;
  window.__orbitHiveHealthUiLoaded = true;

  const q = (selector) => document.querySelector(selector);

  function installStyle() {
    if (q("#orbit-hive-health-style")) return;
    const style = document.createElement("style");
    style.id = "orbit-hive-health-style";
    style.textContent = `
      .primary-system-card.hive-online{border-color:color-mix(in srgb,var(--ok) 72%,var(--sys-line))!important;box-shadow:0 0 18px color-mix(in srgb,var(--ok) 26%,transparent)!important}
      .primary-system-card.hive-offline{border-color:color-mix(in srgb,var(--danger) 75%,var(--sys-line))!important;box-shadow:0 0 18px color-mix(in srgb,var(--danger) 30%,transparent)!important}
      .topology.hive-online .topology-node-hub{color:var(--ok)!important;border-color:var(--ok)!important;box-shadow:0 0 9px color-mix(in srgb,var(--ok) 70%,transparent)!important}
      .topology.hive-online .topology-pulse{background:var(--ok)!important;box-shadow:0 0 9px color-mix(in srgb,var(--ok) 70%,transparent)!important}
      .topology.hive-offline .topology-node-hub{color:var(--danger)!important;border-color:var(--danger)!important;box-shadow:0 0 9px color-mix(in srgb,var(--danger) 72%,transparent)!important}
      .topology.hive-offline .topology-pulse{background:var(--danger)!important;box-shadow:0 0 9px color-mix(in srgb,var(--danger) 72%,transparent)!important;animation:none!important;left:50%!important;opacity:1!important}
      .sys-zone .pill.down{box-shadow:0 0 8px color-mix(in srgb,var(--danger) 48%,transparent)!important}
    `;
    document.head.appendChild(style);
  }

  function renameUi() {
    const heading = [...document.querySelectorAll("strong")].find((el) => el.textContent.trim() === "ChatGPT ↔ Claude connection monitor");
    if (heading) heading.textContent = "OrbitFS connections";

    const diskRow = q("#disk-summary")?.closest(".infra-item");
    const label = diskRow?.querySelector("span:first-child");
    if (label && !label.id) label.id = "hive-drive-label";
    if (label && !label.textContent.includes("OrbitFS files drive")) label.textContent = "OrbitFS files drive";
  }

  function applyState(running, disk) {
    const card = q(".primary-system-card");
    const topology = q(".topology");
    for (const el of [card, topology]) {
      el?.classList.toggle("hive-online", running === true);
      el?.classList.toggle("hive-offline", running !== true);
    }

    const label = q("#hive-drive-label");
    if (label) label.textContent = disk?.label || "OrbitFS files drive";
    const summary = q("#disk-summary");
    if (summary && Number.isFinite(Number(disk?.freeGB))) summary.textContent = `${disk.freeGB} GB free`;
  }

  async function refresh() {
    renameUi();
    const token = localStorage.getItem("panelToken");
    if (!token) return;
    try {
      const response = await fetch("/api/system/status", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      const status = await response.json();
      applyState(status?.hive?.running === true, status?.disk || {});
    } catch {
      applyState(false, {});
    }
  }

  function install() {
    installStyle();
    renameUi();
    refresh();
    document.querySelectorAll(".tab-btn").forEach((button) => button.addEventListener("click", () => requestAnimationFrame(refresh)));
    q("#system-refresh-btn")?.addEventListener("click", () => setTimeout(refresh, 400));
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
    setInterval(refresh, 30000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
})();
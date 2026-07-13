(() => {
  if (window.__orbitStartupPickerLoaded) return;
  window.__orbitStartupPickerLoaded = true;

  const levels = ["low", "medium", "high"];
  const blockedParts = new Set(["archive", "archives", "_trash"]);
  let currentLevel = "medium";
  let currentPath = "";
  let entries = [];
  let filter = "";

  const normalize = (value = "") => String(value).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const isBlocked = (value = "") => normalize(value).split("/").some((part) => blockedParts.has(part.toLowerCase()));
  const inputFor = (level) => document.getElementById(`startup-files-${level}`);
  const valuesFor = (level) => (inputFor(level)?.value || "").split(/\r?\n/).map(normalize).filter(Boolean);
  const setValues = (level, values) => {
    const input = inputFor(level);
    if (input) input.value = [...new Set(values.map(normalize).filter(Boolean))].join("\n");
  };

  function injectStyles() {
    const style = document.createElement("style");
    style.textContent = `
      .startup-picker-shell{display:grid;gap:12px;margin-top:12px}
      .startup-level-tabs{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
      .startup-level-tabs button{min-height:44px;font-weight:700}
      .startup-level-tabs button.active{background:var(--accent,#5b8cff);color:#fff;border-color:transparent}
      .startup-selection-list{display:grid;gap:7px;min-height:52px}
      .startup-selection-row{display:grid;grid-template-columns:auto 1fr auto;gap:9px;align-items:center;padding:10px;border:1px solid var(--border,#2a3140);border-radius:10px;background:rgba(255,255,255,.025)}
      .startup-selection-path{min-width:0;overflow-wrap:anywhere;font-size:13px}
      .startup-selection-row button{min-width:42px;min-height:38px}
      .startup-browser{border:1px solid var(--border,#2a3140);border-radius:12px;overflow:hidden;background:rgba(0,0,0,.12)}
      .startup-browser-toolbar{display:grid;grid-template-columns:auto 1fr auto;gap:8px;padding:10px;border-bottom:1px solid var(--border,#2a3140)}
      .startup-browser-toolbar input{min-width:0}
      .startup-browser-path{padding:9px 11px;font-size:12px;overflow-wrap:anywhere;border-bottom:1px solid var(--border,#2a3140)}
      .startup-browser-list{display:grid;gap:6px;padding:8px;max-height:390px;overflow:auto}
      .startup-browser-row{display:grid;grid-template-columns:auto 1fr auto;gap:9px;align-items:center;padding:9px;border-radius:9px;border:1px solid transparent}
      .startup-browser-row:hover{background:rgba(91,140,255,.08);border-color:rgba(91,140,255,.28)}
      .startup-browser-name{min-width:0;overflow-wrap:anywhere;text-align:left;background:none;border:0;padding:4px;color:inherit}
      .startup-empty{padding:16px;text-align:center;color:var(--muted,#9aa3b2)}
      .startup-picker-note{font-size:12px}
      #startup-files-low,#startup-files-medium,#startup-files-high,.startup-config-legacy-label{display:none!important}
      @media(max-width:620px){.startup-browser-toolbar{grid-template-columns:auto 1fr}.startup-browser-toolbar button:last-child{grid-column:1/-1}.startup-selection-row{grid-template-columns:auto 1fr auto}.startup-browser-list{max-height:55vh}}
    `;
    document.head.appendChild(style);
  }

  function getProject() {
    return document.getElementById("startup-config-project")?.value || "1. Legal";
  }

  function renderSelections() {
    const list = document.getElementById("startup-selection-list");
    const count = document.getElementById("startup-selection-count");
    if (!list) return;
    const values = valuesFor(currentLevel);
    if (count) count.textContent = `${values.length} selected for ${currentLevel[0].toUpperCase()}${currentLevel.slice(1)}`;
    list.innerHTML = "";
    if (!values.length) {
      list.innerHTML = '<div class="startup-empty">No files or folders selected for this strength.</div>';
      return;
    }
    values.forEach((filepath) => {
      const row = document.createElement("div");
      row.className = "startup-selection-row";
      const icon = document.createElement("span");
      icon.textContent = /\.[^/]+$/.test(filepath) ? "📄" : "📁";
      const pathEl = document.createElement("div");
      pathEl.className = "startup-selection-path";
      pathEl.textContent = filepath;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger";
      remove.textContent = "✕";
      remove.title = "Remove from preset";
      remove.addEventListener("click", () => {
        setValues(currentLevel, valuesFor(currentLevel).filter((value) => value !== filepath));
        renderSelections();
      });
      row.append(icon, pathEl, remove);
      list.appendChild(row);
    });
  }

  function activateLevel(level) {
    currentLevel = level;
    document.querySelectorAll("[data-startup-level]").forEach((button) => button.classList.toggle("active", button.dataset.startupLevel === level));
    renderSelections();
  }

  function addSelection(filepath) {
    const normalized = normalize(filepath);
    const message = document.getElementById("startup-config-message");
    if (!normalized || isBlocked(normalized)) {
      if (message) message.textContent = "Archive and _trash cannot be added to startup presets.";
      return;
    }
    const values = valuesFor(currentLevel);
    if (!values.includes(normalized)) setValues(currentLevel, [...values, normalized]);
    if (message) message.textContent = `Added to ${currentLevel}. Save presets to apply.`;
    renderSelections();
  }

  async function loadFolder(pathValue = "") {
    currentPath = normalize(pathValue);
    const list = document.getElementById("startup-browser-list");
    const breadcrumb = document.getElementById("startup-browser-path");
    if (breadcrumb) breadcrumb.textContent = currentPath ? `/${currentPath}` : "/";
    if (list) list.innerHTML = '<div class="startup-empty">Loading…</div>';
    try {
      const result = await api(`/api/files?subpath=${encodeURIComponent(currentPath)}`);
      entries = (result.entries || []).filter((entry) => !isBlocked(currentPath ? `${currentPath}/${entry.name}` : entry.name));
      renderBrowser();
    } catch (error) {
      if (list) list.innerHTML = `<div class="startup-empty">${String(error.message || error)}</div>`;
    }
  }

  function renderBrowser() {
    const list = document.getElementById("startup-browser-list");
    if (!list) return;
    list.innerHTML = "";
    const shown = entries
      .filter((entry) => !filter || entry.name.toLowerCase().includes(filter.toLowerCase()))
      .sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1);
    if (!shown.length) {
      list.innerHTML = '<div class="startup-empty">No matching files or folders.</div>';
      return;
    }
    shown.forEach((entry) => {
      const full = normalize(currentPath ? `${currentPath}/${entry.name}` : entry.name);
      const row = document.createElement("div");
      row.className = "startup-browser-row";
      const icon = document.createElement("span");
      icon.textContent = entry.type === "dir" ? "📁" : "📄";
      const name = document.createElement("button");
      name.type = "button";
      name.className = "startup-browser-name";
      name.textContent = entry.name;
      name.addEventListener("click", () => entry.type === "dir" ? loadFolder(full) : addSelection(full));
      const action = document.createElement("button");
      action.type = "button";
      action.textContent = entry.type === "dir" ? "+ Folder" : "+ File";
      action.addEventListener("click", () => addSelection(full));
      row.append(icon, name, action);
      list.appendChild(row);
    });
  }

  function buildPicker() {
    const form = document.getElementById("startup-config-form");
    if (!form || document.getElementById("startup-picker-shell")) return;
    form.querySelectorAll("label.field-label").forEach((label) => {
      if (["Low", "Medium", "High"].includes(label.textContent.trim())) label.classList.add("startup-config-legacy-label");
    });
    const project = document.getElementById("startup-config-project");
    const shell = document.createElement("div");
    shell.id = "startup-picker-shell";
    shell.className = "startup-picker-shell";
    shell.innerHTML = `
      <div class="startup-level-tabs">
        <button type="button" data-startup-level="low">Low</button>
        <button type="button" data-startup-level="medium" class="active">Medium</button>
        <button type="button" data-startup-level="high">High</button>
      </div>
      <div class="toolbar"><strong id="startup-selection-count">0 selected</strong><span class="spacer"></span><button type="button" id="startup-clear-level">Clear level</button></div>
      <div id="startup-selection-list" class="startup-selection-list"></div>
      <div class="startup-browser">
        <div class="startup-browser-toolbar">
          <button type="button" id="startup-browser-up">← Up</button>
          <input id="startup-browser-search" type="search" placeholder="Search this folder" autocomplete="off" />
          <button type="button" id="startup-add-current-folder">+ Add current folder</button>
        </div>
        <div id="startup-browser-path" class="startup-browser-path">/</div>
        <div id="startup-browser-list" class="startup-browser-list"></div>
      </div>
      <p class="muted-text startup-picker-note">Tap a folder name to open it. Use + Folder to load everything readable inside that folder. Archive and _trash are excluded.</p>`;
    project.insertAdjacentElement("afterend", shell);

    shell.querySelectorAll("[data-startup-level]").forEach((button) => button.addEventListener("click", () => activateLevel(button.dataset.startupLevel)));
    document.getElementById("startup-clear-level").addEventListener("click", () => {
      if (!confirm(`Clear all ${currentLevel} preset selections?`)) return;
      setValues(currentLevel, []);
      renderSelections();
    });
    document.getElementById("startup-browser-up").addEventListener("click", () => loadFolder(currentPath.split("/").slice(0, -1).join("/")));
    document.getElementById("startup-add-current-folder").addEventListener("click", () => currentPath && addSelection(currentPath));
    document.getElementById("startup-browser-search").addEventListener("input", (event) => { filter = event.target.value; renderBrowser(); });
    project.addEventListener("change", () => setTimeout(() => { renderSelections(); loadFolder(""); }, 0));

    const originalRender = window.renderStartupConfig;
    if (typeof originalRender === "function") {
      window.renderStartupConfig = function renderStartupConfigWithPicker(...args) {
        const result = originalRender.apply(this, args);
        renderSelections();
        return result;
      };
    }
    activateLevel("medium");
    loadFolder("");
  }

  injectStyles();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", buildPicker, { once: true });
  else buildPicker();
})();

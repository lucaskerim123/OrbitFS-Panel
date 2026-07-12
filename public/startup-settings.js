(() => {
  const CONFIG_PATH = "_system/Config/startup-loading.json";
  const defaults = {
    defaultProject: "Mental",
    defaultStrength: "med",
    includeMasterProfiles: false,
    includeFolders: ["0. Core"],
    excludeFolders: ["_trash", "archive", "archives", "2. Wellbeing/Pure Vent Mode"],
    levels: {
      low: { maxFiles: 0, maxCharacters: 60000, perFileCharacters: 30000 },
      med: { maxFiles: 24, maxCharacters: 240000, perFileCharacters: 50000 },
      high: { maxFiles: 80, maxCharacters: 700000, perFileCharacters: 90000 },
    },
  };

  function mergeConfig(value = {}) {
    return {
      ...defaults,
      ...value,
      levels: {
        low: { ...defaults.levels.low, ...(value.levels?.low || {}) },
        med: { ...defaults.levels.med, ...(value.levels?.med || {}) },
        high: { ...defaults.levels.high, ...(value.levels?.high || {}) },
      },
    };
  }

  function inject() {
    if (document.getElementById("startup-loading-card")) return;
    const admin = document.querySelector(".sys-zone-admin");
    if (!admin) return;
    const card = document.createElement("details");
    card.id = "startup-loading-card";
    card.className = "card";
    card.innerHTML = `
      <summary>Startup loading</summary>
      <p class="muted-text">Shared by the web panel and the ChatGPT Hive app.</p>
      <form id="startup-settings-form">
        <div class="startup-settings-grid">
          <label>Default project<select id="startup-default-project"><option>Master</option><option>Court</option><option>Mental</option><option>Media</option><option>Combined</option></select></label>
          <label>Default strength<select id="startup-default-strength"><option value="low">Low</option><option value="med">Medium</option><option value="high">High</option></select></label>
          <label>Always include folders<input id="startup-include-folders" placeholder="comma separated Hive paths" /></label>
          <label>Exclude folders<input id="startup-exclude-folders" placeholder="comma separated Hive paths" /></label>
          <label class="startup-check"><input id="startup-include-profiles" type="checkbox" /> Load all Master Profiles automatically</label>
        </div>
        <div class="startup-settings-levels">
          ${["low","med","high"].map((level) => `<div class="startup-level"><strong>${level.toUpperCase()}</strong><label>Maximum files<input id="startup-${level}-files" type="number" min="0" max="500" /></label><label>Total characters<input id="startup-${level}-chars" type="number" min="1000" max="5000000" /></label><label>Per-file characters<input id="startup-${level}-per-file" type="number" min="1000" max="1000000" /></label></div>`).join("")}
        </div>
        <div class="startup-settings-actions"><button type="submit" class="primary">Save configuration</button><button id="startup-settings-reload" type="button">Reload</button><button id="startup-settings-preview-btn" type="button">Preview configuration</button></div>
        <p id="startup-settings-message" class="muted-text"></p>
        <pre id="startup-settings-preview" class="log-view startup-settings-preview hidden"></pre>
      </form>`;
    admin.insertBefore(card, admin.children[1] || null);
    card.querySelector("form").addEventListener("submit", save);
    card.querySelector("#startup-settings-reload").addEventListener("click", load);
    card.querySelector("#startup-settings-preview-btn").addEventListener("click", () => {
      const preview = document.getElementById("startup-settings-preview");
      preview.textContent = JSON.stringify(readForm(), null, 2);
      preview.classList.toggle("hidden");
    });
    load();
  }

  async function load() {
    const message = document.getElementById("startup-settings-message");
    if (!message) return;
    message.textContent = "Loading…";
    let config = defaults;
    try {
      const result = await api(`/api/file?path=${encodeURIComponent(CONFIG_PATH)}`);
      config = mergeConfig(JSON.parse(result.content || "{}"));
      message.textContent = `Loaded ${CONFIG_PATH}`;
    } catch {
      config = mergeConfig();
      message.textContent = "Using defaults until saved.";
    }
    writeForm(config);
  }

  function values(id) { return document.getElementById(id).value.split(",").map((v) => v.trim()).filter(Boolean); }
  function readForm() {
    return {
      defaultProject: document.getElementById("startup-default-project").value,
      defaultStrength: document.getElementById("startup-default-strength").value,
      includeMasterProfiles: document.getElementById("startup-include-profiles").checked,
      includeFolders: values("startup-include-folders"),
      excludeFolders: values("startup-exclude-folders"),
      levels: Object.fromEntries(["low","med","high"].map((level) => [level, {
        maxFiles: Number(document.getElementById(`startup-${level}-files`).value),
        maxCharacters: Number(document.getElementById(`startup-${level}-chars`).value),
        perFileCharacters: Number(document.getElementById(`startup-${level}-per-file`).value),
      }])),
    };
  }

  function writeForm(config) {
    document.getElementById("startup-default-project").value = config.defaultProject;
    document.getElementById("startup-default-strength").value = config.defaultStrength;
    document.getElementById("startup-include-profiles").checked = !!config.includeMasterProfiles;
    document.getElementById("startup-include-folders").value = (config.includeFolders || []).join(", ");
    document.getElementById("startup-exclude-folders").value = (config.excludeFolders || []).join(", ");
    for (const level of ["low","med","high"]) {
      document.getElementById(`startup-${level}-files`).value = config.levels[level].maxFiles;
      document.getElementById(`startup-${level}-chars`).value = config.levels[level].maxCharacters;
      document.getElementById(`startup-${level}-per-file`).value = config.levels[level].perFileCharacters;
    }
  }

  async function save(event) {
    event.preventDefault();
    const message = document.getElementById("startup-settings-message");
    const config = mergeConfig(readForm());
    message.textContent = "Saving…";
    try {
      await api("/api/file", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: CONFIG_PATH, content: `${JSON.stringify(config, null, 2)}\n` }) });
      message.textContent = "Saved. ChatGPT startup will use this configuration on its next run.";
    } catch (error) { message.textContent = error.message; }
  }

  const observer = new MutationObserver(inject);
  observer.observe(document.body, { childList: true, subtree: true });
  inject();
})();
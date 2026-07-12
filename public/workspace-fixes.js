(() => {
  const CONTEXT_KEY = "orbitfsPanelContextFiles";
  const BLOCKED = new Set(["_trash", ".git", "node_modules", "archive", "archives"]);
  const normalize = (value) => String(value || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const join = (...parts) => normalize(parts.filter(Boolean).join("/"));
  const nameOf = (path) => normalize(path).split("/").filter(Boolean).pop() || "";
  const isBlocked = (path) => normalize(path).split("/").some((part) => BLOCKED.has(part.toLowerCase()));

  function readContext() {
    try { return JSON.parse(localStorage.getItem(CONTEXT_KEY) || "[]"); }
    catch { return []; }
  }

  function writeContext(files) {
    localStorage.setItem(CONTEXT_KEY, JSON.stringify(files));
  }

  async function addFile(path) {
    if (isBlocked(path)) return false;
    const { content = "" } = await api(`/api/file?path=${encodeURIComponent(path)}`);
    const existing = readContext();
    const old = existing.find((item) => item.path === path);
    const entry = {
      path,
      name: nameOf(path),
      characters: String(content).length,
      loadedAt: new Date().toISOString(),
      pinned: old?.pinned || false,
      profile: /master[_\s-]*profile/i.test(nameOf(path)),
    };
    writeContext([entry, ...existing.filter((item) => item.path !== path)]);
    return true;
  }

  async function collectFiles(folder, output = [], depth = 0) {
    if (depth > 8 || output.length >= 300 || isBlocked(folder)) return output;
    const { entries = [] } = await api(`/api/files?subpath=${encodeURIComponent(folder)}`);
    for (const entry of entries) {
      const path = join(folder, entry.name);
      if (isBlocked(path)) continue;
      if (entry.type === "file") output.push(path);
      else await collectFiles(path, output, depth + 1);
      if (output.length >= 300) break;
    }
    return output;
  }

  function refreshContextUi() {
    document.getElementById("context-refresh")?.click();
  }

  const loadPathButton = document.getElementById("context-load-path");
  loadPathButton?.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    const status = document.getElementById("context-status");
    const path = normalize(document.getElementById("context-path")?.value);
    if (!path) return;
    if (isBlocked(path)) {
      status.textContent = "That folder is excluded from context loading.";
      return;
    }
    status.textContent = "Loading…";
    try {
      let loaded = 0;
      try {
        loaded = await addFile(path) ? 1 : 0;
      } catch {
        const files = await collectFiles(path);
        for (const file of files) {
          try { if (await addFile(file)) loaded += 1; } catch {}
        }
      }
      status.textContent = `${loaded} file${loaded === 1 ? "" : "s"} loaded · no truncation`;
      refreshContextUi();
    } catch (error) {
      status.textContent = error.message;
    }
  }, true);

  const profilesButton = document.getElementById("context-load-profiles");
  profilesButton?.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    const status = document.getElementById("context-status");
    status.textContent = "Finding profiles…";
    try {
      const files = (await collectFiles("")).filter((path) => /master[_\s-]*profile/i.test(nameOf(path)));
      let loaded = 0;
      for (const file of files) {
        try { if (await addFile(file)) loaded += 1; } catch {}
      }
      status.textContent = `${loaded} profile${loaded === 1 ? "" : "s"} loaded`;
      refreshContextUi();
    } catch (error) {
      status.textContent = error.message;
    }
  }, true);
})();
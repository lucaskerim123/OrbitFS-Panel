// Talks to the OrbitFS REST API (see orbitfs-mcp/server.js /api/*).
// One node, one client - this used to be split into "pc"/"vps" clients for
// a two-way sync feature that never made sense once it turned out Claude
// Desktop and the OrbitFS server both just run on this one VPS.
export function makeOrbitFSClient(baseUrl, apiKey) {
  const headers = { Authorization: `Bearer ${apiKey}`, "X-Hive-Flow": "webpanel" };

  async function ping() {
    try {
      const resp = await fetch(new URL("/api/ping", baseUrl), { signal: AbortSignal.timeout(5000) });
      return resp.ok;
    } catch {
      return false;
    }
  }

  async function listFiles(subpath) {
    const url = new URL("/api/files", baseUrl);
    if (subpath) url.searchParams.set("subpath", subpath);
    const resp = await fetch(url, { headers });
    if (!resp.ok) throw new Error(`list failed: ${resp.status}`);
    return (await resp.json()).entries;
  }

  async function readFile(filepath) {
    const url = new URL("/api/file", baseUrl);
    url.searchParams.set("path", filepath);
    const resp = await fetch(url, { headers });
    if (!resp.ok) throw new Error(`read failed: ${resp.status}`);
    return (await resp.json()).content;
  }

  async function writeFile(filepath, content) {
    const resp = await fetch(new URL("/api/file", baseUrl), {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ path: filepath, content }),
    });
    if (!resp.ok) throw new Error(`write failed: ${resp.status}`);
  }

  async function deleteFile(filepath) {
    const url = new URL("/api/file", baseUrl);
    url.searchParams.set("path", filepath);
    const resp = await fetch(url, { method: "DELETE", headers });
    if (!resp.ok) throw new Error(`delete failed: ${resp.status}`);
  }

  async function moveToTrash(filepath) {
    const resp = await fetch(new URL("/api/trash", baseUrl), {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ path: filepath }),
    });
    if (!resp.ok) throw new Error(`trash move failed: ${resp.status}`);
    return resp.json();
  }

  async function emptyTrash() {
    const resp = await fetch(new URL("/api/trash/empty", baseUrl), { method: "POST", headers });
    if (!resp.ok) throw new Error(`empty trash failed: ${resp.status}`);
    return resp.json();
  }

  async function getTrashConfig() {
    const resp = await fetch(new URL("/api/trash/config", baseUrl), { headers });
    if (!resp.ok) throw new Error(`get trash config failed: ${resp.status}`);
    return resp.json();
  }

  async function setTrashConfig(retentionDays) {
    const resp = await fetch(new URL("/api/trash/config", baseUrl), {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ retentionDays }),
    });
    if (!resp.ok) throw new Error(`set trash config failed: ${resp.status}`);
    return resp.json();
  }

  async function moveFile(from, to) {
    const resp = await fetch(new URL("/api/move", baseUrl), {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to }),
    });
    if (!resp.ok) throw new Error(`move failed: ${resp.status}`);
  }

  async function mkdir(dirpath) {
    const resp = await fetch(new URL("/api/mkdir", baseUrl), {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ path: dirpath }),
    });
    if (!resp.ok) throw new Error(`mkdir failed: ${resp.status}`);
  }

  async function previewSort() {
    const resp = await fetch(new URL("/api/sort/preview", baseUrl), { method: "POST", headers });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(body.error || `sort preview failed: ${resp.status}`);
    return body;
  }

  async function applySort(moves) {
    const resp = await fetch(new URL("/api/sort/apply", baseUrl), {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ moves }),
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(body.error || `sort apply failed: ${resp.status}`);
    return body;
  }

  async function oauthState() {
    const resp = await fetch(new URL("/api/oauth-state", baseUrl), { headers });
    if (!resp.ok) throw new Error(`oauth-state failed: ${resp.status}`);
    return resp.json();
  }

  async function disconnectOauth(email, flow) {
    const resp = await fetch(new URL("/api/oauth-disconnect", baseUrl), {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ email, flow }),
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(body.error || `oauth disconnect failed: ${resp.status}`);
    return body;
  }

  // Upload/download are proxied by server.js as raw byte streams rather than
  // wrapped here, so large files never get buffered into a JS string.

  return { baseUrl, headers, ping, listFiles, readFile, writeFile, deleteFile, moveToTrash, emptyTrash, getTrashConfig, setTrashConfig, moveFile, mkdir, previewSort, applySort, oauthState, disconnectOauth };
}

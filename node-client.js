export function makeNodeClient(name, baseUrl, apiKey) {
  const headers = { Authorization: `Bearer ${apiKey}` };

  async function ping() {
    try {
      const resp = await fetch(new URL("/api/ping", baseUrl), { signal: AbortSignal.timeout(5000) });
      return resp.ok;
    } catch {
      return false;
    }
  }

  async function manifest() {
    const resp = await fetch(new URL("/api/manifest", baseUrl), { headers });
    if (!resp.ok) throw new Error(`${name} manifest failed: ${resp.status}`);
    return (await resp.json()).files;
  }

  async function listFiles(subpath) {
    const url = new URL("/api/files", baseUrl);
    if (subpath) url.searchParams.set("subpath", subpath);
    const resp = await fetch(url, { headers });
    if (!resp.ok) throw new Error(`${name} list failed: ${resp.status}`);
    return (await resp.json()).entries;
  }

  async function readFile(filepath) {
    const url = new URL("/api/file", baseUrl);
    url.searchParams.set("path", filepath);
    const resp = await fetch(url, { headers });
    if (!resp.ok) throw new Error(`${name} read failed: ${resp.status}`);
    return (await resp.json()).content;
  }

  async function writeFile(filepath, content) {
    const resp = await fetch(new URL("/api/file", baseUrl), {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ path: filepath, content }),
    });
    if (!resp.ok) throw new Error(`${name} write failed: ${resp.status}`);
  }

  async function deleteFile(filepath) {
    const url = new URL("/api/file", baseUrl);
    url.searchParams.set("path", filepath);
    const resp = await fetch(url, { method: "DELETE", headers });
    if (!resp.ok) throw new Error(`${name} delete failed: ${resp.status}`);
  }

  return { name, baseUrl, ping, manifest, listFiles, readFile, writeFile, deleteFile };
}

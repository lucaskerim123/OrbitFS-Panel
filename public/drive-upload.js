(() => {
  if (window.__orbitDriveUploadLoaded) return;
  window.__orbitDriveUploadLoaded = true;

  const FOLDER_MIME = "application/vnd.google-apps.folder";
  const EXPORTS = {
    "application/vnd.google-apps.document": { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: ".docx" },
    "application/vnd.google-apps.spreadsheet": { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: ".xlsx" },
    "application/vnd.google-apps.presentation": { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ext: ".pptx" },
    "application/vnd.google-apps.drawing": { mime: "application/pdf", ext: ".pdf" },
  };

  let accessToken = "";
  let tokenClient = null;
  let currentFolderId = "root";
  let currentFolderName = "My Drive";
  let folderStack = [];
  let driveFiles = [];
  let selected = new Map();

  const el = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value || "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const clientId = () => localStorage.getItem("orbitGoogleClientId") || "";

  function loadGoogleIdentity() {
    return new Promise((resolve, reject) => {
      if (window.google?.accounts?.oauth2) return resolve();
      const existing = document.querySelector('script[data-orbit-google-identity="1"]');
      if (existing) {
        existing.addEventListener("load", resolve, { once: true });
        existing.addEventListener("error", reject, { once: true });
        return;
      }
      const script = document.createElement("script");
      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      script.defer = true;
      script.dataset.orbitGoogleIdentity = "1";
      script.onload = resolve;
      script.onerror = () => reject(new Error("Google sign-in failed to load"));
      document.head.appendChild(script);
    });
  }

  function setStatus(message, error = false) {
    const status = el("drive-import-status");
    if (!status) return;
    status.textContent = message || "";
    status.classList.toggle("error", !!error);
  }

  function setConnected(connected) {
    el("drive-connect-btn").textContent = connected ? "Reconnect Drive" : "Connect Google Drive";
    el("drive-browser").classList.toggle("hidden", !connected);
  }

  async function connectDrive() {
    const id = clientId();
    if (!id) {
      el("drive-setup").classList.remove("hidden");
      setStatus("Add the Google OAuth client ID once, then connect.");
      return;
    }
    try {
      await loadGoogleIdentity();
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: id,
        scope: "https://www.googleapis.com/auth/drive.readonly",
        callback: async (response) => {
          if (response.error) return setStatus(response.error, true);
          accessToken = response.access_token;
          setConnected(true);
          setStatus("Google Drive connected.");
          folderStack = [];
          currentFolderId = "root";
          currentFolderName = "My Drive";
          await loadDriveFolder();
        },
      });
      tokenClient.requestAccessToken({ prompt: accessToken ? "" : "consent" });
    } catch (error) {
      setStatus(error.message, true);
    }
  }

  async function driveFetch(url) {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (response.status === 401) {
      accessToken = "";
      setConnected(false);
      throw new Error("Google Drive session expired. Connect again.");
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error?.message || `Google Drive request failed (${response.status})`);
    }
    return response;
  }

  async function loadDriveFolder() {
    if (!accessToken) return;
    setStatus("Loading Drive folder…");
    const query = encodeURIComponent(`'${currentFolderId}' in parents and trashed = false`);
    const fields = encodeURIComponent("files(id,name,mimeType,size,modifiedTime,iconLink)");
    try {
      const response = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${query}&fields=${fields}&pageSize=1000&orderBy=folder,name&supportsAllDrives=true&includeItemsFromAllDrives=true`);
      const body = await response.json();
      driveFiles = body.files || [];
      selected.clear();
      renderDriveBreadcrumb();
      renderDriveFiles();
      setStatus(`${driveFiles.length} item${driveFiles.length === 1 ? "" : "s"} in ${currentFolderName}.`);
    } catch (error) {
      setStatus(error.message, true);
    }
  }

  function renderDriveBreadcrumb() {
    const host = el("drive-breadcrumb");
    host.innerHTML = "";
    const root = document.createElement("button");
    root.type = "button";
    root.textContent = "My Drive";
    root.addEventListener("click", async () => {
      folderStack = [];
      currentFolderId = "root";
      currentFolderName = "My Drive";
      await loadDriveFolder();
    });
    host.appendChild(root);
    folderStack.forEach((folder, index) => {
      host.appendChild(Object.assign(document.createElement("span"), { textContent: "›" }));
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = folder.name;
      button.addEventListener("click", async () => {
        folderStack = folderStack.slice(0, index + 1);
        currentFolderId = folder.id;
        currentFolderName = folder.name;
        await loadDriveFolder();
      });
      host.appendChild(button);
    });
  }

  function renderDriveFiles() {
    const list = el("drive-file-list");
    const search = el("drive-search").value.trim().toLowerCase();
    const items = driveFiles
      .filter((file) => !search || file.name.toLowerCase().includes(search))
      .sort((a, b) => a.mimeType === b.mimeType ? a.name.localeCompare(b.name) : a.mimeType === FOLDER_MIME ? -1 : 1);
    list.innerHTML = "";
    if (!items.length) {
      list.innerHTML = '<div class="drive-empty">No matching Drive files.</div>';
      return;
    }
    for (const file of items) {
      const row = document.createElement("div");
      row.className = `drive-file-row${selected.has(file.id) ? " selected" : ""}`;
      if (file.mimeType === FOLDER_MIME) {
        row.innerHTML = `<button type="button" class="drive-open-folder"><span>📁</span><span>${escapeHtml(file.name)}</span><span>›</span></button>`;
        row.querySelector("button").addEventListener("click", async () => {
          folderStack.push({ id: file.id, name: file.name });
          currentFolderId = file.id;
          currentFolderName = file.name;
          await loadDriveFolder();
        });
      } else {
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = selected.has(file.id);
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) selected.set(file.id, file);
          else selected.delete(file.id);
          renderDriveFiles();
          updateImportButton();
        });
        const name = document.createElement("div");
        name.className = "drive-file-name";
        name.innerHTML = `<strong>${escapeHtml(file.name)}</strong><small>${file.size ? uploadFormatBytes(Number(file.size)) : "Google file"}</small>`;
        row.append(checkbox, document.createTextNode("📄"), name);
        row.addEventListener("click", (event) => {
          if (event.target === checkbox) return;
          checkbox.checked = !checkbox.checked;
          checkbox.dispatchEvent(new Event("change"));
        });
      }
      list.appendChild(row);
    }
  }

  function updateImportButton() {
    const button = el("drive-import-btn");
    button.disabled = selected.size === 0;
    button.textContent = selected.size ? `Add ${selected.size} to upload queue` : "Add selected to upload queue";
  }

  function exportedName(file) {
    const config = EXPORTS[file.mimeType];
    if (!config) return file.name;
    return file.name.toLowerCase().endsWith(config.ext) ? file.name : `${file.name}${config.ext}`;
  }

  async function downloadDriveFile(file) {
    const exportConfig = EXPORTS[file.mimeType];
    let url;
    let mime = file.mimeType || "application/octet-stream";
    if (exportConfig) {
      url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}/export?mimeType=${encodeURIComponent(exportConfig.mime)}`;
      mime = exportConfig.mime;
    } else {
      url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`;
    }
    const response = await driveFetch(url);
    const blob = await response.blob();
    return new File([blob], exportedName(file), { type: blob.type || mime, lastModified: Date.now() });
  }

  async function importSelected() {
    const files = [...selected.values()];
    if (!files.length) return;
    const button = el("drive-import-btn");
    button.disabled = true;
    try {
      const downloaded = [];
      for (let index = 0; index < files.length; index += 1) {
        setStatus(`Preparing ${index + 1} of ${files.length}: ${files[index].name}`);
        downloaded.push(await downloadDriveFile(files[index]));
      }
      if (typeof addUploadFiles !== "function") throw new Error("OrbitFS upload queue is unavailable");
      addUploadFiles(downloaded);
      selected.clear();
      renderDriveFiles();
      updateImportButton();
      setStatus(`${downloaded.length} Drive file${downloaded.length === 1 ? "" : "s"} added to the upload queue.`);
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      updateImportButton();
    }
  }

  function injectStyles() {
    const style = document.createElement("style");
    style.textContent = `
      .upload-source-tabs{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:10px 0}
      .upload-source-tabs button.active{background:var(--accent,#5b8cff);color:#fff}
      .drive-import-panel{display:grid;gap:9px;padding:10px;border:1px solid var(--border,#30384a);border-radius:12px;background:rgba(0,0,0,.12)}
      .drive-import-head{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}
      .drive-setup{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px}
      .drive-browser{display:grid;gap:8px}
      .drive-browser-tools{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px}
      .drive-breadcrumb{display:flex;gap:4px;align-items:center;overflow-x:auto;white-space:nowrap}
      .drive-breadcrumb button{padding:5px 7px;border:0;background:transparent;color:#9fb3ff}
      .drive-file-list{display:grid;max-height:360px;overflow:auto;border:1px solid var(--border,#30384a);border-radius:10px}
      .drive-file-row{display:grid;grid-template-columns:auto auto minmax(0,1fr);gap:9px;align-items:center;padding:10px;border-bottom:1px solid rgba(255,255,255,.06);cursor:pointer}
      .drive-file-row.selected{background:rgba(91,140,255,.1)}
      .drive-file-name{display:grid;gap:2px;min-width:0;overflow-wrap:anywhere}.drive-file-name small{color:var(--muted,#9aa3b2)}
      .drive-open-folder{grid-column:1/-1;display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:9px;width:100%;text-align:left;border:0;background:transparent}
      .drive-empty{padding:18px;text-align:center;color:var(--muted,#9aa3b2)}
      #drive-import-status.error{color:var(--danger,#ff7474)}
      @media(max-width:600px){.drive-setup{grid-template-columns:1fr}.drive-browser-tools{grid-template-columns:1fr}.drive-file-list{max-height:48vh}}
    `;
    document.head.appendChild(style);
  }

  function install() {
    const panel = el("upload-panel");
    const dropzone = el("upload-dropzone");
    if (!panel || !dropzone || el("drive-import-panel")) return;
    injectStyles();

    const tabs = document.createElement("div");
    tabs.className = "upload-source-tabs";
    tabs.innerHTML = '<button type="button" id="upload-source-device" class="active">Device</button><button type="button" id="upload-source-drive">Google Drive</button>';

    const drivePanel = document.createElement("section");
    drivePanel.id = "drive-import-panel";
    drivePanel.className = "drive-import-panel hidden";
    drivePanel.innerHTML = `
      <div class="drive-import-head"><div><strong>Google Drive</strong><p class="muted-text">Browse and multi-select files without downloading them to your phone first.</p></div><button type="button" id="drive-connect-btn">Connect Google Drive</button></div>
      <div id="drive-setup" class="drive-setup hidden"><input id="drive-client-id" type="text" placeholder="Google OAuth client ID" autocomplete="off"><button type="button" id="drive-save-client">Save setup</button></div>
      <div id="drive-browser" class="drive-browser hidden">
        <div class="drive-browser-tools"><button type="button" id="drive-up-btn">Up</button><input id="drive-search" type="search" placeholder="Search this Drive folder" autocomplete="off"></div>
        <div id="drive-breadcrumb" class="drive-breadcrumb"></div>
        <div id="drive-file-list" class="drive-file-list"></div>
        <button type="button" id="drive-import-btn" class="primary" disabled>Add selected to upload queue</button>
      </div>
      <p id="drive-import-status" class="muted-text"></p>`;

    dropzone.insertAdjacentElement("beforebegin", tabs);
    tabs.insertAdjacentElement("afterend", drivePanel);

    el("upload-source-device").addEventListener("click", () => {
      el("upload-source-device").classList.add("active");
      el("upload-source-drive").classList.remove("active");
      drivePanel.classList.add("hidden");
      dropzone.classList.remove("hidden");
    });
    el("upload-source-drive").addEventListener("click", () => {
      el("upload-source-drive").classList.add("active");
      el("upload-source-device").classList.remove("active");
      drivePanel.classList.remove("hidden");
      dropzone.classList.add("hidden");
      if (!clientId()) el("drive-setup").classList.remove("hidden");
    });
    el("drive-connect-btn").addEventListener("click", connectDrive);
    el("drive-save-client").addEventListener("click", () => {
      const value = el("drive-client-id").value.trim();
      if (!value) return setStatus("Enter the Google OAuth client ID.", true);
      localStorage.setItem("orbitGoogleClientId", value);
      el("drive-setup").classList.add("hidden");
      setStatus("Google Drive setup saved. Connect Drive now.");
    });
    el("drive-search").addEventListener("input", renderDriveFiles);
    el("drive-up-btn").addEventListener("click", async () => {
      if (!folderStack.length) return;
      folderStack.pop();
      const parent = folderStack[folderStack.length - 1];
      currentFolderId = parent?.id || "root";
      currentFolderName = parent?.name || "My Drive";
      await loadDriveFolder();
    });
    el("drive-import-btn").addEventListener("click", importSelected);
    if (clientId()) el("drive-client-id").value = clientId();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
})();
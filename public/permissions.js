function isAdminUser() {
  return state.role === "admin";
}

async function loadPermissions() {
  if (!isAdminUser()) return;
  try {
    const { rules } = await api("/api/file-permissions");
    const body = document.getElementById("permissions-body");
    if (!body) return;
    body.innerHTML = "";
    rules.forEach((rule) => {
      const tr = document.createElement("tr");
      const pathTd = document.createElement("td");
      pathTd.textContent = rule.path || "/";
      const roleTd = document.createElement("td");
      roleTd.innerHTML = `<span class="permission-badge ${rule.role}">${rule.role}</span>`;
      const actionTd = document.createElement("td");
      const clear = document.createElement("button");
      clear.className = "icon-btn";
      clear.textContent = "↺";
      clear.title = "Reset to user";
      clear.addEventListener("click", async () => {
        if (!confirm(`Reset '${rule.path || "/"}' to User access?`)) return;
        await api(`/api/file-permissions?path=${encodeURIComponent(rule.path)}`, { method: "DELETE" });
        await loadPermissions();
        await loadFiles();
      });
      actionTd.appendChild(clear);
      tr.append(pathTd, roleTd, actionTd);
      body.appendChild(tr);
    });
    if (!rules.length) body.innerHTML = `<tr><td colspan="3">(no overrides - users can access all files)</td></tr>`;
  } catch (err) {
    console.error(err);
  }
}

async function setPermissionPrompt(filepath) {
  if (!isAdminUser()) return;
  const choice = prompt(`Permission for:\n${filepath}\n\nType 'user' or 'admin':`, "admin");
  if (!choice) return;
  const role = choice.trim().toLowerCase();
  if (!["user", "admin"].includes(role)) {
    alert("Use 'user' or 'admin'.");
    return;
  }
  try {
    await api("/api/file-permissions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: filepath, role }),
    });
    await loadPermissions();
    await loadFiles();
  } catch (err) {
    alert(err.message);
  }
}

function addPermissionButton(container, filepath) {
  if (!isAdminUser() || !container) return;
  const btn = document.createElement("button");
  btn.className = "icon-btn";
  btn.textContent = "🔒";
  btn.title = "Set permission";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    setPermissionPrompt(filepath);
  });
  container.appendChild(btn);
}

const baseRenderRow = renderRow;
renderRow = function renderRowWithPermissions(list, entry) {
  baseRenderRow(list, entry);
  if (!isAdminUser()) return;
  const li = list.lastElementChild;
  const actions = li?.querySelector(".row-actions");
  const full = state.subpath ? `${state.subpath}/${entry.name}` : entry.name;

  if (entry.permission) {
    const badge = document.createElement("span");
    badge.className = `permission-badge ${entry.permission}`;
    badge.textContent = entry.permission;
    li.querySelector(".row-name")?.appendChild(badge);
  }

  addPermissionButton(actions, full);
};

const baseLoadSystem = loadSystem;
loadSystem = async function loadSystemWithPermissions() {
  await baseLoadSystem();
  await loadPermissions();
};

document.getElementById("editor-permission-btn")?.addEventListener("click", () => {
  if (state.openFile) setPermissionPrompt(state.openFile);
});

document.getElementById("preview-permission-btn")?.addEventListener("click", () => {
  if (state.previewFile) setPermissionPrompt(state.previewFile);
});

const baseOpenFile = openFile;
openFile = async function openFileWithPermissionButton(filepath) {
  await baseOpenFile(filepath);
  document.getElementById("editor-permission-btn")?.classList.toggle("hidden", !isAdminUser());
};

const baseOpenPreview = openPreview;
openPreview = async function openPreviewWithPermissionButton(filepath, entry) {
  await baseOpenPreview(filepath, entry);
  document.getElementById("preview-permission-btn")?.classList.toggle("hidden", !isAdminUser());
};

if (isAdminUser()) loadPermissions();

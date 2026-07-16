from pathlib import Path

root = Path(r"F:\OrbitFS Project\OrbitFS-Panel")
server_path = root / "server.js"
app_path = root / "public" / "app.js"
setup_path = root / "setup.js"
test_path = root / "test-license-ui.mjs"

server = server_path.read_text(encoding="utf-8")
old = '''app.post("/api/license/activate", express.json(), async (req, res) => {
  try {
    if (!(await needsSetup())) {
      const session = await sessionOf(req);
      if (!session) return res.status(401).json({ error: "Unauthorized" });
      if (session.role !== "admin") return res.status(403).json({ error: "Admin access required" });
    }
'''
new = '''app.post("/api/license/activate", express.json(), async (req, res) => {
  try {
    const firstRun = await needsSetup();
    if (!firstRun) {
      const panelStatus = await getComponentStatus(COMPONENTS.PANEL);
      if (panelStatus.licensed) {
        const session = await sessionOf(req);
        if (!session) return res.status(401).json({ error: "Unauthorized" });
        if (session.role !== "admin") return res.status(403).json({ error: "Admin access required" });
      }
    }
'''
assert old in server, "activation auth block not found"
server = server.replace(old, new, 1)
old = '''app.get("/api/setup/status", async (req, res) => {
  try {
    res.json({ needsSetup: await needsSetup() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});'''
new = '''app.get("/api/setup/status", async (req, res) => {
  try {
    const systemSetup = await needsSetup();
    let license = null;
    let needsLicenseSetup = false;
    if (!systemSetup && isLicenseEnforced()) {
      license = await getComponentStatus(COMPONENTS.PANEL);
      needsLicenseSetup = !license.licensed;
    }
    res.json({ needsSetup: systemSetup, needsLicenseSetup, license });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});'''
assert old in server, "setup status block not found"
server = server.replace(old, new, 1)
server_path.write_text(server, encoding="utf-8")

app = app_path.read_text(encoding="utf-8")
start = app.index('function showPanelLicenseBlocked(license = {}) {')
end = app.index('\nfunction hidePanelLicenseBlocked()', start)
app = app[:start] + '''function showPanelLicenseBlocked(license = {}) {
  showLicenseOnlySetup(license);
}
''' + app[end:]
old = '''app.get("/api/setup/status", async (req, res) => {
  try {
    res.json({ needsSetup: await needsSetup() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});'''
new = '''app.get("/api/setup/status", async (req, res) => {
  try {
    const systemSetup = await needsSetup();
    let license = null;
    let needsLicenseSetup = false;
    if (!systemSetup && isLicenseEnforced()) {
      license = await getComponentStatus(COMPONENTS.PANEL);
      needsLicenseSetup = !license.licensed;
    }
    res.json({ needsSetup: systemSetup, needsLicenseSetup, license });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});'''
assert old in server, "setup status block not found"
server = server.replace(old, new, 1)
server_path.write_text(server, encoding="utf-8")

app = app_path.read_text(encoding="utf-8")
start = app.index('function showPanelLicenseBlocked(license = {}) {')
end = app.index('\nfunction hidePanelLicenseBlocked()', start)
app = app[:start] + '''function showPanelLicenseBlocked(license = {}) {
  showLicenseOnlySetup(license);
}
''' + app[end:]
anchor = 'let setupLoginCreds = null;\n'
insert = '''let setupLoginCreds = null;
let setupMode = "full";

function showLicenseOnlySetup(license = {}) {
  setupMode = "license";
  hidePanelLicenseBlocked();
  document.getElementById("app").classList.add("hidden");
  document.getElementById("login").classList.add("hidden");
  document.getElementById("setup-done").classList.add("hidden");
  const setup = document.getElementById("setup");
  const form = document.getElementById("setup-form");
  form.classList.remove("hidden");
  const keep = new Set([
    form.querySelector(".brand"), form.querySelector(".brand-subtitle"),
    form.querySelector('label[for="setup-license-key"]'),
    document.getElementById("setup-license-key"),
    document.getElementById("setup-license-key")?.nextElementSibling,
    document.getElementById("setup-license-server-toggle"),
    document.getElementById("setup-license-server-fields"),
    form.querySelector('button[type="submit"]'),
    document.getElementById("setup-error"), document.getElementById("setup-status"),
  ].filter(Boolean));
  [...form.children].forEach((child) => child.classList.toggle("hidden", !keep.has(child)));
  form.querySelector(".brand h1").textContent = "Activate OrbitFS";
  form.querySelector(".brand-subtitle").textContent = "Enter a valid licence key to unlock this installation.";
  form.querySelector('button[type="submit"]').textContent = "Activate licence";
'''
assert anchor in app, "setup state anchor not found"
anchor = 'let setupLoginCreds = null;\n'
insert = '''let setupLoginCreds = null;
let setupMode = "full";

function showLicenseOnlySetup(license = {}) {
  setupMode = "license";
  hidePanelLicenseBlocked();
  document.getElementById("app").classList.add("hidden");
  document.getElementById("login").classList.add("hidden");
  document.getElementById("setup-done").classList.add("hidden");
  const setup = document.getElementById("setup");
  const form = document.getElementById("setup-form");
  form.classList.remove("hidden");
  const keep = new Set([
    form.querySelector(".brand"), form.querySelector(".brand-subtitle"),
    form.querySelector('label[for="setup-license-key"]'),
    document.getElementById("setup-license-key"),
    document.getElementById("setup-license-key")?.nextElementSibling,
    document.getElementById("setup-license-server-toggle"),
    document.getElementById("setup-license-server-fields"),
    form.querySelector('button[type="submit"]'),
    document.getElementById("setup-error"), document.getElementById("setup-status"),
  ].filter(Boolean));
  [...form.children].forEach((child) => child.classList.toggle("hidden", !keep.has(child)));
  form.querySelector(".brand h1").textContent = "Activate OrbitFS";
  form.querySelector(".brand-subtitle").textContent = "Enter a valid licence key to unlock this installation.";
  form.querySelector('button[type="submit"]').textContent = "Activate licence";
'''
assert anchor in app, "setup state anchor not found"
  const reasonText = {
    not_found: "The current licence key was deleted or does not exist.",
    blocked: "The current licence has been blocked.",
    expired: "The current licence has expired.",
    locked_elsewhere: "The current licence is locked to another installation.",
    not_activated: "This installation has not been activated.",
  }[license.reason] || "A valid Panel licence is required.";
  document.getElementById("setup-error").textContent = reasonText;
  document.getElementById("setup-status").textContent = license.installationId
    ? `Installation: ${license.installationId}` : "";
  setup.classList.remove("hidden");
  document.getElementById("setup-license-key").focus();
}
'''
app = app.replace(anchor, insert, 1)

submit_anchor = '''  errorEl.textContent = "";

  const dataFolder = document.getElementById("setup-data-folder").value.trim();'''
submit_insert = '''  errorEl.textContent = "";

  if (setupMode === "license") {
    const licenseKey = normaliseLicenseKey(document.getElementById("setup-license-key").value);
    if (!licenseKey) {
      errorEl.textContent = "Enter an OrbitFS licence key.";
      return;
    }
    if (!/^OFS-[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/.test(licenseKey)) {
      errorEl.textContent = "Use a key formatted as OFS-XXXX-XXXX-XXXX-XXXX.";
      return;
    }
'''
assert submit_anchor in app, "setup submit anchor not found"
  const reasonText = {
    not_found: "The current licence key was deleted or does not exist.",
    blocked: "The current licence has been blocked.",
    expired: "The current licence has expired.",
    locked_elsewhere: "The current licence is locked to another installation.",
    not_activated: "This installation has not been activated.",
  }[license.reason] || "A valid Panel licence is required.";
  document.getElementById("setup-error").textContent = reasonText;
  document.getElementById("setup-status").textContent = license.installationId
    ? `Installation: ${license.installationId}` : "";
  setup.classList.remove("hidden");
  document.getElementById("setup-license-key").focus();
}
'''
app = app.replace(anchor, insert, 1)

submit_anchor = '''  errorEl.textContent = "";

  const dataFolder = document.getElementById("setup-data-folder").value.trim();'''
submit_insert = '''  errorEl.textContent = "";

  if (setupMode === "license") {
    const licenseKey = normaliseLicenseKey(document.getElementById("setup-license-key").value);
    if (!licenseKey) {
      errorEl.textContent = "Enter an OrbitFS licence key.";
      return;
    }
    if (!/^OFS-[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/.test(licenseKey)) {
      errorEl.textContent = "Use a key formatted as OFS-XXXX-XXXX-XXXX-XXXX.";
      return;
    }
'''
assert submit_anchor in app, "setup submit anchor not found"

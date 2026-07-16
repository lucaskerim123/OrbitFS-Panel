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
old = '''function showPanelLicenseBlocked(license = {}) {
  const overlay = document.getElementById("license-blocked-overlay");
  if (!overlay) return;
  const reasons = {
    not_found: "This licence key has been deleted or does not exist.",
    blocked: "This licence has been blocked by the administrator.",
    expired: "This licence has expired.",
    locked_elsewhere: "This licence is locked to another OrbitFS installation.",
    not_activated: "This installation has not been activated.",
  };
'''}old = '''app.get("/api/setup/status", async (req, res) => {
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
old = '''function showPanelLicenseBlocked(license = {}) {
  const overlay = document.getElementById("license-blocked-overlay");
  if (!overlay) return;
  const reasons = {
    not_found: "This licence key has been deleted or does not exist.",
    blocked: "This licence has been blocked by the administrator.",
    expired: "This licence has expired.",
    locked_elsewhere: "This licence is locked to another OrbitFS installation.",
    not_activated: "This installation has not been activated.",
  };
'''}
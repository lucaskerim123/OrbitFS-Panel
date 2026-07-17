import assert from "node:assert/strict";
import fs from "node:fs";

const html = fs.readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("./public/app.js", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("./server.js", import.meta.url), "utf8");
const setup = fs.readFileSync(new URL("./setup.js", import.meta.url), "utf8");

const ids = [
  "setup-license-key",
  "setup-license-api-url",
  "setup-done-license",
  "system-license-card",
  "system-license-refresh",
  "system-license-activate",
  "license-blocked-overlay",
  "license-blocked-activate",
];
for (const id of ids) {
  assert.equal((html.match(new RegExp(`id=["']${id}["']`, "g")) || []).length, 1, `${id} must exist exactly once`);
}
assert.match(app, /async function loadLicensePanel/);
assert.match(app, /function showPanelLicenseBlocked/);
assert.match(app, /function showLicenseOnlySetup/);
assert.match(app, /body\.needsLicenseSetup/);
assert.match(server, /needsLicenseSetup/);
assert.match(server, /panelStatus\.licensed/);
assert.match(app, /activatePanelLicense/);
assert.match(server, /app\.get\("\/api\/license\/status"/);
assert.match(server, /app\.post\("\/api\/license\/activate"/);
assert.match(setup, /INVALID_LICENSE_KEY_FORMAT/);
assert.match(setup, /const activationComponents = \[COMPONENTS\.PANEL\]/);
assert.doesNotMatch(setup, /const activationComponents = \[[^\]]*COMPONENTS\.WORKSPACES/);
assert.match(setup, /removeEnvKey\(panelEnvPath, "ORBITFS_LICENSE_KEY"\)/);
console.log("OrbitFS licence UI integration checks passed");

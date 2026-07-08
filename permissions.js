import fs from "fs/promises";

const PERMISSIONS_PATH = process.env.FILE_PERMISSIONS_PATH || "./file-permissions.json";
const ROLES = new Set(["admin", "user"]);

function normalizeRole(role) {
  return role === "admin" ? "admin" : "user";
}

export function normalizeFilePath(input) {
  return String(input || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

async function loadPermissions() {
  try {
    const parsed = JSON.parse(await fs.readFile(PERMISSIONS_PATH, "utf-8"));
    return Array.isArray(parsed?.rules) ? parsed.rules : [];
  } catch {
    return [];
  }
}

async function savePermissions(rules) {
  await fs.writeFile(PERMISSIONS_PATH, JSON.stringify({ rules }, null, 2), "utf-8");
}

function matchRule(rulePath, targetPath) {
  const rule = normalizeFilePath(rulePath);
  const target = normalizeFilePath(targetPath);
  if (!rule) return true;
  return target === rule || target.startsWith(`${rule}/`);
}

async function matchingRule(filepath) {
  const target = normalizeFilePath(filepath);
  const rules = await loadPermissions();
  return rules
    .filter((r) => ROLES.has(r.role) && matchRule(r.path, target))
    .sort((a, b) => normalizeFilePath(b.path).length - normalizeFilePath(a.path).length)[0] || null;
}

export async function requiredRoleForPath(filepath) {
  return matchingRule(filepath).then((rule) => normalizeRole(rule?.role));
}

export async function canAccessPath(userRole, filepath) {
  if (normalizeRole(userRole) === "admin") return true;
  return (await requiredRoleForPath(filepath)) === "user";
}

export async function filterEntriesForRole(entries, userRole, subpath = "") {
  if (normalizeRole(userRole) === "admin") {
    return Promise.all(entries.map(async (entry) => {
      const full = normalizeFilePath(subpath ? `${subpath}/${entry.name}` : entry.name);
      return { ...entry, permission: await requiredRoleForPath(full) };
    }));
  }

  const out = [];
  for (const entry of entries) {
    const full = normalizeFilePath(subpath ? `${subpath}/${entry.name}` : entry.name);
    if (await canAccessPath(userRole, full)) {
      out.push({ ...entry, permission: await requiredRoleForPath(full) });
    }
  }
  return out;
}

export async function listPermissions() {
  const rules = await loadPermissions();
  return rules
    .filter((r) => ROLES.has(r.role))
    .map((r) => ({ path: normalizeFilePath(r.path), role: normalizeRole(r.role) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export async function setPermission(filepath, role) {
  const normalizedPath = normalizeFilePath(filepath);
  const normalizedRole = normalizeRole(role);
  const rules = (await loadPermissions()).filter((r) => normalizeFilePath(r.path) !== normalizedPath);

  // "user" is the default, so storing only admin overrides keeps this simple.
  if (normalizedRole === "admin") {
    rules.push({ path: normalizedPath, role: "admin" });
  }

  await savePermissions(rules.sort((a, b) => normalizeFilePath(a.path).localeCompare(normalizeFilePath(b.path))));
  return { path: normalizedPath, role: normalizedRole };
}

export async function clearPermission(filepath) {
  const normalizedPath = normalizeFilePath(filepath);
  const rules = (await loadPermissions()).filter((r) => normalizeFilePath(r.path) !== normalizedPath);
  await savePermissions(rules);
  return { path: normalizedPath, role: "user" };
}

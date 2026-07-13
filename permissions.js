import { query, mainWorkspaceId } from "./db.js";

export const FILE_ACTIONS = ["read", "write", "download", "move", "delete", "create"];
const ALLOW_ALL = Object.freeze(Object.fromEntries(FILE_ACTIONS.map((action) => [action, true])));

function normalizeRole(role) { return role === "admin" ? "admin" : "user"; }
function normalizePermissions(input, fallback = ALLOW_ALL) {
  return Object.fromEntries(FILE_ACTIONS.map((action) => [action, typeof input?.[action] === "boolean" ? input[action] : fallback[action]]));
}

export function normalizeFilePath(input) {
  return String(input || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

async function matchingRule(filepath) {
  const workspaceId = await mainWorkspaceId();
  const target = normalizeFilePath(filepath);
  const result = await query(
    `SELECT relative_path,can_read,can_write,can_download,can_move,can_delete,can_create
     FROM file_permissions
     WHERE workspace_id=$1 AND subject_type='workspace_role' AND subject_value='user'
       AND ($2=relative_path OR $2 LIKE relative_path || '/%' OR relative_path='')
     ORDER BY length(relative_path) DESC LIMIT 1`,
    [workspaceId, target]
  );
  return result.rows[0] || null;
}

export async function permissionsForPath(userRole, filepath) {
  if (normalizeRole(userRole) === "admin") return { ...ALLOW_ALL };
  const row = await matchingRule(filepath);
  if (!row) return { ...ALLOW_ALL };
  return {
    read: row.can_read, write: row.can_write, download: row.can_download,
    move: row.can_move, delete: row.can_delete, create: row.can_create,
  };
}
export async function canAccessPath(userRole, filepath, action = "read") {
  if (!FILE_ACTIONS.includes(action)) throw new Error(`Unknown file permission action "${action}"`);
  return (await permissionsForPath(userRole, filepath))[action];
}

export async function filterEntriesForRole(entries, userRole, subpath = "") {
  if (normalizeRole(userRole) === "admin") {
    return Promise.all(entries.map(async (entry) => {
      const full = normalizeFilePath(subpath ? `${subpath}/${entry.name}` : entry.name);
      return { ...entry, permissions: await permissionsForPath("user", full) };
    }));
  }
  const out = [];
  for (const entry of entries) {
    const full = normalizeFilePath(subpath ? `${subpath}/${entry.name}` : entry.name);
    if (await canAccessPath(userRole, full, "read")) out.push({ ...entry, permissions: await permissionsForPath(userRole, full) });
  }
  return out;
}

export async function listPermissions() {
  const workspaceId = await mainWorkspaceId();
  const result = await query(
    `SELECT relative_path,can_read,can_write,can_download,can_move,can_delete,can_create
     FROM file_permissions WHERE workspace_id=$1 AND subject_type='workspace_role' AND subject_value='user'
     ORDER BY relative_path`, [workspaceId]
  );
  return result.rows.map((r) => ({ path: r.relative_path, permissions: {
    read:r.can_read, write:r.can_write, download:r.can_download,
    move:r.can_move, delete:r.can_delete, create:r.can_create,
  }}));
}
export async function setPermission(filepath, permissions) {
  const workspaceId = await mainWorkspaceId();
  const path = normalizeFilePath(filepath);
  const p = normalizePermissions(permissions);
  const result = await query(
    `INSERT INTO file_permissions(workspace_id,relative_path,subject_type,subject_value,can_read,can_write,can_download,can_move,can_delete,can_create)
     VALUES($1,$2,'workspace_role','user',$3,$4,$5,$6,$7,$8)
     ON CONFLICT(workspace_id,relative_path,subject_type,subject_value)
     DO UPDATE SET can_read=EXCLUDED.can_read,can_write=EXCLUDED.can_write,can_download=EXCLUDED.can_download,can_move=EXCLUDED.can_move,can_delete=EXCLUDED.can_delete,can_create=EXCLUDED.can_create,updated_at=now()
     RETURNING relative_path`,
    [workspaceId,path,p.read,p.write,p.download,p.move,p.delete,p.create]
  );
  return { path: result.rows[0].relative_path, permissions: p };
}

export async function clearPermission(filepath) {
  const workspaceId = await mainWorkspaceId();
  const path = normalizeFilePath(filepath);
  await query(
    `DELETE FROM file_permissions
     WHERE workspace_id=$1 AND relative_path=$2 AND subject_type='workspace_role' AND subject_value='user'`,
    [workspaceId,path]
  );
  return { path, inherited: true };
}

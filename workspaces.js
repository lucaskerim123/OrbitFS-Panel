import fs from "fs/promises";
import path from "path";
import { query } from "./db.js";

const DEFAULT_QUOTA = 2684354560;
const BRANCHED_ROOT = "F:\\OrbitFS Project\\The Orbit FS\\Branched Workshop";

function cleanName(value) {
  return String(value || "").trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, " ").replace(/\s+/g, " ").slice(0, 80);
}

function slugify(value) {
  return cleanName(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
}

async function uniqueSlug(base) {
  let slug = base;
  let n = 2;
  while ((await query("SELECT 1 FROM workspaces WHERE slug=$1", [slug])).rowCount) slug = `${base}-${n++}`;
  return slug;
}

export async function listUserWorkspaces(userId, systemRole) {
  const result = await query(
    `SELECT w.id,w.slug,w.name,w.description,w.status,w.storage_quota_mode,w.storage_quota_bytes,
            w.storage_used_bytes,w.filesystem_root,w.is_main,w.owner_id,
            CASE WHEN w.owner_id=$1 THEN 'owner' ELSE wm.permission END AS permission,
            u.username AS owner_username
     FROM workspaces w
     LEFT JOIN workspace_members wm ON wm.workspace_id=w.id AND wm.user_id=$1
     LEFT JOIN users u ON u.id=w.owner_id
     WHERE w.status='active' AND ($2='admin' OR w.owner_id=$1 OR wm.user_id=$1 OR w.is_main=true)
     ORDER BY w.is_main DESC,w.name`, [userId, systemRole]
  );
  return result.rows;
}

export async function getWorkspaceForUser(workspaceId, userId, systemRole) {
  const result = await query(
    `SELECT w.*,CASE WHEN w.owner_id=$2 THEN 'owner' ELSE wm.permission END AS permission,u.username AS owner_username
     FROM workspaces w
     LEFT JOIN workspace_members wm ON wm.workspace_id=w.id AND wm.user_id=$2
     LEFT JOIN users u ON u.id=w.owner_id
     WHERE w.id=$1 AND w.status='active' AND ($3='admin' OR w.owner_id=$2 OR wm.user_id=$2 OR w.is_main=true)
     LIMIT 1`, [workspaceId, userId, systemRole]
  );
  return result.rows[0] || null;
}
export async function createWorkspace({ name, description, userId, username }) {
  const safeName = cleanName(name);
  if (safeName.length < 2) throw new Error("Workspace name must be at least 2 characters");
  const slug = await uniqueSlug(slugify(safeName));
  const client = await query("SELECT id FROM users WHERE id=$1", [userId]);
  if (!client.rowCount) throw new Error("Owner account not found");
  const inserted = await query(
    `INSERT INTO workspaces(slug,name,description,owner_id,status,storage_quota_mode,storage_quota_bytes,storage_used_bytes,filesystem_root,is_main)
     VALUES($1,$2,$3,$4,'active','fixed',$5,0,'',false) RETURNING id`,
    [slug,safeName,String(description||"").trim().slice(0,500),userId,DEFAULT_QUOTA]
  );
  const id = inserted.rows[0].id;
  const folderName = `${id}@${cleanName(username)} ${safeName}`;
  const filesystemRoot = path.join(BRANCHED_ROOT, folderName);
  try {
    await fs.mkdir(filesystemRoot,{recursive:true});
    await query("UPDATE workspaces SET filesystem_root=$2,updated_at=now() WHERE id=$1",[id,filesystemRoot]);
    await query(
      `INSERT INTO workspace_members(workspace_id,user_id,permission)
       VALUES($1,$2,'owner') ON CONFLICT(workspace_id,user_id) DO UPDATE SET permission='owner',updated_at=now()`,
      [id,userId]
    );
  } catch (error) {
    await query("DELETE FROM workspaces WHERE id=$1",[id]).catch(()=>{});
    throw error;
  }
  return getWorkspaceForUser(id,userId,"admin");
}

export async function workspaceUsage(root) {
  let total=0;
  async function walk(dir){
    for(const entry of await fs.readdir(dir,{withFileTypes:true})){
      const full=path.join(dir,entry.name);
      if(entry.isDirectory()) await walk(full);
      else total+=(await fs.stat(full)).size;
    }
  }
  try{await walk(root);}catch(error){if(error.code!=="ENOENT") throw error;}
  return total;
}

export async function refreshWorkspaceUsage(workspace) {
  if(workspace.is_main) return workspace;
  const used=await workspaceUsage(workspace.filesystem_root);
  await query("UPDATE workspaces SET storage_used_bytes=$2,updated_at=now() WHERE id=$1",[workspace.id,used]);
  return {...workspace,storage_used_bytes:used};
}

export function assertWorkspaceWrite(workspace) {
  if(!["owner","editor","contributor"].includes(workspace.permission)) throw new Error("Workspace is read-only");
}

export function assertWorkspaceQuota(workspace,incomingBytes=0,currentBytes=0) {
  if(workspace.storage_quota_mode!=="fixed" || workspace.storage_quota_bytes==null) return;
  const projected=Number(workspace.storage_used_bytes||0)-Number(currentBytes||0)+Number(incomingBytes||0);
  if(projected>Number(workspace.storage_quota_bytes)) throw new Error("Workspace storage quota exceeded");
}

export { BRANCHED_ROOT, DEFAULT_QUOTA };

export async function updateWorkspace(workspaceId, changes, actorId, systemRole) {
  const workspace = await getWorkspaceForUser(workspaceId, actorId, systemRole);
  if (!workspace) throw new Error("Workspace not found or access denied");
  if (systemRole !== "admin" && workspace.permission !== "owner") throw new Error("Owner access required");
  const fields = [];
  const values = [];
  const add = (column, value) => { values.push(value); fields.push(`${column}=$${values.length}`); };
  if (changes.name !== undefined && !workspace.is_main) add("name", cleanName(changes.name));
  if (changes.description !== undefined) add("description", String(changes.description || "").trim().slice(0, 500));
  if (changes.status !== undefined && !workspace.is_main) {
    if (!["active", "suspended", "archived"].includes(changes.status)) throw new Error("Invalid workspace status");
    add("status", changes.status);
  }
  if (systemRole === "admin" && changes.storageQuotaBytes !== undefined && !workspace.is_main) {
    const quota = Number(changes.storageQuotaBytes);
    if (!Number.isFinite(quota) || quota < 0) throw new Error("Invalid quota");
    add("storage_quota_mode", "custom");
    add("storage_quota_bytes", Math.trunc(quota));
  }
  if (systemRole === "admin" && changes.filesystemRoot !== undefined && !workspace.is_main) {
    const root = path.resolve(String(changes.filesystemRoot || ""));
    await fs.mkdir(root, { recursive: true });
    add("filesystem_root", root);
  }
  if (!fields.length) return workspace;
  values.push(workspaceId);
  await query(`UPDATE workspaces SET ${fields.join(",")},updated_at=now() WHERE id=$${values.length}`, values);
  return getWorkspaceForUser(workspaceId, actorId, systemRole);
}

export async function listWorkspaceMembers(workspaceId, actorId, systemRole) {
  const workspace = await getWorkspaceForUser(workspaceId, actorId, systemRole);
  if (!workspace) throw new Error("Workspace not found or access denied");
  const result = await query(
    `SELECT wm.user_id,u.username,u.role AS system_role,wm.permission,wm.joined_at
     FROM workspace_members wm JOIN users u ON u.id=wm.user_id
     WHERE wm.workspace_id=$1 ORDER BY CASE wm.permission WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 WHEN 'contributor' THEN 2 ELSE 3 END,u.username`,
    [workspaceId]
  );
  return result.rows;
}

export async function setWorkspaceMember(workspaceId, username, permission, actorId, systemRole) {
  const workspace = await getWorkspaceForUser(workspaceId, actorId, systemRole);
  if (!workspace) throw new Error("Workspace not found or access denied");
  if (systemRole !== "admin" && workspace.permission !== "owner") throw new Error("Owner access required");
  if (workspace.is_main && systemRole !== "admin") throw new Error("Only admins can manage Main Workspace members");
  if (!["owner", "editor", "contributor", "viewer"].includes(permission)) throw new Error("Invalid workspace role");
  const user = await query("SELECT id FROM users WHERE lower(username)=lower($1) AND status='active' LIMIT 1", [username]);
  if (!user.rows[0]) throw new Error("User not found");
  const userId = user.rows[0].id;
  if (permission === "owner") {
    await query("BEGIN");
    try {
      await query("UPDATE workspaces SET owner_id=$2,updated_at=now() WHERE id=$1", [workspaceId, userId]);
      await query("UPDATE workspace_members SET permission='editor',updated_at=now() WHERE workspace_id=$1 AND permission='owner'", [workspaceId]);
      await query(
        `INSERT INTO workspace_members(workspace_id,user_id,permission,invited_by)
         VALUES($1,$2,'owner',$3)
         ON CONFLICT(workspace_id,user_id) DO UPDATE SET permission='owner',updated_at=now()`,
        [workspaceId, userId, actorId]
      );
      await query("COMMIT");
    } catch (error) {
      await query("ROLLBACK");
      throw error;
    }
  } else {
    await query(
      `INSERT INTO workspace_members(workspace_id,user_id,permission,invited_by)
       VALUES($1,$2,$3,$4)
       ON CONFLICT(workspace_id,user_id) DO UPDATE SET permission=EXCLUDED.permission,updated_at=now()`,
      [workspaceId, userId, permission, actorId]
    );
  }
  return listWorkspaceMembers(workspaceId, actorId, systemRole);
}

export async function removeWorkspaceMember(workspaceId, userId, actorId, systemRole) {
  const workspace = await getWorkspaceForUser(workspaceId, actorId, systemRole);
  if (!workspace) throw new Error("Workspace not found or access denied");
  if (systemRole !== "admin" && workspace.permission !== "owner") throw new Error("Owner access required");
  if (String(userId) === String(workspace.owner_id)) throw new Error("Transfer ownership before removing the owner");
  await query("DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2", [workspaceId, userId]);
  return listWorkspaceMembers(workspaceId, actorId, systemRole);
}

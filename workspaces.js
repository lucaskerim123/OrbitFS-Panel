import fs from "fs/promises";
import path from "path";
import { query } from "./db.js";
import { createNotification,notifyWorkspaceMembers,notifyWorkspaceOwner } from "./notifications.js";

const DEFAULT_QUOTA = 2684354560;
const DEFAULT_MAX_WORKSPACES_PER_USER = 1;
const BRANCHED_ROOT = "F:\\OrbitFS Project\\Branched Workspaces";

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
            w.storage_used_bytes,w.filesystem_root,w.is_main,w.owner_id,w.suspension_reason,
            w.storage_last_scanned_at,w.file_count,w.folder_count,w.trash_used_bytes,w.trash_limit_bytes,w.is_visible,
            w.drive_state,w.last_activity_at,w.offline_at,w.deletion_due_at,w.lifecycle_notice,w.mcp_ui_enabled,
            CASE WHEN w.is_main OR w.drive_state='offline' THEN 0 ELSE COALESCE(w.storage_quota_bytes,0) END AS allocated_bytes,
            CASE WHEN w.owner_id=$1 THEN 'owner' ELSE wm.permission END AS permission,
            u.username AS owner_username
     FROM workspaces w
     LEFT JOIN workspace_members wm ON wm.workspace_id=w.id AND wm.user_id=$1
     LEFT JOIN users u ON u.id=w.owner_id
     WHERE w.status IN ('active','suspended') AND ($2='admin' OR w.owner_id=$1 OR wm.user_id=$1 OR w.is_main=true)
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
     WHERE w.id=$1 AND w.status IN ('active','suspended') AND ($3='admin' OR w.owner_id=$2 OR wm.user_id=$2 OR w.is_main=true)
     LIMIT 1`, [workspaceId, userId, systemRole]
  );
  return result.rows[0] || null;
}
export async function getWorkspaceCreationSettings() {
  await query(`INSERT INTO system_settings(setting_key,setting_value) VALUES('max_workspaces_per_user',$1::jsonb) ON CONFLICT(setting_key) DO NOTHING`, [JSON.stringify(DEFAULT_MAX_WORKSPACES_PER_USER)]);
  const result = await query(`SELECT setting_value FROM system_settings WHERE setting_key='max_workspaces_per_user' LIMIT 1`);
  const value = Number(result.rows[0]?.setting_value ?? DEFAULT_MAX_WORKSPACES_PER_USER);
  return { maxWorkspacesPerUser: Number.isInteger(value) && value >= 0 ? value : DEFAULT_MAX_WORKSPACES_PER_USER };
}

export async function setMaxWorkspacesPerUser(value) {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 0 || limit > 1000) throw new Error('Maximum workspaces must be a whole number from 0 to 1000');
  await query(`INSERT INTO system_settings(setting_key,setting_value,updated_at) VALUES('max_workspaces_per_user',$1::jsonb,now()) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=now()`, [JSON.stringify(limit)]);
  return { maxWorkspacesPerUser: limit };
}

export async function ownedWorkspaceCount(userId) {
  const result = await query(`SELECT count(*)::int AS count FROM workspaces WHERE owner_id=$1 AND is_main=false AND status<>'archived'`, [userId]);
  return result.rows[0]?.count || 0;
}

export async function createWorkspace({ name, description, userId, username, systemRole }) {
  const settings = await getWorkspaceCreationSettings();
  const currentCount = await ownedWorkspaceCount(userId);
  if (systemRole !== "admin" && settings.maxWorkspacesPerUser > 0 && currentCount >= settings.maxWorkspacesPerUser) {
    throw new Error(`Workspace limit reached (${settings.maxWorkspacesPerUser})`);
  }
  const safeName = cleanName(name);
  if (safeName.length < 2) throw new Error("Workspace name must be at least 2 characters");
  const slug = await uniqueSlug(slugify(safeName));
  const client = await query("SELECT id FROM users WHERE id=$1", [userId]);
  if (!client.rowCount) throw new Error("Owner account not found");
  const inserted = await query(
    `INSERT INTO workspaces(slug,name,description,owner_id,status,storage_quota_mode,storage_quota_bytes,storage_used_bytes,filesystem_root,is_main)
     VALUES($1,$2,$3,$4,'active','custom',$5,0,'',false) RETURNING id`,
    [slug,safeName,String(description||"").trim().slice(0,500),userId,DEFAULT_QUOTA]
  );
  const id = inserted.rows[0].id;
  const folderName = `${id}@${cleanName(username)} ${safeName}`;
  const filesystemRoot = path.join(BRANCHED_ROOT, folderName);
  try {
    await fs.mkdir(path.join(filesystemRoot,"_trash"),{recursive:true});
    await fs.mkdir(path.join(filesystemRoot,"_sorter"),{recursive:true});
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

export async function workspaceStorageStats(root) {
  const base = path.resolve(root || ".");
  const stats = { storage_used_bytes:0, file_count:0, folder_count:0, trash_used_bytes:0 };
  async function walk(dir, inTrash=false) {
    for (const entry of await fs.readdir(dir,{withFileTypes:true})) {
      const full = path.join(dir,entry.name);
      const relative = path.relative(base,full).replace(/\\/g,"/");
      const trash = inTrash || relative === "_trash" || relative.startsWith("_trash/");
      if (entry.isDirectory()) {
        stats.folder_count += 1;
        await walk(full,trash);
      } else {
        const size = (await fs.stat(full)).size;
        stats.storage_used_bytes += size;
        stats.file_count += 1;
        if (trash) stats.trash_used_bytes += size;
      }
    }
  }
  try { await walk(base); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  return stats;
}

export async function workspaceUsage(root) {
  return (await workspaceStorageStats(root)).storage_used_bytes;
}

export async function refreshWorkspaceUsage(workspace) {
  const stats = await workspaceStorageStats(workspace.filesystem_root);
  const scannedAt = new Date();
  await query(
    `UPDATE workspaces SET storage_used_bytes=$2,file_count=$3,folder_count=$4,
     trash_used_bytes=$5,storage_last_scanned_at=$6,updated_at=now() WHERE id=$1`,
    [workspace.id,stats.storage_used_bytes,stats.file_count,stats.folder_count,stats.trash_used_bytes,scannedAt]
  );
  return {...workspace,...stats,storage_last_scanned_at:scannedAt.toISOString()};
}

export async function getWorkspaceStorage(workspaceId,userId,systemRole,refresh=false) {
  const workspace = await getWorkspaceForUser(workspaceId,userId,systemRole);
  if (!workspace) throw new Error("Workspace not found or access denied");
  return refresh ? refreshWorkspaceUsage(workspace) : workspace;
}

export function assertWorkspaceWrite(workspace) {
  if(!["owner","editor","contributor"].includes(workspace.permission)) throw new Error("Workspace is read-only");
}

export function assertWorkspaceQuota(workspace,incomingBytes=0,currentBytes=0) {
  if(workspace.storage_quota_mode!=="custom" || workspace.storage_quota_bytes==null) return;
  const projected=Number(workspace.storage_used_bytes||0)-Number(currentBytes||0)+Number(incomingBytes||0);
  if(projected>Number(workspace.storage_quota_bytes)) throw new Error("Workspace storage quota exceeded");
}

export { BRANCHED_ROOT, DEFAULT_QUOTA, DEFAULT_MAX_WORKSPACES_PER_USER };

export async function updateWorkspace(workspaceId, changes, actorId, systemRole, allowEditSettings=false) {
  const workspace = await getWorkspaceForUser(workspaceId, actorId, systemRole);
  const previousQuotaBytes = workspace ? Number(workspace.storage_quota_bytes || 0) : null;
  if (!workspace) throw new Error("Workspace not found or access denied");
  if (systemRole !== "admin" && workspace.permission !== "owner" && !allowEditSettings) throw new Error("Workspace settings permission required");
  const fields = [];
  const values = [];
  const add = (column, value) => { values.push(value); fields.push(`${column}=$${values.length}`); };
  if (changes.name !== undefined && !workspace.is_main) add("name", cleanName(changes.name));
  if (changes.description !== undefined) add("description", String(changes.description || "").trim().slice(0, 500));
  if (changes.status !== undefined && !workspace.is_main && systemRole === "admin") {
    if (!["active", "suspended", "archived"].includes(changes.status)) throw new Error("Invalid workspace status");
    add("status", changes.status);
    const reason = changes.status === "suspended"
      ? String(changes.suspensionReason || "").trim().slice(0, 500) || null
      : null;
    add("suspension_reason", reason);
  } else if (systemRole === "admin" && changes.suspensionReason !== undefined && !workspace.is_main) {
    add("suspension_reason", String(changes.suspensionReason || "").trim().slice(0, 500) || null);
  }
  if (systemRole === "admin" && changes.trashLimitBytes !== undefined && !workspace.is_main) {
    const limit = Number(changes.trashLimitBytes);
    if (!Number.isFinite(limit) || limit < 0) throw new Error("Invalid trash limit");
    add("trash_limit_bytes", Math.trunc(limit));
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
  const updated=await getWorkspaceForUser(workspaceId, actorId, systemRole);
  const nextQuotaBytes = Number(updated.storage_quota_bytes || 0);
  if (!workspace.is_main && systemRole === "admin" && changes.storageQuotaBytes !== undefined && previousQuotaBytes !== nextQuotaBytes) {
    await notifyWorkspaceOwner(workspaceId, {
      actorUserId: actorId, category: "storage_requests", eventType: "workspace_storage_changed",
      title: "Workspace storage changed",
      message: `${updated.name} storage changed from ${previousQuotaBytes} bytes to ${nextQuotaBytes} bytes.`,
      severity: "success", metadata: { previousQuotaBytes, storageQuotaBytes: nextQuotaBytes }, force: true,
    });
  }
  if(!workspace.is_main && workspace.status!==updated.status){
    if(updated.status==="suspended"){
      await notifyWorkspaceMembers(workspaceId,{
        actorUserId:actorId,category:"workspace_status",eventType:"workspace_suspended",
        title:"Workspace suspended",message:`${updated.name} has been suspended by an administrator.`,
        severity:"warning",metadata:{status:"suspended"},
      },{excludeUserIds:[updated.owner_id]});
      await notifyWorkspaceOwner(workspaceId,{
        actorUserId:actorId,category:"workspace_status",eventType:"workspace_suspended",
        title:"Your workspace was suspended",
        message:`${updated.name} was suspended. Reason: ${updated.suspension_reason || "No reason was provided."}`,
        severity:"warning",metadata:{status:"suspended",reason:updated.suspension_reason || null},
      });
    } else if(updated.status==="active" && workspace.status==="suspended"){
      await notifyWorkspaceMembers(workspaceId,{
        actorUserId:actorId,category:"workspace_status",eventType:"workspace_unsuspended",
        title:"Workspace restored",message:`${updated.name} is active again.`,severity:"success",
        metadata:{status:"active"},
      });
    }
  }
  return updated;
}

export async function listWorkspaceMembers(workspaceId, actorId, systemRole, allowManageMembers=false) {
  const workspace = await getWorkspaceForUser(workspaceId, actorId, systemRole);
  if (!workspace) throw new Error("Workspace not found or access denied");
  if (systemRole !== "admin" && String(workspace.owner_id) !== String(actorId) && !allowManageMembers) throw new Error("Manage members permission required");
  const result = await query(
    `SELECT wm.user_id,u.username,u.role AS system_role,wm.permission,wm.joined_at
     FROM workspace_members wm JOIN users u ON u.id=wm.user_id
     WHERE wm.workspace_id=$1 ORDER BY CASE wm.permission WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 WHEN 'contributor' THEN 2 ELSE 3 END,u.username`,
    [workspaceId]
  );
  return result.rows;
}

export async function setWorkspaceMember(workspaceId, username, permission, actorId, systemRole, allowManageMembers=false) {
  const workspace = await getWorkspaceForUser(workspaceId, actorId, systemRole);
  if (!workspace) throw new Error("Workspace not found or access denied");
  if (systemRole !== "admin" && workspace.permission !== "owner" && !allowManageMembers) throw new Error("Manage members permission required");
  if (workspace.is_main && systemRole !== "admin") throw new Error("Only admins can manage Main Workspace members");
  if (!["owner", "editor", "contributor", "viewer"].includes(permission)) throw new Error("Invalid workspace role");
  const user = await query("SELECT id FROM users WHERE lower(username)=lower($1) AND status='active' LIMIT 1", [username]);
  if (!user.rows[0]) throw new Error("User not found");
  const userId = user.rows[0].id;
  const prior=(await query("SELECT permission FROM workspace_members WHERE workspace_id=$1 AND user_id=$2",[workspaceId,userId])).rows[0] || null;
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
  if(permission==="owner"){
    if(String(workspace.owner_id)!==String(userId)){
      await createNotification({recipientUserId:workspace.owner_id,workspaceId,actorUserId:actorId,
        category:"ownership_changes",eventType:"workspace_owner_changed",title:"Workspace ownership changed",
        message:`You are no longer the owner of ${workspace.name}.`,severity:"warning"});
      await createNotification({recipientUserId:userId,workspaceId,actorUserId:actorId,
        category:"ownership_changes",eventType:"workspace_owner_changed",title:"You now own a workspace",
        message:`You are now the owner of ${workspace.name}.`,severity:"success"});
    }
  } else if(!prior){
    await createNotification({recipientUserId:userId,workspaceId,actorUserId:actorId,
      category:"membership_changes",eventType:"workspace_added",title:"Added to workspace",
      message:`You were added to ${workspace.name} as ${permission}.`,severity:"success",metadata:{permission}});
  } else if(prior.permission!==permission){
    await createNotification({recipientUserId:userId,workspaceId,actorUserId:actorId,
      category:"role_changes",eventType:"workspace_role_changed",title:"Workspace role changed",
      message:`Your role in ${workspace.name} changed from ${prior.permission} to ${permission}.`,
      severity:"info",metadata:{previousRole:prior.permission,permission}});
  }
  return listWorkspaceMembers(workspaceId, actorId, systemRole, allowManageMembers);
}

export async function removeWorkspaceMember(workspaceId, userId, actorId, systemRole, allowManageMembers=false) {
  const workspace = await getWorkspaceForUser(workspaceId, actorId, systemRole);
  if (!workspace) throw new Error("Workspace not found or access denied");
  if (systemRole !== "admin" && workspace.permission !== "owner" && !allowManageMembers) throw new Error("Manage members permission required");
  if (String(userId) === String(workspace.owner_id)) throw new Error("Transfer ownership before removing the owner");
  const removedUser=(await query("SELECT username FROM users WHERE id=$1",[userId])).rows[0];
  const removed=await query("DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 RETURNING user_id", [workspaceId, userId]);
  if(removed.rowCount){
    await createNotification({recipientUserId:userId,workspaceId,actorUserId:actorId,
      category:"membership_changes",eventType:"workspace_removed",title:"Removed from workspace",
      message:`You were removed from ${workspace.name}.`,severity:"warning"});
    await notifyWorkspaceOwner(workspaceId,{actorUserId:actorId,category:"membership_changes",
      eventType:"workspace_member_removed",title:"Workspace member removed",
      message:`${removedUser?.username || "A member"} was removed from ${workspace.name}.`,severity:"info"});
  }
  return listWorkspaceMembers(workspaceId, actorId, systemRole, allowManageMembers);
}


export async function deleteWorkspace(workspaceId, actorId, systemRole, allowDeleteWorkspace=false) {
  const result = await query("SELECT * FROM workspaces WHERE id=$1 LIMIT 1", [workspaceId]);
  const workspace = result.rows[0];
  if (!workspace) throw new Error("Workspace not found");
  if (workspace.is_main) throw new Error("Main Workspace cannot be deleted");
  if (systemRole !== "admin" && String(workspace.owner_id) !== String(actorId) && !allowDeleteWorkspace) {
    throw new Error("Delete workspace permission required");
  }
  const root = workspace.filesystem_root ? path.resolve(workspace.filesystem_root) : null;
  await query("DELETE FROM workspaces WHERE id=$1", [workspaceId]);
  if (root) {
    try { await fs.rm(root, { recursive: true, force: true }); }
    catch (error) { console.error("Workspace folder cleanup failed", error); }
  }
  return { ok: true };
}


export async function transferWorkspaceOwner(workspaceId, username, actorId, systemRole) {
  if (systemRole !== "admin") throw new Error("Admin access required");
  const workspace = await getWorkspaceForUser(workspaceId, actorId, systemRole);
  if (!workspace) throw new Error("Workspace not found or access denied");
  if (workspace.is_main) throw new Error("Main Workspace ownership cannot be reassigned here");
  const userResult = await query(
    "SELECT id,username FROM users WHERE lower(username)=lower($1) AND status='active' LIMIT 1",
    [String(username || "").trim()]
  );
  const user = userResult.rows[0];
  if (!user) throw new Error("User not found");
  await query("BEGIN");
  try {
    await query("UPDATE workspace_members SET permission='editor',updated_at=now() WHERE workspace_id=$1 AND permission='owner'",[workspaceId]);
    await query(
      `INSERT INTO workspace_members(workspace_id,user_id,permission,invited_by)
       VALUES($1,$2,'owner',$3)
       ON CONFLICT(workspace_id,user_id) DO UPDATE SET permission='owner',updated_at=now()`,
      [workspaceId,user.id,actorId]
    );
    await query("UPDATE workspaces SET owner_id=$2,updated_at=now() WHERE id=$1",[workspaceId,user.id]);
    await query("COMMIT");
  } catch (error) {
    await query("ROLLBACK");
    throw error;
  }
  if(String(workspace.owner_id)!==String(user.id)){
    await createNotification({recipientUserId:workspace.owner_id,workspaceId,actorUserId:actorId,
      category:"ownership_changes",eventType:"workspace_owner_changed",title:"Workspace ownership transferred",
      message:`Ownership of ${workspace.name} was transferred to ${user.username}.`,severity:"warning"});
    await createNotification({recipientUserId:user.id,workspaceId,actorUserId:actorId,
      category:"ownership_changes",eventType:"workspace_owner_changed",title:"You now own a workspace",
      message:`You are now the owner of ${workspace.name}.`,severity:"success"});
  }
  return getWorkspaceForUser(workspaceId,actorId,systemRole);
}


export async function setWorkspaceMcpEnabled(workspaceId, enabled, actorId, systemRole) {
  if (systemRole !== "admin") throw new Error("Admin access required");
  const result = await query("SELECT id FROM workspaces WHERE id=$1 LIMIT 1", [workspaceId]);
  if (!result.rows[0]) throw new Error("Workspace not found");
  await query("UPDATE workspaces SET mcp_ui_enabled=$2,updated_at=now() WHERE id=$1", [workspaceId, !!enabled]);
  return getWorkspaceForUser(workspaceId, actorId, systemRole);
}

export async function setMainWorkspaceVisibility(workspaceId, visible, actorId, systemRole) {
  const result = await query("SELECT id,is_main,owner_id FROM workspaces WHERE id=$1 LIMIT 1",[workspaceId]);
  const workspace = result.rows[0];
  if (!workspace || !workspace.is_main) throw new Error("Main Workspace not found");
  if (systemRole !== "admin" && String(workspace.owner_id) !== String(actorId)) throw new Error("Only the Main Workspace owner or an administrator can change drive visibility");
  await query("UPDATE workspaces SET is_visible=$2,updated_at=now() WHERE id=$1",[workspaceId,!!visible]);
  return getWorkspaceForUser(workspaceId,actorId,"admin");
}


const LIFECYCLE_DEFAULTS = {
  inactiveDays:30, offlineWarningDays:7, deleteAfterOfflineDays:30, deleteWarningDays:7,
};

export async function getWorkspaceLifecycleSettings() {
  const keys = ['workspace_inactive_days','workspace_offline_warning_days','workspace_delete_after_offline_days','workspace_delete_warning_days'];
  const result = await query(`SELECT setting_key,setting_value FROM system_settings WHERE setting_key=ANY($1)`,[keys]);
  const values = Object.fromEntries(result.rows.map(row=>[row.setting_key,Number(row.setting_value)]));
  return {
    inactiveDays:values.workspace_inactive_days ?? 30,
    offlineWarningDays:values.workspace_offline_warning_days ?? 7,
    deleteAfterOfflineDays:values.workspace_delete_after_offline_days ?? 30,
    deleteWarningDays:values.workspace_delete_warning_days ?? 7,
  };
}

export async function setWorkspaceLifecycleSettings(changes) {
  const names={inactiveDays:'workspace_inactive_days',offlineWarningDays:'workspace_offline_warning_days',deleteAfterOfflineDays:'workspace_delete_after_offline_days',deleteWarningDays:'workspace_delete_warning_days'};
  for (const [key,setting] of Object.entries(names)) {
    if (changes[key] === undefined) continue;
    const value=Number(changes[key]);
    if(!Number.isInteger(value)||value<1||value>3650) throw new Error(`${key} must be 1-3650 days`);
    await query(`INSERT INTO system_settings(setting_key,setting_value,updated_at) VALUES($1,$2::jsonb,now()) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=now()`,[setting,JSON.stringify(value)]);
  }
  return getWorkspaceLifecycleSettings();
}

export async function touchWorkspaceActivity(workspaceId) {
  await query(`UPDATE workspaces SET last_activity_at=now(),lifecycle_notice=NULL,updated_at=now() WHERE id=$1 AND is_main=false`,[workspaceId]);
}

export async function setWorkspaceDriveState(workspaceId,online,actorId,systemRole,allowEditSettings=false) {
  const workspace=await getWorkspaceForUser(workspaceId,actorId,systemRole);
  if(!workspace) throw new Error('Workspace not found or access denied');
  if(workspace.is_main) throw new Error('Use the Main Workspace visibility control');
  if(systemRole!=='admin' && workspace.permission!=='owner' && !allowEditSettings) throw new Error('Workspace settings permission required');
  const settings=await getWorkspaceLifecycleSettings();
  if(online){
    await query(`UPDATE workspaces SET drive_state='online',offline_at=NULL,deletion_due_at=NULL,lifecycle_notice=NULL,last_activity_at=now(),updated_at=now() WHERE id=$1`,[workspaceId]);
  } else {
    await query(`UPDATE workspaces SET drive_state='offline',offline_at=now(),deletion_due_at=now()+($2||' days')::interval,lifecycle_notice=$3,updated_at=now() WHERE id=$1`,[workspaceId,String(settings.deleteAfterOfflineDays),`Drive offline. Scheduled for deletion after ${settings.deleteAfterOfflineDays} days offline.`]);
  }
  const updated=await getWorkspaceForUser(workspaceId,actorId,systemRole);
  await notifyWorkspaceMembers(workspaceId,{
    actorUserId:actorId,category:"lifecycle_warnings",
    eventType:online?"workspace_drive_online":"workspace_drive_offline",
    title:online?"Workspace drive online":"Workspace drive offline",
    message:online?`${workspace.name} is online again.`:`${workspace.name} was taken offline. It is scheduled for deletion after ${settings.deleteAfterOfflineDays} days unless brought online.`,
    severity:online?"success":"warning",dedupKey:`workspace:${workspaceId}:drive-state`,
    metadata:{driveState:online?"online":"offline",deletionDueAt:updated.deletion_due_at || null},
  });
  return updated;
}


export async function evaluateWorkspaceLifecycle() {
  const settings=await getWorkspaceLifecycleSettings();
  const rows=(await query(`SELECT * FROM workspaces WHERE is_main=false AND status<>'archived'`)).rows;
  const now=Date.now();
  const deleted=[];
  for(const workspace of rows){
    if(workspace.status==='suspended') continue;
    if(workspace.drive_state==='online'){
      const inactiveDays=(now-new Date(workspace.last_activity_at||workspace.created_at).getTime())/86400000;
      const remaining=settings.inactiveDays-inactiveDays;
      if(remaining<=0){
        await query(`UPDATE workspaces SET drive_state='offline',offline_at=now(),deletion_due_at=now()+($2||' days')::interval,lifecycle_notice=$3,updated_at=now() WHERE id=$1`,[workspace.id,String(settings.deleteAfterOfflineDays),`Automatically offline after ${settings.inactiveDays} days without activity. Scheduled for deletion after ${settings.deleteAfterOfflineDays} days offline.`]);
        await notifyWorkspaceOwner(workspace.id,{category:"lifecycle_warnings",eventType:"workspace_auto_offline",
          title:"Workspace automatically taken offline",message:`${workspace.name} was taken offline after ${settings.inactiveDays} days without activity. Bring it online within ${settings.deleteAfterOfflineDays} days to prevent deletion.`,
          severity:"warning",dedupKey:`workspace:${workspace.id}:drive-state`,metadata:{driveState:"offline"}});
      } else if(remaining<=settings.offlineWarningDays){
        const daysRemaining=Math.max(1,Math.ceil(remaining));
        const notice=`Warning: drive will go offline in ${daysRemaining} day(s) without activity.`;
        if(workspace.lifecycle_notice!==notice){
          await query(`UPDATE workspaces SET lifecycle_notice=$2,updated_at=now() WHERE id=$1`,[workspace.id,notice]);
          await notifyWorkspaceOwner(workspace.id,{category:"lifecycle_warnings",eventType:"workspace_inactivity_warning",
            title:"Workspace inactivity warning",message:`${workspace.name} will go offline in ${daysRemaining} day(s) without activity.`,
            severity:"warning",dedupKey:`workspace:${workspace.id}:inactivity-warning`,metadata:{daysRemaining}});
        }
      }
      continue;
    }
    const due=workspace.deletion_due_at ? new Date(workspace.deletion_due_at).getTime() : now+settings.deleteAfterOfflineDays*86400000;
    const remaining=(due-now)/86400000;
    if(remaining<=0){
      const root=workspace.filesystem_root ? path.resolve(workspace.filesystem_root) : null;
      await createNotification({recipientUserId:workspace.owner_id,category:"lifecycle_warnings",eventType:"workspace_deleted_offline",
        title:"Workspace deleted",message:`${workspace.name} was deleted after remaining offline past its deletion date.`,
        severity:"critical",force:true,metadata:{formerWorkspaceId:workspace.id,workspaceName:workspace.name}});
      await query(`DELETE FROM workspaces WHERE id=$1`,[workspace.id]);
      if(root) await fs.rm(root,{recursive:true,force:true}).catch(()=>{});
      deleted.push(workspace.id);
    } else if(remaining<=settings.deleteWarningDays){
      const daysRemaining=Math.max(1,Math.ceil(remaining));
      const notice=`Final warning: workspace will be deleted in ${daysRemaining} day(s). Bring it online to cancel deletion.`;
      if(workspace.lifecycle_notice!==notice){
        await query(`UPDATE workspaces SET lifecycle_notice=$2,updated_at=now() WHERE id=$1`,[workspace.id,notice]);
        await notifyWorkspaceOwner(workspace.id,{category:"lifecycle_warnings",eventType:"workspace_deletion_warning",
          title:"Workspace deletion warning",message:`${workspace.name} will be deleted in ${daysRemaining} day(s). Bring it online to cancel deletion.`,
          severity:"critical",force:true,dedupKey:`workspace:${workspace.id}:deletion-warning`,metadata:{daysRemaining}});
      }
    }
  }
  return {checked:rows.length,deleted};
}

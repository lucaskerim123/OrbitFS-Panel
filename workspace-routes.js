import express from "express";
import fs from "fs/promises";
import path from "path";
import { Readable } from "stream";
import { query } from "./db.js";
import { makeLocalOps } from "./local-orbitfs-ops.js";
import { beginDownload } from "./download-limits.js";
import { WORKSPACE_ACTIONS,WORKSPACE_ROLES,WORKSPACE_ADMIN_ACTIONS,effectiveWorkspacePermissions,effectiveWorkspaceAdminPermissions,fullWorkspaceAdminPermissions,workspaceAdminRoleDefaults,normalizeWorkspacePath,roleDefaults } from "./workspace-permissions.js";
import { requestWorkspaceTransfer,listTransferRequests,respondTransferRequest,cancelTransferRequest,listWorkspaceUserDirectory } from "./workspace-transfers.js";
import { requestWorkspaceStorageChange,listWorkspaceStorageRequests,respondWorkspaceStorageRequest,cancelWorkspaceStorageRequest } from "./workspace-storage-requests.js";
import { inviteWorkspaceUser,listPendingInvitations,listWorkspaceInvitations,respondToWorkspaceInvitation,revokeWorkspaceInvitation } from "./workspace-invitations.js";
import { listNotifications,unreadNotificationCount,markNotificationRead,markAllNotificationsRead,dismissNotification,getNotificationPreferences,updateNotificationPreferences,sendGlobalNotification,sendWorkspaceNotification,listNotificationMessages,notifyWorkspaceOwner } from "./notifications.js";
import {
  listUserWorkspaces, getWorkspaceForUser, createWorkspace, updateWorkspace, deleteWorkspace, setMainWorkspaceVisibility,
  listWorkspaceMembers, setWorkspaceMember, removeWorkspaceMember, transferWorkspaceOwner,
  getWorkspaceCreationSettings, setMaxWorkspacesPerUser, ownedWorkspaceCount,
  refreshWorkspaceUsage, getWorkspaceStorage, assertWorkspaceWrite, assertWorkspaceQuota,
  setWorkspaceDriveState,getWorkspaceLifecycleSettings,setWorkspaceLifecycleSettings,
  evaluateWorkspaceLifecycle,touchWorkspaceActivity,setWorkspaceMcpEnabled,
} from "./workspaces.js";
import { listWorkspaceMcpGrants, grantWorkspaceMcpAccess, revokeWorkspaceMcpAccess, revokeAllWorkspaceMcpGrants } from "./workspace-mcp.js";
import { cfConfigured } from "./cloudflare-access.js";

const FULL = { read:true,write:true,download:true,move:true,delete:true,create:true };
const READ = { read:true,write:false,download:true,move:false,delete:false,create:false };
const MCP_PUBLIC_URL = process.env.MCP_PUBLIC_URL || "https://mcp.incendiarynetworks.cc/mcp";
const RESTRICTABLE_TABS = new Set(["sorter"]);
async function workspaceModeEnabled(){
  const row=(await query("SELECT setting_value FROM system_settings WHERE setting_key='workspace_mode_enabled' LIMIT 1")).rows[0];
  return row?.setting_value!==false;
}
async function setWorkspaceModeEnabled(enabled){
  await query(`INSERT INTO system_settings(setting_key,setting_value,updated_at) VALUES('workspace_mode_enabled',$1::jsonb,now())
    ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=now()`,[JSON.stringify(!!enabled)]);
  return {workspaceModeEnabled:!!enabled};
}
async function workspacePermissionsAt(req,filepath=''){
  if(req.role==='admin'||req.workspace.permission==='owner') return roleDefaults('editor');
  return effectiveWorkspacePermissions(req.workspace.id,req.workspace.permission,filepath);
}
async function assertWorkspaceAction(req,filepath,action){
  const effective=await workspacePermissionsAt(req,filepath);
  if(!effective[action]){ const error=new Error(`Workspace permission denied: ${action}`); error.status=403; throw error; }
  return effective;
}

async function workspaceAdminPermissionsFor(req,workspace){
  if(req.role==='admin'||workspace.permission==='owner') return fullWorkspaceAdminPermissions();
  return effectiveWorkspaceAdminPermissions(workspace.id,workspace.permission);
}
async function assertWorkspaceAdminAction(req,workspace,action){
  const effective=await workspaceAdminPermissionsFor(req,workspace);
  if(!effective[action]){ const error=new Error('Workspace administration permission denied: '+action); error.status=403; throw error; }
  return effective;
}

async function moveWorkspacePathToTrash(req, filepath) {
  const clean = normalizeWorkspacePath(filepath);
  await assertWorkspaceAction(req,clean,"delete");
  const info = await req.workspaceOps.inspectPath(clean);
  const result = await req.workspaceOps.moveToTrash(clean,Number(req.workspace.trash_limit_bytes||209715200));
  await query(`INSERT INTO workspace_trash_events(
      workspace_id,original_path,trash_path,item_name,item_type,size_bytes,deleted_by)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,[
      req.workspace.id,clean,result.trashPath,path.posix.basename(clean),info.type,info.sizeBytes,req.userId,
    ]);
  await touchWorkspaceActivity(req.workspace.id);
  return {...result,originalPath:clean,...info};
}

async function listWorkspaceTrash(workspace, ops) {
  const physical = await ops.listTrashItems();
  const rows = (await query(`SELECT e.id,e.original_path,e.trash_path,e.item_name,e.item_type,e.size_bytes,
      e.deleted_at,e.status,u.username AS deleted_by_username
    FROM workspace_trash_events e LEFT JOIN users u ON u.id=e.deleted_by
    WHERE e.workspace_id=$1 AND e.status='trashed' ORDER BY e.deleted_at DESC`,[workspace.id])).rows;
  const byPath = new Map(rows.map(row=>[row.trash_path,row]));
  return physical.map(item=>{
    const event = byPath.get(item.trashPath);
    return event ? {...item,...event,sizeBytes:Number(event.size_bytes||item.sizeBytes)} : {
      ...item,id:null,original_path:null,item_name:item.name,item_type:item.type,
      deleted_at:item.mtime,deleted_by_username:"Unknown (legacy trash item)",status:"trashed",
    };
  });
}

function permissions(workspace, systemRole) {
  if (systemRole === "admin" || ["owner","editor"].includes(workspace.permission)) return FULL;
  if (workspace.permission === "contributor") return { ...FULL, delete:false };
  return READ;
}

async function tabRestrictionsForUser(userId) {
  const result = await query("SELECT setting_value FROM system_settings WHERE setting_key=$1 LIMIT 1", [`tab_restrictions:${userId}`]);
  const value = result.rows[0]?.setting_value;
  return Array.isArray(value) ? value.filter((tab) => RESTRICTABLE_TABS.has(tab)) : [];
}

async function saveTabRestrictions(userId, tabs) {
  const clean = [...new Set((Array.isArray(tabs) ? tabs : []).filter((tab) => RESTRICTABLE_TABS.has(tab)))];
  await query(
    `INSERT INTO system_settings(setting_key,setting_value,updated_at)
     VALUES($1,$2::jsonb,now())
     ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=now()`,
    [`tab_restrictions:${userId}`, JSON.stringify(clean)]
  );
  return clean;
}

async function selectedWorkspace(req) {
  const requested = req.get("x-workspace-id") || req.query.workspaceId || req.body?.workspaceId;
  const all = await listUserWorkspaces(req.userId, req.role);
  const fallback = all.find((w) => w.is_main) || all[0];
  const workspace = requested ? await getWorkspaceForUser(requested, req.userId, req.role) : fallback;
  if (!workspace) throw new Error("Workspace not found or access denied");
  if (req.role === "admin" && !workspace.permission) workspace.permission = "owner";
  return workspace;
}

function assertNoTrashPath(req) {
  const values = [req.query?.path,req.query?.subpath,req.body?.path,req.body?.from,req.body?.to];
  for (const value of values) {
    const clean = String(value || "").replace(/\\/g,"/").replace(/^\/+/ ,"");
    if (clean === "_trash" || clean.startsWith("_trash/")) throw new Error("Workspace trash is managed automatically");
  }
}

async function branched(req, res, next) {
  try {
    const workspace = await selectedWorkspace(req);
    assertNoTrashPath(req);
    if (workspace.is_main) {
      const canBypassVisibility = req.role === "admin" || String(workspace.owner_id) === String(req.userId);
      if (!workspace.is_visible && !canBypassVisibility) {
        return res.status(423).json({ error:"Drive offline", driveOffline:true });
      }
      // Main Workspace remains Simple Mode. The existing file permission
      // routes in server.js decide read/write/download/move/delete/create.
      return next("router");
    }
    if (!(await workspaceModeEnabled())) return res.status(423).json({ error:"Workspace Mode is disabled by an administrator", workspaceModeDisabled:true });
    if (workspace.drive_state === "offline") {
      return res.status(423).json({ error:"Drive offline", driveOffline:true, deletionDueAt:workspace.deletion_due_at, notice:workspace.lifecycle_notice });
    }
    if (workspace.status === "suspended" && req.role !== "admin") {
      return res.status(423).json({ error:"Workspace suspended", suspended:true, reason:workspace.permission==="owner" ? (workspace.suspension_reason || null) : null });
    }
    req.workspace = workspace;
    req.workspaceOps = makeLocalOps(req.workspace.filesystem_root);
    await req.workspaceOps.ensureTrash();
    req.workspacePermissions = await workspacePermissionsAt(req,"");
    next();
  } catch (error) { res.status(403).json({ error:error.message }); }
}

export function workspaceRouter() {
  const router = express.Router();

  router.use(async (req,res,next) => {
    if (req.role === "admin") return next();
    const sorterRequest = req.path === "/sorter" || req.path.startsWith("/sorter/") || req.path === "/sort" || req.path.startsWith("/sort/");
    if (!sorterRequest) return next();
    try {
      const restricted = await tabRestrictionsForUser(req.userId);
      if (restricted.includes("sorter")) return res.status(403).json({ error:"Sorter access is restricted by an administrator", restrictedTab:"sorter" });
      next();
    } catch (error) { res.status(500).json({ error:error.message }); }
  });

  router.get("/tab-restrictions/me", async (req,res) => {
    try { res.json({ tabs:req.role === "admin" ? [] : await tabRestrictionsForUser(req.userId) }); }
    catch(error) { res.status(400).json({error:error.message}); }
  });
  router.get("/tab-restrictions", async (req,res) => {
    if(req.role!=="admin") return res.status(403).json({error:"Admin access required"});
    try {
      const users=(await query("SELECT id,username,role,status FROM users ORDER BY username")).rows;
      const rows=[];
      for(const user of users) rows.push({...user,tabs:user.role==="admin"?[]:await tabRestrictionsForUser(user.id)});
      res.json({users:rows,restrictableTabs:["sorter"]});
    } catch(error) { res.status(400).json({error:error.message}); }
  });
  router.put("/tab-restrictions/:userId", express.json(), async (req,res) => {
    if(req.role!=="admin") return res.status(403).json({error:"Admin access required"});
    try {
      const target=(await query("SELECT id,username,role FROM users WHERE id=$1 LIMIT 1",[req.params.userId])).rows[0];
      if(!target) throw new Error("User not found");
      if(target.role==="admin") throw new Error("Admin tabs cannot be restricted");
      res.json({userId:target.id,username:target.username,tabs:await saveTabRestrictions(target.id,req.body?.tabs)});
    } catch(error) { res.status(400).json({error:error.message}); }
  });

  router.get("/sorter-access",async(req,res)=>{
    try{
      const workspace=await selectedWorkspace(req);
      let permissions;
      if(req.role==="admin"||workspace.permission==="owner"||String(workspace.owner_id)===String(req.userId)) permissions=fullWorkspaceAdminPermissions();
      else if(workspace.is_main){
        const restricted=await tabRestrictionsForUser(req.userId);
        permissions={use_sorter:!restricted.includes("sorter"),manage_sorter_settings:false};
      } else permissions=await effectiveWorkspaceAdminPermissions(workspace.id,workspace.permission);
      if(req.role!=="admin"&&(await tabRestrictionsForUser(req.userId)).includes("sorter")){permissions.use_sorter=false;permissions.manage_sorter_settings=false;}
      res.json({workspaceId:workspace.id,useSorter:!!permissions.use_sorter,accessSorterSettings:!!permissions.use_sorter&&!!permissions.manage_sorter_settings});
    }catch(error){res.status(error.status||400).json({error:error.message});}
  });
  router.get("/notifications",async(req,res)=>{
    try{res.json({notifications:await listNotifications(req.userId,{limit:req.query.limit,unreadOnly:req.query.unreadOnly==="true"}),unreadCount:await unreadNotificationCount(req.userId)});}
    catch(error){res.status(400).json({error:error.message});}
  });
  router.get("/notifications/unread-count",async(req,res)=>{
    try{res.json({unreadCount:await unreadNotificationCount(req.userId)});}
    catch(error){res.status(400).json({error:error.message});}
  });
  router.patch("/notifications/:id/read",async(req,res)=>{
    try{res.json(await markNotificationRead(req.userId,req.params.id));}
    catch(error){res.status(400).json({error:error.message});}
  });
  router.post("/notifications/read-all",async(req,res)=>{
    try{res.json(await markAllNotificationsRead(req.userId));}
    catch(error){res.status(400).json({error:error.message});}
  });
  router.delete("/notifications/:id",async(req,res)=>{
    try{res.json(await dismissNotification(req.userId,req.params.id));}
    catch(error){res.status(400).json({error:error.message});}
  });
  router.get("/notification-preferences",async(req,res)=>{
    try{res.json({preferences:await getNotificationPreferences(req.userId)});}
    catch(error){res.status(400).json({error:error.message});}
  });
  router.patch("/notification-preferences",express.json(),async(req,res)=>{
    try{res.json({preferences:await updateNotificationPreferences(req.userId,req.body||{})});}
    catch(error){res.status(400).json({error:error.message});}
  });
  router.get("/admin/notification-messages",async(req,res)=>{
    if(req.role!=="admin") return res.status(403).json({error:"Admin access required"});
    try{res.json({messages:await listNotificationMessages(req.query.limit)});}
    catch(error){res.status(400).json({error:error.message});}
  });
  router.post("/admin/notifications/global",express.json(),async(req,res)=>{
    if(req.role!=="admin") return res.status(403).json({error:"Admin access required"});
    try{res.status(201).json(await sendGlobalNotification({senderId:req.userId,audience:req.body?.audience,title:req.body?.title,body:req.body?.message,severity:req.body?.severity}));}
    catch(error){res.status(400).json({error:error.message});}
  });
  router.post("/workspaces/:id/messages",express.json(),async(req,res)=>{
    try{
      const workspace=await getWorkspaceForUser(req.params.id,req.userId,req.role);
      if(!workspace) throw new Error("Workspace not found or access denied");
      if(workspace.is_main){if(req.role!=="admin") throw new Error("Admin access required");}
      else await assertWorkspaceAdminAction(req,workspace,"send_messages");
      const severity=req.role==="admin"?req.body?.severity:(req.body?.severity==="warning"?"warning":"info");
      res.status(201).json(await sendWorkspaceNotification({workspaceId:workspace.id,senderId:req.userId,title:req.body?.title,body:req.body?.message,severity}));
    }catch(error){res.status(error.status||400).json({error:error.message});}
  });
  router.get("/workspaces", async (req,res) => {
    try {
      await evaluateWorkspaceLifecycle();
      const workspaces = await listUserWorkspaces(req.userId,req.role);
      const enrichedWorkspaces = await Promise.all(workspaces.map(async workspace => ({
        ...workspace,
        suspension_reason:(req.role==="admin"||workspace.permission==="owner")?workspace.suspension_reason:null,
        management_permissions: await workspaceAdminPermissionsFor(req,workspace),
      })));
      const settings = { ...(await getWorkspaceCreationSettings()), ...(await getWorkspaceLifecycleSettings()), workspaceModeEnabled:await workspaceModeEnabled() };
      const ownedCount = await ownedWorkspaceCount(req.userId);
      res.json({ workspaces:enrichedWorkspaces, settings, ownedCount });
    } catch(error) { res.status(500).json({error:error.message}); }
  });
  router.get("/workspace-user-directory", async (req,res) => {
    try { res.json({ users:await listWorkspaceUserDirectory() }); }
    catch(error) { res.status(400).json({error:error.message}); }
  });
  router.get("/workspace-transfer-requests", async (req,res) => {
    try { res.json({ requests:await listTransferRequests(req.userId,req.role) }); }
    catch(error) { res.status(400).json({error:error.message}); }
  });
  router.get("/workspace-storage-requests", async (req,res) => {
    try { res.json({ requests:await listWorkspaceStorageRequests(req.userId,req.role) }); }
    catch(error) { res.status(400).json({error:error.message}); }
  });
  router.post("/workspaces/:id/storage-request", express.json(), async (req,res) => {
    try { res.status(201).json({ request:await requestWorkspaceStorageChange(req.params.id,req.body?.requestedQuotaBytes,req.body?.message,req.userId,req.role) }); }
    catch(error) { res.status(400).json({error:error.message}); }
  });
  router.post("/workspace-storage-requests/:id/respond", express.json(), async (req,res) => {
    try { res.json(await respondWorkspaceStorageRequest(req.params.id,req.body?.decision,req.body?.message,req.userId,req.role)); }
    catch(error) { res.status(400).json({error:error.message}); }
  });
  router.delete("/workspace-storage-requests/:id", async (req,res) => {
    try { res.json(await cancelWorkspaceStorageRequest(req.params.id,req.userId,req.role)); }
    catch(error) { res.status(400).json({error:error.message}); }
  });
  router.post("/workspaces/:id/transfer-request", express.json(), async (req,res) => {
    try { res.status(201).json({ request:await requestWorkspaceTransfer(req.params.id,req.body?.username,req.userId,req.role) }); }
    catch(error) { res.status(400).json({error:error.message}); }
  });
  router.post("/workspace-transfer-requests/:id/respond", express.json(), async (req,res) => {
    try { res.json(await respondTransferRequest(req.params.id,req.body?.decision,req.userId,req.role)); }
    catch(error) { res.status(400).json({error:error.message}); }
  });
  router.delete("/workspace-transfer-requests/:id", async (req,res) => {
    try { res.json(await cancelTransferRequest(req.params.id,req.userId,req.role)); }
    catch(error) { res.status(400).json({error:error.message}); }
  });
  router.get("/workspace-mode", async (req,res) => {
    try { res.json({workspaceModeEnabled:await workspaceModeEnabled()}); }
    catch(error){ res.status(400).json({error:error.message}); }
  });
  router.patch("/workspace-mode",express.json(),async(req,res)=>{
    if(req.role!=="admin") return res.status(403).json({error:"Admin access required"});
    try { res.json(await setWorkspaceModeEnabled(req.body?.enabled)); }
    catch(error){ res.status(400).json({error:error.message}); }
  });
  router.get("/workspaces/:id/permission-overrides",async(req,res)=>{
    try{
      const workspace=await getWorkspaceForUser(req.params.id,req.userId,req.role);
      if(!workspace) throw new Error("Workspace not found or access denied");
      if(workspace.is_main) throw new Error("Main Workspace uses Simple Mode file permissions");
      await assertWorkspaceAdminAction(req,workspace,"manage_permissions");
      const rows=(await query(`SELECT relative_path,workspace_role,can_read,can_write,can_download,can_move,can_delete,can_create
        FROM workspace_permission_overrides WHERE workspace_id=$1 ORDER BY relative_path,workspace_role`,[workspace.id])).rows;
      res.json({overrides:rows.map(row=>({path:row.relative_path,role:row.workspace_role,permissions:{read:row.can_read,write:row.can_write,download:row.can_download,move:row.can_move,delete:row.can_delete,create:row.can_create}}))});
    }catch(error){ res.status(400).json({error:error.message}); }
  });
  router.put("/workspaces/:id/permission-overrides",express.json(),async(req,res)=>{
    try{
      const workspace=await getWorkspaceForUser(req.params.id,req.userId,req.role);
      if(!workspace) throw new Error("Workspace not found or access denied");
      if(workspace.is_main) throw new Error("Main Workspace uses Simple Mode file permissions");
      await assertWorkspaceAdminAction(req,workspace,"manage_permissions");
      const role=String(req.body?.role||""); if(!WORKSPACE_ROLES.includes(role)) throw new Error("Invalid workspace role");
      const relativePath=normalizeWorkspacePath(req.body?.path); const input=req.body?.permissions||{};
      const values=WORKSPACE_ACTIONS.map(action=>!!input[action]);
      await query(`INSERT INTO workspace_permission_overrides(workspace_id,relative_path,workspace_role,can_read,can_write,can_download,can_move,can_delete,can_create)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT(workspace_id,relative_path,workspace_role) DO UPDATE SET can_read=EXCLUDED.can_read,can_write=EXCLUDED.can_write,can_download=EXCLUDED.can_download,can_move=EXCLUDED.can_move,can_delete=EXCLUDED.can_delete,can_create=EXCLUDED.can_create,updated_at=now()`,[workspace.id,relativePath,role,...values]);
      res.json({ok:true});
    }catch(error){ res.status(400).json({error:error.message}); }
  });
  router.delete("/workspaces/:id/permission-overrides",async(req,res)=>{
    try{
      const workspace=await getWorkspaceForUser(req.params.id,req.userId,req.role);
      if(!workspace) throw new Error("Workspace not found or access denied");
      await assertWorkspaceAdminAction(req,workspace,"manage_permissions");
      await query(`DELETE FROM workspace_permission_overrides WHERE workspace_id=$1 AND relative_path=$2 AND workspace_role=$3`,[workspace.id,normalizeWorkspacePath(req.query.path),String(req.query.role||"")]);
      res.json({ok:true});
    }catch(error){ res.status(400).json({error:error.message}); }
  });
  router.get("/workspaces/:id/admin-permissions",async(req,res)=>{
    try{
      const workspace=await getWorkspaceForUser(req.params.id,req.userId,req.role);
      if(!workspace||workspace.is_main) throw new Error("Workspace not found or not configurable");
      if(req.role!=="admin"&&workspace.permission!=="owner") throw new Error("Owner access required");
      const permissions={};
      for(const role of WORKSPACE_ROLES) permissions[role]=await effectiveWorkspaceAdminPermissions(workspace.id,role);
      res.json({permissions,defaults:Object.fromEntries(WORKSPACE_ROLES.map(role=>[role,workspaceAdminRoleDefaults(role)]))});
    }catch(error){res.status(error.status||400).json({error:error.message});}
  });
  router.put("/workspaces/:id/admin-permissions",express.json(),async(req,res)=>{
    try{
      const workspace=await getWorkspaceForUser(req.params.id,req.userId,req.role);
      if(!workspace||workspace.is_main) throw new Error("Workspace not found or not configurable");
      if(req.role!=="admin"&&workspace.permission!=="owner") throw new Error("Owner access required");
      const role=String(req.body?.role||""); if(!WORKSPACE_ROLES.includes(role)) throw new Error("Invalid workspace role");
      const input=req.body?.permissions||{}; const values=WORKSPACE_ADMIN_ACTIONS.map(action=>!!input[action]);
      await query(`INSERT INTO workspace_role_admin_permissions(workspace_id,workspace_role,can_view_settings,can_edit_settings,can_manage_members,can_manage_permissions,can_send_messages,can_use_sorter,can_manage_sorter_settings,can_delete_workspace)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT(workspace_id,workspace_role) DO UPDATE SET can_view_settings=EXCLUDED.can_view_settings,can_edit_settings=EXCLUDED.can_edit_settings,can_manage_members=EXCLUDED.can_manage_members,can_manage_permissions=EXCLUDED.can_manage_permissions,can_send_messages=EXCLUDED.can_send_messages,can_use_sorter=EXCLUDED.can_use_sorter,can_manage_sorter_settings=EXCLUDED.can_manage_sorter_settings,can_delete_workspace=EXCLUDED.can_delete_workspace,updated_at=now()`,[workspace.id,role,...values]);
      res.json({ok:true,permissions:await effectiveWorkspaceAdminPermissions(workspace.id,role)});
    }catch(error){res.status(error.status||400).json({error:error.message});}
  });
  router.get("/workspace-settings", async (req,res) => {
    try {
      const settings = await getWorkspaceCreationSettings();
      const ownedCount = await ownedWorkspaceCount(req.userId);
      res.json({ ...settings, ownedCount });
    } catch(error) { res.status(500).json({error:error.message}); }
  });
  router.patch("/workspace-settings", express.json(), async (req,res) => {
    if (req.role !== "admin") return res.status(403).json({error:"Admin access required"});
    try { res.json(await setMaxWorkspacesPerUser(req.body?.maxWorkspacesPerUser)); }
    catch(error) { res.status(400).json({error:error.message}); }
  });
  router.get("/workspace-invitations", async (req,res) => {
    try { res.json({ invitations:await listPendingInvitations(req.userId) }); }
    catch(error) { res.status(400).json({error:error.message}); }
  });
  router.post("/workspace-invitations/:id/respond", express.json(), async (req,res) => {
    try { res.json(await respondToWorkspaceInvitation(req.params.id,req.userId,req.body?.decision)); }
    catch(error) { res.status(400).json({error:error.message}); }
  });
  router.get("/workspaces/:id/invitations", async (req,res) => {
    try { const workspace=await getWorkspaceForUser(req.params.id,req.userId,req.role); const access=await assertWorkspaceAdminAction(req,workspace,"manage_members"); res.json({ invitations:await listWorkspaceInvitations(req.params.id,req.userId,req.role,access.manage_members) }); }
    catch(error) { res.status(400).json({error:error.message}); }
  });
  router.post("/workspaces/:id/invitations", express.json(), async (req,res) => {
    try { const workspace=await getWorkspaceForUser(req.params.id,req.userId,req.role); const access=await assertWorkspaceAdminAction(req,workspace,"manage_members"); res.status(201).json({ invitation:await inviteWorkspaceUser(req.params.id,req.body?.username,req.body?.permission,req.userId,req.role,access.manage_members) }); }
    catch(error) { res.status(400).json({error:error.message}); }
  });
  router.delete("/workspace-invitations/:id", async (req,res) => {
    try { const row=(await query("SELECT workspace_id FROM workspace_invitations WHERE id=$1",[req.params.id])).rows[0]; if(!row) throw new Error("Invitation not found"); const workspace=await getWorkspaceForUser(row.workspace_id,req.userId,req.role); const access=await assertWorkspaceAdminAction(req,workspace,"manage_members"); res.json(await revokeWorkspaceInvitation(req.params.id,req.userId,req.role,access.manage_members)); }
    catch(error) { res.status(400).json({error:error.message}); }
  });
  router.post("/workspaces", express.json(), async (req,res) => {
    try { res.status(201).json({ workspace:await createWorkspace({ ...req.body,userId:req.userId,username:req.username,systemRole:req.role }) }); }
    catch(error) { res.status(400).json({error:error.message}); }
  });
  router.get("/workspace-lifecycle-settings", async (req,res) => {
    try { res.json(await getWorkspaceLifecycleSettings()); }
    catch(error) { res.status(400).json({error:error.message}); }
  });
  router.patch("/workspace-lifecycle-settings", express.json(), async (req,res) => {
    if(req.role!=="admin") return res.status(403).json({error:"Admin access required"});
    try { res.json(await setWorkspaceLifecycleSettings(req.body||{})); }
    catch(error) { res.status(400).json({error:error.message}); }
  });
  router.patch("/workspaces/:id/drive-state", express.json(), async (req,res) => {
    try { const workspace=await getWorkspaceForUser(req.params.id,req.userId,req.role); const access=await assertWorkspaceAdminAction(req,workspace,"edit_settings"); res.json({workspace:await setWorkspaceDriveState(req.params.id,!!req.body?.online,req.userId,req.role,access.edit_settings)}); }
    catch(error) { res.status(400).json({error:error.message}); }
  });
  router.patch("/workspaces/:id/visibility", express.json(), async (req,res) => {
    try { res.json({ workspace:await setMainWorkspaceVisibility(req.params.id,req.body?.visible,req.userId,req.role) }); }
    catch(error) { res.status(400).json({error:error.message}); }
  });
  router.patch("/workspaces/:id", express.json(), async (req,res) => {
    try { const workspace=await getWorkspaceForUser(req.params.id,req.userId,req.role); const access=await assertWorkspaceAdminAction(req,workspace,"edit_settings"); res.json({ workspace:await updateWorkspace(req.params.id,req.body||{},req.userId,req.role,access.edit_settings) }); }
    catch(error) { res.status(400).json({error:error.message}); }
  });
  router.get("/workspaces/:id/storage", async (req,res) => {
    try { res.json({ workspace:await getWorkspaceStorage(req.params.id,req.userId,req.role,req.query.refresh==="true") }); }
    catch(error) { res.status(400).json({error:error.message}); }
  });
  router.get("/workspaces/:id/trash", async (req,res) => {
    try {
      const workspace=await getWorkspaceForUser(req.params.id,req.userId,req.role);
      if(!workspace) throw new Error("Workspace not found or access denied");
      if(workspace.is_main) throw new Error("Main Workspace trash is managed by Simple Mode");
      const ops=makeLocalOps(workspace.filesystem_root);
      await ops.ensureSystemFolders();
      res.json({items:await listWorkspaceTrash(workspace,ops)});
    } catch(error) { res.status(400).json({error:error.message}); }
  });
  router.delete("/workspaces/:id/trash", async (req,res) => {
    try {
      const workspace=await getWorkspaceForUser(req.params.id,req.userId,req.role);
      if(!workspace) throw new Error("Workspace not found or access denied");
      if(workspace.is_main) throw new Error("Main Workspace trash is managed by Simple Mode");
      if(req.role!=="admin" && workspace.permission!=="owner") throw new Error("Owner access required");
      const ops=makeLocalOps(workspace.filesystem_root);
      const items=await listWorkspaceTrash(workspace,ops);
      await ops.emptyTrash();
      await query(`UPDATE workspace_trash_events SET status='purged',purged_by=$2,purged_at=now()
        WHERE workspace_id=$1 AND status='trashed'`,[workspace.id,req.userId]);
      res.json({ok:true,purged:items.length,workspace:await refreshWorkspaceUsage(workspace)});
    } catch(error) { res.status(400).json({error:error.message}); }
  });
  router.patch("/workspaces/:id/owner", express.json(), async (req,res) => {
    try { res.json({ workspace:await transferWorkspaceOwner(req.params.id,req.body?.username,req.userId,req.role) }); }
    catch(error) { res.status(400).json({error:error.message}); }
  });
  router.delete("/workspaces/:id", async (req,res) => {
    try { const workspace=await getWorkspaceForUser(req.params.id,req.userId,req.role); const access=await assertWorkspaceAdminAction(req,workspace,"delete_workspace"); res.json(await deleteWorkspace(req.params.id,req.userId,req.role,access.delete_workspace)); }
    catch(error) { res.status(400).json({error:error.message}); }
  });
  router.delete("/workspaces/:id/leave", async (req,res) => {
    try {
      const workspace=await getWorkspaceForUser(req.params.id,req.userId,req.role);
      if(!workspace) throw new Error("Workspace not found or access denied");
      if(workspace.is_main) throw new Error("Main Workspace cannot be left");
      if(String(workspace.owner_id)===String(req.userId) || workspace.permission==="owner") throw new Error("Transfer ownership before leaving this workspace");
      const removed=await query("DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 RETURNING user_id",[workspace.id,req.userId]);
      if(!removed.rowCount) throw new Error("You are not a member of this workspace");
      await notifyWorkspaceOwner(workspace.id,{actorUserId:req.userId,category:"membership_changes",eventType:"workspace_member_left",title:"Member left workspace",message:`${req.username} left ${workspace.name}.`,severity:"info"});
      res.json({ok:true});
    } catch(error) { res.status(400).json({error:error.message}); }
  });
  router.get("/workspaces/:id/members", async (req,res) => {
    try { const workspace=await getWorkspaceForUser(req.params.id,req.userId,req.role); const access=await assertWorkspaceAdminAction(req,workspace,"manage_members"); res.json({ members:await listWorkspaceMembers(req.params.id,req.userId,req.role,access.manage_members) }); }
    catch(error) { res.status(400).json({error:error.message}); }
  });
  router.put("/workspaces/:id/members/:username", express.json(), async (req,res) => {
    try { const workspace=await getWorkspaceForUser(req.params.id,req.userId,req.role); const access=await assertWorkspaceAdminAction(req,workspace,"manage_members"); res.json({ members:await setWorkspaceMember(req.params.id,req.params.username,req.body?.permission,req.userId,req.role,access.manage_members) }); }
    catch(error) { res.status(400).json({error:error.message}); }
  });
  router.delete("/workspaces/:id/members/:userId", async (req,res) => {
    try { const workspace=await getWorkspaceForUser(req.params.id,req.userId,req.role); const access=await assertWorkspaceAdminAction(req,workspace,"manage_members"); res.json({ members:await removeWorkspaceMember(req.params.id,req.params.userId,req.userId,req.role,access.manage_members) }); }
    catch(error) { res.status(400).json({error:error.message}); }
  });
  router.patch("/workspaces/:id/mcp-enabled", express.json(), async (req,res) => {
    try {
      if (req.role !== "admin") throw new Error("Admin access required");
      const workspace = await setWorkspaceMcpEnabled(req.params.id, !!req.body?.enabled, req.userId, req.role);
      const cascade = workspace.mcp_ui_enabled ? null : await revokeAllWorkspaceMcpGrants(req.params.id);
      res.json({ workspace, cascade });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  router.get("/workspaces/:id/mcp-grants", async (req,res) => {
    try {
      const workspace = await getWorkspaceForUser(req.params.id, req.userId, req.role);
      if (!workspace) throw new Error("Workspace not found or access denied");
      if (req.role !== "admin" && workspace.permission !== "owner") throw new Error("Workspace owner access required");
      res.json({ grants: await listWorkspaceMcpGrants(req.params.id, req.userId, req.role), mcpEnabled: !!workspace.mcp_ui_enabled, cfConfigured: cfConfigured() });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  router.put("/workspaces/:id/mcp-grants/:userId", async (req,res) => {
    try { res.json({ grants: await grantWorkspaceMcpAccess(req.params.id, req.params.userId, req.userId, req.role) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  router.delete("/workspaces/:id/mcp-grants/:userId", async (req,res) => {
    try { res.json({ grants: await revokeWorkspaceMcpAccess(req.params.id, req.params.userId, req.userId, req.role) }); }
    catch (error) { res.status(400).json({ error: error.message }); }
  });
  router.get("/workspaces/:id/mcp-grants/me", async (req,res) => {
    try {
      const workspace = await getWorkspaceForUser(req.params.id, req.userId, req.role);
      if (!workspace) throw new Error("Workspace not found or access denied");
      const grant = (await query(
        `SELECT granted_at FROM workspace_mcp_grants WHERE workspace_id=$1 AND user_id=$2 AND revoked_at IS NULL`,
        [req.params.id, req.userId]
      )).rows[0];
      res.json({ mcpEnabled: !!workspace.mcp_ui_enabled, granted: !!grant, grantedAt: grant?.granted_at || null, connectUrl: MCP_PUBLIC_URL });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });
  router.post("/bulk-download/validate",express.json(),branched,async(req,res)=>{
    if(!req.workspace)return;
    try{
      const paths=Array.isArray(req.body?.paths)?req.body.paths:[];
      if(!paths.length) throw new Error("Select at least one file");
      if(paths.length>3) throw new Error("Maximum 3 files per bulk download");
      let total=0;
      for(const item of paths){
        await assertWorkspaceAction(req,item,"download");
        const stat=await fs.stat(req.workspaceOps.safeResolve(item));
        if(!stat.isFile()) throw new Error("Folders cannot be bulk downloaded");
        total+=stat.size;
      }
      if(total>262144000) throw new Error("Bulk download limit is 250 MB");
      res.json({ok:true,paths,totalBytes:total});
    }catch(error){res.status(error.status||400).json({error:error.message});}
  });
  router.post("/bulk-move",express.json(),branched,async(req,res)=>{
    if(!req.workspace)return;
    try{
      const paths=Array.isArray(req.body?.paths)?req.body.paths:[];
      const destination=normalizeWorkspacePath(req.body?.destination||"");
      if(!paths.length) throw new Error("Select at least one item");
      const targets=paths.map(item=>({from:normalizeWorkspacePath(item),to:destination?destination+"/"+path.posix.basename(item):path.posix.basename(item)}));
      for(const item of targets){
        await assertWorkspaceAction(req,item.from,"move");
        const parent=path.posix.dirname(item.to); await assertWorkspaceAction(req,parent==='.'?'':parent,"create");
        await fs.stat(req.workspaceOps.safeResolve(item.from));
        if(await req.workspaceOps.fileSize(item.to)) throw new Error("Destination already exists: "+item.to);
      }
      for(const item of targets) await req.workspaceOps.moveFile(item.from,item.to);
      res.json({ok:true,moved:targets.length});
    }catch(error){res.status(error.status||400).json({error:error.message});}
  });
  router.post("/bulk-trash",express.json(),branched,async(req,res)=>{
    if(!req.workspace)return;
    try{
      const paths=Array.isArray(req.body?.paths)?req.body.paths.map(normalizeWorkspacePath):[];
      if(!paths.length) throw new Error("Select at least one item");
      const trashed=[];
      for(const item of paths) trashed.push(await moveWorkspacePathToTrash(req,item));
      res.json({ok:true,trashed:trashed.length,items:trashed,workspace:await refreshWorkspaceUsage(req.workspace)});
    }catch(error){res.status(error.status||400).json({error:error.message});}
  });
  router.get("/files",branched,async(req,res)=>{
    if(!req.workspace)return;
    try{
      const subpath=normalizeWorkspacePath(req.query.subpath||"");
      const folderPermissions=await assertWorkspaceAction(req,subpath,"read");
      const entries=await req.workspaceOps.listFiles(subpath); const visible=[];
      for(const entry of entries){
        const full=subpath?subpath+"/"+entry.name:entry.name;
        const entryPermissions=await workspacePermissionsAt(req,full);
        if(entryPermissions.read) visible.push({...entry,permissions:entryPermissions});
      }
      res.json({entries:visible,folderPermissions,workspace:req.workspace});
    }catch(error){res.status(error.status||400).json({error:error.message});}
  });
  router.get("/file",branched,async(req,res)=>{
    if(!req.workspace)return;
    try{
      const filepath=normalizeWorkspacePath(req.query.path);
      const effective=await assertWorkspaceAction(req,filepath,"read");
      res.json({content:await req.workspaceOps.readFile(filepath),permissions:effective});
    }catch(error){res.status(error.status||400).json({error:error.message});}
  });
  router.put("/file",express.json({limit:"25mb"}),branched,async(req,res)=>{
    if(!req.workspace)return;
    try{
      const filepath=normalizeWorkspacePath(req.body.path);
      await assertWorkspaceAction(req,filepath,"write");
      const current=await req.workspaceOps.fileSize(filepath);
      assertWorkspaceQuota(req.workspace,Buffer.byteLength(req.body.content||""),current);
      await req.workspaceOps.writeFile(filepath,req.body.content||"");
      await touchWorkspaceActivity(req.workspace.id);
      await refreshWorkspaceUsage(req.workspace);
      res.json({ok:true});
    }catch(error){res.status(error.status||400).json({error:error.message});}
  });
  router.delete("/file",branched,async(req,res)=>{
    if(!req.workspace)return;
    try{
      const result=await moveWorkspacePathToTrash(req,req.query.path);
      res.json({...result,workspace:await refreshWorkspaceUsage(req.workspace)});
    }catch(error){res.status(error.status||400).json({error:error.message});}
  });
  router.post("/mkdir",express.json(),branched,async(req,res)=>{
    if(!req.workspace)return;
    try{
      const target=normalizeWorkspacePath(req.body.path); const parent=path.posix.dirname(target);
      await assertWorkspaceAction(req,parent==='.'?'':parent,"create");
      await req.workspaceOps.mkdir(target);
      await touchWorkspaceActivity(req.workspace.id); res.json({ok:true});
    }catch(error){res.status(error.status||400).json({error:error.message});}
  });
  router.post("/move",express.json(),branched,async(req,res)=>{
    if(!req.workspace)return;
    try{
      const from=normalizeWorkspacePath(req.body.from); const to=normalizeWorkspacePath(req.body.to);
      await assertWorkspaceAction(req,from,"move");
      const parent=path.posix.dirname(to); await assertWorkspaceAction(req,parent==="."?"":parent,"create");
      await req.workspaceOps.moveFile(from,to);
      await touchWorkspaceActivity(req.workspace.id); res.json({ok:true});
    }catch(error){res.status(error.status||400).json({error:error.message});}
  });
  router.post("/trash",express.json(),branched,async(req,res)=>{
    if(!req.workspace)return;
    try{
      const result=await moveWorkspacePathToTrash(req,req.body.path);
      res.json({...result,workspace:await refreshWorkspaceUsage(req.workspace)});
    }catch(error){res.status(error.status||400).json({error:error.message});}
  });
  for(const route of ["/preview","/download"]){
    router.get(route,branched,async(req,res)=>{
      if(!req.workspace)return;
      try{
        const filepath=normalizeWorkspacePath(req.query.path);
        await assertWorkspaceAction(req,filepath,route==="/download"?"download":"read");
        const {stream,filename,size}=await req.workspaceOps.downloadStream(filepath);
        const release=route==="/download"?beginDownload(req.userId,size):()=>{};
        res.once("finish",release); res.once("close",release);
        res.set("Content-Type","application/octet-stream");
        res.set("Content-Disposition",route==="/preview"?"inline":"attachment; filename=\""+encodeURIComponent(filename)+"\"");
        stream.pipe(res);
      }catch(error){res.status(error.status||400).json({error:error.message});}
    });
  }
  router.post("/upload",express.raw({type:()=>true,limit:"2gb"}),branched,async(req,res)=>{
    if(!req.workspace)return;
    try{
      const filepath=normalizeWorkspacePath(req.query.path);
      const exists=await fs.stat(req.workspaceOps.safeResolve(filepath)).then(()=>true).catch(()=>false);
      const parent=path.posix.dirname(filepath);
      await assertWorkspaceAction(req,exists?filepath:(parent==="."?"":parent),exists?"write":"create");
      const current=await req.workspaceOps.fileSize(filepath);
      assertWorkspaceQuota(req.workspace,req.body?.length||0,current);
      await req.workspaceOps.writeBuffer(filepath,req.body||Buffer.alloc(0));
      await touchWorkspaceActivity(req.workspace.id);
      await refreshWorkspaceUsage(req.workspace);
      res.json({ok:true});
    }catch(error){res.status(error.status||400).json({error:error.message});}
  });
  router.use("/file-permissions",branched,(req,res,next)=>{
    if(!req.workspace)return;
    res.status(409).json({error:"File-level permissions are managed by workspace roles in branched workspaces"});
  });
  return router;
}
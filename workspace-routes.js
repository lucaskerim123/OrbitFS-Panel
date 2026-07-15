import express from "express";
import fs from "fs/promises";
import path from "path";
import { Readable } from "stream";
import { query } from "./db.js";
import { makeLocalOps } from "./local-orbitfs-ops.js";
import { beginDownload } from "./download-limits.js";
import { WORKSPACE_ACTIONS,WORKSPACE_ROLES,effectiveWorkspacePermissions,normalizeWorkspacePath,roleDefaults } from "./workspace-permissions.js";
import { requestWorkspaceTransfer,listTransferRequests,respondTransferRequest,cancelTransferRequest,listWorkspaceUserDirectory } from "./workspace-transfers.js";
import { inviteWorkspaceUser,listPendingInvitations,listWorkspaceInvitations,respondToWorkspaceInvitation,revokeWorkspaceInvitation } from "./workspace-invitations.js";
import {
  listUserWorkspaces, getWorkspaceForUser, createWorkspace, updateWorkspace, deleteWorkspace, setMainWorkspaceVisibility,
  listWorkspaceMembers, setWorkspaceMember, removeWorkspaceMember, transferWorkspaceOwner,
  getWorkspaceCreationSettings, setMaxWorkspacesPerUser, ownedWorkspaceCount,
  refreshWorkspaceUsage, getWorkspaceStorage, assertWorkspaceWrite, assertWorkspaceQuota,
  setWorkspaceDriveState,getWorkspaceLifecycleSettings,setWorkspaceLifecycleSettings,
  evaluateWorkspaceLifecycle,touchWorkspaceActivity,
} from "./workspaces.js";

const FULL = { read:true,write:true,download:true,move:true,delete:true,create:true };
const READ = { read:true,write:false,download:true,move:false,delete:false,create:false };
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
      const isOwner = String(workspace.owner_id) === String(req.userId);
      if (!workspace.is_visible && !isOwner) {
        return res.status(423).json({ error:"Drive offline", driveOffline:true });
      }
      if (!isOwner && !["GET","HEAD"].includes(req.method)) {
        return res.status(403).json({ error:"Main Workspace is read-only for this account" });
      }
      return next("router");
    }
    if (!(await workspaceModeEnabled())) return res.status(423).json({ error:"Workspace Mode is disabled by an administrator", workspaceModeDisabled:true });
    if (workspace.drive_state === "offline") {
      return res.status(423).json({ error:"Drive offline", driveOffline:true, deletionDueAt:workspace.deletion_due_at, notice:workspace.lifecycle_notice });
    }
    if (workspace.status === "suspended" && req.role !== "admin") {
      return res.status(423).json({ error:"Workspace suspended", suspended:true, reason:workspace.suspension_reason || null });
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

  router.get("/workspaces", async (req,res) => {
    try {
      await evaluateWorkspaceLifecycle();
      const workspaces = await listUserWorkspaces(req.userId,req.role);
      const settings = { ...(await getWorkspaceCreationSettings()), ...(await getWorkspaceLifecycleSettings()), workspaceModeEnabled:await workspaceModeEnabled() };
      const ownedCount = await ownedWorkspaceCount(req.userId);
      res.json({ workspaces, settings, ownedCount });
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
      if(req.role!=="admin"&&workspace.permission!=="owner") throw new Error("Owner access required");
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
      if(req.role!=="admin"&&workspace.permission!=="owner") throw new Error("Owner access required");
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
      if(req.role!=="admin"&&workspace.permission!=="owner") throw new Error("Owner access required");
      await query(`DELETE FROM workspace_permission_overrides WHERE workspace_id=$1 AND relative_path=$2 AND workspace_role=$3`,[workspace.id,normalizeWorkspacePath(req.query.path),String(req.query.role||"")]);
      res.json({ok:true});
    }catch(error){ res.status(400).json({error:error.message}); }
  });  router.get("/workspace-settings", async (req,res) => {
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
    try { res.json({ invitations:await listWorkspaceInvitations(req.params.id,req.userId,req.role) }); }
    catch(error) { res.status(400).json({error:error.message}); }
  });
  router.post("/workspaces/:id/invitations", express.json(), async (req,res) => {
    try { res.status(201).json({ invitation:await inviteWorkspaceUser(req.params.id,req.body?.username,req.body?.permission,req.userId,req.role) }); }
    catch(error) { res.status(400).json({error:error.message}); }
  });
  router.delete("/workspace-invitations/:id", async (req,res) => {
    try { res.json(await revokeWorkspaceInvitation(req.params.id,req.userId,req.role)); }
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
    try { res.json({workspace:await setWorkspaceDriveState(req.params.id,!!req.body?.online,req.userId,req.role)}); }
    catch(error) { res.status(400).json({error:error.message}); }
  });
  router.patch("/workspaces/:id/visibility", express.json(), async (req,res) => {
    try { res.json({ workspace:await setMainWorkspaceVisibility(req.params.id,req.body?.visible,req.userId) }); }
    catch(error) { res.status(400).json({error:error.message}); }
  });
  router.patch("/workspaces/:id", express.json(), async (req,res) => {
    try { res.json({ workspace:await updateWorkspace(req.params.id,req.body||{},req.userId,req.role) }); }
    catch(error) { res.status(400).json({error:error.message}); }
  });
  router.get("/workspaces/:id/storage", async (req,res) => {
    try { res.json({ workspace:await getWorkspaceStorage(req.params.id,req.userId,req.role,req.query.refresh==="true") }); }
    catch(error) { res.status(400).json({error:error.message}); }
  });
  router.delete("/workspaces/:id/trash", async (req,res) => {
    try {
      const workspace=await getWorkspaceForUser(req.params.id,req.userId,req.role);
      if(!workspace) throw new Error("Workspace not found or access denied");
      if(workspace.is_main) throw new Error("Main Workspace trash is managed by MCP");
      if(req.role!=="admin" && workspace.permission!=="owner") throw new Error("Owner access required");
      const ops=makeLocalOps(workspace.filesystem_root);
      await ops.emptyTrash();
      res.json({ok:true,workspace:await refreshWorkspaceUsage(workspace)});
    } catch(error) { res.status(400).json({error:error.message}); }
  });
  router.patch("/workspaces/:id/owner", express.json(), async (req,res) => {
    try { res.json({ workspace:await transferWorkspaceOwner(req.params.id,req.body?.username,req.userId,req.role) }); }
    catch(error) { res.status(400).json({error:error.message}); }
  });
  router.delete("/workspaces/:id", async (req,res) => {
    try { res.json(await deleteWorkspace(req.params.id,req.userId,req.role)); }
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
      res.json({ok:true});
    } catch(error) { res.status(400).json({error:error.message}); }
  });
  router.get("/workspaces/:id/members", async (req,res) => {
    try { res.json({ members:await listWorkspaceMembers(req.params.id,req.userId,req.role) }); }
    catch(error) { res.status(400).json({error:error.message}); }
  });
  router.put("/workspaces/:id/members/:username", express.json(), async (req,res) => {
    try { res.json({ members:await setWorkspaceMember(req.params.id,req.params.username,req.body?.permission,req.userId,req.role) }); }
    catch(error) { res.status(400).json({error:error.message}); }
  });
  router.delete("/workspaces/:id/members/:userId", async (req,res) => {
    try { res.json({ members:await removeWorkspaceMember(req.params.id,req.params.userId,req.userId,req.role) }); }
    catch(error) { res.status(400).json({error:error.message}); }
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
      for(const item of paths){ await assertWorkspaceAction(req,item,"delete"); await fs.stat(req.workspaceOps.safeResolve(item)); }
      for(const item of paths) await req.workspaceOps.moveToTrash(item,Number(req.workspace.trash_limit_bytes||209715200));
      res.json({ok:true,trashed:paths.length,workspace:await refreshWorkspaceUsage(req.workspace)});
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
      const filepath=normalizeWorkspacePath(req.query.path);
      await assertWorkspaceAction(req,filepath,"delete");
      await req.workspaceOps.deleteFile(filepath);
      await refreshWorkspaceUsage(req.workspace);
      res.json({ok:true});
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
      const filepath=normalizeWorkspacePath(req.body.path);
      await assertWorkspaceAction(req,filepath,"delete");
      const result=await req.workspaceOps.moveToTrash(filepath,Number(req.workspace.trash_limit_bytes||209715200));
      await touchWorkspaceActivity(req.workspace.id);
      const workspace=await refreshWorkspaceUsage(req.workspace);
      res.json({...result,workspace});
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
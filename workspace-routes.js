import express from "express";
import { Readable } from "stream";
import { makeLocalOps } from "./local-hive-ops.js";
import {
  listUserWorkspaces, getWorkspaceForUser, createWorkspace, updateWorkspace,
  listWorkspaceMembers, setWorkspaceMember, removeWorkspaceMember,
  refreshWorkspaceUsage, assertWorkspaceWrite, assertWorkspaceQuota,
} from "./workspaces.js";

const FULL = { read:true,write:true,download:true,move:true,delete:true,create:true };
const READ = { read:true,write:false,download:true,move:false,delete:false,create:false };

function permissions(workspace, systemRole) {
  if (systemRole === "admin" || ["owner","editor"].includes(workspace.permission)) return FULL;
  if (workspace.permission === "contributor") return { ...FULL, delete:false };
  return READ;
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

async function branched(req, res, next) {
  try {
    const workspace = await selectedWorkspace(req);
    if (workspace.is_main) return next();
    req.workspace = await refreshWorkspaceUsage(workspace);
    req.workspaceOps = makeLocalOps(req.workspace.filesystem_root);
    req.workspacePermissions = permissions(req.workspace, req.role);
    next();
  } catch (error) { res.status(403).json({ error:error.message }); }
}

export function workspaceRouter() {
  const router = express.Router();
  router.get("/workspaces", async (req,res) => {
    try {
      const rows = await listUserWorkspaces(req.userId,req.role);
      const workspaces = [];
      for (const row of rows) workspaces.push(row.is_main ? row : await refreshWorkspaceUsage(row));
      res.json({ workspaces });
    } catch(error) { res.status(500).json({error:error.message}); }
  });
  router.post("/workspaces", express.json(), async (req,res) => {
    try { res.status(201).json({ workspace:await createWorkspace({ ...req.body,userId:req.userId,username:req.username }) }); }
    catch(error) { res.status(400).json({error:error.message}); }
  });
  router.patch("/workspaces/:id", express.json(), async (req,res) => {
    try { res.json({ workspace:await updateWorkspace(req.params.id,req.body||{},req.userId,req.role) }); }
    catch(error) { res.status(400).json({error:error.message}); }
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
  router.get("/files",branched,async(req,res)=>{
    if(!req.workspace)return;
    try{
      const subpath=req.query.subpath||"";
      const entries=await req.workspaceOps.listFiles(subpath);
      res.json({entries:entries.map((e)=>({...e,permissions:req.workspacePermissions})),folderPermissions:req.workspacePermissions,workspace:req.workspace});
    }catch(error){res.status(400).json({error:error.message});}
  });
  router.get("/file",branched,async(req,res)=>{
    if(!req.workspace)return;
    try{res.json({content:await req.workspaceOps.readFile(req.query.path),permissions:req.workspacePermissions});}
    catch(error){res.status(400).json({error:error.message});}
  });
  router.put("/file",express.json({limit:"25mb"}),branched,async(req,res)=>{
    if(!req.workspace)return;
    try{
      assertWorkspaceWrite(req.workspace);
      const current=await req.workspaceOps.fileSize(req.body.path);
      assertWorkspaceQuota(req.workspace,Buffer.byteLength(req.body.content||""),current);
      await req.workspaceOps.writeFile(req.body.path,req.body.content||"");
      await refreshWorkspaceUsage(req.workspace);
      res.json({ok:true});
    }catch(error){res.status(400).json({error:error.message});}
  });
  router.delete("/file",branched,async(req,res)=>{
    if(!req.workspace)return;
    try{assertWorkspaceWrite(req.workspace);await req.workspaceOps.deleteFile(req.query.path);await refreshWorkspaceUsage(req.workspace);res.json({ok:true});}
    catch(error){res.status(400).json({error:error.message});}
  });
  router.post("/mkdir",express.json(),branched,async(req,res)=>{
    if(!req.workspace)return;
    try{assertWorkspaceWrite(req.workspace);await req.workspaceOps.mkdir(req.body.path);res.json({ok:true});}
    catch(error){res.status(400).json({error:error.message});}
  });
  router.post("/move",express.json(),branched,async(req,res)=>{
    if(!req.workspace)return;
    try{assertWorkspaceWrite(req.workspace);await req.workspaceOps.moveFile(req.body.from,req.body.to);res.json({ok:true});}
    catch(error){res.status(400).json({error:error.message});}
  });
  router.post("/trash",express.json(),branched,async(req,res)=>{
    if(!req.workspace)return;
    try{assertWorkspaceWrite(req.workspace);const result=await req.workspaceOps.moveToTrash(req.body.path);await refreshWorkspaceUsage(req.workspace);res.json(result);}
    catch(error){res.status(400).json({error:error.message});}
  });
  for(const route of ["/preview","/download"]){
    router.get(route,branched,async(req,res)=>{
      if(!req.workspace)return;
      try{
        const {stream,filename}=await req.workspaceOps.downloadStream(req.query.path);
        res.set("Content-Type","application/octet-stream");
        res.set("Content-Disposition",route==="/preview"?"inline":`attachment; filename="${encodeURIComponent(filename)}"`);
        stream.pipe(res);
      }catch(error){res.status(400).json({error:error.message});}
    });
  }
  router.post("/upload",express.raw({type:()=>true,limit:"2gb"}),branched,async(req,res)=>{
    if(!req.workspace)return;
    try{
      assertWorkspaceWrite(req.workspace);
      const current=await req.workspaceOps.fileSize(req.query.path);
      assertWorkspaceQuota(req.workspace,req.body?.length||0,current);
      await req.workspaceOps.writeBuffer(req.query.path,req.body||Buffer.alloc(0));
      await refreshWorkspaceUsage(req.workspace);
      res.json({ok:true});
    }catch(error){res.status(400).json({error:error.message});}
  });
  router.use("/file-permissions",branched,(req,res,next)=>{
    if(!req.workspace)return;
    res.status(409).json({error:"File-level permissions are managed by workspace roles in branched workspaces"});
  });
  return router;
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { query } from '../../db.js';
import { effectiveWorkspacePermissions } from '../../workspace-permissions.js';
import { canAccessPath } from '../../permissions.js';

const STOP_WORDS = new Set(['the','and','for','with','from','that','this','into','onto','file','copy','scan','page','pages','document','docs','new','final','draft']);
const SORTER_DIR = '_sorter';
const TRASH_DIR = '_trash';

function norm(value='') { return String(value).toLowerCase().replace(/[_\-.]+/g,' '); }
function tokens(value='') { return [...new Set(norm(value).split(/[^a-z0-9]+/).filter(v=>v.length>=3&&!STOP_WORDS.has(v)))]; }
function rootOf(ctx) { if(!ctx?.root) throw new Error('Workspace root missing'); return path.resolve(ctx.root); }
function safeJoin(ctx,...parts) { const root=rootOf(ctx); const full=path.resolve(root,...parts); if(full!==root&&!full.startsWith(root+path.sep)) throw new Error('Path escapes workspace'); return full; }
function rel(root,full) { return path.relative(root,full).split(path.sep).join('/'); }
function hidden(p) { const parts=p.split('/'); return parts.includes(SORTER_DIR)||parts.includes(TRASH_DIR); }

async function sorterPermissions(ctx, filepath='') {
  if (ctx.isAdmin || ctx.isOwner) return { read:true,write:true,download:true,move:true,delete:true,create:true };
  if (ctx.isMain) {
    const allowed = {};
    for (const action of ['read','write','download','move','delete','create']) allowed[action] = await canAccessPath(ctx.systemRole || 'user', filepath, action);
    return allowed;
  }
  return effectiveWorkspacePermissions(ctx.workspaceId, ctx.workspaceRole || 'viewer', filepath);
}

async function assertSorterAction(ctx, filepath, action) {
  const permissions = await sorterPermissions(ctx, filepath);
  if (!permissions[action]) { const error = new Error(`Sorter permission denied: ${action} ${filepath || '/'}`); error.status = 403; throw error; }
  return permissions;
}

async function walk(root,dir=root,out={folders:[],files:[]}) {
  let entries=[]; try { entries=await fs.readdir(dir,{withFileTypes:true}); } catch { return out; }
  for(const ent of entries){ const full=path.join(dir,ent.name); const rp=rel(root,full); if(ent.isDirectory()){ out.folders.push(rp); await walk(root,full,out); } else { const st=await fs.stat(full); out.files.push({path:rp,name:ent.name,size:st.size}); } }
  return out;
}

async function settings(workspaceId){
  await query(`INSERT INTO sorter_workspace_settings(workspace_id) VALUES($1) ON CONFLICT(workspace_id) DO NOTHING`,[workspaceId]);
  const row=(await query(`SELECT * FROM sorter_workspace_settings WHERE workspace_id=$1`,[workspaceId])).rows[0];
  const policy=(await query(`SELECT setting_key,setting_value FROM system_settings WHERE setting_key=ANY($1)`,[['sorter_allow_automatic','sorter_allow_content_scanning']])).rows;
  const map=Object.fromEntries(policy.map(r=>[r.setting_key,r.setting_value]));
  return {...row,allowAutomatic:map.sorter_allow_automatic===true,allowContentScanning:map.sorter_allow_content_scanning===true};
}

export async function getSorterSettings(ctx){ return settings(ctx.workspaceId); }
export async function getSorterPolicy(ctx){
  if(!ctx.isAdmin) throw new Error('Admin access required');
  const current=await settings(ctx.workspaceId);
  return { allowAutomatic:current.allowAutomatic, allowContentScanning:current.allowContentScanning };
}
export async function updateSorterPolicy(ctx,changes={}){
  if(!ctx.isAdmin) throw new Error('Admin access required');
  const values={
    sorter_allow_automatic:!!changes.allowAutomatic,
    sorter_allow_content_scanning:!!changes.allowContentScanning,
  };
  for(const [key,value] of Object.entries(values)) await query(`INSERT INTO system_settings(setting_key,setting_value,updated_at) VALUES($1,$2::jsonb,now()) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=now()`,[key,JSON.stringify(value)]);
  return getSorterPolicy(ctx);
}
export async function updateSorterSettings(ctx,changes,{isAdmin=false,isOwner=false}={}){
  if(!isAdmin&&!isOwner) throw new Error('Owner access required');
  const current=await settings(ctx.workspaceId); const mode=['manual','confirm','automatic'].includes(changes.mode)?changes.mode:current.mode;
  if(mode==='automatic'&&!current.allowAutomatic) throw new Error('Automatic sorting is disabled by admin');
  const auto=Math.max(.5,Math.min(1,Number(changes.autoThreshold??current.auto_threshold)));
  const suggest=Math.max(.1,Math.min(auto,Number(changes.suggestionThreshold??current.suggestion_threshold)));
  const scan=!!changes.contentScanning && current.allowContentScanning;
  await query(`UPDATE sorter_workspace_settings SET mode=$2,auto_threshold=$3,suggestion_threshold=$4,content_scanning=$5,updated_at=now() WHERE workspace_id=$1`,[ctx.workspaceId,mode,auto,suggest,scan]);
  return settings(ctx.workspaceId);
}

async function learning(workspaceId){
  return (await query(`SELECT signal_type,signal_value,destination_path,positive_count,negative_count FROM sorter_learning WHERE workspace_id=$1`,[workspaceId])).rows;
}

function addScore(scores,folder,value,reason){
  const current=scores.get(folder)||{score:0,reasons:[]}; current.score+=value; if(reason) current.reasons.push(reason); scores.set(folder,current);
}

function candidates(file,index,learned){
  const scores=new Map(); const ext=path.extname(file.name).toLowerCase(); const words=tokens(file.name);
  for(const folder of index.folders){
    const folderWords=tokens(folder.path); let similarity=0;
    for(const word of words) if(folderWords.includes(word)) similarity+=8;
    if(ext&&folder.extensions?.[ext]) similarity+=Math.min(20,folder.extensions[ext]*2);
    if(similarity) addScore(scores,folder.path,similarity,'Workspace structure match');
  }
  for(const row of learned){
    const matched=(row.signal_type==='extension'&&row.signal_value===ext)||(row.signal_type==='token'&&words.includes(row.signal_value));
    if(matched) addScore(scores,row.destination_path,row.positive_count*14-row.negative_count*18,'Learned from confirmed and corrected moves');
  }
  return [...scores.entries()].map(([folder,data])=>({folder,raw:data.score,reason:[...new Set(data.reasons)].join(' + ')})).filter(x=>index.folderSet.has(x.folder)).sort((a,b)=>b.raw-a.raw).slice(0,3);
}

export async function buildFolderIndex(ctx){
  const root=rootOf(ctx); const tree=await walk(root); const folderFiles=new Map();
  for(const file of tree.files){ const dir=path.posix.dirname(file.path); if(dir==='.'||hidden(dir)) continue; if(!folderFiles.has(dir)) folderFiles.set(dir,[]); folderFiles.get(dir).push(file); }
  const folders=[];
  for(const p of tree.folders){
    if(hidden(p)) continue;
    const permissions=await sorterPermissions(ctx,p);
    if(!permissions.create) continue;
    const extensions={}; for(const file of folderFiles.get(p)||[]){ const ext=path.extname(file.name).toLowerCase(); if(ext) extensions[ext]=(extensions[ext]||0)+1; }
    folders.push({path:p,name:path.posix.basename(p),extensions,fileCount:(folderFiles.get(p)||[]).length});
  }
  return {root,builtAt:new Date().toISOString(),folders,folderSet:new Set(folders.map(f=>f.path))};
}

function confidence(raw){ return Math.max(0,Math.min(.99,raw/(raw+35))); }

export async function startSorter(ctx){
  const cfg=await settings(ctx.workspaceId); const index=await buildFolderIndex(ctx); const learned=await learning(ctx.workspaceId);
  const sorterPath=safeJoin(ctx,SORTER_DIR); const inbox=await walk(rootOf(ctx),sorterPath); const items=[];
  for(const file of inbox.files){
    const sourcePermissions=await sorterPermissions(ctx,file.path);
    if(!sourcePermissions.read||!sourcePermissions.move) continue;
    const ranked=candidates(file,index,learned).map(c=>({...c,confidence:confidence(c.raw)})); const best=ranked[0];
    const selectedDestination=best?`${best.folder}/${file.name}`:''; const auto=cfg.mode==='automatic'&&cfg.allowAutomatic&&best?.confidence>=Number(cfg.auto_threshold);
    items.push({id:Buffer.from(file.path).toString('base64url'),source:file.path,name:file.name,classification:best?'Learned workspace match':'Needs destination',reason:best?.reason||'Not enough workspace history yet',confidence:best?.confidence||0,candidates:ranked,selectedDestination,approved:auto,status:selectedDestination?'preview':'needs_destination'});
  }
  return {status:'preview',safeMode:cfg.mode!=='automatic',startedAt:new Date().toISOString(),items,index:{...index,folderSet:undefined},settings:cfg};
}

async function learnMove(workspaceId,itemName,destination,previousCandidates=[]){
  const folder=path.posix.dirname(destination); const ext=path.extname(itemName).toLowerCase();
  const signals=[...(ext?[['extension',ext]]:[]),...tokens(itemName).map(token=>['token',token])];
  for(const [type,value] of signals){
    await query(`INSERT INTO sorter_learning(workspace_id,signal_type,signal_value,destination_path,positive_count)
      VALUES($1,$2,$3,$4,1) ON CONFLICT(workspace_id,signal_type,signal_value,destination_path)
      DO UPDATE SET positive_count=sorter_learning.positive_count+1,updated_at=now()`,[workspaceId,type,value,folder]);
    for(const candidate of previousCandidates||[]){ if(candidate.folder===folder) continue;
      await query(`INSERT INTO sorter_learning(workspace_id,signal_type,signal_value,destination_path,negative_count)
        VALUES($1,$2,$3,$4,1) ON CONFLICT(workspace_id,signal_type,signal_value,destination_path)
        DO UPDATE SET negative_count=sorter_learning.negative_count+1,updated_at=now()`,[workspaceId,type,value,candidate.folder]);
    }
  }
}

async function uniqueDest(full){
  const parsed=path.parse(full); let candidate=full; let n=1;
  while(true){ try{ await fs.access(candidate); candidate=path.join(parsed.dir,`${parsed.name} (${n++})${parsed.ext}`); } catch { return candidate; } }
}

export async function confirmSorter(ctx,items){
  const moved=[]; const skipped=[];
  for(const item of items||[]){
    if(!item.approved){ skipped.push({...item,reason:'not approved'}); continue; }
    if(!item.source?.startsWith(`${SORTER_DIR}/`)){ skipped.push({...item,reason:'source not in sorter'}); continue; }
    if(!item.selectedDestination||hidden(item.selectedDestination)){ skipped.push({...item,reason:'blocked destination'}); continue; }
    await assertSorterAction(ctx,item.source,'move');
    const destinationFolder=path.posix.dirname(item.selectedDestination);
    await assertSorterAction(ctx,destinationFolder==='.'?'':destinationFolder,'create');
    const src=safeJoin(ctx,item.source); const dest=await uniqueDest(safeJoin(ctx,item.selectedDestination));
    await fs.mkdir(path.dirname(dest),{recursive:true}); await fs.rename(src,dest);
    const destination=rel(rootOf(ctx),dest); await learnMove(ctx.workspaceId,item.name,destination,item.candidates);
    moved.push({source:item.source,destination});
  }
  return {status:'confirmed',confirmedAt:new Date().toISOString(),moved,skipped};
}

export async function resetSorterLearning(ctx){
  if(!ctx.isAdmin&&!ctx.isOwner) throw new Error('Owner access required');
  await query(`DELETE FROM sorter_learning WHERE workspace_id=$1`,[ctx.workspaceId]);
  return {ok:true};
}

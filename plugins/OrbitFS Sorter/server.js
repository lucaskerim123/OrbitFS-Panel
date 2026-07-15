import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { startSorter,confirmSorter,buildFolderIndex,getSorterSettings,updateSorterSettings,getSorterPolicy,updateSorterPolicy,resetSorterLearning } from './sorter-core.js';

const APP_DIR=path.dirname(fileURLToPath(import.meta.url));
dotenv.config({path:path.join(APP_DIR,'.env')});
const config=JSON.parse(await fs.readFile(path.join(APP_DIR,'config.json'),'utf8'));
const PORT=Number(process.env.SORTER_PORT||process.env.PORT||config.port||4055);
const API_KEY=process.env.HIVE_API_KEY||config.apiKey;
const states=new Map();

function authorized(req){ return !API_KEY||(req.headers.authorization||'')===`Bearer ${API_KEY}`; }
function context(req){
  const workspaceId=req.headers['x-workspace-id']; const root=req.headers['x-workspace-root'];
  if(!workspaceId||!root) throw new Error('Trusted workspace context missing');
  return {
    workspaceId:String(workspaceId),
    root:decodeURIComponent(String(root)),
    isAdmin:req.headers['x-sorter-admin']==='true',
    isOwner:req.headers['x-sorter-owner']==='true',
    workspaceRole:String(req.headers['x-workspace-role']||'viewer'),
    isMain:req.headers['x-workspace-main']==='true',
    systemRole:String(req.headers['x-system-role']||'user'),
  };
}
function send(res,code,data){ res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'}); res.end(JSON.stringify(data)); }
async function body(req){ const chunks=[]; for await(const c of req) chunks.push(c); const raw=Buffer.concat(chunks).toString('utf8'); return raw?JSON.parse(raw):{}; }
async function api(req,res){
  const url=new URL(req.url,'http://localhost');
  if(req.method==='GET'&&url.pathname==='/api/status') return send(res,200,{ok:true});
  const ctx=context(req); const state=states.get(ctx.workspaceId)||{status:'idle',safeMode:true,items:[],lastRun:null};
  if(req.method==='GET'&&url.pathname==='/api/session') return send(res,200,state);
  if(req.method==='GET'&&url.pathname==='/api/folders'){ const index=await buildFolderIndex(ctx); return send(res,200,{folders:index.folders}); }
  if(req.method==='GET'&&url.pathname==='/api/settings') return send(res,200,await getSorterSettings(ctx));
  if(req.method==='PUT'&&url.pathname==='/api/settings') return send(res,200,await updateSorterSettings(ctx,await body(req),ctx));
  if(req.method==='GET'&&url.pathname==='/api/policy') return send(res,200,await getSorterPolicy(ctx));
  if(req.method==='PUT'&&url.pathname==='/api/policy') return send(res,200,await updateSorterPolicy(ctx,await body(req)));
  if(req.method==='DELETE'&&url.pathname==='/api/learning') return send(res,200,await resetSorterLearning(ctx));
  if(req.method==='PUT'&&url.pathname==='/api/session'){ const next=await body(req); states.set(ctx.workspaceId,next); return send(res,200,next); }
  if(req.method==='POST'&&url.pathname==='/api/startsorter'){
    const run=await startSorter(ctx); let autoResult=null; let items=run.items;
    if(run.settings?.mode==='automatic'&&run.settings?.allowAutomatic){
      const automatic=run.items.filter(item=>item.approved);
      if(automatic.length) autoResult=await confirmSorter(ctx,automatic);
      const movedSources=new Set((autoResult?.moved||[]).map(item=>item.source));
      items=run.items.filter(item=>!movedSources.has(item.source));
    }
    const next={...run,items,autoResult,lastRun:run.startedAt}; states.set(ctx.workspaceId,next); return send(res,200,next);
  }
  if(req.method==='POST'&&url.pathname==='/api/stopsorter'){ const next={status:'stopped',safeMode:true,items:[],lastRun:state.lastRun}; states.set(ctx.workspaceId,next); return send(res,200,next); }
  if(req.method==='POST'&&url.pathname==='/api/confirmsorter'){ const input=await body(req); const result=await confirmSorter(ctx,input.items||state.items||[]); states.set(ctx.workspaceId,{status:'confirmed',safeMode:true,items:[],lastRun:state.lastRun,result}); return send(res,200,result); }
  return send(res,404,{error:'unknown api route'});
}

async function findFreePort(port){ return new Promise((resolve,reject)=>{ const server=http.createServer(); server.listen(port,()=>server.close(()=>resolve(port))); server.on('error',err=>err.code==='EADDRINUSE'?findFreePort(port+1).then(resolve,reject):reject(err)); }); }
const actual=await findFreePort(PORT);
http.createServer(async(req,res)=>{
  try{
    if(!req.url.startsWith('/api/')) return send(res,404,{error:'not found'});
    if(!authorized(req)) return send(res,401,{error:'Unauthorized'});
    await api(req,res);
  }catch(error){ send(res,error.status||500,{error:error.message}); }
}).listen(actual,async()=>{
  await fs.writeFile(path.join(APP_DIR,'.sorter-port'),String(actual),'utf8').catch(()=>{});
  console.log(`OrbitFS Sorter running on http://localhost:${actual}`);
});

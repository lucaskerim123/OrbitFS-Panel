from pathlib import Path
p = Path(r"F:\OrbitFS Project\OrbitFS-Panel\plugins\OrbitFS Sorter\server.js")
s = p.read_text(encoding="utf-8")
old = """  if(req.method==='GET'&&url.pathname==='/api/status'){ const license=await getComponentStatus(COMPONENTS.SORTER); return send(res,200,{ok:true,license}); }
  await assertComponentLicensed(COMPONENTS.SORTER);
  const ctx=context(req); const state=states.get(ctx.workspaceId)||{status:'idle',safeMode:true,items:[],lastRun:null};"""
new = """  if(req.method==='GET'&&url.pathname==='/api/status'){ const license=await getComponentStatus(COMPONENTS.SORTER); return send(res,200,{ok:true,license,blocked:!license.licensed}); }
  const license=await getComponentStatus(COMPONENTS.SORTER);
  if(!license.licensed){
    if(req.method==='GET'&&(url.pathname==='/api/license'||url.pathname==='/api/setup'||url.pathname==='/api/check')) return send(res,200,{ok:false,blocked:true,license});
    return send(res,403,{error:'Sorter is blocked by licence',code:'LICENSE_REQUIRED',license});
  }
  await assertComponentLicensed(COMPONENTS.SORTER);
  const ctx=context(req); const state=states.get(ctx.workspaceId)||{status:'idle',safeMode:true,items:[],lastRun:null};"""
if old not in s:
    raise SystemExit('sorter licence gate block not found')
p.write_text(s.replace(old, new, 1), encoding="utf-8")
print('PATCHED_SORTER_SELF_GATE')
const fs = require('fs');
const path = require('path');
const root = process.cwd();
function read(p){ return fs.readFileSync(path.join(root,p),'utf8'); }
function section(html,id){
  const start = html.indexOf(`<section id="tab-${id}"`);
  if(start < 0) return '';
  const next = html.indexOf('\n    <section id="tab-', start + 10);
  return html.slice(start, next < 0 ? html.length : next);
}
const html = read('public/index.html');
for (const id of ['workspaces','system','config','admin']) {
  const s = section(html,id);
  console.log(`\n### TAB:${id.toUpperCase()} HTML_IDS`);
  [...s.matchAll(/id="([^"]+)"/g)].map(m=>m[1]).forEach(x=>console.log(x));
  console.log(`### TAB:${id.toUpperCase()} HEADINGS`);
  [...s.matchAll(/<(summary|h2|h3)[^>]*>([\s\S]*?)<\/\1>/g)].map(m=>m[2].replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim()).filter(Boolean).forEach(x=>console.log(x));
}
console.log('\n### SERVER_ROUTES');
const server = read('server.js');
[...server.matchAll(/app\.(get|post|put|patch|delete)\("([^"]+)"/g)].forEach(m=>console.log(`${m[1].toUpperCase()} ${m[2]}`));
console.log('\n### FRONTEND_API_CALLS');
for (const file of ['public/app.js','public/workspace-ui.js','public/workspace-permission-editor.js','public/workspace-access.js','public/addon-manager.js','public/system-admin-final.js','public/stable-admin-layout.js']) {
  if(!fs.existsSync(path.join(root,file))) continue;
  const text = read(file);
  [...text.matchAll(/api\(`([^`]+)`|api\("([^"]+)"|fetch\("([^"]+)/g)].forEach(m=>console.log(`${file}: ${m[1]||m[2]||m[3]}`));
}

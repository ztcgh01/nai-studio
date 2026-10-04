const { app, BrowserWindow, ipcMain, shell } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const STORE_DIR = { entries:'library/entries', atlasEntries:'library/atlas', foldersV2:'library/folders' };
let root;
const safe = s => String(s||'').replace(/[^a-zA-Z0-9._-]/g,'_');

async function ensure(){
  root = path.join(app.getPath('documents'),'NAI Studio Data');
  for(const p of ['library/entries','library/atlas','library/folders','images/gallery','images/atlas','images/folders','backups']) await fsp.mkdir(path.join(root,p),{recursive:true});
  await recoverJson(path.join(root,'meta.json'));
  try{await fsp.access(path.join(root,'meta.json'))}catch{await atomicJson(path.join(root,'meta.json'),{})}
}
async function recoverJson(file){
  const bak=file+'.bak';
  try{await fsp.access(file);return}catch{}
  try{await fsp.rename(bak,file)}catch{}
}
async function atomicJson(file,obj){
  const tmp=file+'.tmp-'+process.pid+'-'+Date.now()+'-'+Math.random().toString(16).slice(2),bak=file+'.bak';
  await fsp.mkdir(path.dirname(file),{recursive:true});
  await fsp.writeFile(tmp,JSON.stringify(obj,null,2),'utf8');
  try{await fsp.unlink(bak)}catch{}
  try{await fsp.rename(file,bak)}catch{}
  try{await fsp.rename(tmp,file)}catch(err){
    try{await fsp.rename(bak,file)}catch{}
    throw err;
  }
  try{await fsp.unlink(bak)}catch{}
}
async function readJson(file,fallback=null){
  await recoverJson(file);
  try{return JSON.parse(await fsp.readFile(file,'utf8'))}catch{return fallback}
}
function extFromMime(mime,name=''){
  if(/png/i.test(mime))return 'png'; if(/webp/i.test(mime))return 'webp'; if(/jpe?g/i.test(mime))return 'jpg';
  const e=path.extname(name).replace('.','').toLowerCase(); return ['png','jpg','jpeg','webp'].includes(e)?e:'bin';
}
async function materializeBinary(obj,baseParts=[]){
  if(!obj||typeof obj!=='object')return obj;
  if(obj.__naiBinary&&obj.bytes){
    const ext=extFromMime(obj.mime,obj.name),rel=path.join(...baseParts)+'.'+ext,abs=path.join(root,rel);
    await fsp.mkdir(path.dirname(abs),{recursive:true});
    const tmp=abs+'.tmp-'+process.pid+'-'+Date.now()+'-'+Math.random().toString(16).slice(2); await fsp.writeFile(tmp,Buffer.from(obj.bytes)); try{await fsp.rename(tmp,abs)}catch(err){try{await fsp.unlink(abs)}catch{}await fsp.rename(tmp,abs)}
    return {__naiFile:rel.replace(/\\/g,'/'),mime:obj.mime||'',name:obj.name||''};
  }
  if(Array.isArray(obj)){const out=[];for(let i=0;i<obj.length;i++)out.push(await materializeBinary(obj[i],[...baseParts,String(i)]));return out}
  const out={};for(const [k,v] of Object.entries(obj))out[k]=await materializeBinary(v,[...baseParts,safe(k)]);return out;
}
async function hydrateBinary(obj){
  if(!obj||typeof obj!=='object')return obj;
  if(obj.__naiFile){try{return {__naiBinary:true,__naiFileRef:obj.__naiFile,mime:obj.mime||'',name:obj.name||'',bytes:new Uint8Array(await fsp.readFile(path.join(root,obj.__naiFile)))}}catch{return null}}
  if(Array.isArray(obj)){const out=[];for(const v of obj)out.push(await hydrateBinary(v));return out}
  const out={};for(const [k,v] of Object.entries(obj))out[k]=await hydrateBinary(v);return out;
}
function recFile(store,id){return path.join(root,STORE_DIR[store],safe(id)+'.json')}
function binBase(store,id){return store==='entries'?['images','gallery',safe(id)]:store==='atlasEntries'?['images','atlas',safe(id)]:['images','folders',safe(id)]}
async function getAll(store){
  if(store==='meta'){const m=await readJson(path.join(root,'meta.json'),{});return Object.entries(m).map(([key,value])=>({key,value}))}
  const dir=path.join(root,STORE_DIR[store]);let names=[];try{names=await fsp.readdir(dir)}catch{}
  const rows=await Promise.all(names.filter(x=>x.endsWith('.json')).map(async n=>{const raw=await readJson(path.join(dir,n));return raw?hydrateBinary(raw):null}));
  return rows.filter(Boolean);
}
async function put(store,val){
  if(store==='meta'){const file=path.join(root,'meta.json'),m=await readJson(file,{});m[val.key]=val.value;await atomicJson(file,m);return}
  const encoded=await materializeBinary(val,binBase(store,val.id));await atomicJson(recFile(store,val.id),encoded);
}
async function del(store,id){
  if(store==='meta'){const file=path.join(root,'meta.json'),m=await readJson(file,{});delete m[id];await atomicJson(file,m);return}
  try{await fsp.unlink(recFile(store,id))}catch{}
}
async function replace(store,vals){
  if(store==='meta')throw new Error('meta replace unsupported');
  const dir=path.join(root,STORE_DIR[store]);await fsp.mkdir(dir,{recursive:true});
  const keep=new Set(vals.map(v=>safe(v.id)+'.json'));
  for(const v of vals)await put(store,v);
  for(const n of await fsp.readdir(dir))if(n.endsWith('.json')&&!keep.has(n))await fsp.unlink(path.join(dir,n));
}
async function importLooseGalleryFiles(){
  const imgDir=path.join(root,'images','gallery'),recDir=path.join(root,'library','entries');
  const known=new Set();
  for(const n of await fsp.readdir(recDir)){
    if(!n.endsWith('.json'))continue;
    const r=await readJson(path.join(recDir,n));
    if(r&&r.__desktopImportedFile)known.add(r.__desktopImportedFile);
  }
  for(const n of await fsp.readdir(imgDir)){
    if(!/\.(png|jpe?g|webp)$/i.test(n)||known.has(n))continue;
    const abs=path.join(imgDir,n),st=await fsp.stat(abs);
    const id='desktop_'+Buffer.from(n+'|'+st.size+'|'+st.mtimeMs).toString('base64url').slice(0,32);
    if(await readJson(recFile('entries',id)))continue;
    const mime=/\.png$/i.test(n)?'image/png':/\.webp$/i.test(n)?'image/webp':'image/jpeg';
    await atomicJson(recFile('entries',id),{
      id,
      name:n,
      fileName:n,
      createdAt:new Date(st.birthtimeMs||st.mtimeMs).toISOString(),
      updatedAt:new Date(st.mtimeMs).toISOString(),
      __desktopImportedFile:n,
      imageBlob:{__naiFile:path.relative(root,abs).replace(/\\/g,'/'),mime,name:n}
    });
  }
}
async function createWindow(){
  await ensure();
  await importLooseGalleryFiles();
  const win=new BrowserWindow({width:1440,height:920,minWidth:980,minHeight:680,backgroundColor:'#f7f7f7',autoHideMenuBar:true,
    webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:false}});
  win.setMenuBarVisibility(false);
  await win.loadFile(path.join(__dirname,'index.html'));
}
app.whenReady().then(()=>{
  ipcMain.handle('nai:getAll',(_,s)=>getAll(s));
  ipcMain.handle('nai:put',(_,s,v)=>put(s,v));
  ipcMain.handle('nai:delete',(_,s,id)=>del(s,id));
  ipcMain.handle('nai:replace',(_,s,v)=>replace(s,v));
  ipcMain.handle('nai:dataPath',()=>root);
  ipcMain.handle('nai:openData',()=>shell.openPath(root));
  createWindow();
});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit()});

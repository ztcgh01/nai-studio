const { app, BrowserWindow, ipcMain, shell, dialog, protocol, net } = require('electron');
const { autoUpdater } = require('electron-updater');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { pathToFileURL } = require('url');

protocol.registerSchemesAsPrivileged([{scheme:'nai-image',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true}}]);

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
async function materializeBinary(obj,baseParts=[],ctx={store:'',id:'',keyPath:[]}){
  if(!obj||typeof obj!=='object')return obj;
  if(obj.__naiBinary&&obj.bytes){
    const ext=extFromMime(obj.mime,obj.name),rel=path.join(...baseParts,binaryStem(ctx.store,ctx.id,obj,ctx.keyPath))+'.'+ext,abs=path.join(root,rel);
    await fsp.mkdir(path.dirname(abs),{recursive:true});
    const tmp=abs+'.tmp-'+process.pid+'-'+Date.now()+'-'+Math.random().toString(16).slice(2); await fsp.writeFile(tmp,Buffer.from(obj.bytes)); try{await fsp.rename(tmp,abs)}catch(err){try{await fsp.unlink(abs)}catch{}await fsp.rename(tmp,abs)}
    return {__naiFile:rel.replace(/\\/g,'/'),mime:obj.mime||'',name:obj.name||''};
  }
  if(Array.isArray(obj)){const out=[];for(let i=0;i<obj.length;i++)out.push(await materializeBinary(obj[i],baseParts,{...ctx,keyPath:[...ctx.keyPath,String(i)]}));return out}
  const out={};for(const [k,v] of Object.entries(obj))out[k]=await materializeBinary(v,baseParts,{...ctx,keyPath:[...ctx.keyPath,k]});return out;
}
async function hydrateBinary(obj){
  if(!obj||typeof obj!=='object')return obj;
  if(obj.__naiFile){try{return {__naiBinary:true,__naiFileRef:obj.__naiFile,mime:obj.mime||'',name:obj.name||'',bytes:new Uint8Array(await fsp.readFile(path.join(root,obj.__naiFile)))}}catch{return null}}
  if(Array.isArray(obj)){const out=[];for(const v of obj)out.push(await hydrateBinary(v));return out}
  const out={};for(const [k,v] of Object.entries(obj))out[k]=await hydrateBinary(v);return out;
}
function recFile(store,id){return path.join(root,STORE_DIR[store],safe(id)+'.json')}
function binBase(store,id){return store==='entries'?['images','gallery']:store==='atlasEntries'?['images','atlas']:['images','folders']}
function binaryStem(store,id,obj,keyPath=[]){
  const original=path.basename(String(obj?.name||'')).replace(/\.[^.]+$/,'');
  const suffix=keyPath.length?'-'+keyPath.map(safe).join('-'):'';
  return safe((original||id)+suffix+'-'+safe(id).slice(-10));
}
async function getAll(store,options={}){
  if(store==='meta'){const m=await readJson(path.join(root,'meta.json'),{});return Object.entries(m).map(([key,value])=>({key,value}))}
  const dir=path.join(root,STORE_DIR[store]);let names=[];try{names=await fsp.readdir(dir)}catch{}
  const rawRows=(await Promise.all(names.filter(x=>x.endsWith('.json')).map(n=>readJson(path.join(dir,n))))).filter(Boolean);
  if(options?.metadataOnly)return rawRows;
  const rows=await Promise.all(rawRows.map(raw=>hydrateBinary(raw)));
  return rows.filter(Boolean);
}
async function getFolderSummaries(){
  const dir=path.join(root,STORE_DIR.foldersV2);let names=[];try{names=await fsp.readdir(dir)}catch{}
  const rows=(await Promise.all(names.filter(x=>x.endsWith('.json')).map(n=>readJson(path.join(dir,n))))).filter(Boolean);
  return rows.map(f=>{
    const items=Array.isArray(f.items)?f.items.map(it=>{
      if(!it||typeof it!=='object')return it;
      const o={...it};
      // Filesystem refs are tiny and safe for cover rendering. Never ship binary byte payloads in Archive summaries.
      if(o.blob?.__naiBinary||o.blob?.bytes)delete o.blob;
      if(Array.isArray(o.images))o.images=o.images.map(v=>{
        if(v?.blob?.__naiBinary||v?.blob?.bytes){const z={...v};delete z.blob;return z}
        return v;
      });
      return o;
    }):[];
    return {...f,items};
  });
}
async function getOneHydrated(store,id){
  if(store==='meta')return null;
  const raw=await readJson(recFile(store,id));
  if(!raw)return null;
  return hydrateBinary(raw);
}
async function copyAtlasToGalleryBatch(items,onProgress){
  if(!Array.isArray(items)||!items.length)return [];
  const out=new Array(items.length),concurrency=Math.min(6,items.length);let next=0,done=0;
  await Promise.all(Array.from({length:concurrency},async()=>{while(true){
    const i=next++;if(i>=items.length)break;
    const it=items[i],src=await readJson(recFile('atlasEntries',it.atlasId));
    if(!src)throw new Error('Atlas record not found: '+it.atlasId);
    const ref=src?.imageBlob?.__naiFile;if(!ref)throw new Error('Atlas image file reference missing: '+it.atlasId);
    const srcAbs=path.resolve(root,ref),imagesRoot=path.resolve(root,'images');
    if(!srcAbs.startsWith(imagesRoot+path.sep))throw new Error('Invalid Atlas image path');
    const ext=path.extname(srcAbs)||'.png',name=path.basename(srcAbs,ext),rel=path.join('images','gallery',safe(name)+'-'+safe(it.entry.id).slice(-10)+ext).replace(/\\/g,'/');
    const dst=path.join(root,rel);await fsp.mkdir(path.dirname(dst),{recursive:true});
    try{await fsp.copyFile(srcAbs,dst)}catch(err){if(err?.code!=='EEXIST')throw err}
    const row={...it.entry,imageBlob:{__naiFile:rel,mime:src.imageBlob?.mime||'',name:src.imageBlob?.name||path.basename(dst)}};
    await atomicJson(recFile('entries',row.id),row);out[i]=row;done++;onProgress?.(done,items.length);
  }}));
  return out;
}
async function putMany(store,vals){
  if(!Array.isArray(vals)||!vals.length)return;
  const concurrency=Math.min(8,vals.length);let next=0;
  await Promise.all(Array.from({length:concurrency},async()=>{while(next<vals.length){const i=next++;await put(store,vals[i])}}));
}
async function put(store,val){
  if(store==='meta'){const file=path.join(root,'meta.json'),m=await readJson(file,{});m[val.key]=val.value;await atomicJson(file,m);return}
  const encoded=await materializeBinary(val,binBase(store,val.id),{store,id:val.id,keyPath:[]});await atomicJson(recFile(store,val.id),encoded);
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
async function importLooseImages(kind,{force=false}={}){
  const cfg=kind==='atlas'
    ?{store:'atlasEntries',imageDir:'atlas',recordDir:'atlas',scanName:'.atlas-scan.json',idPrefix:'desktop_atlas_'}
    :{store:'entries',imageDir:'gallery',recordDir:'entries',scanName:'.gallery-scan.json',idPrefix:'desktop_'};
  let added=0;
  const imgDir=path.join(root,'images',cfg.imageDir),recDir=path.join(root,'library',cfg.recordDir),scanFile=path.join(root,'library',cfg.scanName);
  let dirStamp=0;try{dirStamp=(await fsp.stat(imgDir)).mtimeMs}catch{}
  const previousScan=await readJson(scanFile,{});
  if(!force&&dirStamp&&previousScan?.dirStamp===dirStamp)return 0;

  const known=new Set();
  for(const n of await fsp.readdir(recDir)){
    if(!n.endsWith('.json'))continue;
    const r=await readJson(path.join(recDir,n));
    if(r&&r.__desktopImportedFile)known.add(r.__desktopImportedFile);
    const ref=r?.imageBlob?.__naiFile;
    if(ref&&String(ref).replace(/\\/g,'/').startsWith('images/'+cfg.imageDir+'/'))known.add(path.basename(ref));
  }
  const imageNames=(await fsp.readdir(imgDir)).filter(n=>/\.(png|jpe?g|webp)$/i.test(n));
  const newNames=imageNames.filter(n=>!known.has(n));
  for(const n of newNames){
    const abs=path.join(imgDir,n),st=await fsp.stat(abs);
    const id=cfg.idPrefix+Buffer.from(n+'|'+st.size+'|'+st.mtimeMs).toString('base64url').slice(0,32);
    if(await readJson(recFile(cfg.store,id)))continue;
    const mime=/\.png$/i.test(n)?'image/png':/\.webp$/i.test(n)?'image/webp':'image/jpeg';
    const row={
      id,name:n,fileName:n,
      createdAt:new Date(st.birthtimeMs||st.mtimeMs).toISOString(),
      updatedAt:new Date(st.mtimeMs).toISOString(),
      __desktopImportedFile:n,
      imageBlob:{__naiFile:path.relative(root,abs).replace(/\\/g,'/'),mime,name:n}
    };
    if(kind==='atlas'){row.rating='unrated';row.utilityTags=[];row.memo='';row.artists=[]}
    await atomicJson(recFile(cfg.store,id),row);
    added++;
  }
  let finalStamp=dirStamp;try{finalStamp=(await fsp.stat(imgDir)).mtimeMs}catch{}
  await atomicJson(scanFile,{dirStamp:finalStamp,scannedAt:Date.now()});
  return added;
}
async function scanLooseImages(options={}){
  const [gallery,atlas]=await Promise.all([
    importLooseImages('gallery',options),
    importLooseImages('atlas',options)
  ]);
  return {gallery,atlas,total:gallery+atlas};
}
let mainWindow=null,updateBusy=false;
autoUpdater.autoDownload=false;
autoUpdater.autoInstallOnAppQuit=true;
autoUpdater.allowPrerelease=false;

async function checkForUpdates(interactive=false){
  if(!app.isPackaged){if(interactive)await dialog.showMessageBox({type:'info',title:'NAI Studio 업데이트',message:'개발 실행에서는 업데이트를 확인하지 않습니다.'});return {status:'dev'}}
  if(updateBusy)return {status:'busy'};
  updateBusy=true;
  try{
    const result=await autoUpdater.checkForUpdates();
    const latest=result?.updateInfo?.version;
    if(!latest||latest===app.getVersion()){
      if(interactive)await dialog.showMessageBox(mainWindow,{type:'info',title:'NAI Studio 업데이트',message:`현재 최신 버전입니다. (v${app.getVersion()})`});
      return {status:'current',version:app.getVersion()};
    }
    const choice=await dialog.showMessageBox(mainWindow,{type:'info',title:'NAI Studio 업데이트',message:`NAI Studio v${latest} 업데이트가 있습니다.`,detail:'프로그램 파일만 업데이트되며 Documents\\NAI Studio Data의 이미지와 라이브러리 데이터는 그대로 유지됩니다.',buttons:['업데이트','나중에'],defaultId:0,cancelId:1,noLink:true});
    if(choice.response!==0)return {status:'later',version:latest};
    await autoUpdater.downloadUpdate();
    return {status:'downloading',version:latest};
  }catch(err){
    console.error('Update check failed',err);
    if(interactive)await dialog.showMessageBox(mainWindow,{type:'warning',title:'업데이트 확인 실패',message:'업데이트 서버를 확인하지 못했습니다.',detail:String(err?.message||err)});
    return {status:'error',message:String(err?.message||err)};
  }finally{updateBusy=false}
}
autoUpdater.on('update-downloaded',async info=>{
  const choice=await dialog.showMessageBox(mainWindow,{type:'info',title:'업데이트 준비 완료',message:`NAI Studio v${info.version} 다운로드가 완료되었습니다.`,detail:'지금 재시작하면 업데이트가 적용됩니다.',buttons:['재시작하여 업데이트','나중에'],defaultId:0,cancelId:1,noLink:true});
  if(choice.response===0)autoUpdater.quitAndInstall(false,true);
});

async function createWindow(){
  await ensure();
  const win=new BrowserWindow({width:1440,height:920,minWidth:980,minHeight:680,backgroundColor:'#f7f7f7',autoHideMenuBar:true,
    webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:false}});
  mainWindow=win;
  win.setMenuBarVisibility(false);
  win.webContents.on('found-in-page',(_event,result)=>{if(!win.isDestroyed())win.webContents.send('nai:findResult',result)});
  await win.loadFile(path.join(__dirname,'index.html'));
  // Disk discovery is manual-only via Image Scan. Never rescan the library during startup.
  setTimeout(()=>checkForUpdates(false),4500);
}
app.whenReady().then(()=>{
  protocol.handle('nai-image',request=>{
    try{
      const u=new URL(request.url),rel=decodeURIComponent(u.pathname.replace(/^\/+/,'' )).replace(/\\/g,'/');
      if(!rel.startsWith('images/'))return new Response('Forbidden',{status:403});
      const imagesRoot=path.resolve(root,'images'),abs=path.resolve(root,rel);
      if(abs!==imagesRoot&&!abs.startsWith(imagesRoot+path.sep))return new Response('Forbidden',{status:403});
      return net.fetch(pathToFileURL(abs).href);
    }catch(err){console.error('nai-image protocol failed',err);return new Response('Not found',{status:404})}
  });
  ipcMain.handle('nai:getAll',(_,s,o)=>getAll(s,o));
  ipcMain.handle('nai:findInPage',(event,text,options={})=>event.sender.findInPage(String(text||''),options||{}));
  ipcMain.handle('nai:stopFind',(event,action='clearSelection')=>{event.sender.stopFind(action);return true});
  ipcMain.handle('nai:getOneHydrated',(_,s,id)=>getOneHydrated(s,id));
  ipcMain.handle('nai:getFolderSummaries',()=>getFolderSummaries());
  ipcMain.handle('nai:scanLooseImages',()=>scanLooseImages({force:true}));
  ipcMain.handle('nai:put',(_,s,v)=>put(s,v));
  ipcMain.handle('nai:putMany',(_,s,v)=>putMany(s,v));
  ipcMain.handle('nai:atlasToGalleryBatch',async(event,items)=>copyAtlasToGalleryBatch(items,(done,total)=>event.sender.send('nai:batchProgress',{kind:'atlasToGallery',done,total})));
  ipcMain.handle('nai:delete',(_,s,id)=>del(s,id));
  ipcMain.handle('nai:replace',(_,s,v)=>replace(s,v));
  ipcMain.handle('nai:dataPath',()=>root);
  ipcMain.handle('nai:openData',()=>shell.openPath(root));
  ipcMain.handle('nai:checkUpdate',()=>checkForUpdates(true));
  ipcMain.handle('nai:version',()=>app.getVersion());
  createWindow();
});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit()});

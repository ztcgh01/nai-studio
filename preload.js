const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('naiDesktop',{
  getAll:(s,o)=>ipcRenderer.invoke('nai:getAll',s,o),
  getOneHydrated:(s,id)=>ipcRenderer.invoke('nai:getOneHydrated',s,id),
  imageUrl:(rel)=>`nai-image://local/${encodeURIComponent(String(rel||''))}`,
  onExternalImportComplete:(cb)=>{const fn=(_e,payload)=>cb(payload);ipcRenderer.on('nai:externalImportComplete',fn);return ()=>ipcRenderer.removeListener('nai:externalImportComplete',fn)},
  put:(s,v)=>ipcRenderer.invoke('nai:put',s,v),
  putMany:(s,v)=>ipcRenderer.invoke('nai:putMany',s,v),
  del:(s,id)=>ipcRenderer.invoke('nai:delete',s,id),
  replace:(s,v)=>ipcRenderer.invoke('nai:replace',s,v),
  dataPath:()=>ipcRenderer.invoke('nai:dataPath'),
  openData:()=>ipcRenderer.invoke('nai:openData'),
  checkUpdate:()=>ipcRenderer.invoke('nai:checkUpdate'),
  version:()=>ipcRenderer.invoke('nai:version')
});

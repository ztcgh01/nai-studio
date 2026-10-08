const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('naiDesktop',{
  getAll:(s,o)=>ipcRenderer.invoke('nai:getAll',s,o),
  showImageContextMenu:(payload)=>ipcRenderer.invoke('nai:showImageContextMenu',payload),
  getOneHydrated:(s,id)=>ipcRenderer.invoke('nai:getOneHydrated',s,id),
  getFolderSummaries:()=>ipcRenderer.invoke('nai:getFolderSummaries'),
  findInPage:(text,options)=>ipcRenderer.invoke('nai:findInPage',text,options),
  stopFind:(action)=>ipcRenderer.invoke('nai:stopFind',action),
  onFindResult:(cb)=>{const fn=(_e,result)=>cb(result);ipcRenderer.on('nai:findResult',fn);return ()=>ipcRenderer.removeListener('nai:findResult',fn)},
  scanLooseImages:()=>ipcRenderer.invoke('nai:scanLooseImages'),
  imageUrl:(rel)=>`nai-image://local/${encodeURIComponent(String(rel||''))}`,
  onExternalImportComplete:(cb)=>{const fn=(_e,payload)=>cb(payload);ipcRenderer.on('nai:externalImportComplete',fn);return ()=>ipcRenderer.removeListener('nai:externalImportComplete',fn)},
  put:(s,v)=>ipcRenderer.invoke('nai:put',s,v),
  putMany:(s,v)=>ipcRenderer.invoke('nai:putMany',s,v),
  atlasToGalleryBatch:(items)=>ipcRenderer.invoke('nai:atlasToGalleryBatch',items),
  onBatchProgress:(cb)=>{const fn=(_e,payload)=>cb(payload);ipcRenderer.on('nai:batchProgress',fn);return ()=>ipcRenderer.removeListener('nai:batchProgress',fn)},
  del:(s,id)=>ipcRenderer.invoke('nai:delete',s,id),
  replace:(s,v)=>ipcRenderer.invoke('nai:replace',s,v),
  dataPath:()=>ipcRenderer.invoke('nai:dataPath'),
  openData:()=>ipcRenderer.invoke('nai:openData'),
  checkUpdate:()=>ipcRenderer.invoke('nai:checkUpdate'),
  version:()=>ipcRenderer.invoke('nai:version')
});

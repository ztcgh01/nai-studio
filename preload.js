const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('naiDesktop',{
  getAll:s=>ipcRenderer.invoke('nai:getAll',s),
  put:(s,v)=>ipcRenderer.invoke('nai:put',s,v),
  del:(s,id)=>ipcRenderer.invoke('nai:delete',s,id),
  replace:(s,v)=>ipcRenderer.invoke('nai:replace',s,v),
  dataPath:()=>ipcRenderer.invoke('nai:dataPath'),
  openData:()=>ipcRenderer.invoke('nai:openData')
});

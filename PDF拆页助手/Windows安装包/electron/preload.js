const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  openPdf: () => ipcRenderer.invoke('open-pdf'),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  saveFile: (folder, name, data) => ipcRenderer.invoke('save-file', folder, name, data),
  showItem: (p) => ipcRenderer.invoke('show-item', p)
});

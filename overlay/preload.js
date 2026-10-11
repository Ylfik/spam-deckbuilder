const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ov', {
  on: (ch, fn) => ipcRenderer.on(ch, (_, d) => fn(d)),
  height: (h) => ipcRenderer.send('height', h),
  ready: () => ipcRenderer.send('ui-ready'),
  toggleEdit: () => ipcRenderer.send('toggle-edit'),
  hide: () => ipcRenderer.send('hide'),
  openSite: () => ipcRenderer.send('open-site'),
  chooseDir: () => ipcRenderer.send('choose-dir'),
  setOpp: (ids) => ipcRenderer.send('set-opp', ids),
  allCards: () => ipcRenderer.invoke('all-cards'),
});

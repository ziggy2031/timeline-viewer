const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('api', {
  open: () => ipcRenderer.invoke('open'),
  load: p => ipcRenderer.invoke('load', p),
  last: () => ipcRenderer.invoke('last'),
  geocode: (lat, lng) => ipcRenderer.invoke('geocode', lat, lng),
  nearby: (lat, lng) => ipcRenderer.invoke('nearby', lat, lng),
  search: q => ipcRenderer.invoke('search', q),
  places: () => ipcRenderer.invoke('places-get'),
  savePlaces: a => ipcRenderer.invoke('places-set', a),
  saveCsv: (n, t) => ipcRenderer.invoke('save-csv', n, t),
  copy: t => ipcRenderer.invoke('copy', t),
  pathFor: f => webUtils.getPathForFile(f)
});

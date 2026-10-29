const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('packageSmoke', { ping: () => ipcRenderer.invoke('codepet:package-smoke') });

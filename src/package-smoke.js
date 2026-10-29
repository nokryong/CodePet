const fs = require('node:fs');
const path = require('node:path');
async function runPackageSmoke({app, BrowserWindow, ipcMain}, output) {
  ipcMain.handle('codepet:package-smoke', () => app.getVersion());
  const win = new BrowserWindow({show:false, webPreferences:{preload:path.join(__dirname,'package-smoke-preload.js'), contextIsolation:true, sandbox:true}});
  try {
    await win.loadURL('data:text/html,<title>CodePet package smoke</title>');
    const version = await win.webContents.executeJavaScript('window.packageSmoke.ping()');
    if (version !== app.getVersion()) throw new Error('Packaged IPC version mismatch');
    fs.writeFileSync(output, JSON.stringify({ready:true, ipc:true, version}));
  } finally { win.destroy(); ipcMain.removeHandler('codepet:package-smoke'); }
  app.quit();
}
module.exports = {runPackageSmoke};

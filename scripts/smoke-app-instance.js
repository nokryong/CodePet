// Electron harness: exercise the OS singleton, ready queue and launch routing.
const {app}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const {claimInstance}=require('../src/app-instance');
const root=process.env.CODEPET_INSTANCE_SMOKE_ROOT;
if(!root) throw new Error('Missing isolated smoke root');
app.disableHardwareAcceleration();
const ready=claimInstance(app,root,argv=>{
  fs.writeFileSync(path.join(root,'routed.json'),JSON.stringify(argv.filter(arg=>/^--(chat|settings|live|usage)$/.test(arg))));
  setTimeout(()=>app.quit(), 250);
});
if(ready) app.whenReady().then(()=>{
  ready(); fs.writeFileSync(path.join(root,'ready'),'ready');
  if(process.argv.includes('--standalone')) app.quit();
});
setTimeout(()=>app.exit(1),15000).unref();

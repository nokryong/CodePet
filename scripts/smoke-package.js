const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn, execFileSync} = require('node:child_process');
async function smokePackage(file, args = []) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codepet-package-smoke-'));
  const output=path.join(root,'result.json');
  let mounted=false;
  try {
    let executable=file;
    if (process.platform==='darwin') {
      const mount=path.join(root,'mount');fs.mkdirSync(mount);
      execFileSync('hdiutil',['attach','-readonly','-nobrowse','-mountpoint',mount,file]);mounted=true;
      executable=path.join(mount,'CodePet.app','Contents','MacOS','CodePet');
    }
    const env={...process.env, HOME:root, USERPROFILE:root, APPDATA:root, LOCALAPPDATA:root, CODE_PET_HOME:path.join(root,'store'), CODEPET_PACKAGE_SMOKE_OUTPUT:output};
    delete env.ELECTRON_RUN_AS_NODE;
    await new Promise((resolve,reject)=>{
      const child=spawn(executable,args,{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
      let diagnostic='';
      child.stderr.on('data',chunk=>{diagnostic=(diagnostic+chunk).slice(-4000);});
      child.stdout.resume();
      const timer=setTimeout(()=>{
        if(process.platform==='win32') { try {execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true});} catch {} }
        else child.kill('SIGKILL');
        reject(new Error(`Package smoke timed out: ${diagnostic}`));
      },60000);
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('close',code=>{clearTimeout(timer);code===0?resolve():reject(new Error(`Package exited ${code}`));});
    });
    const result=JSON.parse(fs.readFileSync(output,'utf8'));
    if (!result.ready || !result.ipc || result.version!==require('../package.json').version) throw new Error('Missing package readiness / IPC proof');
    console.log(`PASS package readiness, IPC and clean exit: ${path.basename(file)}`);
  } finally {
    if(mounted) execFileSync('hdiutil',['detach',path.join(root,'mount')]);
    const resolved=fs.realpathSync(root), base=fs.realpathSync(os.tmpdir());
    if(!resolved.startsWith(base+path.sep)) throw new Error('Unexpected smoke directory');
    fs.rmSync(root,{recursive:true,force:true});
  }
}
if(require.main===module) smokePackage(path.resolve(process.argv[2]),process.argv.slice(3)).catch(error=>{console.error(error);process.exitCode=1;});
module.exports={smokePackage};

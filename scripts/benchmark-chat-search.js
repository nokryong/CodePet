const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {performance}=require('node:perf_hooks');
async function main() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codepet-search-bench-'));
  try {
    const dir=path.join(root,'sessions','fixture'); fs.mkdirSync(dir,{recursive:true});
    const line=JSON.stringify({kind:'message',message:{id:'fixture',authorType:'user',text:'needle '+ 'x'.repeat(1000)}})+'\n';
    const fd=fs.openSync(path.join(dir,'transcript.jsonl'),'w');
    for(let i=0;i<30000;i++) fs.writeSync(fd,line);
    fs.closeSync(fd);
    let Store=require('../src/chat/chat-store').ChatStore;
    if(process.argv.includes('--baseline')) {
      const Module=require('node:module'); const file=require.resolve('../src/chat/chat-store');
      const mod=new Module(file);mod.filename=file;mod.paths=Module._nodeModulePaths(path.dirname(file));
      mod._compile(require('node:child_process').execFileSync('git',['show','cf4187f38fcf59d94e8ac71a72a814bb10be79b9:src/chat/chat-store.js'],{encoding:'utf8',windowsHide:true}),file);Store=mod.exports.ChatStore;
    }
    const store=new Store({root});store.index.sessions=[{id:'fixture',title:'fixture'}];
    for(const query of ['needle','not-present']) {
      global.gc?.();const memory=process.memoryUsage();let delay;
      const started=performance.now();const timer=new Promise(resolve=>setTimeout(()=>{delay=performance.now()-started;resolve();},0));
      const result=await (store.searchSessionsAsync ? store.searchSessionsAsync(query) : store.searchSessions(query));
      const elapsed=performance.now()-started;await timer;
      console.log(JSON.stringify({query,messages:30000,bytes:line.length*30000,matches:result.length,elapsedMs:elapsed,mainTimerDelayMs:delay,rssDelta:process.memoryUsage().rss-memory.rss,heapDelta:process.memoryUsage().heapUsed-memory.heapUsed}));
    }
  } finally {
    if(!fs.realpathSync(root).startsWith(fs.realpathSync(os.tmpdir())+path.sep)) throw new Error('Unexpected benchmark path');
    fs.rmSync(root,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { killTree } = require('../src/chat/chat-agent-runner');

test('POSIX cancellation kills a TERM-ignoring owned group including descendants', { skip: process.platform === 'win32', timeout: 10000 }, async () => {
  const { runAgentProcess } = require('../src/chat/chat-agent-runner');
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  let descendant;
  const run = runAgentProcess({ commandPath: process.execPath, prompt: '', cancelGraceMs: 100,
    argv: ['-e', `const {spawn}=require('child_process'); process.on('SIGTERM',()=>{});
      const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','ignore']});
      child.stdout.once('data',()=>console.log(child.pid)); setInterval(()=>{},1000);`],
    parseLine: line => ({kind:'status', pid:Number(line)}), onEvent: event => { descendant=event.pid; ready(); } });
  await started;
  const at = Date.now(); run.cancel(); run.cancel();
  const result = await run.promise;
  assert.equal(result.cancelled, true);
  assert.ok(Date.now()-at < 5000);
  // A killed orphan may briefly remain as a zombie until the OS reaps it.
  let running = true;
  try {
    process.kill(descendant, 0);
    if (process.platform === 'linux') running = !/\) Z /.test(require('fs').readFileSync(`/proc/${descendant}/stat`, 'utf8'));
  } catch (error) { if (['ESRCH','ENOENT'].includes(error.code)) running=false; else throw error; }
  assert.equal(running, false);
});

test('Windows cancellation preserves the parent until taskkill has terminated the tree', () => {
  let directKills = 0;
  const child = { pid: 123, killed: false, exitCode: null, kill() { directKills++; } };
  const killer = new EventEmitter();
  killTree(child, 'win32', (command, args, options) => {
    assert.equal(command, 'taskkill');
    assert.deepEqual(args, ['/pid', '123', '/T', '/F']);
    assert.equal(options.windowsHide, true);
    return killer;
  });
  assert.equal(directKills, 0);
  killer.emit('close', 0);
  assert.equal(directKills, 0);
});

test('Windows cancellation falls back if taskkill cannot start or fails', () => {
  for (const event of ['error', 'close']) {
    let directKills = 0;
    const child = { pid: 123, killed: false, exitCode: null, kill() { directKills++; } };
    const killer = new EventEmitter();
    killTree(child, 'win32', () => killer);
    killer.emit(event, event === 'error' ? new Error('fixture') : 1);
    assert.equal(directKills, 1);
  }
});

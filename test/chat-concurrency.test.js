const test = require('node:test');
const assert = require('node:assert/strict');
const { ChatRoom } = require('../src/chat/chat-room');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('a failed partial answer remains visibly failed and cannot delegate work', async () => {
  const {room, calls} = harness();
  room.sendUserMessage('@codex work');
  calls[0].finish({ok:false, status:'partial', exitCode:7, text:'@agy partial work', error:'exit 7'});
  await room.waitForIdle();
  const message = room.messages.at(-1);
  assert.equal(message.error, true);
  assert.equal(message.status, 'partial');
  assert.match(message.text, /partial work/);
  assert.match(message.text, /exit 7/);
  assert.equal(calls.length, 1);
});
const agents = ['claude', 'codex', 'agy', 'codex-2'].map(id => ({
  id, name: id, aliases: [id], available: true, enabled: true,
}));

function harness(options = {}) {
  const calls = [];
  const room = new ChatRoom({ agents, random: () => 0.99, ...options,
    runAgent: ({ agent, prompt }) => {
      let finish;
      const promise = new Promise(resolve => { finish = resolve; });
      const call = { id: agent.id, prompt, finish, cancelled: false };
      calls.push(call);
      return { promise, cancel: () => { call.cancelled = true; } };
    },
  });
  return { room, calls };
}

test('coordinator hands work to three participants together, including two accounts of one provider', async () => {
  const { room, calls } = harness();
  room.sendUserMessage('@claude coordinate');
  calls[0].finish({ ok: true, text: '@codex task A @agy task B @codex-2 task C' });
  await tick();
  assert.deepEqual(calls.map(c => c.id), ['claude', 'codex', 'agy', 'codex-2']);
  assert.deepEqual(room.turnState().currentAgents, ['codex', 'agy', 'codex-2']);
  assert.deepEqual(room.turnState().queue, []);
  for (const call of calls.slice(1)) {
    const roster = call.prompt.split('\n').find(line => line.startsWith('현재 함께 작업 중인 참가자:'));
    assert.ok(roster);
    for (const peer of ['codex', 'agy', 'codex-2'].filter(id => id !== call.id)) assert.ok(roster.includes(`@${peer}`));
    assert.match(call.prompt, /다른 참가자의 변경을 덮어쓰거나 되돌리지 마세요/);
  }
  calls[2].finish({ ok: true, text: 'first result' });
  await tick();
  assert.equal(room.messages.at(-1).text, 'first result');
  calls[1].finish({ ok: true, text: 'second result' });
  calls[3].finish({ ok: true, text: 'last result' });
  await room.waitForIdle();
  assert.equal(room.batchSnapshots.size, 0);
});

test('a slow participant does not block a free participant or a result report', async () => {
  const { room, calls } = harness();
  room.sendUserMessage('@claude @codex work');
  calls[0].finish({ ok: true, text: '@agy independent task' });
  await tick();
  assert.deepEqual(calls.map(c => c.id), ['claude', 'codex', 'agy']);
  calls[2].finish({ ok: true, text: '@claude result report' });
  await tick();
  assert.deepEqual(calls.map(c => c.id), ['claude', 'codex', 'agy', 'claude']);
  assert.equal(room.turnState().currentAgents.includes('codex'), true);
  room.stopAll();
  for (const call of calls) call.finish({ cancelled: true });
  await room.waitForIdle();
});

test('stop immediately clears current work and stale completion cannot change the replacement batch', async () => {
  const { room, calls } = harness();
  room.sendUserMessage('@codex old request');
  const old = calls[0];
  room.interject();
  assert.equal(old.cancelled, true);
  assert.equal(room.turnState().current, null);
  room.sendUserMessage('모두 작업 시작해');
  assert.deepEqual(calls.slice(1).map(c => c.id), agents.map(a => a.id));
  assert.equal(room.turnState().currentAgents.length, 4);
  old.finish({ ok: true, text: '@agy obsolete result' });
  await tick();
  assert.equal(room.turnState().currentAgents.length, 4);
  assert.equal(room.activeRuns, 4);
  assert.equal(room.typingCounts.size, 4);
  assert.ok(room.messages.every(m => !m.text.includes('obsolete result')));
  for (const call of calls.slice(1)) call.finish({ ok: true, text: 'done' });
  await room.waitForIdle();
  assert.equal(room.activeRuns, 0);
});

test('cancelled preparation cannot launch late or clear the new run state', async () => {
  let releasePreparation;
  let first = true;
  const { room, calls } = harness({ prepareAgent: () => {
    if (!first) return;
    first = false;
    return new Promise(resolve => { releasePreparation = resolve; });
  } });
  room.sendUserMessage('@codex old request');
  room.stopAll();
  room.sendUserMessage('@codex replacement');
  await tick();
  assert.equal(calls.length, 1);
  releasePreparation();
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(room.activeRuns, 1);
  assert.deepEqual(room.turnState().currentAgents, ['codex']);
  calls[0].finish({ ok: true, text: 'done' });
  await room.waitForIdle();
});

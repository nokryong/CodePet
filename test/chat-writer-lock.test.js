const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { acquireWriter } = require('../src/chat/chat-writer-lock');
const { ChatStore } = require('../src/chat/chat-store');

function root(t) {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'codepet-writer-'));
  t.after(() => fs.rmSync(value, { recursive: true, force: true }));
  return value;
}

for (const owner of [
  { hostname: 'foreign-' + os.hostname(), pid: 2147483000, token: 'foreign-owner' },
  { pid: 2147483000, token: 'legacy-owner' },
]) {
  test('does not probe or reclaim a foreign/unknown host lock: ' + owner.token, t => {
    const dir = root(t), file = path.join(dir, '.writer-lock');
    const before = JSON.stringify(owner); fs.writeFileSync(file, before);
    let probes = 0;
    t.mock.method(process, 'kill', () => { probes++; throw Object.assign(new Error('not local'), { code: 'ESRCH' }); });
    assert.throws(() => acquireWriter(dir), /소유 호스트/);
    assert.equal(probes, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(dir), ['.writer-lock']);
  });
}

test('same-host live writer stays locked and dead writer can be recovered', t => {
  const dir = root(t), file = path.join(dir, '.writer-lock');
  const release = acquireWriter(dir);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).hostname, os.hostname());
  assert.throws(() => acquireWriter(dir), /writer/);
  release();
  fs.writeFileSync(file, JSON.stringify({ hostname: os.hostname(), pid: 2147483000, token: 'dead' }));
  t.mock.method(process, 'kill', () => { throw Object.assign(new Error('dead'), { code: 'ESRCH' }); });
  const recovered = acquireWriter(dir);
  assert.notEqual(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'dead');
  recovered(); assert.deepEqual(fs.readdirSync(dir), []);
});

for (const code of ['ENOTSUP', 'EPERM']) {
  test('unsupported hardlinks fail closed without changing stored data: ' + code, t => {
    const dir = root(t); fs.writeFileSync(path.join(dir, 'sentinel'), 'unchanged');
    t.mock.method(fs, 'linkSync', () => { throw Object.assign(new Error('fixture'), { code }); });
    assert.throws(() => new ChatStore({ root: dir }).init(), error => /하드 링크/.test(error.message) && error.cause.code === code);
    assert.deepEqual(fs.readdirSync(dir), ['sentinel']);
    assert.equal(fs.readFileSync(path.join(dir, 'sentinel'), 'utf8'), 'unchanged');
  });
}

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

// Execute the actual metadata step with local Git history and a fake read-only gh.
const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/release.yml'), 'utf8');
const metadata = workflow.split('      - id: release\n')[1].split('\n  build:')[0];
const script = metadata.split('        run: |\n')[1].split('\n').map(line => line.replace(/^          /, '')).join('\n');
const shell = process.platform === 'win32'
  ? path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/bash.exe') : 'bash';
const portable = value => value.replaceAll('\\', '/');

function runMetadata(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codepet-release-metadata-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const config = path.join(root, 'gitconfig'); fs.writeFileSync(config, '');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_SYSTEM: config,
    GIT_AUTHOR_NAME: 'Release fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Release fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); git('commit', '--allow-empty', '-m', 'released');
  const old = git('rev-parse', 'HEAD');
  git('commit', '--allow-empty', '-m', 'candidate');
  const candidate = git('rev-parse', 'HEAD');
  if (options.tag !== 'absent') git('tag', 'v1.2.1', options.tag === 'old' ? old : candidate);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.2.1' }));
  const output = path.join(root, 'output'); fs.writeFileSync(output, '');
  const calls = path.join(root, 'calls'); fs.writeFileSync(calls, '');
  const mock = path.join(root, 'mock-gh.js');
  fs.writeFileSync(mock, `const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_GH_CALLS, JSON.stringify(args) + '\\n');
const state = JSON.parse(process.env.TEST_GH_STATE);
if (args[0] === 'release' && args[1] === 'view') {
  if (state.lookupFails) process.exit(1);
  if (args.includes('isDraft')) console.log(state.draft);
  else if (args.includes('targetCommitish')) console.log(state.target);
  else process.exit(92);
} else if (args[0] === 'api') {
  if (state.listFails) process.exit(1);
  console.log(state.listed ? 'v1.2.1' : 'v1.2.0');
} else process.exit(93);
`);
  fs.writeFileSync(path.join(bin, 'gh'), '#!/usr/bin/env bash\nexec "$TEST_NODE" "$TEST_GH_SCRIPT" "$@"\n', { mode: 0o755 });
  const scriptFile = path.join(root, 'metadata.sh'); fs.writeFileSync(scriptFile, script);
  const result = spawnSync(shell, [portable(scriptFile)], { cwd: root, encoding: 'utf8', timeout: 15000,
    env: { ...env, PATH: bin + path.delimiter + process.env.PATH,
      TEST_NODE: portable(process.execPath), TEST_GH_SCRIPT: portable(mock), TEST_GH_CALLS: calls,
      TEST_GH_STATE: JSON.stringify({ draft: options.draft ?? 'true', target: options.target === 'old' ? old : candidate,
        lookupFails: options.lookupFails, listFails: options.listFails, listed: options.listed }),
      GITHUB_REF: options.ref || 'refs/heads/main', GITHUB_REF_NAME: options.refName || 'main',
      GITHUB_SHA: candidate, GITHUB_REPOSITORY: 'fixture/codepet', GITHUB_OUTPUT: portable(output) } });
  assert.ifError(result.error);
  return { ...result, output: fs.readFileSync(output, 'utf8'), calls: fs.readFileSync(calls, 'utf8') };
}

test('published same-version release skips an advanced main without resolving its old target', t => {
  const result = runMetadata(t, { draft: 'false', tag: 'old', target: 'old' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.output, /^publish=false$/m);
  assert.doesNotMatch(result.calls, /targetCommitish/);
});

test('published same-version release skips a matching version tag event', t => {
  // isDraft=false is the existing skip criterion; prerelease status must not change it.
  const result = runMetadata(t, { draft: 'false', tag: 'old', target: 'old', ref: 'refs/tags/v1.2.1', refName: 'v1.2.1' });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.output, /publish=true/);
});

for (const options of [{}, { tag: 'absent', lookupFails: true }, { lookupFails: true }]) {
  test('matching draft or absent release can publish: ' + JSON.stringify(options), t => {
    const result = runMetadata(t, options);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.output, /^publish=true$/m);
  });
}

for (const options of [
  { tag: 'old' }, { target: 'old' }, { tag: 'old', lookupFails: true },
  { lookupFails: true, listed: true }, { lookupFails: true, listFails: true },
  { draft: 'false', tag: 'old', ref: 'refs/tags/v1.2.2', refName: 'v1.2.2' },
  { draft: 'invalid' },
]) {
  test('metadata fails closed: ' + JSON.stringify(options), t => {
    const result = runMetadata(t, options);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.output, /^publish=true$/m);
  });
}

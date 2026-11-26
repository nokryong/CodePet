const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  clearUsageCache,
  fetchAntigravityUsage,
  fetchClaudeUsage,
  normalizeClaudeUsage,
  normalizeGrokUsage,
  parseAgyUsage,
  readGrokUsage,
} = require("../src/provider-usage");

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  };
}

test("AGY CLI /usage 출력에서 모델 그룹과 남은 비율을 사용률로 정규화한다", () => {
  const sample = [
    "Gemini Models\tWeekly Limit Remaining\t56%\t2026-11-25T07:32:02Z",
    "Gemini Models\tFive Hour Limit Remaining\t96%\t2026-11-20T10:55:49Z",
    "Gemini 4 Argon\tGemini 4 Argon Weekly Limit\t49%\t2026-11-25T07:35:20Z",
    "Invalid row without percentage",
  ].join("\n");

  assert.deepEqual(parseAgyUsage(sample), [
    { label: "Gemini Models · Weekly Limit", usedPercent: 44, resetText: "2026-11-25T07:32:02Z" },
    { label: "Gemini Models · Five Hour Limit", usedPercent: 4, resetText: "2026-11-20T10:55:49Z" },
    { label: "Gemini 4 Argon · Weekly Limit", usedPercent: 51, resetText: "2026-11-25T07:35:20Z" },
  ]);
});

test("AGY 사용량은 직접 API 호출 없이 공식 agy CLI 실행 결과를 캐싱해 반환한다", async (t) => {
  clearUsageCache();
  t.after(() => clearUsageCache());
  let calls = 0;
  const result = await fetchAntigravityUsage({
    commandPath: "C:\\agy\\bin\\agy.exe",
    accountHint: "agy@example.com",
    probeModels: async () => ({ models: [{ id: "gemini-4" }] }),
    runCli: async (commandPath, needsShell) => {
      calls += 1;
      assert.equal(commandPath, "C:\\agy\\bin\\agy.exe");
      assert.equal(needsShell, false);
      return {
        code: 0,
        stdout: "Gemini Models\tWeekly Limit Remaining\t75%\t2026-11-25T07:32:02Z\n",
        stderr: "",
        timedOut: false,
      };
    },
  });
  assert.deepEqual(result.gauges, [
    { label: "Gemini Models · Weekly Limit", usedPercent: 25, resetText: "2026-11-25T07:32:02Z" },
  ]);
  await fetchAntigravityUsage({
    commandPath: "C:\\agy\\bin\\agy.exe",
    accountHint: "agy@example.com",
    runCli: async () => { throw new Error("Cache should avoid extra CLI invocation"); },
  });
  assert.equal(calls, 1);
});

test("AGY 인증 실패 뒤 자동 조회는 멈추고 직접 새로고침하면 다시 조회한다", async (t) => {
  t.after(() => clearUsageCache());
  let authenticated = false;
  let probes = 0;
  let reads = 0;
  const options = {
    commandPath: "fixture-agy",
    ttl: 0,
    probeModels: async () => {
      probes++;
      return { authenticationRequired: !authenticated, models: authenticated ? [{ id: "gemini-4" }] : [] };
    },
    runCli: async () => {
      reads++;
      return { code: 0, stdout: "Gemini Models\tWeekly Limit Remaining\t75%" };
    },
  };
  await assert.rejects(fetchAntigravityUsage(options), { status: 401 });
  await assert.rejects(fetchAntigravityUsage(options), { status: 401 });
  assert.deepEqual([probes, reads], [1, 0]);
  authenticated = true;
  const usage = await fetchAntigravityUsage({ ...options, force: true });
  assert.equal(usage.gauges[0].usedPercent, 25);
  assert.deepEqual([probes, reads], [2, 1]);
});

test("AGY 세션이 조회 직전에 만료돼도 브라우저 없는 CLI 환경으로 실행한다", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codepet quota "));
  t.after(() => { clearUsageCache(); fs.rmSync(dir, { recursive: true, force: true }); });
  const script = path.join(dir, "agy.cjs");
  const calls = path.join(dir, "calls.txt");
  fs.writeFileSync(script, [
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2).join(' ');",
    `fs.appendFileSync(${JSON.stringify(calls)}, args + '\\n');`,
    "if (args === 'models') console.log('gemini-4\\tGemini');",
    "else if (args === '-p /usage') {",
    "  const dirs = (process.env.PATH || '').split(require('node:path').delimiter).filter(Boolean);",
    "  const helpers = dirs.flatMap(dir => fs.readdirSync(dir));",
    "  if (process.env.BROWSER || helpers.some(name => !['security', 'secret-tool'].includes(name))) throw Error('Unexpected URL opener path');",
    "  console.error('Authentication required.');",
    "  process.exitCode = 1;",
    "}",
    "else throw new Error('A browser would have opened');",
  ].join("\n"), { mode: 0o700 });
  const needsShell = process.platform === "win32";
  const commandPath = path.join(dir, needsShell ? "agy.cmd" : "agy");
  if (needsShell) fs.writeFileSync(commandPath, `@echo off\r\n"${process.execPath}" "%~dp0agy.cjs" %*\r\n`);
  else fs.writeFileSync(commandPath, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o700 });
  await assert.rejects(fetchAntigravityUsage({ commandPath, needsShell }), { status: 401 });
  await assert.rejects(fetchAntigravityUsage({ commandPath, needsShell }), { status: 401 });
  assert.deepEqual(fs.readFileSync(calls, "utf8").trim().split("\n"), ["models", "-p /usage"]);
});

test("AGY CLI가 로그아웃 상태를 반환하면 401 오류로 알린다", async (t) => {
  clearUsageCache();
  t.after(() => clearUsageCache());
  await assert.rejects(
    () => fetchAntigravityUsage({
      commandPath: "agy",
      force: true,
      probeModels: async () => ({ models: [{ id: "gemini-4" }] }),
      runCli: async () => ({ code: 1, stdout: "", stderr: "Please sign in first", timedOut: false }),
    }),
    (error) => error.status === 401 && /로그인/.test(error.message)
  );
});

test("Claude 한도는 전체 및 모델별 창을 표시하고 범위를 보정한다", () => {
  const gauges = normalizeClaudeUsage({
    five_hour: { utilization: 50.4, resets_at: "a" },
    seven_day: { utilization: 120, resets_at: "b" },
    seven_day_sonnet: { utilization: 25, resets_at: "c" },
    seven_day_opus: { utilization: null },
  });
  assert.deepEqual(gauges.map((item) => item.label), ["5시간", "7일", "7일 · Sonnet"]);
  assert.deepEqual(gauges.map((item) => item.usedPercent), [50, 100, 25]);
});

test("Grok billing 로그에서 구독 플랜과 주간 한도를 읽는다", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-grok-usage-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const logDir = path.join(home, ".grok", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const now = Date.parse("2026-08-08T00:00:00Z");
  const entry = {
    ts: "2026-08-07T23:59:30Z",
    msg: "billing: fetched credits config",
    ctx: {
      subscriptionTier: "SuperGrok Plus",
      config: {
        creditUsagePercent: 5,
        currentPeriod: { end: "2026-08-14T00:00:00Z" },
      },
    },
  };
  fs.writeFileSync(
    path.join(logDir, "unified.jsonl"),
    `${JSON.stringify({ msg: "unrelated" })}\n${JSON.stringify(entry)}\n`
  );

  assert.deepEqual(normalizeGrokUsage(entry), {
    provider: "grok",
    plan: "SuperGrok Plus",
    gauges: [{ label: "주간 한도", usedPercent: 5, resetText: "2026-08-14T00:00:00Z" }],
  });
  assert.deepEqual(readGrokUsage({ home, env: {}, now }), normalizeGrokUsage(entry));
});

test("Grok billing 로그가 오래됐으면 현재 한도로 표시하지 않는다", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-grok-stale-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const logDir = path.join(home, ".grok", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, "unified.jsonl"), JSON.stringify({
    ts: "2026-08-07T20:00:00Z",
    msg: "billing: fetched credits config",
    ctx: { subscriptionTier: "SuperGrok Plus", config: { creditUsagePercent: 5 } },
  }));
  assert.throws(
    () => readGrokUsage({ home, env: {}, now: Date.parse("2026-08-08T00:00:00Z") }),
    /오래되어/
  );
});

test("Claude 사용량 cache는 계정 자격 증명별로 분리한다", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-usage-"));
  const credentialPath = path.join(home, ".claude", ".credentials.json");
  fs.mkdirSync(path.dirname(credentialPath), { recursive: true });
  const originalFetch = global.fetch;
  let calls = 0;
  t.after(() => {
    global.fetch = originalFetch;
    clearUsageCache();
    fs.rmSync(home, { recursive: true, force: true });
  });
  global.fetch = async () => {
    calls += 1;
    return jsonResponse({ five_hour: { utilization: calls * 10, resets_at: "soon" } });
  };

  fs.writeFileSync(
    credentialPath,
    JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "account-a" } })
  );
  await fetchClaudeUsage({ home });
  await fetchClaudeUsage({ home });
  fs.writeFileSync(
    credentialPath,
    JSON.stringify({ claudeAiOauth: { accessToken: "b", refreshToken: "account-b" } })
  );
  await fetchClaudeUsage({ home });
  assert.equal(calls, 2);
});

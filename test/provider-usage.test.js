const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  clearUsageCache,
  fetchAntigravityUsage,
  fetchClaudeUsage,
  normalizeAgyQuota,
  normalizeClaudeUsage,
  normalizeGrokUsage,
  readGrokUsage,
  tierLabel,
} = require("../src/provider-usage");

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  };
}

test("AGY 한도는 남은 비율을 사용률로 바꾸고 잘못된 bucket은 제외한다", () => {
  assert.deepEqual(
    normalizeAgyQuota({
      groups: [
        {
          displayName: "모델",
          buckets: [
            { displayName: "주간", remainingFraction: 0.25, resetTime: "soon" },
            { displayName: "누락" },
          ],
        },
      ],
    }),
    [{ label: "모델 · 주간", usedPercent: 75, resetText: "soon" }]
  );
});

test("Claude 한도는 전체 및 모델별 창을 표시하고 범위를 보정한다", () => {
  const gauges = normalizeClaudeUsage({
    five_hour: { utilization: 50.4, resets_at: "a" },
    seven_day: { utilization: 120, resets_at: "b" },
    seven_day_sonnet: { utilization: 25, resets_at: "c" },
  });
  assert.deepEqual(gauges.map((item) => item.label), ["5시간", "7일", "7일 · Sonnet"]);
  assert.deepEqual(gauges.map((item) => item.usedPercent), [50, 100, 25]);
});

test("AGY 응답에서 계정, 플랜, 한도만 정규화한다", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
    clearUsageCache();
  });
  global.fetch = async (url) => {
    if (String(url).includes("loadCodeAssist")) {
      return jsonResponse({
        cloudaicompanionProject: "projects/test",
        currentTier: { displayName: "Antigravity" },
        paidTier: { name: "Google AI Pro" },
      });
    }
    if (String(url).includes("userinfo")) return jsonResponse({ email: "agy@example.com" });
    return jsonResponse({
      groups: [{ displayName: "모델", buckets: [{ displayName: "5시간", remainingFraction: 0.8 }] }],
    });
  };

  const result = await fetchAntigravityUsage({
    credential: { token: { access_token: "access", refresh_token: "refresh" } },
    force: true,
  });
  assert.equal(result.email, "agy@example.com");
  assert.equal(result.plan, "Google AI Pro");
  assert.equal(result.gauges[0].usedPercent, 20);
  assert.equal(tierLabel({ currentTier: { name: "free-tier" } }), "free-tier");
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

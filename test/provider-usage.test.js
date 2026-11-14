const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  UsageAuthError,
  claudePlanLabel,
  clearUsageCache,
  fetchAntigravityUsage,
  fetchClaudeUsage,
  normalizeAgyQuota,
  normalizeClaudeUsage,
  parseWindowKey,
  resolveClaudeCredential,
  tierLabel,
} = require("../src/provider-usage");

function jsonResponse(value, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    json: async () => value,
  };
}

// 테스트용 ~/.claude/.credentials.json을 만들고 경로를 돌려줍니다.
function credentialHome(oauth) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-usage-"));
  const file = path.join(home, ".claude", ".credentials.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (oauth !== undefined) fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: oauth }));
  return { home, file, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
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
        currentTier: { displayName: "Google AI Pro" },
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

test("창 키를 해석해서 라벨과 길이를 만든다", () => {
  assert.deepEqual(parseWindowKey("five_hour"), { label: "5시간", minutes: 300, model: null });
  assert.deepEqual(parseWindowKey("seven_day_fable"), {
    label: "7일 · Fable",
    minutes: 10080,
    model: "Fable",
  });
  assert.deepEqual(parseWindowKey("sevenDayOpus"), {
    label: "7일 · Opus",
    minutes: 10080,
    model: "Opus",
  });
  assert.equal(parseWindowKey("plan_type"), null);
  assert.equal(parseWindowKey("overage_status"), null);
});

test("새로 생긴 모델별 주간 창도 코드 수정 없이 표시한다", () => {
  const gauges = normalizeClaudeUsage({
    plan_type: "max_20x",
    seven_day_fable: { utilization: 5, resets_at: "e" },
    five_hour: { utilization: 40, resets_at: "a" },
    seven_day_opus: { utilization: 10, resets_at: "d" },
    seven_day: { utilization: 60, resets_at: "b" },
  });
  assert.deepEqual(gauges.map((item) => item.label), [
    "5시간",
    "7일",
    "7일 · Fable",
    "7일 · Opus",
  ]);
  assert.equal(claudePlanLabel({ plan_type: "max_20x" }), "max_20x");
});

test("used_percentage·camelCase·used/limit 표기와 rate_limits 중첩을 모두 받는다", () => {
  assert.deepEqual(
    normalizeClaudeUsage({ rateLimits: { fiveHour: { used_percentage: 33, resetsAt: 1794713948 } } }),
    [{ label: "5시간", usedPercent: 33, resetText: 1794713948 }]
  );
  assert.deepEqual(
    normalizeClaudeUsage({ seven_day: { used: 25, limit: 200 } }),
    [{ label: "7일", usedPercent: 13, resetText: "" }]
  );
});

test("지출은 켜져 있고 한도가 있을 때만 금액 게이지로 붙는다", () => {
  // 실응답 형태: 금액은 {amount_minor, currency, exponent}, 끈 계정은 enabled=false·limit=null
  assert.deepEqual(
    normalizeClaudeUsage({
      five_hour: { utilization: 10 },
      spend: {
        used: { amount_minor: 27140, currency: "USD", exponent: 2 },
        limit: { amount_minor: 50000, currency: "USD", exponent: 2 },
        percent: 54,
        enabled: true,
      },
    }).at(-1),
    { label: "지출", usedPercent: 54, resetText: "$271.40 / $500.00" }
  );

  // 이 PC의 pro 계정 실응답: 크레딧을 꺼 둔 상태 → 게이지 없음
  assert.deepEqual(
    normalizeClaudeUsage({
      five_hour: { utilization: 10 },
      spend: {
        used: { amount_minor: 0, currency: "USD", exponent: 2 },
        limit: null,
        percent: 0,
        enabled: false,
      },
      extra_usage: { is_enabled: false, monthly_limit: null, utilization: null },
    }),
    [{ label: "5시간", usedPercent: 10, resetText: "" }]
  );
});

test("추가 사용량은 켜 둔 계정에만 게이지로 붙는다", () => {
  assert.deepEqual(
    normalizeClaudeUsage({
      extra_usage: { is_enabled: true, utilization: 40, used_credits: 8, monthly_limit: 20 },
    }),
    [{ label: "추가 사용량", usedPercent: 40, resetText: "8 / 20" }]
  );
});

test("토큰이 비워진 자격 증명은 로그아웃 상태로 안내한다", (t) => {
  const missing = credentialHome(undefined);
  const emptied = credentialHome({
    accessToken: "",
    refreshToken: "",
    expiresAt: 0,
    scopes: ["user:inference"],
    subscriptionType: "pro",
  });
  const expired = credentialHome({
    accessToken: "",
    refreshToken: "stale",
    refreshTokenExpiresAt: Date.now() - 1000,
  });
  t.after(() => {
    missing.cleanup();
    emptied.cleanup();
    expired.cleanup();
  });

  assert.throws(() => resolveClaudeCredential({ home: missing.home }), {
    name: "UsageAuthError",
    message: "Claude 로그인 정보가 없습니다.",
  });
  assert.throws(() => resolveClaudeCredential({ home: emptied.home }), (error) => {
    assert.ok(error instanceof UsageAuthError);
    assert.match(error.message, /로그아웃 상태/);
    assert.match(error.message, /CLAUDE_CODE_OAUTH_TOKEN/);
    return true;
  });
  assert.throws(() => resolveClaudeCredential({ home: expired.home }), {
    message: "Claude 로그인이 만료됐습니다. 다시 로그인하세요.",
  });
});

test("CLAUDE_CODE_OAUTH_TOKEN이 있으면 파일 자격 증명보다 먼저 쓴다", (t) => {
  const emptied = credentialHome({ accessToken: "", refreshToken: "" });
  const original = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  t.after(() => {
    if (original === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = original;
    emptied.cleanup();
  });
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "setup-token";
  const resolved = resolveClaudeCredential({ home: emptied.home });
  assert.equal(resolved.source, "env");
  assert.equal(resolved.oauth.accessToken, "setup-token");
  assert.equal(resolved.oauth.refreshToken, null);
});

test("429는 마지막 성공값을 기준 시각과 함께 돌려주고 추가 호출을 막는다", async (t) => {
  const { home, cleanup } = credentialHome({ accessToken: "live", refreshToken: "r-429" });
  const originalFetch = global.fetch;
  let calls = 0;
  t.after(() => {
    global.fetch = originalFetch;
    clearUsageCache();
    cleanup();
  });

  global.fetch = async () => {
    calls += 1;
    if (calls === 1) return jsonResponse({ five_hour: { utilization: 42, resets_at: "soon" } });
    return jsonResponse({}, 429, { "retry-after": "120" });
  };

  const fresh = await fetchClaudeUsage({ home });
  assert.equal(fresh.stale, false);
  assert.equal(fresh.gauges[0].usedPercent, 42);

  const stale = await fetchClaudeUsage({ home, force: true });
  assert.equal(stale.stale, true);
  assert.equal(stale.gauges[0].usedPercent, 42);
  assert.ok(Date.parse(stale.asOf) > 0);
  assert.equal(calls, 2);

  // Retry-After가 남아 있는 동안에는 force로도 서버를 다시 부르지 않습니다.
  const backedOff = await fetchClaudeUsage({ home, force: true });
  assert.equal(backedOff.stale, true);
  assert.equal(calls, 2);
});

test("자격 증명 오류는 stale 폴백 대상이 아니다", async (t) => {
  const live = credentialHome({ accessToken: "live", refreshToken: "r-auth" });
  const emptied = credentialHome({ accessToken: "", refreshToken: "" });
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
    clearUsageCache();
    live.cleanup();
    emptied.cleanup();
  });
  global.fetch = async () => jsonResponse({ five_hour: { utilization: 11 } });

  await fetchClaudeUsage({ home: live.home });
  await assert.rejects(() => fetchClaudeUsage({ home: emptied.home }), { name: "UsageAuthError" });
});

// 2026-11-15에 실제 /api/oauth/usage(pro 계정)에서 받은 응답의 구조입니다.
// 수치는 중립값으로 바꿨고 키·중첩·null 패턴은 실응답 그대로입니다.
// 이 형태가 깨지면 모델별 주간 한도가 다시 사라지므로 회귀 기준으로 둡니다.
const LIVE_USAGE_RESPONSE = {
  five_hour: {
    utilization: 40,
    resets_at: "2026-11-15T00:00:00.311135+00:00",
    limit_dollars: null,
    used_dollars: null,
    remaining_dollars: null,
    locked_reason: null,
  },
  seven_day: {
    utilization: 25,
    resets_at: "2026-11-15T06:00:00.311152+00:00",
    limit_dollars: null,
    used_dollars: null,
    remaining_dollars: null,
    locked_reason: null,
  },
  // 예전 모델별 키는 실응답에서 전부 null이었습니다. 이것만 읽으면 모델별 한도를 못 봅니다.
  seven_day_oauth_apps: null,
  seven_day_opus: null,
  seven_day_sonnet: null,
  seven_day_cowork: null,
  tangelo: null,
  pace: null,
  indicator: null,
  extra_usage: {
    is_enabled: false,
    monthly_limit: null,
    used_credits: null,
    utilization: null,
    user_disabled: true,
    spend_limit_reached: false,
    credits_ever_enabled: true,
  },
  // 정본. 모델별 주간 한도(weekly_scoped)는 여기에만 있습니다.
  limits: [
    {
      kind: "session",
      group: "session",
      percent: 40,
      severity: "normal",
      resets_at: "2026-11-15T00:00:00.311135+00:00",
      scope: null,
      is_active: false,
    },
    {
      kind: "weekly_all",
      group: "weekly",
      percent: 25,
      severity: "normal",
      resets_at: "2026-11-15T06:00:00.311152+00:00",
      scope: null,
      is_active: false,
    },
    {
      kind: "weekly_scoped",
      group: "weekly",
      percent: 60,
      severity: "normal",
      resets_at: "2026-11-15T06:00:00.311379+00:00",
      scope: { model: { id: null, display_name: "Fable" }, surface: null },
      is_active: true,
    },
  ],
  spend: {
    used: { amount_minor: 0, currency: "USD", exponent: 2 },
    limit: null,
    percent: 0,
    severity: "normal",
    enabled: false,
    can_purchase_credits: false,
  },
  member_dashboard_available: false,
  seven_day_breakdown: {
    as_of: "2026-11-14T19:21:25.337469+00:00",
    window_started_at: "2026-11-08T06:00:00.311152+00:00",
    rows: [{ key: "claude_code", display_name: "Claude Code", percent: 50 }],
  },
  weekly_scoped_shares: [
    { limit_index: 2, used_percent_of_weekly: 30, allowance_percent_of_weekly: 50 },
  ],
};

test("실응답에서는 limits 배열을 정본으로 읽어 모델별 주간 한도까지 보여준다", () => {
  const gauges = normalizeClaudeUsage(LIVE_USAGE_RESPONSE);
  assert.deepEqual(gauges.map((item) => item.label), ["5시간", "7일", "7일 · Fable"]);
  assert.deepEqual(gauges.map((item) => item.usedPercent), [40, 25, 60]);
  // 서버가 준 severity를 그대로 넘깁니다.
  assert.deepEqual(gauges.map((item) => item.severity), ["normal", "normal", "normal"]);
  // 크레딧을 끈 계정이라 지출·추가 사용량 게이지는 없습니다.
  assert.equal(gauges.length, 3);
});

test("limits가 없으면 예전 키 방식으로 돌아간다 (setup-token·구버전 서버)", () => {
  const { limits, ...withoutLimits } = LIVE_USAGE_RESPONSE;
  assert.ok(limits.length > 0);
  const gauges = normalizeClaudeUsage(withoutLimits);
  // 예전 모델별 키가 null이므로 전체 창 두 개만 남습니다. limits가 왜 필요한지가 여기서 드러납니다.
  assert.deepEqual(gauges.map((item) => item.label), ["5시간", "7일"]);
  assert.deepEqual(gauges.map((item) => item.usedPercent), [40, 25]);
});

test("scope는 모델과 surface를 라벨에 붙이고 percent가 없는 행은 건너뛴다", () => {
  const gauges = normalizeClaudeUsage({
    limits: [
      { kind: "weekly_scoped", group: "weekly", percent: 5, scope: { surface: "Cowork" } },
      { kind: "weekly_scoped", group: "weekly", scope: { model: { display_name: "Opus" } } },
      { kind: "future_kind", group: "monthly", percent: 9, scope: null },
    ],
  });
  assert.deepEqual(gauges.map((item) => item.label), ["7일 · Cowork", "future_kind"]);
});

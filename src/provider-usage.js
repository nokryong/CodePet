const crypto = require("node:crypto");
const os = require("node:os");
const { createClaudeFileStore } = require("./claude-live-credentials");

const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";

// 조회가 실패해도 마지막 성공값을 이 시간까지는 "기준 시각"을 붙여 계속 보여줍니다.
// Claude Code의 /usage도 사용량 엔드포인트가 막히면 에러 화면 대신 마지막 값을 씁니다.
const STALE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_RETRY_AFTER_MS = 60 * 1000;
const MAX_RETRY_AFTER_MS = 15 * 60 * 1000;

const cache = new Map();

class HttpError extends Error {
  constructor(message, status, retryAfterMs = null) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

// 자격 증명 문제는 다시 호출해도 같은 결과이므로 stale 폴백과 재시도 대상에서 제외합니다.
class UsageAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageAuthError";
    this.kind = "auth";
  }
}

function clampPercent(value) {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function tokenKey(provider, token) {
  const digest = crypto.createHash("sha256").update(String(token || "none")).digest("hex").slice(0, 16);
  return `${provider}:${digest}`;
}

function isRetryable(error) {
  if (error?.kind === "auth") return false;
  const status = Number(error?.status);
  if (!Number.isFinite(status)) return true; // 네트워크 오류·타임아웃
  if (status === 408 || status === 425 || status === 429) return true;
  return status >= 500;
}

function staleValue(entry) {
  return { ...entry.good, stale: true, asOf: new Date(entry.goodAt).toISOString() };
}

// 같은 키의 동시 호출은 요청 하나로 합치고(single flight), TTL 안에서는 그 결과를 재사용합니다.
// 실패하면 조건에 맞으면 마지막 성공값(stale)을 돌려주고, 429는 Retry-After만큼 호출 자체를 멈춥니다.
async function cached(key, load, { ttl = 60000, force = false, staleTtl = STALE_TTL_MS } = {}) {
  const entry = cache.get(key) || {};
  const now = Date.now();

  if (!force && entry.value && now - entry.at < ttl) return entry.value;

  if (entry.retryAfter && now < entry.retryAfter) {
    if (entry.good && now - entry.goodAt <= staleTtl) return staleValue(entry);
    const seconds = Math.ceil((entry.retryAfter - now) / 1000);
    throw new HttpError(`사용량 조회가 제한됐습니다. ${seconds}초 후 다시 시도하세요.`, 429);
  }

  const value = Promise.resolve().then(load);
  cache.set(key, { ...entry, at: now, value });

  try {
    const resolved = await value;
    cache.set(key, { at: Date.now(), value, good: resolved, goodAt: Date.now() });
    return resolved;
  } catch (error) {
    const current = cache.get(key) || {};
    const next = { good: current.good, goodAt: current.goodAt };
    if (Number(error?.status) === 429) {
      next.retryAfter = Date.now() + (error.retryAfterMs || DEFAULT_RETRY_AFTER_MS);
    }
    cache.set(key, next);
    if (next.good && isRetryable(error) && Date.now() - next.goodAt <= staleTtl) {
      return staleValue(next);
    }
    throw error;
  }
}

function clearUsageCache(provider = null) {
  for (const key of cache.keys()) {
    if (!provider || key.startsWith(`${provider}:`)) cache.delete(key);
  }
}

function normalizeAgyQuota(data) {
  return (data?.groups || []).flatMap((group) =>
    (group.buckets || []).flatMap((bucket) => {
      const remaining = Number(bucket.remainingFraction ?? bucket.remaining_fraction);
      if (!Number.isFinite(remaining)) return [];
      return [{
        label: [group.displayName || group.name, bucket.displayName || bucket.window]
          .filter(Boolean)
          .join(" · "),
        usedPercent: clampPercent((1 - remaining) * 100),
        resetText: bucket.resetTime || bucket.reset_time || "",
      }];
    })
  );
}

// ---------------------------------------------------------------------------
// Claude 한도 정규화
//
// 2026-11-15에 실제 /api/oauth/usage 응답을 확인한 결과(pro 계정):
//   - 정본은 `limits` 배열이다.
//     [{kind:"session",     group:"session", percent:17, resets_at, scope:null},
//      {kind:"weekly_all",  group:"weekly",  percent:16, resets_at, scope:null},
//      {kind:"weekly_scoped",group:"weekly", percent:23, resets_at,
//       scope:{model:{id:null,display_name:"Fable"},surface:null}, is_active:true}]
//   - `five_hour`/`seven_day` 키는 아직 오지만 **모델별 주간 한도는 limits에만 있다.**
//   - `seven_day_opus` / `seven_day_sonnet` / `seven_day_oauth_apps` 등 예전 모델별 키는
//     이 계정에서 전부 null이었다. 즉 그 키만 읽으면 모델별 한도가 영구히 안 보인다.
//   - 응답에 plan_type은 없다. 플랜은 `claude auth status`의 subscriptionType에서 온다.
//
// 그래서 limits를 먼저 쓰고, 없을 때만 예전 키 방식으로 돌아간다
// (setup-token 응답과 구버전 서버 대비). 예전 키 쪽도 키를 해석해서
// 새 모델 창이 생겨도 코드 수정이 필요 없게 둔다.
// ---------------------------------------------------------------------------
const LIMIT_KIND_LABELS = {
  session: "5시간",
  five_hour: "5시간",
  weekly_all: "7일",
  weekly: "7일",
};

// scope가 모델별/표면별 한도를 구분합니다. ("Fable" 주간 한도 등)
function scopeLabel(scope) {
  const model = scope?.model?.display_name || scope?.model?.displayName || scope?.model?.id;
  const surface = scope?.surface?.display_name || scope?.surface?.displayName ||
    (typeof scope?.surface === "string" ? scope.surface : null);
  return [model, surface].filter(Boolean).join(" ") || null;
}

function limitLabel(limit) {
  const base = LIMIT_KIND_LABELS[limit.kind] ||
    LIMIT_KIND_LABELS[limit.group] ||
    String(limit.kind || limit.group || "한도");
  const scope = scopeLabel(limit.scope);
  return scope ? `${base} · ${scope}` : base;
}

// 서버가 준 순서(세션 → 주간 전체 → 모델별)를 그대로 유지합니다.
function normalizeLimitRows(limits) {
  return limits.flatMap((limit) => {
    if (!limit || typeof limit !== "object") return [];
    const percent = firstFiniteNumber(limit.percent, limit.utilization, limit.used_percentage);
    if (percent === null) return [];
    return [{
      label: limitLabel(limit),
      usedPercent: clampPercent(percent),
      resetText: windowReset(limit),
      severity: limit.severity || null,
    }];
  });
}

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, twelve: 12, fifteen: 15, twenty: 20, twenty_four: 24, thirty: 30, sixty: 60,
};

const UNITS = {
  minute: { minutes: 1, label: "분" },
  hour: { minutes: 60, label: "시간" },
  day: { minutes: 1440, label: "일" },
  week: { minutes: 10080, label: "주" },
  month: { minutes: 43200, label: "개월" },
};

const MODEL_LABELS = {
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  fable: "Fable",
};

function camelToSnake(key) {
  return String(key).replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function modelLabel(tokens) {
  if (tokens.length === 0) return null;
  const joined = tokens.join("_");
  if (MODEL_LABELS[joined]) return MODEL_LABELS[joined];
  return tokens.map((token) => token.charAt(0).toUpperCase() + token.slice(1)).join(" ");
}

// "seven_day_opus" → { label: "7일 · Opus", minutes: 10080, model: "Opus" }
// 창 이름으로 해석되지 않는 키(plan_type 등)는 null을 돌려서 게이지에서 빠집니다.
function parseWindowKey(key) {
  const tokens = camelToSnake(key).split("_").filter(Boolean);
  const unitIndex = tokens.findIndex((token) => UNITS[token.replace(/s$/, "")]);
  if (unitIndex <= 0) return null;

  const unit = UNITS[tokens[unitIndex].replace(/s$/, "")];
  const countText = tokens.slice(0, unitIndex).join("_");
  const count = NUMBER_WORDS[countText] ?? (/^\d+$/.test(countText) ? Number(countText) : null);
  if (!count) return null;

  const model = modelLabel(tokens.slice(unitIndex + 1));
  return {
    label: model ? `${count}${unit.label} · ${model}` : `${count}${unit.label}`,
    minutes: count * unit.minutes,
    model,
  };
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

// utilization(사용률 %)이 기본이고, 상태줄 스크립트와 같은 used_percentage 표기도 받습니다.
// 둘 다 없으면 used/limit 쌍으로 계산합니다.
function windowPercent(value) {
  const direct = firstFiniteNumber(
    value?.utilization,
    value?.used_percentage,
    value?.usedPercentage,
    value?.used_percent,
    value?.usedPercent
  );
  if (direct !== null) return clampPercent(direct);

  const used = firstFiniteNumber(value?.used, value?.used_tokens, value?.usedTokens);
  const limit = firstFiniteNumber(value?.limit, value?.total, value?.limit_tokens, value?.limitTokens);
  if (used === null || !limit) return null;
  return clampPercent((used / limit) * 100);
}

function windowReset(value) {
  const reset = value?.resets_at ?? value?.resetsAt ?? value?.reset_at ?? value?.resetAt;
  if (reset === null || reset === undefined) return "";
  return typeof reset === "number" ? reset : String(reset);
}

// 금액은 {amount_minor, currency, exponent} 형태로 옵니다. (실응답 확인: used = 0 USD, exponent 2)
function moneyAmount(value) {
  if (value === null || value === undefined) return null;
  const direct = firstFiniteNumber(value);
  if (direct !== null) return direct;
  const minor = firstFiniteNumber(value.amount_minor, value.amountMinor);
  if (minor === null) return null;
  const exponent = firstFiniteNumber(value.exponent) ?? 2;
  return minor / 10 ** exponent;
}

// 사용량 크레딧(지출). 켜져 있고 한도가 있을 때만 게이지로 보여줍니다.
// 끈 계정에서는 spend.enabled=false, limit=null로 와서 빈 배열이 됩니다.
function spendGauge(root) {
  const spend = root?.spend || root?.spend_limit || root?.spendLimit;
  if (!spend || typeof spend !== "object" || spend.enabled === false) return [];
  const used = moneyAmount(spend.used ?? spend.used_usd ?? spend.usedUsd);
  const limit = moneyAmount(spend.limit ?? spend.cap ?? spend.limit_usd ?? spend.limitUsd);
  if (!limit) return [];
  const percent = firstFiniteNumber(spend.percent, spend.utilization);
  const usedPercent = percent !== null
    ? clampPercent(percent)
    : (used === null ? null : clampPercent((used / limit) * 100));
  if (usedPercent === null) return [];
  return [{
    label: "지출",
    usedPercent,
    resetText: used === null ? "" : `$${used.toFixed(2)} / $${limit.toFixed(2)}`,
  }];
}

// 추가 사용량(extra usage) 크레딧. 켜 둔 계정에만 값이 들어옵니다.
function extraUsageGauge(root) {
  const extra = root?.extra_usage || root?.extraUsage;
  if (!extra || typeof extra !== "object") return [];
  if (!(extra.is_enabled ?? extra.isEnabled)) return [];
  const percent = firstFiniteNumber(extra.utilization);
  if (percent === null) return [];
  const used = firstFiniteNumber(extra.used_credits, extra.usedCredits);
  const limit = firstFiniteNumber(extra.monthly_limit, extra.monthlyLimit);
  return [{
    label: "추가 사용량",
    usedPercent: clampPercent(percent),
    resetText: used !== null && limit !== null ? `${used} / ${limit}` : "",
  }];
}

function usageRoot(data) {
  if (!data || typeof data !== "object") return {};
  return data.rate_limits || data.rateLimits || data.usage || data;
}

// limits가 없을 때만 쓰는 예전 경로입니다. five_hour 같은 키를 해석합니다.
function legacyWindowRows(root) {
  const windows = Object.entries(root).flatMap(([key, value]) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const parsed = parseWindowKey(key);
    if (!parsed) return [];
    const usedPercent = windowPercent(value);
    if (usedPercent === null) return [];
    return [{ ...parsed, usedPercent, resetText: windowReset(value) }];
  });

  // 짧은 창부터, 같은 창 안에서는 전체 한도를 모델별 한도보다 앞에 둡니다.
  windows.sort((a, b) =>
    a.minutes - b.minutes ||
    Number(Boolean(a.model)) - Number(Boolean(b.model)) ||
    String(a.model).localeCompare(String(b.model))
  );

  return windows.map(({ label, usedPercent, resetText }) => ({ label, usedPercent, resetText }));
}

function normalizeClaudeUsage(data) {
  const root = usageRoot(data);
  const rows = Array.isArray(root.limits) ? normalizeLimitRows(root.limits) : [];
  return [
    ...(rows.length > 0 ? rows : legacyWindowRows(root)),
    ...extraUsageGauge(root),
    ...spendGauge(root),
  ];
}

function claudePlanLabel(data) {
  const root = usageRoot(data);
  const plan = root.plan_type || root.planType || root.subscription_type || root.subscriptionType;
  return typeof plan === "string" && plan.trim() ? plan.trim() : null;
}

// ---------------------------------------------------------------------------

function retryAfterMsFrom(response) {
  const header = response?.headers?.get?.("retry-after");
  if (!header) return DEFAULT_RETRY_AFTER_MS;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_RETRY_AFTER_MS;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(1000, ms));
}

async function json(url, options, timeout = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) {
      const retryAfter = response.status === 429 ? retryAfterMsFrom(response) : null;
      throw new HttpError(
        `사용량 서버가 HTTP ${response.status}를 반환했습니다.`,
        response.status,
        retryAfter
      );
    }
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

function trimmed(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// 최신 Claude Code는 로그아웃·만료 상태에서도 ~/.claude/.credentials.json을 남기고
// accessToken/refreshToken만 빈 문자열로 비웁니다(scopes·subscriptionType 등 메타데이터는 유지).
// 그래서 "파일 없음"과 "토큰 비어 있음"을 구분해 다음 행동을 알려주는 메시지를 돌려줍니다.
// claude setup-token으로 받은 CLAUDE_CODE_OAUTH_TOKEN이 있으면 그 토큰을 먼저 씁니다.
// (이 토큰은 갱신이 없고 5시간·주간 한도만 돌려줍니다)
function resolveClaudeCredential({ home = os.homedir(), credentialStore } = {}) {
  const envToken = trimmed(process.env.CLAUDE_CODE_OAUTH_TOKEN);
  if (envToken) {
    return { source: "env", oauth: { accessToken: envToken, refreshToken: null }, store: null, credentials: null };
  }

  const store = credentialStore || createClaudeFileStore(home);
  const credentials = store.read();
  const oauth = credentials?.claudeAiOauth;
  if (!credentials || !oauth || typeof oauth !== "object") {
    throw new UsageAuthError("Claude 로그인 정보가 없습니다.");
  }

  const accessToken = trimmed(oauth.accessToken);
  const refreshToken = trimmed(oauth.refreshToken);

  if (!accessToken && !refreshToken) {
    throw new UsageAuthError(
      "Claude Code가 로그아웃 상태입니다. claude /login으로 로그인하거나 CLAUDE_CODE_OAUTH_TOKEN을 설정하세요."
    );
  }

  const refreshExpiresAt = Number(oauth.refreshTokenExpiresAt);
  if (!accessToken && refreshExpiresAt > 0 && refreshExpiresAt <= Date.now()) {
    throw new UsageAuthError("Claude 로그인이 만료됐습니다. 다시 로그인하세요.");
  }

  return {
    source: store.kind || "file",
    oauth: { ...oauth, accessToken, refreshToken },
    store,
    credentials,
  };
}

async function refreshClaudeOAuth(credentials, store, oauth) {
  if (!oauth?.refreshToken) throw new UsageAuthError("Claude 로그인 정보가 만료됐습니다.");
  const refresh = await json(CLAUDE_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-beta": CLAUDE_OAUTH_BETA,
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: oauth.refreshToken,
      client_id: CLAUDE_CLIENT_ID,
    }),
  });
  const expiresAt = Number(refresh.expires_at) ||
    (Number(refresh.expires_in) ? Date.now() + Number(refresh.expires_in) * 1000 : oauth.expiresAt);
  const next = {
    ...oauth,
    accessToken: refresh.access_token || oauth.accessToken,
    refreshToken: refresh.refresh_token || oauth.refreshToken,
    expiresAt,
  };
  if (credentials && store) {
    credentials.claudeAiOauth = next;
    store.write(credentials);
  }
  return next;
}

// credentialStore를 넘기지 않으면 파일 저장소를 사용합니다. (macOS 실사용은 main.js가 Keychain 저장소를 주입)
async function fetchClaudeUsage({ home = os.homedir(), force = false, credentialStore } = {}) {
  const resolved = resolveClaudeCredential({ home, credentialStore });
  let oauth = resolved.oauth;
  const key = tokenKey("claude", oauth.refreshToken || oauth.accessToken);

  return cached(key, async () => {
    // refreshToken이 없는 자격 증명(데스크톱 앱 관리 인증, setup-token)은 현재 accessToken으로 그대로 시도합니다.
    const expiringSoon = oauth.expiresAt && Number(oauth.expiresAt) <= Date.now() + 60000;
    if (oauth.refreshToken && (!oauth.accessToken || expiringSoon)) {
      oauth = await refreshClaudeOAuth(resolved.credentials, resolved.store, oauth);
    }
    if (!oauth.accessToken) throw new UsageAuthError("Claude 로그인 정보가 없습니다.");

    const request = () => json(CLAUDE_USAGE_URL, {
      headers: {
        authorization: `Bearer ${oauth.accessToken}`,
        "anthropic-beta": CLAUDE_OAUTH_BETA,
      },
    });

    let data;
    try {
      data = await request();
    } catch (error) {
      if (error.status !== 401 || !oauth.refreshToken) throw error;
      oauth = await refreshClaudeOAuth(resolved.credentials, resolved.store, oauth);
      data = await request();
    }
    return {
      provider: "claude",
      plan: claudePlanLabel(data),
      gauges: normalizeClaudeUsage(data),
      asOf: new Date().toISOString(),
      stale: false,
    };
  }, { force });
}

function tierLabel(assist) {
  const tier = assist?.currentTier || assist?.current_tier || assist?.paidTier || null;
  if (typeof tier === "string") return tier;
  return tier?.displayName || tier?.display_name || tier?.name || tier?.id || null;
}

async function fetchAntigravityUsage({ credential, force = false } = {}) {
  const token = credential?.token?.access_token;
  if (!token) throw new UsageAuthError("AGY 로그인 정보가 없습니다.");
  const key = tokenKey("agy", credential?.token?.refresh_token || token);

  return cached(key, async () => {
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "antigravity/cli/1.0.11 windows/amd64",
    };
    const [assist, identity] = await Promise.all([
      json("https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", {
        method: "POST",
        headers,
        body: JSON.stringify({ metadata: { pluginType: "GEMINI" } }),
      }),
      fetchAntigravityIdentity({ credential }).catch(() => ({})),
    ]);
    const project = assist?.cloudaicompanionProject;
    if (!project) throw new Error("AGY 프로젝트 정보를 찾지 못했습니다.");
    const quota = await json(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
      {
        method: "POST",
        headers,
        body: JSON.stringify({ project }),
      }
    );
    return {
      provider: "agy",
      email: identity.email || null,
      plan: tierLabel(assist),
      gauges: normalizeAgyQuota(quota),
      asOf: new Date().toISOString(),
      stale: false,
    };
  }, { force });
}

async function fetchAntigravityIdentity({ credential, force = false } = {}) {
  const token = credential?.token?.access_token;
  if (!token) throw new UsageAuthError("AGY 로그인 정보가 없습니다.");
  const key = tokenKey("agy:identity", credential?.token?.refresh_token || token);
  return cached(key, async () => {
    const identity = await json("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { authorization: `Bearer ${token}` },
    });
    return { email: identity?.email || null };
  }, { force });
}

module.exports = {
  HttpError,
  UsageAuthError,
  claudePlanLabel,
  clearUsageCache,
  fetchAntigravityIdentity,
  fetchAntigravityUsage,
  fetchClaudeUsage,
  normalizeAgyQuota,
  normalizeClaudeUsage,
  parseWindowKey,
  resolveClaudeCredential,
  tierLabel,
};

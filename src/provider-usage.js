const { spawn } = require("node:child_process");
const { providerCliEnv } = require("./providers/cli-env");
const { probeAgyModelCatalog } = require("./providers/provider-capabilities");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createClaudeFileStore } = require("./claude-live-credentials");

const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const cache = new Map();

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function clampPercent(value) {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function tokenKey(provider, token) {
  const digest = crypto.createHash("sha256").update(String(token || "none")).digest("hex").slice(0, 16);
  return `${provider}:${digest}`;
}

async function cached(key, load, { ttl = 60000, force = false, rememberAuthFailure = false } = {}) {
  const old = cache.get(key);
  if (rememberAuthFailure && old?.pending) return old.value;
  if (!force && old && (old.authFailed || Date.now() - old.at < ttl)) return old.value;
  const value = Promise.resolve().then(load);
  const entry = { at: Date.now(), value, pending: true };
  cache.set(key, entry);
  try {
    return await value;
  } catch (error) {
    if (rememberAuthFailure && error.status === 401) entry.authFailed = true;
    else if (cache.get(key) === entry) cache.delete(key);
    throw error;
  } finally {
    entry.pending = false;
  }
}

function clearUsageCache(provider = null) {
  for (const key of cache.keys()) {
    if (!provider || key.startsWith(`${provider}:`)) cache.delete(key);
  }
}

const AGY_USAGE_LINE = /^\s*(\S.*?)(?:\t+|\s{2,})(\S.*?)(?:\t+|\s{2,})(\d{1,3}(?:\.\d+)?)%(?:(?:\t+|\s{2,})(\S+))?\s*$/;
const AGY_SIGNED_OUT = /authentication required|unauthenticated|not (?:logged|signed)[- ]?in|\bplease (?:sign|log)[- ]?in\b|\b(?:sign|log)[- ]?in (?:first|required)\b/i;
const ANSI_ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const AGY_CLI_TIMEOUT_MS = 25000;
const AGY_MAX_OUTPUT_BYTES = 1024 * 1024;
const AGY_CACHE_TTL_MS = 5 * 60 * 1000;

function parseAgyUsage(text) {
  const gauges = [];
  const plain = String(text || "").replace(ANSI_ESCAPE, "");
  for (const line of plain.split(/\r?\n/)) {
    const match = AGY_USAGE_LINE.exec(line);
    if (!match || gauges.length >= 16) continue;
    const groupName = match[1].trim();
    let windowName = match[2].trim().replace(/\s+Remaining$/i, "");
    if (groupName && windowName.startsWith(`${groupName} `)) {
      windowName = windowName.slice(groupName.length + 1);
    }
    const label = [groupName, windowName].filter(Boolean).join(" · ");
    const remaining = Number(match[3]);
    if (!Number.isFinite(remaining)) continue;
    gauges.push({
      label: label || "사용 한도",
      usedPercent: clampPercent(100 - remaining),
      resetText: (match[4] || "").trim(),
    });
  }
  return gauges;
}

function normalizeClaudeUsage(data) {
  const windows = [
    ["5시간", data?.five_hour],
    ["7일", data?.seven_day],
    ["7일 · Sonnet", data?.seven_day_sonnet],
    ["7일 · Opus", data?.seven_day_opus],
  ];
  return windows.flatMap(([label, value]) => {
    if (value?.utilization == null || value.utilization === "") return [];
    const utilization = Number(value?.utilization);
    if (!Number.isFinite(utilization)) return [];
    return [{
      label,
      usedPercent: clampPercent(utilization),
      resetText: value.resets_at || "",
    }];
  });
}

function normalizeGrokUsage(entry) {
  const config = entry?.ctx?.config || {};
  const usedPercent = Number(config.creditUsagePercent);
  const plan = typeof entry?.ctx?.subscriptionTier === "string"
    ? entry.ctx.subscriptionTier.trim()
    : "";
  const gauges = Number.isFinite(usedPercent)
    ? [{
      label: "주간 한도",
      usedPercent: clampPercent(usedPercent),
      resetText: config.currentPeriod?.end || config.billingPeriodEnd || "",
    }]
    : [];
  if (!plan && gauges.length === 0) return null;
  return { provider: "grok", plan: plan || null, gauges };
}

function readGrokUsage({
  home = os.homedir(),
  env = process.env,
  now = Date.now(),
  maxAgeMs = 10 * 60 * 1000,
  maxBytes = 4 * 1024 * 1024,
} = {}) {
  const grokHome = env.GROK_HOME || path.join(home, ".grok");
  const logPath = path.join(grokHome, "logs", "unified.jsonl");
  const stat = fs.statSync(logPath);
  const length = Math.min(stat.size, maxBytes);
  const buffer = Buffer.alloc(length);
  const file = fs.openSync(logPath, "r");
  try {
    fs.readSync(file, buffer, 0, length, stat.size - length);
  } finally {
    fs.closeSync(file);
  }

  const lines = buffer.toString("utf8").split(/\r?\n/);
  if (stat.size > length) lines.shift();
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let entry;
    try {
      entry = JSON.parse(lines[index]);
    } catch {
      continue;
    }
    if (entry?.msg !== "billing: fetched credits config") continue;
    const timestamp = Date.parse(entry.ts);
    if (Number.isFinite(timestamp) && now - timestamp > maxAgeMs) {
      throw new Error("Grok 한도 정보가 오래되어 다시 조회해야 합니다.");
    }
    const usage = normalizeGrokUsage(entry);
    if (usage) return usage;
  }
  throw new Error("Grok 한도 정보를 찾지 못했습니다.");
}

async function json(url, options, timeout = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) {
      throw new HttpError(`사용량 서버가 HTTP ${response.status}를 반환했습니다.`, response.status);
    }
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function refreshClaudeOAuth(credentials, store) {
  const oauth = credentials.claudeAiOauth;
  if (!oauth?.refreshToken) throw new Error("Claude 로그인 정보가 만료됐습니다.");
  const refresh = await json("https://platform.claude.com/v1/oauth/token", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-beta": "oauth-2025-04-20",
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
  credentials.claudeAiOauth = next;
  store.write(credentials);
  return next;
}

// credentialStore를 넘기지 않으면 파일 저장소를 사용합니다. (macOS 실사용은 main.js가 Keychain 저장소를 주입)
async function fetchClaudeUsage({ home = os.homedir(), force = false, credentialStore } = {}) {
  const store = credentialStore || createClaudeFileStore(home);
  const credentials = store.read();
  if (!credentials) throw new Error("Claude 로그인 정보가 없습니다.");
  let oauth = credentials.claudeAiOauth;
  if (!oauth?.accessToken) throw new Error("Claude 로그인 정보가 없습니다.");
  const key = tokenKey("claude", oauth.refreshToken || oauth.accessToken);

  return cached(key, async () => {
    // refreshToken이 없는 자격 증명(데스크톱 앱 관리 인증)은 현재 accessToken으로 그대로 시도합니다.
    if (oauth.refreshToken && oauth.expiresAt && Number(oauth.expiresAt) <= Date.now() + 60000) {
      oauth = await refreshClaudeOAuth(credentials, store);
    }

    const request = () => json("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        authorization: `Bearer ${oauth.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
    });

    let data;
    try {
      data = await request();
    } catch (error) {
      if (error.status !== 401 || !oauth.refreshToken) throw error;
      oauth = await refreshClaudeOAuth(credentials, store);
      data = await request();
    }
    return { provider: "claude", gauges: normalizeClaudeUsage(data) };
  }, { force });
}

async function readAuthenticatedAgyUsage(commandPath, needsShell, probeModels, runCli) {
  // AGY 1.5.x can launch a URL opener even in print mode if the session
  // expires between "models" and "/usage". Limit helper lookup for this
  // child, while preserving native credential storage and the real account.
  const env = { ...providerCliEnv("agy", process.env) };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === "PATH" || key.toUpperCase() === "BROWSER") delete env[key];
  }
  env.PATH = "";
  let helperDir;
  try {
    if (process.platform === "win32") {
      env.NoDefaultCurrentDirectoryInExePath = "1";
    } else {
      const credentialTool = process.platform === "darwin" ? "/usr/bin/security" : "/usr/bin/secret-tool";
      if (fs.existsSync(credentialTool)) {
        helperDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codepet-agy-"));
        await fs.promises.symlink(credentialTool, path.join(helperDir, path.basename(credentialTool)));
        env.PATH = helperDir;
      }
    }
    // "models" checks the saved session without starting interactive OAuth.
    const catalog = await probeModels(commandPath, needsShell, undefined, env);
    if (catalog.authenticationRequired) throw new HttpError("AGY 로그인이 필요합니다.", 401);
    if (!catalog.models.length) throw new Error("AGY 로그인 상태를 확인하지 못했습니다.");
    return await runCli(commandPath, needsShell, env);
  } finally {
    if (helperDir) await fs.promises.rm(helperDir, { recursive: true, force: true });
  }
}

function readAgyQuota(commandPath, needsShell, env) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let child;
    try {
      child = spawn(needsShell ? `"${commandPath}"` : commandPath, ["-p", "/usage"], {
        env,
        shell: Boolean(needsShell),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: "", timedOut: false, error });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch {}
    }, AGY_CLI_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < AGY_MAX_OUTPUT_BYTES) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < AGY_MAX_OUTPUT_BYTES) stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => finish({ code: null, stdout, stderr, timedOut, error }));
    child.once("close", (code) => finish({ code, stdout, stderr, timedOut, error: null }));
  });
}

async function fetchAntigravityUsage({
  commandPath,
  needsShell = false,
  force = false,
  accountHint = "",
  probeModels = probeAgyModelCatalog,
  runCli = readAgyQuota,
  ttl = AGY_CACHE_TTL_MS,
} = {}) {
  if (!commandPath) {
    throw new Error("AGY CLI가 설치되어 있지 않습니다.");
  }
  const key = tokenKey("agy", accountHint || commandPath);
  return cached(key, async () => {
    const result = await readAuthenticatedAgyUsage(commandPath, needsShell, probeModels, runCli);
    if (result?.error) {
      throw new Error("AGY CLI를 실행하지 못했습니다.");
    }
    const combined = `${result?.stdout || ""}\n${result?.stderr || ""}`;
    if (AGY_SIGNED_OUT.test(combined)) {
      throw new HttpError("AGY 로그인이 필요합니다.", 401);
    }
    if (result?.timedOut || result?.code !== 0) {
      throw new Error("AGY 사용 한도 정보를 조회하지 못했습니다.");
    }
    const gauges = parseAgyUsage(result.stdout);
    if (!gauges.length) {
      throw new Error("AGY CLI가 표시할 사용 한도 정보를 반환하지 않았습니다.");
    }
    return { provider: "agy", gauges };
  }, { ttl, force, rememberAuthFailure: true });
}

module.exports = {
  clearUsageCache,
  fetchAntigravityUsage,
  fetchClaudeUsage,
  normalizeClaudeUsage,
  normalizeGrokUsage,
  parseAgyUsage,
  readGrokUsage,
};

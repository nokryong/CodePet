const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { selectCommandPath, commandNeedsShell } = require("../command-resolution");

// 채팅과 펫 기능이 함께 쓰는 단일 프로바이더 탐지 모듈입니다.
// - 후보 경로 → where/which 순서로 실행 파일을 찾고,
// - --version 프로브로 실제 실행 가능 여부를 확인하며,
// - renderer에는 경로/셸 정보가 없는 안전한 뷰만 내보냅니다.

const PROBE_TIMEOUT_MS = 5000;
const MODEL_PROBE_TIMEOUT_MS = 15000;

function probeCodexModelCatalog(commandPath, needsShell, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let buffer = "";
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child?.kill(); } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    try {
      child = spawn(needsShell ? `"${commandPath}"` : commandPath, ["app-server", "--stdio"], {
        shell: Boolean(needsShell),
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      finish(null);
      return;
    }
    child.on("error", () => finish(null));
    child.on("close", () => finish(null));
    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1 && message.result) {
          child.stdin.write(`${JSON.stringify({ id: 2, method: "model/list", params: { includeHidden: false, limit: 100 } })}\n`);
        }
        if (message.id === 2 && Array.isArray(message.result?.data)) {
          const modelOptions = message.result.data
            .filter((item) => !item.hidden && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/.test(item.model))
            .map((item) => ({
              id: item.model,
              label: item.displayName || item.model,
              isDefault: Boolean(item.isDefault),
              efforts: (item.supportedReasoningEfforts || [])
                .map((entry) => entry.reasoningEffort)
                .filter((effort) => /^[A-Za-z0-9._-]+$/.test(effort)),
            }));
          finish(modelOptions.length > 0 ? modelOptions : null);
        }
      }
    });
    child.stdin.on("error", () => finish(null));
    child.stdin.write(`${JSON.stringify({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "code-pet", version: "1.0.3" }, capabilities: { experimentalApi: true } },
    })}\n`);
  });
}

function probeAgyModelCatalog(commandPath, needsShell, timeoutMs = MODEL_PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let output = "";
    let quietTimer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      if (quietTimer) clearTimeout(quietTimer);
      try { child?.kill(); } catch {}
      const models = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(line));
      resolve(models.length > 0 ? ["default", ...models] : null);
    };
    const hardTimer = setTimeout(finish, timeoutMs);
    if (typeof hardTimer.unref === "function") hardTimer.unref();
    try {
      child = spawn(needsShell ? `"${commandPath}"` : commandPath, ["models"], {
        shell: Boolean(needsShell),
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      finish();
      return;
    }
    child.on("error", finish);
    child.on("close", finish);
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      if (quietTimer) clearTimeout(quietTimer);
      // agy 1.1.10은 목록을 모두 출력한 뒤에도 파이프를 오래 열어두는
      // 경우가 있어, 마지막 출력 후 짧은 정적 구간을 완료로 봅니다.
      quietTimer = setTimeout(finish, 350);
    });
  });
}

function parseGrokAuthStatus(output) {
  const text = String(output || "");
  if (/\byou are not authenticated\b/i.test(text)) return "unauthenticated";
  if (/\byou are logged in(?:\s+with\b[^\r\n.]*)?[.!]?/i.test(text)) return "authenticated";
  return "unknown";
}

function parseGrokModels(output) {
  const models = [];
  const seen = new Set();
  for (const line of String(output || "").split(/\r?\n/)) {
    const match = line.match(
      /^\s*\*\s+([A-Za-z0-9][A-Za-z0-9._:/-]{0,63})(?:\s+\(default\))?\s*$/i
    );
    if (!match || seen.has(match[1])) continue;
    seen.add(match[1]);
    models.push(match[1]);
  }
  return models.length > 0 ? ["default", ...models] : null;
}

// 모델/노력 옵션은 설치된 CLI --help에서 검증된 플래그에만 연결됩니다.
// (claude 2.1.x: --model fable|opus|sonnet, --effort low..max /
//  codex 0.146: -m/--model, -c model_reasoning_effort=...)
const PROVIDER_DEFS = Object.freeze([
  Object.freeze({
    id: "claude",
    name: "Claude",
    color: "#d97757",
    aliases: Object.freeze(["claude"]),
    command: "claude",
    installHint: "Claude Code CLI가 필요합니다. https://claude.com/claude-code 참고",
    installUrl: "https://claude.com/claude-code",
    authProbeArgs: Object.freeze(["auth", "status"]),
    loginCommand: "claude auth login",
    models: Object.freeze(["default", "fable", "opus", "sonnet"]),
    modelsFromHelp: true,
    efforts: Object.freeze(["default", "low", "medium", "high", "xhigh", "max"]),
    allowCustomModel: false,
    supportsImages: "workspace-read-required",
    streaming: "stream-json",
    permissions: Object.freeze({
      chat: Object.freeze({ supported: true, enforcement: "tool-policy" }),
      "workspace-read": Object.freeze({ supported: true, enforcement: "tool-policy" }),
      "workspace-write": Object.freeze({ supported: true, enforcement: "tool-policy" }),
    }),
  }),
  Object.freeze({
    id: "codex",
    name: "Codex",
    color: "#10a37f",
    aliases: Object.freeze(["codex"]),
    command: "codex",
    installHint: "Codex CLI가 필요합니다. npm i -g @openai/codex 참고",
    installUrl: "https://developers.openai.com/codex/cli",
    authProbeArgs: Object.freeze(["login", "status"]),
    loginCommand: "codex login",
    // 모델 이름 목록은 CLI에서 열람할 수 없어 기본값 + 직접 입력만 제공합니다.
    models: Object.freeze(["default"]),
    efforts: Object.freeze(["default", "minimal", "low", "medium", "high", "xhigh"]),
    allowCustomModel: false,
    modelCatalogProbe: "codex-app-server",
    supportsImages: "native",
    streaming: "jsonl",
    permissions: Object.freeze({
      chat: Object.freeze({ supported: true, enforcement: "sandbox" }),
      "workspace-read": Object.freeze({ supported: true, enforcement: "sandbox" }),
      "workspace-write": Object.freeze({ supported: true, enforcement: "sandbox" }),
    }),
  }),
  Object.freeze({
    id: "agy",
    name: "Antigravity",
    color: "#4285f4",
    aliases: Object.freeze(["agy", "antigravity"]),
    command: "agy",
    installHint: "agy CLI가 설치되어 있지 않습니다. https://antigravity.google/docs/cli/install 참고",
    installUrl: "https://antigravity.google/docs/cli/install",
    guiOnlyHint:
      "Antigravity IDE는 설치되어 있지만 agy CLI가 없습니다. https://antigravity.google/docs/cli/install 참고",
    // agy 1.1.10 --help에서 검증된 플래그: -p/--print, --model, --effort low|medium|high,
    // --mode accept-edits|plan, --sandbox, --disable-slash-commands, --add-dir.
    // 모델 목록은 발견 시 `agy models`로 갱신되며, 아래는 그 폴백입니다.
    models: Object.freeze([
      "default",
      "gemini-3.6-flash-high",
      "gemini-3.6-flash-medium",
      "gemini-3.6-flash-low",
      "gemini-3.1-pro-high",
      "gemini-3.1-pro-low",
      "claude-sonnet-4-6",
      "claude-opus-4-6-thinking",
      "gpt-oss-120b-medium",
    ]),
    efforts: Object.freeze(["default", "low", "medium", "high"]),
    allowCustomModel: false,
    modelsProbeArgs: Object.freeze(["models"]),
    supportsImages: "unsupported",
    // --output-format stream-json 플래그는 존재하지만 이 기기에서 이벤트 형식을
    // 스모크 검증하지 못해, 안정성이 확인된 일반 텍스트 출력을 사용합니다.
    streaming: "text",
    permissions: Object.freeze({
      chat: Object.freeze({ supported: true, enforcement: "sandbox" }),
      "workspace-read": Object.freeze({ supported: true, enforcement: "sandbox" }),
      "workspace-write": Object.freeze({ supported: true, enforcement: "sandbox" }),
    }),
  }),
  Object.freeze({
    id: "grok",
    name: "Grok",
    color: "#111111",
    aliases: Object.freeze(["grok"]),
    command: "grok",
    installHint: "Grok Build CLI가 필요합니다. https://x.ai/cli 참고",
    installUrl: "https://x.ai/cli",
    authProbeArgs: Object.freeze(["models"]),
    loginCommand: "grok login",
    models: Object.freeze(["default", "grok-4.5"]),
    // Grok Build 1.0.0의 실제 --effort 허용값입니다.
    efforts: Object.freeze(["default", "low", "medium", "high"]),
    allowCustomModel: false,
    modelsProbeArgs: Object.freeze(["models"]),
    supportsImages: "unsupported",
    streaming: "streaming-messages-json",
    permissions: Object.freeze({
      // 네이티브 Grok은 워크스페이스 경계로 사용하지 않습니다. 기본 정의는
      // 닫힌 상태이고, 실제 Docker Linux 백엔드 프로브가 통과할 때만 아래
      // 읽기와 승인형 쓰기를 컨테이너 권한으로 승격합니다.
      chat: Object.freeze({ supported: true, enforcement: "tool-policy" }),
      "workspace-read": Object.freeze({ supported: false, enforcement: "unavailable" }),
      "workspace-write": Object.freeze({ supported: false, enforcement: "unavailable" }),
    }),
  }),
]);

function cliCandidates(providerId, platform, env, home) {
  const pathApi = platform === "win32" ? path.win32 : path;
  if (providerId === "claude") {
    if (platform === "win32") return [pathApi.join(home, ".local", "bin", "claude.exe")];
    return [
      pathApi.join(home, ".local", "bin", "claude"),
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
    ];
  }
  if (providerId === "codex") {
    if (platform === "win32") return [];
    return [
      pathApi.join(home, ".local", "bin", "codex"),
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
    ];
  }
  if (providerId === "agy") {
    if (platform === "win32") {
      return [
        pathApi.join(env.LOCALAPPDATA || "", "agy", "bin", "agy.exe"),
        pathApi.join(env.LOCALAPPDATA || "", "Antigravity", "agy.exe"),
      ].filter((candidate) => candidate && !candidate.startsWith(pathApi.sep));
    }
    return [
      pathApi.join(home, ".local", "bin", "agy"),
      "/opt/homebrew/bin/agy",
      "/usr/local/bin/agy",
    ];
  }
  if (providerId === "grok") {
    if (platform === "win32") return [pathApi.join(home, ".grok", "bin", "grok.exe")];
    return [
      pathApi.join(home, ".grok", "bin", "grok"),
      pathApi.join(home, ".local", "bin", "grok"),
      "/opt/homebrew/bin/grok",
      "/usr/local/bin/grok",
    ];
  }
  return [];
}

// GUI 설치 흔적은 "설치됨" 안내에만 쓰고, 절대 CLI처럼 실행하지 않습니다.
function guiEvidencePaths(providerId, platform, env) {
  if (providerId !== "agy") return [];
  if (platform === "darwin") return ["/Applications/Antigravity.app"];
  if (platform === "linux") return ["/opt/Antigravity/antigravity", "/usr/share/antigravity"];
  const pathApi = platform === "win32" ? path.win32 : path;
  return [
    pathApi.join(env.LOCALAPPDATA || "", "Programs", "antigravity", "Antigravity.exe"),
    pathApi.join(env.ProgramFiles || "", "Antigravity", "Antigravity.exe"),
  ].filter((candidate) => candidate && !candidate.startsWith(pathApi.sep));
}

function defaultRunCommand(file, args, { timeoutMs = PROBE_TIMEOUT_MS, shell = false } = {}) {
  return new Promise((resolve) => {
    try {
      execFile(
        file,
        args,
        { timeout: timeoutMs, windowsHide: true, shell, encoding: "utf8" },
        (error, stdout, stderr) => {
          resolve({
            ok: !error,
            stdout: String(stdout || ""),
            stderr: String(stderr || ""),
          });
        }
      );
    } catch (error) {
      // Windows 보안 도구가 프로세스 생성을 동기적으로 거부하더라도
      // 한 프로바이더의 실패가 전체 doctor/설정 창을 깨뜨리지 않게 합니다.
      resolve({ ok: false, stdout: "", stderr: String(error?.message || error) });
    }
  });
}

async function whichCommand(command, { platform, runCommand }) {
  const finder = platform === "win32" ? "where.exe" : "which";
  const result = await runCommand(finder, [command], { timeoutMs: PROBE_TIMEOUT_MS });
  if (!result.ok) return null;
  return selectCommandPath(result.stdout, platform) || null;
}

function createCapabilityService(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const home = options.home || os.homedir();
  const fsApi = options.fs || fs;
  const runCommand = options.runCommand || defaultRunCommand;
  const codexModelProbe = options.codexModelProbe ||
    (options.runCommand ? null : probeCodexModelCatalog);
  const agyModelProbe = options.agyModelProbe ||
    (options.runCommand ? null : probeAgyModelCatalog);
  const grokDockerProbe = options.grokDockerProbe || null;
  // cache: { get(): object|null, set(object): void } — 저장 위치는 호출자가 결정합니다.
  const cache = options.cache || { get: () => null, set: () => {} };

  let records = null;
  let discovering = null;

  function statSafe(file) {
    try {
      const stat = fsApi.statSync(file);
      return { mtimeMs: stat.mtimeMs, size: stat.size };
    } catch {
      return null;
    }
  }

  function existsSafe(file) {
    try {
      return fsApi.existsSync(file);
    } catch {
      return false;
    }
  }

  async function resolveCommandPath(def) {
    for (const candidate of cliCandidates(def.id, platform, env, home)) {
      if (candidate && existsSafe(candidate)) return candidate;
    }
    return whichCommand(def.command, { platform, runCommand });
  }

  async function probeVersion(commandPath, needsShell) {
    const result = await runCommand(commandPath, ["--version"], {
      timeoutMs: PROBE_TIMEOUT_MS,
      shell: needsShell,
    });
    if (!result.ok) return null;
    const line = String(result.stdout || "").split(/\r?\n/).find((entry) => entry.trim());
    return line ? line.trim().slice(0, 120) : "unknown";
  }

  async function probeAuth(def, commandPath, needsShell) {
    if (!def.authProbeArgs) {
      return {
        authStatus: "unknown",
        authReason: "이 CLI는 비대화형 로그인 상태 확인을 지원하지 않습니다.",
      };
    }
    const result = await runCommand(commandPath, [...def.authProbeArgs], {
      timeoutMs: PROBE_TIMEOUT_MS,
      shell: needsShell,
    });
    if (def.id === "grok") {
      const authStatus = parseGrokAuthStatus(`${result.stdout || ""}\n${result.stderr || ""}`);
      if (authStatus === "authenticated") return { authStatus, authReason: "" };
      if (authStatus === "unauthenticated") {
        return {
          authStatus,
          authReason: `${def.name} 로그인이 필요합니다.`,
        };
      }
      return {
        authStatus: "unknown",
        authReason: result.ok
          ? "Grok CLI의 로그인 상태 응답을 확인하지 못했습니다."
          : "Grok CLI 로그인 상태 확인에 실패했습니다.",
      };
    }
    if (!result.ok) {
      return {
        authStatus: "unauthenticated",
        authReason: `${def.name} 로그인이 필요합니다.`,
      };
    }
    if (def.id === "claude") {
      try {
        const parsed = JSON.parse(String(result.stdout || ""));
        if (parsed.loggedIn === false) {
          return {
            authStatus: "unauthenticated",
            authReason: `${def.name} 로그인이 필요합니다.`,
          };
        }
      } catch {}
    }
    return { authStatus: "authenticated", authReason: "" };
  }

  // 모델 목록을 CLI 스스로 보고할 수 있는 경우(`agy models`) 프로브로 갱신합니다.
  async function probeModels(def, commandPath, needsShell) {
    if (def.modelsFromHelp) {
      const result = await runCommand(commandPath, ["--help"], {
        timeoutMs: MODEL_PROBE_TIMEOUT_MS,
        shell: needsShell,
      });
      if (!result.ok) return null;
      const modelSection = String(result.stdout || "").match(/--model[\s\S]{0,500}?(?=\n\s{2}--|\n\s{2}-[a-z])/i)?.[0] || "";
      const models = [...modelSection.matchAll(/'([A-Za-z0-9][A-Za-z0-9._:/-]{1,63})'/g)]
        .map((match) => match[1]);
      return models.length > 0 ? ["default", ...new Set(models)] : null;
    }
    if (!def.modelsProbeArgs) return null;
    const result = await runCommand(commandPath, [...def.modelsProbeArgs], {
      timeoutMs: MODEL_PROBE_TIMEOUT_MS,
      shell: needsShell,
    });
    if (!result.ok) return null;
    if (def.id === "grok") {
      return parseGrokModels(`${result.stdout || ""}\n${result.stderr || ""}`);
    }
    const models = String(result.stdout || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(line));
    return models.length > 0 ? ["default", ...models] : null;
  }

  async function discoverOne(def, persistedCache) {
    const record = {
      id: def.id,
      name: def.name,
      color: def.color,
      aliases: [...def.aliases],
      status: "absent",
      reason: def.installHint,
      commandPath: null,
      needsShell: false,
      version: null,
      models: [...def.models],
      modelOptions: def.models.map((model) => ({ id: model, label: model, efforts: [...def.efforts] })),
      efforts: [...def.efforts],
      allowCustomModel: def.allowCustomModel,
      supportsImages: def.supportsImages,
      streaming: def.streaming,
      permissions: { ...def.permissions },
      guiInstalled: false,
      authStatus: "unavailable",
      authReason: "CLI를 먼저 설치해야 합니다.",
      installUrl: def.installUrl,
      loginCommand: def.loginCommand || null,
    };

    if (def.id === "grok" && grokDockerProbe) {
      let docker;
      try {
        docker = await grokDockerProbe();
      } catch (error) {
        docker = { available: false, reason: error?.message || String(error) };
      }
      record.permissions["workspace-read"] = docker?.available
        ? { supported: true, enforcement: "container" }
        : {
            supported: false,
            enforcement: "unavailable",
            reason: docker?.reason || "Docker 격리 실행기를 사용할 수 없습니다.",
          };
      record.permissions["workspace-write"] = docker?.available
        ? { supported: true, enforcement: "container-copy-approval" }
        : { supported: false, enforcement: "unavailable", reason: docker?.reason || "Docker 격리 실행기를 사용할 수 없습니다." };
    }

    record.guiInstalled = guiEvidencePaths(def.id, platform, env).some((entry) => existsSafe(entry));

    const commandPath = await resolveCommandPath(def);
    if (!commandPath) {
      if (record.guiInstalled && def.guiOnlyHint) {
        record.status = "gui-only";
        record.reason = def.guiOnlyHint;
      }
      return record;
    }

    record.commandPath = commandPath;
    record.needsShell = commandNeedsShell(commandPath, platform);

    const stat = statSafe(commandPath);
    const cacheKey = `${def.id}:${commandPath}`;
    const cached = persistedCache?.[cacheKey];
    if (
      cached &&
      stat &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.size === stat.size &&
      cached.version &&
      (def.modelCatalogProbe !== "codex-app-server" || Array.isArray(cached.modelOptions)) &&
      (!def.modelsProbeArgs || Array.isArray(cached.modelOptions)) &&
      (!def.modelsFromHelp || Array.isArray(cached.modelOptions))
    ) {
      record.version = cached.version;
      record.status = "cli";
      record.reason = "";
      if (Array.isArray(cached.models) && cached.models.length > 0) {
        record.models = cached.models;
      }
      if (Array.isArray(cached.modelOptions) && cached.modelOptions.length > 0) {
        record.modelOptions = cached.modelOptions;
      }
      Object.assign(record, await probeAuth(def, commandPath, record.needsShell));
      return record;
    }

    const version = await probeVersion(commandPath, record.needsShell);
    if (!version) {
      record.status = "error";
      record.reason = `${def.name} CLI를 찾았지만 실행 확인(--version)에 실패했습니다.`;
      return record;
    }
    record.version = version;
    record.status = "cli";
    record.reason = "";
    Object.assign(record, await probeAuth(def, commandPath, record.needsShell));
    const probedModels = def.id === "agy" && agyModelProbe
      ? await agyModelProbe(commandPath, record.needsShell)
      : await probeModels(def, commandPath, record.needsShell);
    if (probedModels) record.models = probedModels;
    if (def.modelCatalogProbe === "codex-app-server" && codexModelProbe) {
      const catalog = await codexModelProbe(commandPath, record.needsShell);
      if (catalog?.length) {
        const defaultCatalogModel = catalog.find((option) => option.isDefault);
        record.modelOptions = [
          {
            id: "default",
            label: "기본값 (Codex 설정 따름)",
            efforts: defaultCatalogModel?.efforts?.length
              ? [...defaultCatalogModel.efforts]
              : [...def.efforts],
          },
          ...catalog,
        ];
        record.models = record.modelOptions.map((option) => option.id);
      }
    } else if (probedModels) {
      record.modelOptions = probedModels.map((model) => ({
        id: model,
        label: model,
        efforts: [...def.efforts],
      }));
    }
    if (stat) {
      record.cachePatch = {
        [cacheKey]: {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          version,
          ...(probedModels ? { models: probedModels } : {}),
          models: record.models,
          modelOptions: record.modelOptions,
        },
      };
    }
    return record;
  }

  async function discover({ force = false } = {}) {
    if (records && !force) return records;
    if (discovering && !force) return discovering;
    discovering = (async () => {
      const persistedCache = force ? null : cache.get() || null;
      // Windows에서는 여러 CLI를 동시에 프로브하면 .cmd 실행이 간헐적으로
      // EPERM을 내는 환경이 있어 순차 탐지합니다. 시작 시 한 번뿐이라 체감
      // 지연보다 안정성이 중요합니다.
      const results = [];
      for (const def of PROVIDER_DEFS) {
        results.push(await discoverOne(def, persistedCache));
      }
      const patches = {};
      for (const record of results) {
        if (record.cachePatch) {
          Object.assign(patches, record.cachePatch);
          delete record.cachePatch;
        }
      }
      if (Object.keys(patches).length > 0) {
        try {
          cache.set({ ...(cache.get() || {}), ...patches });
        } catch {}
      }
      records = results;
      return records;
    })();
    try {
      return await discovering;
    } finally {
      discovering = null;
    }
  }

  function getRecord(id) {
    return (records || []).find((record) => record.id === id) || null;
  }

  return { discover, getRecord, defs: PROVIDER_DEFS };
}

// renderer로 보내는 안전한 뷰: 실행 경로/셸/환경 정보는 제외합니다.
function toPublicProvider(record) {
  return {
    id: record.id,
    name: record.name,
    color: record.color,
    aliases: record.aliases,
    status: record.status,
    available: record.status === "cli",
    reason: record.reason || "",
    version: record.version,
    models: record.models,
    modelOptions: record.modelOptions,
    efforts: record.efforts,
    allowCustomModel: record.allowCustomModel,
    supportsImages: record.supportsImages,
    permissions: record.permissions,
    guiInstalled: Boolean(record.guiInstalled),
    authStatus: record.authStatus || "unknown",
    authReason: record.authReason || "",
    installUrl: record.installUrl || null,
    loginCommand: record.loginCommand || null,
  };
}

function toPublicProviders(records) {
  return (records || []).map(toPublicProvider);
}

module.exports = {
  PROVIDER_DEFS,
  PROBE_TIMEOUT_MS,
  MODEL_PROBE_TIMEOUT_MS,
  probeCodexModelCatalog,
  probeAgyModelCatalog,
  parseGrokAuthStatus,
  parseGrokModels,
  cliCandidates,
  guiEvidencePaths,
  createCapabilityService,
  toPublicProvider,
  toPublicProviders,
};

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  cliCandidates,
  guiEvidencePaths,
  createCapabilityService,
  toPublicProviders,
} = require("../src/providers/provider-capabilities");

const WIN_ENV = {
  LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
  ProgramFiles: "C:\\Program Files",
};

function makeService({
  files = new Set(),
  whereResults = {},
  probes = {},
  cacheStore = {},
  codexModelProbe = null,
} = {}) {
  const calls = { runs: [] };
  const service = createCapabilityService({
    platform: "win32",
    env: WIN_ENV,
    home: "C:\\Users\\u",
    fs: {
      existsSync: (file) => files.has(file),
      statSync: (file) => {
        if (!files.has(file)) throw new Error("ENOENT");
        return { mtimeMs: 111, size: 222 };
      },
    },
    runCommand: async (file, args) => {
      calls.runs.push({ file, args });
      if (file === "where.exe") {
        const out = whereResults[args[0]];
        return out ? { ok: true, stdout: out, stderr: "" } : { ok: false, stdout: "", stderr: "" };
      }
      const probe = probes[file];
      if (probe) return { ok: true, stdout: probe, stderr: "" };
      return { ok: false, stdout: "", stderr: "" };
    },
    cache: {
      get: () => cacheStore.value || null,
      set: (value) => {
        cacheStore.value = value;
      },
    },
    ...(codexModelProbe ? { codexModelProbe } : {}),
  });
  return { service, calls };
}

function makeGrokService(modelsResult, extra = {}) {
  const grokPath = path.win32.join("C:\\Users\\u", ".grok", "bin", "grok.exe");
  const files = new Set([grokPath]);
  const calls = [];
  const service = createCapabilityService({
    platform: "win32",
    env: WIN_ENV,
    home: "C:\\Users\\u",
    fs: {
      existsSync: (file) => files.has(file),
      statSync: () => ({ mtimeMs: 7, size: 8 }),
    },
    runCommand: async (file, args) => {
      calls.push({ file, args });
      if (file === grokPath && args[0] === "--version") {
        return { ok: true, stdout: "grok 1.0.0 (abc123) [stable]\n", stderr: "" };
      }
      if (file === grokPath && args[0] === "models") return modelsResult;
      return { ok: false, stdout: "", stderr: "" };
    },
    cache: { get: () => null, set: () => {} },
    ...extra,
  });
  return { service, calls, grokPath };
}

test("agy 후보에 공식 Windows 설치 경로가 포함된다", () => {
  const candidates = cliCandidates("agy", "win32", WIN_ENV, "C:\\Users\\u");
  assert.ok(candidates.includes(path.win32.join(WIN_ENV.LOCALAPPDATA, "agy", "bin", "agy.exe")));
});

test("grok 후보에 공식 관리형 설치 경로가 포함된다", () => {
  const candidates = cliCandidates("grok", "win32", WIN_ENV, "C:\\Users\\u");
  assert.deepEqual(candidates, [path.win32.join("C:\\Users\\u", ".grok", "bin", "grok.exe")]);
});

test("grok 정의는 검증된 모델, 노력, 스트리밍과 단계별 권한 상태를 제공한다", () => {
  const { service } = makeService({});
  const grok = service.defs.find((def) => def.id === "grok");
  assert.ok(grok);
  assert.deepEqual(grok.models, ["default", "grok-4.5"]);
  assert.deepEqual(grok.efforts, ["default", "low", "medium", "high"]);
  assert.equal(grok.streaming, "streaming-messages-json");
  assert.equal(grok.permissions["workspace-write"].enforcement, "unavailable");
  assert.equal(grok.permissions.chat.supported, true);
  assert.equal(grok.permissions["workspace-read"].supported, false);
  assert.equal(grok.permissions["workspace-write"].supported, false);
  assert.deepEqual(grok.authProbeArgs, ["models"]);
  assert.deepEqual(grok.modelsProbeArgs, ["models"]);
});

test("grok models 출력으로 로그인 상태와 모델 목록을 함께 판별한다", async () => {
  const { service, calls, grokPath } = makeGrokService({
    ok: true,
    stdout: [
      "You are logged in with grok.com.",
      "",
      "Default model: grok-4.5",
      "",
      "Available models:",
      "  * grok-4.5 (default)",
      "  * grok-4.4-fast",
      "  * grok-4.4-fast",
      "",
    ].join("\n"),
    stderr: "",
  });
  const grok = (await service.discover()).find((record) => record.id === "grok");
  assert.equal(grok.status, "cli");
  assert.equal(grok.version, "grok 1.0.0 (abc123) [stable]");
  assert.equal(grok.authStatus, "authenticated");
  assert.deepEqual(grok.models, ["default", "grok-4.5", "grok-4.4-fast"]);
  assert.equal(
    calls.filter((call) => call.file === grokPath && call.args[0] === "models").length,
    2
  );
});

test("grok models가 성공 종료해도 미인증 문구를 놓치지 않는다", async () => {
  const { service } = makeGrokService({
    ok: true,
    stdout: [
      "You are not authenticated.",
      "",
      "Default model: grok-4.5",
      "",
      "Available models:",
      "  * grok-4.5 (default)",
    ].join("\n"),
    stderr: "",
  });
  const grok = (await service.discover()).find((record) => record.id === "grok");
  assert.equal(grok.authStatus, "unauthenticated");
  assert.match(grok.authReason, /로그인/);
  assert.deepEqual(grok.models, ["default", "grok-4.5"]);
});

test("grok 인증 프로브의 알 수 없는 출력은 로그인 완료로 추정하지 않는다", async () => {
  const { service } = makeGrokService({
    ok: true,
    stdout: "Default model: grok-4.5\nAvailable models:\n  * grok-4.5 (default)\n",
    stderr: "",
  });
  const grok = (await service.discover()).find((record) => record.id === "grok");
  assert.equal(grok.authStatus, "unknown");
  assert.match(grok.authReason, /확인하지 못했습니다/);
});

test("Docker Linux 백엔드가 확인된 경우에만 Grok 읽기와 승인형 쓰기를 승격한다", async () => {
  const modelsResult = {
    ok: true,
    stdout: "You are logged in with grok.com.\nAvailable models:\n  * grok-4.5 (default)\n",
    stderr: "",
  };
  const available = makeGrokService(modelsResult, {
    grokDockerProbe: async () => ({ available: true, version: "29.6.2" }),
  });
  const grok = (await available.service.discover()).find((record) => record.id === "grok");
  assert.deepEqual(grok.permissions["workspace-read"], { supported: true, enforcement: "container" });
  assert.deepEqual(grok.permissions["workspace-write"], {
    supported: true,
    enforcement: "container-copy-approval",
  });

  const unavailable = makeGrokService(modelsResult, {
    grokDockerProbe: async () => ({ available: false, reason: "Docker Desktop이 실행 중이 아닙니다." }),
  });
  const blocked = (await unavailable.service.discover()).find((record) => record.id === "grok");
  assert.equal(blocked.permissions["workspace-read"].supported, false);
  assert.equal(blocked.permissions["workspace-write"].supported, false);
  assert.match(blocked.permissions["workspace-read"].reason, /Docker Desktop/);
});

test("GUI 흔적 경로는 Antigravity.exe를 가리키지만 실행 후보에는 없다", () => {
  const gui = guiEvidencePaths("agy", "win32", WIN_ENV);
  assert.ok(gui.some((entry) => entry.endsWith("Antigravity.exe")));
  const candidates = cliCandidates("agy", "win32", WIN_ENV, "C:\\Users\\u");
  assert.ok(!candidates.some((entry) => entry.endsWith("Antigravity.exe")));
});

test("CLI 없음 + GUI 설치 → gui-only 상태와 설치 안내", async () => {
  const files = new Set([
    path.win32.join(WIN_ENV.LOCALAPPDATA, "Programs", "antigravity", "Antigravity.exe"),
  ]);
  const { service } = makeService({ files });
  const records = await service.discover();
  const agy = records.find((record) => record.id === "agy");
  assert.equal(agy.status, "gui-only");
  assert.equal(agy.guiInstalled, true);
  assert.ok(agy.reason.includes("IDE는 설치되어 있지만"));
});

test("CLI가 어디에도 없으면 absent + 설치 힌트", async () => {
  const { service } = makeService({});
  const records = await service.discover();
  for (const record of records) {
    assert.equal(record.status, "absent");
    assert.ok(record.reason.length > 0);
  }
});

test("where 결과에서 .exe를 고르고 --version 프로브로 cli 상태가 된다", async () => {
  const claudePath = "C:\\Users\\u\\.local\\bin\\claude.exe";
  const files = new Set([claudePath]);
  const { service } = makeService({
    files,
    probes: { [claudePath]: "2.1.198 (Claude Code)\n" },
  });
  const records = await service.discover();
  const claude = records.find((record) => record.id === "claude");
  assert.equal(claude.status, "cli");
  assert.equal(claude.version, "2.1.198 (Claude Code)");
  assert.equal(claude.reason, "");
});

test("프로브 실패 시 error 상태와 이유를 보고한다", async () => {
  const claudePath = "C:\\Users\\u\\.local\\bin\\claude.exe";
  const files = new Set([claudePath]);
  const { service } = makeService({ files, probes: {} });
  const records = await service.discover();
  const claude = records.find((record) => record.id === "claude");
  assert.equal(claude.status, "error");
  assert.ok(claude.reason.includes("--version"));
});

test("버전 프로브 결과는 경로/크기/수정시각 키로 캐시된다", async () => {
  const claudePath = "C:\\Users\\u\\.local\\bin\\claude.exe";
  const files = new Set([claudePath]);
  const cacheStore = {};
  const first = makeService({ files, probes: { [claudePath]: "2.1.198\n" }, cacheStore });
  await first.service.discover();
  const probeRuns = first.calls.runs.filter(
    (run) => run.file === claudePath && run.args[0] === "--version"
  ).length;
  assert.equal(probeRuns, 1);
  assert.ok(cacheStore.value[`claude:${claudePath}`]);

  // 새 서비스(앱 재시작 시뮬레이션)는 캐시를 재사용해 프로브를 생략한다.
  const second = makeService({ files, probes: { [claudePath]: "2.1.198\n" }, cacheStore });
  const records = await second.service.discover();
  const claude = records.find((record) => record.id === "claude");
  assert.equal(claude.status, "cli");
  assert.equal(
    second.calls.runs.filter((run) => run.file === claudePath && run.args[0] === "--version").length,
    0
  );
  assert.equal(
    second.calls.runs.filter((run) => run.file === claudePath && run.args[0] === "auth").length,
    1
  );
});

test("Claude 로그인 상태는 공개 진단 값으로만 노출되고 계정 정보는 버린다", async () => {
  const claudePath = "C:\\Users\\u\\.local\\bin\\claude.exe";
  const files = new Set([claudePath]);
  const service = createCapabilityService({
    platform: "win32",
    env: WIN_ENV,
    home: "C:\\Users\\u",
    fs: {
      existsSync: (file) => files.has(file),
      statSync: () => ({ mtimeMs: 1, size: 2 }),
    },
    runCommand: async (file, args) => {
      if (file === claudePath && args[0] === "--version") {
        return { ok: true, stdout: "2.1.198\n", stderr: "" };
      }
      if (file === claudePath && args[0] === "auth") {
        return {
          ok: true,
          stdout: JSON.stringify({ loggedIn: true, email: "private@example.com", token: "secret" }),
          stderr: "",
        };
      }
      return { ok: false, stdout: "", stderr: "" };
    },
    cache: { get: () => null, set: () => {} },
  });
  const publicClaude = toPublicProviders(await service.discover()).find(
    (record) => record.id === "claude"
  );
  assert.equal(publicClaude.authStatus, "authenticated");
  assert.ok(!JSON.stringify(publicClaude).includes("private@example.com"));
  assert.ok(!JSON.stringify(publicClaude).includes("secret"));
});

test("로그인 상태 명령 실패는 CLI 설치 오류와 구분한다", async () => {
  const claudePath = "C:\\Users\\u\\.local\\bin\\claude.exe";
  const files = new Set([claudePath]);
  const authFailureService = createCapabilityService({
    platform: "win32",
    env: WIN_ENV,
    home: "C:\\Users\\u",
    fs: {
      existsSync: (file) => files.has(file),
      statSync: () => ({ mtimeMs: 1, size: 2 }),
    },
    runCommand: async (file, args) => ({
      ok: file === claudePath && args[0] === "--version",
      stdout: args[0] === "--version" ? "2.1.198\n" : "",
      stderr: "",
    }),
    cache: { get: () => null, set: () => {} },
  });
  const claude = (await authFailureService.discover()).find((record) => record.id === "claude");
  assert.equal(claude.status, "cli");
  assert.equal(claude.authStatus, "unauthenticated");
});

test("공개 뷰에는 commandPath/needsShell이 절대 포함되지 않는다", async () => {
  const claudePath = "C:\\Users\\u\\.local\\bin\\claude.exe";
  const files = new Set([claudePath]);
  const { service } = makeService({ files, probes: { [claudePath]: "2.1.198\n" } });
  const records = await service.discover();
  const publicView = toPublicProviders(records);
  const json = JSON.stringify(publicView);
  assert.ok(!json.includes("commandPath"));
  assert.ok(!json.includes("needsShell"));
  assert.ok(!json.includes(claudePath.replace(/\\/g, "\\\\")));
  const claude = publicView.find((record) => record.id === "claude");
  assert.equal(claude.available, true);
  assert.ok(Array.isArray(claude.models));
  assert.ok(claude.permissions.chat.enforcement);
});

test("claude 검증된 모델/노력 옵션이 노출된다", async () => {
  const { service } = makeService({});
  const records = await service.discover();
  const claude = records.find((record) => record.id === "claude");
  assert.deepEqual(claude.models, ["default", "fable", "opus", "sonnet"]);
  assert.ok(claude.efforts.includes("max"));
  const codex = records.find((record) => record.id === "codex");
  assert.deepEqual(codex.models, ["default"]);
  assert.equal(codex.allowCustomModel, false);
  const agy = records.find((record) => record.id === "agy");
  assert.equal(agy.permissions["workspace-write"].supported, true);
  assert.equal(agy.permissions.chat.enforcement, "sandbox");
  assert.ok(agy.efforts.includes("high"));
});

test("Codex app-server 카탈로그를 공개 모델과 모델별 노력 목록으로 변환한다", async () => {
  const codexPath = "C:\\tools\\codex.cmd";
  const { service } = makeService({
    whereResults: { codex: `${codexPath}\r\n` },
    probes: { [codexPath]: "codex-cli 0.146.0\n" },
    codexModelProbe: async () => [
      { id: "gpt-5.6-sol", label: "GPT-5.6-Sol", isDefault: true, efforts: ["low", "max"] },
      { id: "gpt-5.6-terra", label: "GPT-5.6-Terra", isDefault: false, efforts: ["medium"] },
    ],
  });
  const codex = (await service.discover()).find((record) => record.id === "codex");
  assert.deepEqual(codex.models, ["default", "gpt-5.6-sol", "gpt-5.6-terra"]);
  assert.deepEqual(codex.modelOptions[0].efforts, ["low", "max"]);
  assert.equal(codex.modelOptions[1].label, "GPT-5.6-Sol");
});

test("agy CLI가 공식 후보 경로에 있으면 PATH 없이도 cli 상태가 된다", async () => {
  const agyPath = path.win32.join(WIN_ENV.LOCALAPPDATA, "agy", "bin", "agy.exe");
  const files = new Set([agyPath]);
  const { service, calls } = makeService({
    files,
    probes: { [agyPath]: "agy 1.1.10\n" },
  });
  const records = await service.discover();
  const agy = records.find((record) => record.id === "agy");
  assert.equal(agy.status, "cli");
  assert.equal(agy.version, "agy 1.1.10");
  // where.exe 조회 없이 후보 경로만으로 해석되어야 한다.
  assert.ok(!calls.runs.some((run) => run.file === "where.exe" && run.args[0] === "agy"));
});

test("agy 모델 목록은 `agy models` 프로브로 갱신된다", async () => {
  const agyPath = path.win32.join(WIN_ENV.LOCALAPPDATA, "agy", "bin", "agy.exe");
  const files = new Set([agyPath]);
  const cacheStore = {};
  const service = createCapabilityService({
    platform: "win32",
    env: WIN_ENV,
    home: "C:\\Users\\u",
    fs: {
      existsSync: (file) => files.has(file),
      statSync: () => ({ mtimeMs: 5, size: 6 }),
    },
    runCommand: async (file, args) => {
      if (file === agyPath && args[0] === "--version") {
        return { ok: true, stdout: "agy 1.1.10\n", stderr: "" };
      }
      if (file === agyPath && args[0] === "models") {
        return {
          ok: true,
          stdout: "gemini-3.6-flash-high\ngemini-3.1-pro-low\nclaude-sonnet-4-6\n",
          stderr: "",
        };
      }
      return { ok: false, stdout: "", stderr: "" };
    },
    cache: {
      get: () => cacheStore.value || null,
      set: (value) => {
        cacheStore.value = value;
      },
    },
  });
  const records = await service.discover();
  const agy = records.find((record) => record.id === "agy");
  assert.deepEqual(agy.models, [
    "default",
    "gemini-3.6-flash-high",
    "gemini-3.1-pro-low",
    "claude-sonnet-4-6",
  ]);
  // 캐시에도 모델 목록이 함께 저장된다.
  const cached = cacheStore.value[`agy:${agyPath}`];
  assert.ok(Array.isArray(cached.models));
});

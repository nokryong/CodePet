const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ERROR_CODES,
  toDiagnostic,
  toDiagnostics,
  isHealthy,
  diagnoseProviders,
} = require("../src/providers/provider-diagnostics");

function makeRecord(overrides = {}) {
  return {
    id: "claude",
    name: "Claude",
    status: "cli",
    reason: "",
    version: "2.1.0",
    models: ["default", "fable", "opus"],
    modelOptions: [
      { id: "default", label: "default", efforts: [] },
      { id: "fable", label: "fable", efforts: [] },
    ],
    authStatus: "authenticated",
    authReason: "",
    installUrl: "https://claude.com/claude-code",
    loginCommand: "claude auth login",
    ...overrides,
  };
}

test("설치·로그인 완료 상태를 installed/loggedIn true로 매핑한다", () => {
  const diagnostic = toDiagnostic(makeRecord());
  assert.deepEqual(diagnostic, {
    provider: "claude",
    name: "Claude",
    installed: true,
    loggedIn: true,
    version: "2.1.0",
    model: "default",
    errorCode: null,
    message: "",
    installUrl: "https://claude.com/claude-code",
    loginCommand: "claude auth login",
  });
  assert.equal(isHealthy(diagnostic), true);
});

test("미설치는 installed false + cli-not-found로 구분한다", () => {
  const diagnostic = toDiagnostic(
    makeRecord({
      status: "absent",
      version: null,
      reason: "CLI가 필요합니다.",
      authStatus: "unavailable",
    })
  );
  assert.equal(diagnostic.installed, false);
  assert.equal(diagnostic.loggedIn, null);
  assert.equal(diagnostic.version, null);
  assert.equal(diagnostic.model, null);
  assert.equal(diagnostic.errorCode, ERROR_CODES.CLI_NOT_FOUND);
  assert.equal(diagnostic.message, "CLI가 필요합니다.");
  assert.equal(isHealthy(diagnostic), false);
});

test("GUI만 설치된 경우는 gui-only 코드로 안내한다", () => {
  const diagnostic = toDiagnostic(
    makeRecord({ id: "agy", name: "Antigravity", status: "gui-only", version: null, authStatus: "unavailable" })
  );
  assert.equal(diagnostic.installed, false);
  assert.equal(diagnostic.errorCode, ERROR_CODES.GUI_ONLY);
});

test("실행 확인(--version) 실패는 installed null(탐지 실패)로 남긴다", () => {
  const diagnostic = toDiagnostic(
    makeRecord({ status: "error", version: null, reason: "실행 확인 실패", authStatus: "unavailable" })
  );
  assert.equal(diagnostic.installed, null);
  assert.equal(diagnostic.loggedIn, null);
  assert.equal(diagnostic.errorCode, ERROR_CODES.VERSION_PROBE_FAILED);
});

test("미로그인은 loggedIn false + not-logged-in으로 구분한다", () => {
  const diagnostic = toDiagnostic(
    makeRecord({ authStatus: "unauthenticated", authReason: "Claude 로그인이 필요합니다." })
  );
  assert.equal(diagnostic.installed, true);
  assert.equal(diagnostic.loggedIn, false);
  assert.equal(diagnostic.errorCode, ERROR_CODES.NOT_LOGGED_IN);
  assert.equal(diagnostic.message, "Claude 로그인이 필요합니다.");
});

test("로그인 상태 확인 미지원 CLI는 loggedIn null + auth-status-unknown", () => {
  const diagnostic = toDiagnostic(
    makeRecord({
      id: "agy",
      name: "Antigravity",
      authStatus: "unknown",
      authReason: "이 CLI는 비대화형 로그인 상태 확인을 지원하지 않습니다.",
    })
  );
  assert.equal(diagnostic.installed, true);
  assert.equal(diagnostic.loggedIn, null);
  assert.equal(diagnostic.errorCode, ERROR_CODES.AUTH_STATUS_UNKNOWN);
  assert.equal(isHealthy(diagnostic), false);
});

test("codex modelOptions의 isDefault 항목을 기본 모델로 고른다", () => {
  const diagnostic = toDiagnostic(
    makeRecord({
      id: "codex",
      name: "Codex",
      models: ["gpt-5.3-codex", "gpt-5.3-codex-mini"],
      modelOptions: [
        { id: "gpt-5.3-codex", label: "GPT-5.3 Codex", isDefault: true, efforts: [] },
        { id: "gpt-5.3-codex-mini", label: "mini", efforts: [] },
      ],
    })
  );
  assert.equal(diagnostic.model, "gpt-5.3-codex");
});

test("toDiagnostics는 레코드 배열을 순서대로 변환한다", () => {
  const diagnostics = toDiagnostics([
    makeRecord(),
    makeRecord({ id: "codex", name: "Codex", status: "absent", authStatus: "unavailable" }),
  ]);
  assert.equal(diagnostics.length, 2);
  assert.equal(diagnostics[0].provider, "claude");
  assert.equal(diagnostics[1].provider, "codex");
  assert.equal(diagnostics[1].installed, false);
});

test("diagnoseProviders는 주입한 service의 discover 결과를 변환한다", async () => {
  const service = {
    discover: async () => [makeRecord(), makeRecord({ id: "agy", name: "Antigravity", status: "gui-only", authStatus: "unavailable" })],
  };
  const diagnostics = await diagnoseProviders({ service });
  assert.equal(diagnostics.length, 2);
  assert.equal(diagnostics[0].loggedIn, true);
  assert.equal(diagnostics[1].errorCode, ERROR_CODES.GUI_ONLY);
});

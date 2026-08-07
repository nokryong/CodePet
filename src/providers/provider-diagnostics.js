// 프로바이더 진단 결과를 합의된 공용 인터페이스로 변환하는 모듈입니다.
// GUI 진단 화면과 `code-pet doctor`가 같은 결과 객체를 공유합니다.
//
// 진단 결과 객체 (그룹 챗에서 합의한 형태):
//   {
//     provider:  "claude" | "codex" | "agy",
//     name:      표시용 이름,
//     installed: true | false | null,   // null = 탐지했지만 실행 확인 실패
//     loggedIn:  true | false | null,   // null = 미설치이거나 CLI가 상태 확인 미지원
//     version:   문자열 | null,
//     model:     기본 모델 id | null,
//     errorCode: 아래 ERROR_CODES 중 하나 | null,
//     message:   사용자 안내 문구 (없으면 ""),
//     installUrl / loginCommand: 해결 액션용 (없으면 null)
//   }

const { createCapabilityService } = require("./provider-capabilities");

const ERROR_CODES = Object.freeze({
  CLI_NOT_FOUND: "cli-not-found",
  GUI_ONLY: "gui-only",
  VERSION_PROBE_FAILED: "version-probe-failed",
  NOT_LOGGED_IN: "not-logged-in",
  AUTH_STATUS_UNKNOWN: "auth-status-unknown",
});

function resolveDefaultModel(record) {
  if (record.status !== "cli") return null;
  const options = Array.isArray(record.modelOptions) ? record.modelOptions : [];
  const flagged = options.find((option) => option?.isDefault);
  if (flagged?.id) return flagged.id;
  const models = Array.isArray(record.models) ? record.models : [];
  if (models.includes("default")) return "default";
  return models[0] || null;
}

// capability record 하나를 진단 결과 객체로 변환합니다.
function toDiagnostic(record) {
  const diagnostic = {
    provider: record.id,
    name: record.name,
    installed: null,
    loggedIn: null,
    version: record.version || null,
    model: resolveDefaultModel(record),
    errorCode: null,
    message: record.reason || "",
    installUrl: record.installUrl || null,
    loginCommand: record.loginCommand || null,
  };

  if (record.status === "cli") {
    diagnostic.installed = true;
  } else if (record.status === "absent") {
    diagnostic.installed = false;
    diagnostic.errorCode = ERROR_CODES.CLI_NOT_FOUND;
  } else if (record.status === "gui-only") {
    diagnostic.installed = false;
    diagnostic.errorCode = ERROR_CODES.GUI_ONLY;
  } else {
    // "error": 실행 파일은 찾았지만 --version 확인에 실패한 상태.
    diagnostic.installed = null;
    diagnostic.errorCode = ERROR_CODES.VERSION_PROBE_FAILED;
  }

  if (diagnostic.installed !== true) return diagnostic;

  if (record.authStatus === "authenticated") {
    diagnostic.loggedIn = true;
  } else if (record.authStatus === "unauthenticated") {
    diagnostic.loggedIn = false;
    diagnostic.errorCode = ERROR_CODES.NOT_LOGGED_IN;
    if (record.authReason) diagnostic.message = record.authReason;
  } else {
    diagnostic.loggedIn = null;
    diagnostic.errorCode = ERROR_CODES.AUTH_STATUS_UNKNOWN;
    if (record.authReason) diagnostic.message = record.authReason;
  }
  return diagnostic;
}

function toDiagnostics(records) {
  return (records || []).map(toDiagnostic);
}

// 설치 + 로그인까지 확인된 상태인지. doctor 종료 코드와 UI 요약에 사용합니다.
function isHealthy(diagnostic) {
  return diagnostic.installed === true && diagnostic.loggedIn === true;
}

// 전체 진단 실행 헬퍼. options는 createCapabilityService에 그대로 전달됩니다.
async function diagnoseProviders(options = {}) {
  const service = options.service ||
    createCapabilityService({ cache: { get: () => null, set: () => {} }, ...options });
  const records = await service.discover({ force: Boolean(options.force) });
  return toDiagnostics(records);
}

module.exports = {
  ERROR_CODES,
  toDiagnostic,
  toDiagnostics,
  isHealthy,
  diagnoseProviders,
};

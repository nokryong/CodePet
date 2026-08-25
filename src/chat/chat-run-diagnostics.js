// 에이전트 실행 실패 기록에서 민감정보를 제거하고 기록 길이를 제한한다.

const TRUNCATION_MARKER = "…(잘림)";

function redactSensitiveText(text) {
  if (typeof text !== "string") {
    return "";
  }

  return text
    // ANSI 이스케이프 코드를 제거한다.
    .replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, "")
    .replace(/\x9B[0-?]*[ -/]*[@-~]/g, "")
    // 인증 헤더와 Bearer 토큰 값을 제거한다.
    .replace(/(\bAuthorization\s*:\s*)[^\r\n]*/gi, "$1[REDACTED]")
    .replace(/(\bBearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    // 알려진 API 키 및 토큰 접두사로 시작하는 값을 제거한다.
    .replace(
      /\b(?:sk-ant-|sk-|ghp_|gho_|xoxb-|xoxp-|AKIA)[A-Za-z0-9._-]+/gi,
      "[REDACTED]",
    )
    // 민감한 이름을 가진 환경변수 대입식의 값 부분을 제거한다.
    .replace(
      /\b([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Za-z0-9_]*\s*=\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s\r\n]+)/gi,
      "$1[REDACTED]",
    )
    // 사용자 홈 디렉터리 경로에서 사용자 이름을 숨긴다.
    .replace(/C:[\\/]Users[\\/][^\\/\s]+/gi, "~")
    .replace(/\/(?:home|Users)\/[^/\s]+/g, "~");
}

function truncateEnd(text, maximumLength) {
  if (text.length <= maximumLength) {
    return text;
  }

  return (
    text.slice(0, maximumLength - TRUNCATION_MARKER.length) +
    TRUNCATION_MARKER
  );
}

function truncateStart(text, maximumLength) {
  if (text.length <= maximumLength) {
    return text;
  }

  return (
    TRUNCATION_MARKER +
    text.slice(-(maximumLength - TRUNCATION_MARKER.length))
  );
}

function buildRunDiagnostics(input) {
  const source = input && typeof input === "object" ? input : {};

  return {
    provider:
      source.provider === null || source.provider === undefined
        ? ""
        : String(source.provider),
    runId:
      source.runId === null || source.runId === undefined
        ? ""
        : String(source.runId),
    exitCode: Number.isInteger(source.exitCode) ? source.exitCode : null,
    lastError: truncateEnd(redactSensitiveText(source.lastError), 500),
    stderrTail: truncateStart(redactSensitiveText(source.stderr), 2048),
    approvalSummary: truncateEnd(
      redactSensitiveText(source.approvalSummary),
      200,
    ),
    approvalDetail: truncateEnd(
      redactSensitiveText(source.approvalDetail),
      2000,
    ),
    autoApprove: Boolean(source.autoApprove),
    approvedRetry: Boolean(source.approvedRetry),
  };
}

module.exports = {
  redactSensitiveText,
  buildRunDiagnostics,
};

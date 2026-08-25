const test = require("node:test");
const assert = require("node:assert/strict");

const {
  redactSensitiveText,
  buildRunDiagnostics,
} = require("../src/chat/chat-run-diagnostics");

test("인증 헤더와 토큰 및 민감한 환경변수 값을 제거한다", () => {
  const input = [
    "Bearer bearer-token-value",
    "Authorization: Basic dXNlcjpwYXNzd29yZA==",
    "OPENAI_KEY=sk-example",
    "ANTHROPIC_TOKEN=sk-ant-example",
    "GITHUB_SECRET=ghp_example",
    "GITHUB_CREDENTIAL=gho_example",
    "SLACK_BOT_TOKEN=xoxb-example",
    "SLACK_USER_TOKEN=xoxp-example",
    "AWS_PASSWORD=AKIAEXAMPLE123456",
  ].join("\n");

  const result = redactSensitiveText(input);

  assert.match(result, /Bearer \[REDACTED\]/);
  assert.match(result, /Authorization: \[REDACTED\]/);
  assert.match(result, /OPENAI_KEY=\[REDACTED\]/);
  assert.match(result, /ANTHROPIC_TOKEN=\[REDACTED\]/);
  assert.match(result, /GITHUB_SECRET=\[REDACTED\]/);
  assert.match(result, /GITHUB_CREDENTIAL=\[REDACTED\]/);
  assert.match(result, /SLACK_BOT_TOKEN=\[REDACTED\]/);
  assert.match(result, /SLACK_USER_TOKEN=\[REDACTED\]/);
  assert.match(result, /AWS_PASSWORD=\[REDACTED\]/);

  assert.doesNotMatch(result, /bearer-token-value/);
  assert.doesNotMatch(result, /dXNlcjpwYXNzd29yZA/);
  assert.doesNotMatch(result, /sk-example/);
  assert.doesNotMatch(result, /sk-ant-example/);
  assert.doesNotMatch(result, /ghp_example/);
  assert.doesNotMatch(result, /gho_example/);
  assert.doesNotMatch(result, /xoxb-example/);
  assert.doesNotMatch(result, /xoxp-example/);
  assert.doesNotMatch(result, /AKIAEXAMPLE123456/);
});

test("사용자 홈 디렉터리 경로를 물결표로 치환한다", () => {
  const input =
    "C:\\Users\\아무개\\project C:/Users/Another/project /home/아무개/project /Users/someone/project";

  assert.equal(
    redactSensitiveText(input),
    "~\\project ~/project ~/project ~/project",
  );
});

test("stderr 꼬리는 제한 길이 안에서 마지막 부분과 잘림 표시를 보존한다", () => {
  const preservedTail = "마지막 오류 내용";
  const stderr = `${"앞".repeat(3000)}${preservedTail}`;

  const diagnostics = buildRunDiagnostics({ stderr });

  assert.ok(diagnostics.stderrTail.length <= 2048);
  assert.ok(diagnostics.stderrTail.startsWith("…(잘림)"));
  assert.ok(diagnostics.stderrTail.endsWith(preservedTail));
});

test("마지막 오류는 500자를 넘지 않고 잘림 표시를 남긴다", () => {
  const diagnostics = buildRunDiagnostics({
    lastError: "오류".repeat(400),
  });

  assert.ok(diagnostics.lastError.length <= 500);
  assert.ok(diagnostics.lastError.endsWith("…(잘림)"));
});

test("승인 상태 입력을 Boolean 값으로 강제한다", () => {
  const truthy = buildRunDiagnostics({
    autoApprove: "yes",
    approvedRetry: 1,
  });
  const falsy = buildRunDiagnostics({
    autoApprove: "",
    approvedRetry: 0,
  });

  assert.equal(truthy.autoApprove, true);
  assert.equal(truthy.approvedRetry, true);
  assert.equal(falsy.autoApprove, false);
  assert.equal(falsy.approvedRetry, false);
});

test("종료 코드가 정수가 아니면 null로 정규화한다", () => {
  assert.equal(buildRunDiagnostics({ exitCode: 1 }).exitCode, 1);
  assert.equal(buildRunDiagnostics({ exitCode: "1" }).exitCode, null);
  assert.equal(buildRunDiagnostics({ exitCode: 1.5 }).exitCode, null);
  assert.equal(buildRunDiagnostics({}).exitCode, null);
});

test("문자열이 아닌 값은 빈 문자열로 정규화한다", () => {
  assert.equal(redactSensitiveText(undefined), "");
  assert.equal(redactSensitiveText(null), "");
  assert.equal(redactSensitiveText(123), "");
  assert.equal(redactSensitiveText({ text: "secret" }), "");
});

test("ANSI 이스케이프 코드를 제거한다", () => {
  assert.equal(redactSensitiveText("\u001b[31m오류\u001b[0m"), "오류");
});

test("모든 진단 텍스트 필드를 빈 문자열이라도 포함한다", () => {
  const diagnostics = buildRunDiagnostics();

  assert.deepEqual(diagnostics, {
    provider: "",
    runId: "",
    exitCode: null,
    lastError: "",
    stderrTail: "",
    approvalSummary: "",
    approvalDetail: "",
    autoApprove: false,
    approvedRetry: false,
  });
});

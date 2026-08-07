const test = require("node:test");
const assert = require("node:assert/strict");

const { parseClaudeLine, parseCodexLine, parseAgyLine, createLineParser } = require("../src/chat/chat-events");

test("claude: 텍스트 델타 스트림 이벤트", () => {
  const line = JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "안녕" } },
  });
  assert.deepEqual(parseClaudeLine(line), { kind: "delta", text: "안녕" });
});

test("claude: 도구 사용은 status로 정규화", () => {
  const line = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Read", input: {} }] },
  });
  assert.deepEqual(parseClaudeLine(line), { kind: "status", label: "도구: Read" });
});

test("claude: result 성공은 final, 실패는 error", () => {
  const success = JSON.stringify({ type: "result", subtype: "success", result: "최종 답변" });
  assert.deepEqual(parseClaudeLine(success), { kind: "final", text: "최종 답변" });

  const failure = JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, result: "한도" });
  assert.equal(parseClaudeLine(failure).kind, "error");
});

test("claude: 알 수 없는 이벤트/비JSON은 무시", () => {
  assert.equal(parseClaudeLine(JSON.stringify({ type: "system", subtype: "init" })), null);
  assert.equal(parseClaudeLine("plain text line"), null);
  assert.equal(parseClaudeLine('{"broken json'), null);
});

test("codex: 신형 item.completed agent_message는 final", () => {
  const line = JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: "코덱스 답변" },
  });
  assert.deepEqual(parseCodexLine(line), { kind: "final", text: "코덱스 답변" });
});

test("codex: 명령 실행 시작은 status", () => {
  const line = JSON.stringify({
    type: "item.started",
    item: { type: "command_execution", command: "ls -al" },
  });
  assert.deepEqual(parseCodexLine(line), { kind: "status", label: "실행: ls -al" });
});

test("codex: turn.failed의 중첩 오류 원인을 표시한다", () => {
  const line = JSON.stringify({
    type: "turn.failed",
    error: { message: "127.0.0.1 프록시 연결 거부" },
  });
  assert.deepEqual(parseCodexLine(line), {
    kind: "error",
    message: "127.0.0.1 프록시 연결 거부",
  });
});

test("codex: 구형 msg 스키마도 처리한다", () => {
  const finalLine = JSON.stringify({ id: "1", msg: { type: "agent_message", message: "구형 답변" } });
  assert.deepEqual(parseCodexLine(finalLine), { kind: "final", text: "구형 답변" });

  const execLine = JSON.stringify({ id: "2", msg: { type: "exec_command_begin", command: ["git", "status"] } });
  assert.deepEqual(parseCodexLine(execLine), { kind: "status", label: "실행: git status" });

  const errorLine = JSON.stringify({ id: "3", msg: { type: "error", message: "문제 발생" } });
  assert.equal(parseCodexLine(errorLine).kind, "error");
});

test("agy stream-json의 최종 응답과 권한 거부를 정규화한다", () => {
  assert.equal(typeof createLineParser("claude"), "function");
  assert.equal(typeof createLineParser("codex"), "function");
  assert.equal(typeof createLineParser("agy"), "function");
  assert.deepEqual(parseAgyLine(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "안녕" } })), { kind: "final", text: "안녕" });
  const denied = parseAgyLine(JSON.stringify({ event: "step_update", step_update: { state: "ERROR", tool_name: "run_command", tool_info: { error: { message: "permission denied" } } } }));
  assert.equal(denied.kind, "approval-required");
});

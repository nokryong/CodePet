const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

const html = source("src/chat.html");
const css = source("src/chat.css");
const renderer = source("src/chat.js");
const preload = source("src/chat-preload.js");

test("입력창 위 발언 큐는 현재 발언자와 취소 가능한 대기 턴을 제공한다", () => {
  assert.match(html, /id="turn-queue-bar"/);
  assert.match(html, /id="turn-current"/);
  assert.match(html, /id="turn-queue-list"/);
  assert.match(html, /id="btn-interject"/);
  assert.match(html, /id="btn-clear-turns"/);
  assert.match(css, /\.turn-queue-bar\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(css, /\.turn-current\[hidden\][\s\S]*?display:\s*none/);
  assert.match(renderer, /function renderTurnQueue\(\)/);
  assert.match(renderer, /turnQueueBar\.hidden = !turnState\.current && waiting\.length === 0/);
});

test("초기 세션 상태와 turn-state 이벤트는 현재 세션의 큐만 렌더링한다", () => {
  assert.match(renderer, /turnState = normalizeTurnState\(full\.session\.turnState\)/);
  assert.match(
    renderer,
    /onTurnState\(\(\{ sessionId, \.\.\.nextTurnState \}\) => \{\s*if \(sessionId !== activeSessionId\) return;\s*turnState = normalizeTurnState\(nextTurnState\);\s*renderTurnQueue\(\)/s
  );
});

test("개별 취소, 현재 응답 개입, 전체 중지를 각각 노출된 IPC로 호출한다", () => {
  assert.match(preload, /turnInterject: \(sessionId\) => ipcRenderer\.invoke\(INVOKE\.TURN_INTERJECT/);
  assert.match(preload, /turnCancel: \(sessionId, turnId\) =>\s*ipcRenderer\.invoke\(INVOKE\.TURN_CANCEL/s);
  assert.match(preload, /onTurnState: \(handler\) => subscribe\("chat:turn-state", handler\)/);
  assert.match(renderer, /chatApi\.turnCancel\(activeSessionId, turn\.turnId\)/);
  assert.match(renderer, /chatApi\.turnInterject\(sessionId\)/);
  assert.match(renderer, /window\.confirm\(prompt\)/);
  assert.match(renderer, /chatApi\.stop\(sessionId\)/);
});

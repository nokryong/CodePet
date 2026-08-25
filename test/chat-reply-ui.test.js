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

test("메시지 인용 버튼과 작성 중 인용 미리보기·해제 UI가 연결된다", () => {
  assert.match(html, /id="reply-preview"[^>]*hidden/);
  assert.match(html, /id="reply-preview-author"/);
  assert.match(html, /id="reply-preview-excerpt"/);
  assert.match(html, /id="btn-clear-reply"/);
  assert.match(css, /\.message:hover \.message-reply[\s\S]*?opacity:\s*1/);
  assert.match(css, /\.reply-preview\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(renderer, /replyButton\.addEventListener\("click", \(\) => quoteMessage\(message\)\)/);
  assert.match(renderer, /clearReplyButton\.addEventListener\("click"/);
});

test("인용 스냅숏은 전송 payload에 포함되고 성공·세션 전환·초기화 때 정리된다", () => {
  assert.match(
    preload,
    /send: \(sessionId, text, attachmentIds, replyTo\) =>\s*ipcRenderer\.invoke\(INVOKE\.SEND, \{ sessionId, text, attachmentIds, replyTo \}\)/s
  );
  assert.match(renderer, /chatApi\.send\(sessionId, text, attachmentIds, replyTo\)/);
  assert.match(renderer, /if \(pendingReplyTo === replyTo\) clearPendingReply\(\)/);
  assert.match(renderer, /if \(previousSessionId !== activeSessionId\) clearPendingReply\(\)/);
  assert.match(renderer, /onReset\([\s\S]*?clearPendingReply\(\)/);
});

test("저장된 replyTo는 말풍선 안의 안전한 텍스트 인용 블록으로 표시된다", () => {
  assert.match(renderer, /const replyTo = normalizeReplySnapshot\(message\.replyTo\)/);
  assert.match(renderer, /if \(replyTo\) bubble\.append\(makeReplyContext\(replyTo\)\)/);
  assert.match(renderer, /author\.textContent = replyAuthorLabel\(replyTo\)/);
  assert.match(renderer, /excerpt\.textContent = replyTo\.excerpt/);
  assert.doesNotMatch(renderer, /reply-context[\s\S]{0,300}innerHTML/);
});

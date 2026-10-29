const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ChatStore } = require("../src/chat/chat-store");
const { ChatRoom } = require("../src/chat/chat-room");
const { createChatFeature } = require("../src/chat/chat-ipc");

function fixture(t, count = 125) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-history-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new ChatStore({ root }).init();
  const session = store.createSession();
  const messages = Array.from({ length: count }, (_, i) => ({
    id: `m${i}`, ts: i, authorType: "user", author: "user", text: `대화 ${i} 한글 🚀`,
  }));
  fs.writeFileSync(store.transcriptPath(session.id), messages.map((message) =>
    JSON.stringify({ kind: "message", message })).join("\n") + "\n");
  return { store, id: session.id, messages };
}

test("최근 50개부터 이전 페이지를 누락·중복 없이 시간순으로 읽는다", (t) => {
  const { store, id, messages } = fixture(t);
  const first = store.readMessagesPage(id);
  assert.deepEqual(first.messages, messages.slice(-50));
  assert.equal(first.hasMore, true);
  const second = store.readMessagesPage(id, { before: first.before });
  const last = store.readMessagesPage(id, { before: second.before });
  assert.equal(last.hasMore, false);
  assert.deepEqual([...last.messages, ...second.messages, ...first.messages], messages);
  assert.deepEqual(store.readMessagesPage(id, { before: 0 }).messages, []);
  assert.deepEqual(store.getSession(id).messages, messages, "export still has the complete transcript");
});

test("페이지 사이 새 메시지가 추가되어도 이전 커서가 유지된다", (t) => {
  const { store, id, messages } = fixture(t);
  const first = store.readMessagesPage(id);
  store.appendEvent(id, { kind: "message", message: { id: "new", text: "새 메시지" } });
  assert.deepEqual(store.readMessagesPage(id, { before: first.before }).messages, messages.slice(25, 75));
  assert.equal(store.readMessagesPage(id).messages.at(-1).id, "new");
});

test("손상 줄·비메시지 이벤트·CRLF·마지막 개행 없는 한글을 처리한다", (t) => {
  const { store, id, messages } = fixture(t, 3);
  fs.writeFileSync(store.transcriptPath(id), [
    JSON.stringify({ kind: "message", message: messages[0] }),
    "{broken", JSON.stringify({ kind: "status", text: "skip" }),
    JSON.stringify({ kind: "message", message: { ...messages[1], text: "한글🚀".repeat(20000) } }),
    JSON.stringify({ kind: "message", message: messages[2] }),
  ].join("\r\n"));
  const page = store.readMessagesPage(id);
  assert.equal(page.messages.length, 3);
  assert.equal(page.messages[1].text, "한글🚀".repeat(20000));
  assert.equal(page.hasMore, false);
});

test("페이지 바이트 예산으로 큰 메시지를 분할하되 한 메시지는 자르지 않는다", (t) => {
  const { store, id, messages } = fixture(t, 3);
  const page = store.readMessagesPage(id, { maxBytes: 1 });
  assert.deepEqual(page.messages, [messages[2]]);
  assert.equal(page.hasMore, true);
  assert.deepEqual(store.readMessagesPage(id, { before: page.before, maxBytes: 1 }).messages, [messages[1]]);
});

test("1만 개 기록의 최근 페이지는 파일 전체를 읽지 않는다", (t) => {
  const { store, id, messages } = fixture(t, 10000);
  let bytesRead = 0;
  const original = fs.readSync;
  t.mock.method(fs, "readSync", (...args) => {
    const size = original(...args);
    bytesRead += size;
    return size;
  });
  assert.deepEqual(store.readMessagesPage(id).messages, messages.slice(-50));
  assert.ok(bytesRead <= 128 * 1024, `${bytesRead} bytes read`);
});

test("화면 기록을 제한해도 모델 문맥은 최근 정상 메시지를 독립적으로 조회한다", (t) => {
  const { store, id, messages } = fixture(t);
  for (let i = 0; i < 150; i++) {
    fs.appendFileSync(store.transcriptPath(id), JSON.stringify({ kind: "message", message: {
      id: `system-${i}`, authorType: "system", text: "상태", } }) + "\n");
  }
  const room = new ChatRoom({
    maxStoredMessages: 10,
    loadPromptMessages: () => store.readMessagesPage(id, {
      limit: 40, maxBytes: Infinity, filter: (m) => m.authorType !== "system" && !m.error,
    }).messages,
  });
  for (let i = 0; i < 20; i++) room.appendSystem("상태");
  assert.equal(room.messages.length, 10);
  assert.deepEqual(room.promptMessages(), messages.slice(-40));
});

test("기록 IPC는 세션·커서를 검증하고 첨부 내부 경로를 노출하지 않는다", async (t) => {
  const { store, id } = fixture(t, 1);
  store.appendEvent(id, { kind: "message", message: {
    id: "attachment", authorType: "user", text: "첨부", attachments: [{
      id: "a1", name: "image.png", mime: "image/png", kind: "image", size: 100,
      fileName: "internal.png", sha256: "private", path: "internal-path",
    }],
  } });
  const handlers = new Map();
  const feature = createChatFeature({ store, storeRoot: store.root, electron: {
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), on() {} },
    dialog: {}, BrowserWindow: class {}, shell: {},
  } });
  feature.registerIpcHandlers();
  const read = handlers.get("chat:messages:history");
  assert.equal((await read({}, { sessionId: "../outside" })).ok, false);
  for (const before of [-1, "1", {}, 1.5, Number.MAX_SAFE_INTEGER]) {
    assert.equal((await read({}, { sessionId: id, before })).ok, false);
  }
  const page = await read({}, { sessionId: id, before: null });
  assert.equal(page.ok, true);
  assert.deepEqual(page.messages.at(-1).attachments, [{
    id: "a1", name: "image.png", mime: "image/png", kind: "image", size: 100,
  }]);
});

test("최근 페이지 밖의 오래된 이미지 첨부도 미리볼 수 있다", async (t) => {
  const { store, id, messages } = fixture(t);
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
  const fileName = "1234567890abcdef.png";
  fs.writeFileSync(path.join(store.attachmentsDir(id), fileName), bytes);
  messages[0].attachments = [{ id: "old-image", fileName }];
  fs.writeFileSync(store.transcriptPath(id), messages.map((message) =>
    JSON.stringify({ kind: "message", message })).join("\n") + "\n");
  const handlers = new Map();
  createChatFeature({ store, storeRoot: store.root, electron: {
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), on() {} },
    dialog: {}, BrowserWindow: class {}, shell: {},
  } }).registerIpcHandlers();
  const result = await handlers.get("chat:attachments:preview")({}, { sessionId: id, attachmentId: "old-image" });
  assert.equal(result.ok, true);
  assert.equal(result.dataUrl, `data:image/png;base64,${bytes.toString("base64")}`);
});

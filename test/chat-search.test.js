const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ChatStore } = require("../src/chat/chat-store");
const { createChatFeature } = require("../src/chat/chat-ipc");

function makeStore(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-search-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return new ChatStore({ root, ...options }).init();
}

function addMessage(store, sessionId, message) {
  store.appendEvent(sessionId, { kind: "message", message });
}

test("세션 검색은 대소문자 없이 메시지를 찾고 시스템 메시지는 제외한다", (t) => {
  let now = 1_000;
  const store = makeStore(t, { now: () => (now += 1) });
  const session = store.createSession({ title: "릴리스 준비" });
  addMessage(store, session.id, {
    id: "m1",
    ts: 1_100,
    authorType: "agent",
    author: "codex",
    text: `${"앞".repeat(50)}Deploy READY for review${"뒤".repeat(50)}`,
  });
  addMessage(store, session.id, {
    id: "system",
    ts: 1_200,
    authorType: "system",
    author: "system",
    text: "READY 시스템 안내",
  });

  const results = store.searchSessions("ready");

  assert.equal(results.length, 1);
  assert.equal(results[0].sessionId, session.id);
  assert.equal(results[0].title, "릴리스 준비");
  assert.equal(results[0].messageId, "m1");
  assert.equal(results[0].ts, 1_100);
  assert.match(results[0].snippet, /^….*READY.*…$/u);
});

test("세션 검색은 세션당 3건, 전체 50건으로 제한한다", (t) => {
  let now = 2_000;
  const store = makeStore(t, { now: () => (now += 1) });
  for (let sessionIndex = 0; sessionIndex < 17; sessionIndex += 1) {
    const session = store.createSession({ title: `세션 ${sessionIndex}` });
    for (let messageIndex = 0; messageIndex < 4; messageIndex += 1) {
      addMessage(store, session.id, {
        id: `${sessionIndex}-${messageIndex}`,
        ts: now,
        authorType: "user",
        author: "user",
        text: `needle ${sessionIndex}-${messageIndex}`,
      });
    }
  }

  const results = store.searchSessions("needle");
  const counts = new Map();
  for (const result of results) {
    counts.set(result.sessionId, (counts.get(result.sessionId) || 0) + 1);
  }

  assert.equal(results.length, 50);
  assert.ok([...counts.values()].every((count) => count <= 3));
});

test("빈 검색어는 즉시 빈 결과를 반환한다", (t) => {
  const store = makeStore(t);
  assert.deepEqual(store.searchSessions("   "), []);
  assert.deepEqual(store.searchSessions(null), []);
});

test("세션 검색은 손상된 JSONL 줄을 건너뛰고 정상 메시지를 계속 찾는다", (t) => {
  const store = makeStore(t);
  const session = store.createSession({ title: "복구 테스트" });
  addMessage(store, session.id, {
    id: "before",
    ts: 10,
    authorType: "user",
    author: "user",
    text: "needle before",
  });
  fs.appendFileSync(store.transcriptPath(session.id), "{broken jsonl line}\n", "utf8");
  addMessage(store, session.id, {
    id: "after",
    ts: 20,
    authorType: "agent",
    author: "claude",
    text: "needle after",
  });

  assert.deepEqual(
    store.searchSessions("needle").map((result) => result.messageId),
    ["after", "before"]
  );
});

test("세션 검색 IPC는 질의를 검증하고 저장소 결과만 반환한다", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-search-ipc-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storeRoot = path.join(root, "store");
  const store = new ChatStore({ root: storeRoot }).init();
  const session = store.createSession({ title: "IPC 검색" });
  addMessage(store, session.id, {
    id: "ipc-message",
    ts: 30,
    authorType: "agent",
    author: "agy",
    text: "Find This Message",
  });

  const handlers = new Map();
  const feature = createChatFeature({
    storeRoot,
    electron: {
      ipcMain: {
        handle(channel, handler) {
          handlers.set(channel, handler);
        },
        on() {},
      },
      dialog: {},
      BrowserWindow: class {},
      shell: {},
    },
  });
  feature.registerIpcHandlers();

  const handler = handlers.get("chat:sessions:search");
  assert.equal(typeof handler, "function");
  assert.deepEqual(await handler({}, { query: {} }), { ok: true, results: [] });
  const result = await handler({}, { query: "  find this  " });
  assert.equal(result.ok, true);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].messageId, "ipc-message");
});

test("검색 UI는 preload, 디바운스, 안전한 강조 렌더링과 연결된다", () => {
  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "src", "chat.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "src", "chat.css"), "utf8");
  const preload = fs.readFileSync(path.join(root, "src", "chat-preload.js"), "utf8");
  const renderer = fs.readFileSync(path.join(root, "src", "chat.js"), "utf8");

  assert.match(html, /id="session-search-input"[^>]*type="search"/s);
  assert.match(preload, /sessionsSearch: \(query\) => ipcRenderer\.invoke\(INVOKE\.SESSIONS_SEARCH, \{ query \}\)/);
  assert.match(renderer, /const SESSION_SEARCH_DEBOUNCE_MS = 250/);
  assert.match(renderer, /window\.chatApi\.sessionsSearch\(query\)/);
  assert.match(renderer, /mark\.textContent = text\.slice/);
  assert.match(renderer, /button\.addEventListener\("click", \(\) => selectSession\(result\.sessionId\)\)/);
  assert.match(renderer, /previousSessionId !== activeSessionId[\s\S]*?resetSessionSearchState\(\)/);
  assert.match(css, /\.session-search-result-snippet mark/);
});

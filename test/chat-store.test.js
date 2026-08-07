const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  ChatStore,
  STORE_SCHEMA_VERSION,
  defaultRoot,
  readJsonlTolerant,
} = require("../src/chat/chat-store");

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codepet-store-"));
}

function makeStore(options = {}) {
  const root = options.root || makeRoot();
  const store = new ChatStore({ root, ...options });
  store.init();
  return store;
}

test("CODE_PET_HOME이 기본 루트를 대체한다", () => {
  const override = makeRoot();
  assert.equal(defaultRoot({ CODE_PET_HOME: override }), path.resolve(override));
  assert.equal(defaultRoot({}), path.join(os.homedir(), ".code-pet"));
});

test("초기화가 디렉터리 구조와 config를 만든다", () => {
  const store = makeStore();
  assert.ok(fs.existsSync(path.join(store.root, "sessions")));
  assert.ok(fs.existsSync(path.join(store.root, "trash")));
  assert.ok(fs.existsSync(store.runtimeChatDir()));
  const config = JSON.parse(fs.readFileSync(store.configPath(), "utf8"));
  assert.equal(config.schemaVersion, STORE_SCHEMA_VERSION);
});

test("세션 생성/조회/이름변경/목록", () => {
  const store = makeStore();
  const meta = store.createSession({ title: "  테스트   방 " });
  assert.equal(meta.title, "테스트 방");
  assert.ok(fs.existsSync(store.attachmentsDir(meta.id)));

  const renamed = store.renameSession(meta.id, "새 이름");
  assert.equal(renamed.title, "새 이름");

  const list = store.listSessions();
  assert.equal(list.length, 1);
  assert.equal(list[0].title, "새 이름");
});

test("메시지 추가가 미리보기/자동 제목/updatedAt을 갱신한다", () => {
  let clock = 1000;
  const store = makeStore({ now: () => (clock += 1) });
  const meta = store.createSession({});
  store.appendEvent(meta.id, {
    kind: "message",
    message: { id: "m1", ts: 1, authorType: "user", author: "user", text: "안녕하세요 오늘 코드 리뷰 부탁해요" },
  });
  const session = store.getSession(meta.id);
  assert.equal(session.messages.length, 1);
  assert.ok(session.meta.title.startsWith("안녕하세요"));
  assert.equal(session.meta.autoTitle, false);
  assert.ok(session.meta.preview.includes("코드 리뷰"));
  assert.ok(session.meta.updatedAt > meta.updatedAt);
});

test("원자적 쓰기: 임시 파일이 남아도 원본 메타는 유효하다", () => {
  const store = makeStore();
  const meta = store.createSession({ title: "유지" });
  // 크래시 시나리오: 다른 프로세스가 남긴 임시 파일이 있어도 로드에 지장이 없어야 한다.
  fs.writeFileSync(path.join(store.sessionDir(meta.id), ".meta.json.999.1.tmp"), "{broken", "utf8");
  const reloaded = new ChatStore({ root: store.root }).init();
  assert.equal(reloaded.getSession(meta.id).meta.title, "유지");
});

test("찢긴 JSONL 마지막 줄은 버리고 나머지를 복구한다", () => {
  const store = makeStore();
  const meta = store.createSession({});
  store.appendEvent(meta.id, { kind: "message", message: { id: "m1", authorType: "user", author: "user", text: "hello" } });
  store.appendEvent(meta.id, { kind: "message", message: { id: "m2", authorType: "agent", author: "codex", text: "world" } });
  fs.appendFileSync(store.transcriptPath(meta.id), '{"v":1,"kind":"message","mess', "utf8");

  const events = readJsonlTolerant(store.transcriptPath(meta.id));
  assert.equal(events.length, 2);
  const messages = store.readMessages(meta.id);
  assert.deepEqual(messages.map((m) => m.id), ["m1", "m2"]);
});

test("index.json이 깨지면 메타에서 재구축한다", () => {
  const store = makeStore();
  const a = store.createSession({ title: "A" });
  const b = store.createSession({ title: "B" });
  fs.writeFileSync(store.indexPath(), "not json at all", "utf8");

  const reloaded = new ChatStore({ root: store.root }).init();
  const ids = reloaded.listSessions().map((entry) => entry.id).sort();
  assert.deepEqual(ids, [a.id, b.id].sort());
});

test("더 새로운 스키마의 저장소는 읽기 전용으로 열린다", () => {
  const root = makeRoot();
  const store = makeStore({ root });
  const meta = store.createSession({ title: "미래" });
  const config = JSON.parse(fs.readFileSync(store.configPath(), "utf8"));
  fs.writeFileSync(store.configPath(), JSON.stringify({ ...config, schemaVersion: STORE_SCHEMA_VERSION + 5 }), "utf8");

  const reloaded = new ChatStore({ root }).init();
  assert.equal(reloaded.readOnly, true);
  assert.throws(() => reloaded.createSession({}));
  // 읽기는 계속 가능하다.
  assert.equal(reloaded.getSession(meta.id).meta.title, "미래");
  // 쓰기는 거부된다.
  assert.equal(reloaded.appendEvent(meta.id, { kind: "message", message: { text: "x" } }), null);
});

test("더 새로운 스키마의 세션 메타는 세션 단위로 읽기 전용이 된다", () => {
  const store = makeStore();
  const meta = store.createSession({ title: "future-session" });
  const raw = JSON.parse(fs.readFileSync(store.metaPath(meta.id), "utf8"));
  fs.writeFileSync(
    store.metaPath(meta.id),
    JSON.stringify({ ...raw, schemaVersion: STORE_SCHEMA_VERSION + 1 }),
    "utf8"
  );
  const read = store.readMeta(meta.id);
  assert.equal(read.readOnly, true);
  assert.equal(store.appendEvent(meta.id, { kind: "message", message: { text: "x" } }), null);
});

test("소프트 삭제는 trash로 이동하고 복원할 수 있다", () => {
  const store = makeStore();
  const meta = store.createSession({ title: "삭제 대상" });
  store.appendEvent(meta.id, { kind: "message", message: { id: "m1", authorType: "user", author: "user", text: "내용" } });

  assert.equal(store.deleteSession(meta.id), true);
  assert.equal(store.listSessions().length, 0);
  assert.ok(fs.existsSync(path.join(store.trashRoot(), meta.id, "transcript.jsonl")));
  assert.equal(store.listTrash()[0].id, meta.id);

  const restored = store.restoreSession(meta.id);
  assert.equal(restored.id, meta.id);
  assert.equal(store.listSessions().length, 1);
  assert.equal(store.readMessages(meta.id).length, 1);
});

test("보존 기간이 지난 휴지통 항목은 정리된다", () => {
  let clock = 1_000_000;
  const store = makeStore({ now: () => clock, trashRetentionMs: 1000 });
  const meta = store.createSession({});
  store.deleteSession(meta.id);
  clock += 5000;
  store.purgeTrash();
  assert.equal(store.listTrash().length, 0);
  assert.ok(!fs.existsSync(path.join(store.trashRoot(), meta.id)));
});

test("running 상태 세션은 재시작 시 interrupted로 표시된다", () => {
  const root = makeRoot();
  const store = makeStore({ root });
  const meta = store.createSession({});
  store.setSessionStatus(meta.id, "running");

  const reloaded = new ChatStore({ root }).init();
  const session = reloaded.getSession(meta.id);
  assert.equal(session.meta.status, "interrupted");
  const last = session.messages.at(-1);
  assert.equal(last.authorType, "system");
  assert.ok(last.text.includes("중단"));
});

test("세션 메타 patch가 워크스페이스/권한/에이전트 설정을 저장한다", () => {
  const store = makeStore();
  const meta = store.createSession({});
  store.updateMeta(meta.id, {
    workspace: "D:/work/project",
    permissionMode: "workspace-read",
    agents: { claude: { enabled: false, model: "fable", effort: "high" } },
  });
  const reloaded = new ChatStore({ root: store.root }).init();
  const loaded = reloaded.getSession(meta.id).meta;
  assert.equal(loaded.workspace, "D:/work/project");
  assert.equal(loaded.permissionMode, "workspace-read");
  assert.equal(loaded.agents.claude.model, "fable");
  assert.equal(reloaded.listSessions()[0].permissionMode, "workspace-read");
});

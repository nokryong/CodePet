const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  GrokWatcher,
  parseGrokUpdate,
  grokSessionsRoot,
} = require("../src/grok-watcher");

function update(sessionUpdate, values = {}, eventId = `event-${sessionUpdate}`) {
  return {
    params: {
      sessionId: "session-1",
      update: { sessionUpdate, ...values },
      _meta: { eventId },
    },
  };
}

function tempDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-grok-watcher-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("Grok update parser는 사용자·응답 청크를 읽고 생각 청크는 숨긴다", () => {
  const user = parseGrokUpdate(update("user_message_chunk", { content: { type: "text", text: "요청" } }));
  const assistant = parseGrokUpdate(update("agent_message_chunk", { content: { type: "text", text: "응답" } }));
  const thought = parseGrokUpdate(update("agent_thought_chunk", { content: { type: "text", text: "비공개" } }));

  assert.deepEqual(
    { type: user.type, text: user.text, append: user.append },
    { type: "user", text: "요청", append: true }
  );
  assert.deepEqual(
    { type: assistant.type, text: assistant.text, append: assistant.append },
    { type: "assistant", text: "응답", append: true }
  );
  assert.equal(thought, null);
});

test("Grok tool과 turn 완료를 본체 watcher 이벤트로 정규화한다", () => {
  const tool = parseGrokUpdate(update("tool_call_update", { title: "Edit `app.js`", kind: "edit" }));
  const complete = parseGrokUpdate(update("turn_completed", { stop_reason: "end_turn" }));
  const failed = parseGrokUpdate(update("turn_completed", { stop_reason: "error" }, "failed"));

  assert.equal(tool.type, "tool");
  assert.equal(tool.kind, "patch");
  assert.equal(complete.finished, true);
  assert.equal(complete.reason, "done");
  assert.equal(failed.reason, "failed");
});

test("Grok parser는 알 수 없거나 깨진 행을 조용히 무시한다", () => {
  assert.equal(parseGrokUpdate(null), null);
  assert.equal(parseGrokUpdate({ params: { sessionId: "s", update: { sessionUpdate: "unknown" } } }), null);
  assert.equal(parseGrokUpdate({ params: { update: { sessionUpdate: "agent_message_chunk" } } }), null);
});

test("Grok watcher는 streaming 청크를 누적하고 완료 메시지를 보존한다", (t) => {
  const root = tempDir(t);
  const group = path.join(root, encodeURIComponent("C:\\work"), "session-1");
  fs.mkdirSync(group, { recursive: true });
  const file = path.join(group, "updates.jsonl");
  fs.writeFileSync(file, "");

  const watcher = new GrokWatcher({ roots: [root], quietMs: 60_000 });
  const messages = [];
  const contexts = [];
  const tools = [];
  const finished = [];
  watcher.on("agent-message", (message, context) => {
    messages.push(message);
    contexts.push(context);
  });
  watcher.on("tool-activity", (tool) => tools.push(tool));
  watcher.on("task-finished", (result) => finished.push(result));
  watcher.seed();

  const rows = [
    update("user_message_chunk", { content: { type: "text", text: "해줘" } }, "u1"),
    update("agent_message_chunk", { content: { type: "text", text: "처리" } }, "a1"),
    update("agent_message_chunk", { content: { type: "text", text: " 완료" } }, "a2"),
    update("tool_call", { title: "Read app.js", kind: "read" }, "t1"),
    update("turn_completed", { stop_reason: "end_turn" }, "done"),
  ];
  fs.appendFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  watcher.poll();

  assert.deepEqual(messages, ["처리", "처리 완료"]);
  assert.equal(contexts[0].cwd, "C:\\work");
  assert.equal(tools[0].kind, "read");
  assert.equal(finished.length, 1);
  assert.equal(finished[0].message, "처리 완료");
  assert.equal(finished[0].reason, "done");
  assert.equal(finished[0].threadId, "grok:session-1");
});

test("Grok의 긴 streaming 응답은 마지막 조각만이 아니라 누적된 최신 문맥을 보인다", (t) => {
  const root = tempDir(t);
  const group = path.join(root, "cwd", "session-1");
  fs.mkdirSync(group, { recursive: true });
  const file = path.join(group, "updates.jsonl");
  fs.writeFileSync(file, "");
  const watcher = new GrokWatcher({ roots: [root], quietMs: 60_000 });
  const messages = [];
  watcher.on("agent-message", (message) => messages.push(message));
  watcher.seed();

  fs.appendFileSync(
    file,
    `${JSON.stringify(update("agent_message_chunk", { content: { type: "text", text: "가".repeat(300) } }, "long-1"))}\n` +
      `${JSON.stringify(update("agent_message_chunk", { content: { type: "text", text: "마지막문맥" } }, "long-2"))}\n`
  );
  watcher.poll();

  assert.match(messages.at(-1), /마지막문맥$/);
  assert.ok(messages.at(-1).length > "마지막문맥".length);
});

test("Grok watcher는 updates.jsonl만 찾고 GROK_HOME을 존중한다", (t) => {
  const root = tempDir(t);
  const grokHome = path.join(root, "custom-grok");
  const sessions = path.join(grokHome, "sessions");
  const session = path.join(sessions, "cwd", "session");
  fs.mkdirSync(session, { recursive: true });
  fs.writeFileSync(path.join(session, "updates.jsonl"), "");
  fs.writeFileSync(path.join(session, "chat_history.jsonl"), "");

  assert.equal(grokSessionsRoot({ home: root, env: { GROK_HOME: grokHome } }), sessions);
  const watcher = new GrokWatcher({ home: root, env: { GROK_HOME: grokHome } });
  assert.deepEqual(watcher.files(), [path.join(session, "updates.jsonl")]);
});

test("main process는 Grok watcher를 등록하고 모든 수명주기에서 정리한다", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  assert.match(source, /new GrokWatcher\(\)/);
  assert.match(source, /registerExternalWatcher\(grokWatcher, "Grok"\)/);
  assert.match(source, /grokWatcher\.start\(\)/);
  assert.ok((source.match(/grokWatcher\.stop\(\)/g) || []).length >= 2);
  assert.match(source, /isAnyProviderWorking[\s\S]*grokWatcher\.working/);
  assert.match(source, /new GrokAccountSwitcher\(\)/);
  assert.match(source, /writeGrokLoginScript/);
  assert.match(source, /buildSimpleProviderSubmenu\(grokAccountSwitcher, "grok", "Grok"\)/);
  assert.match(source, /\{ id: "grok", label: "Grok", accounts: grok\.accounts, dockerRead: grok\.dockerRead \}/);
  assert.match(source, /readGrokUsage\(\)/);
  assert.doesNotMatch(source, /plan: modelLabel/);
});

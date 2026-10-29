const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ChatStore, STORE_SCHEMA_VERSION } = require("../src/chat/chat-store");
const { ChatTraceStore } = require("../src/chat/chat-traces");
const { GrokDockerRuntime } = require("../src/grok-docker-runtime");
const { createChatFeature } = require("../src/chat/chat-ipc");

for (const mode of ["session", "store", "writable"]) {
  test(`삭제 IPC는 ${mode} 읽기 전용 여부를 정리 작업보다 먼저 확인한다`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-delete-readonly-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = new ChatStore({ root }).init();
    const meta = store.createSession({ title: "삭제 보호" });
    if (mode === "session") {
      fs.writeFileSync(store.metaPath(meta.id), JSON.stringify({ ...meta, schemaVersion: STORE_SCHEMA_VERSION + 1 }));
    } else if (mode === "store") {
      fs.writeFileSync(store.configPath(), JSON.stringify({ schemaVersion: STORE_SCHEMA_VERSION + 1 }));
    }
    let traceDiscards = 0, changeDiscards = 0;
    t.mock.method(ChatTraceStore.prototype, "discard", async () => { traceDiscards++; });
    t.mock.method(GrokDockerRuntime.prototype, "discardSessionChanges", () => { changeDiscards++; });
    const handlers = new Map();
    store.close();
    const feature = createChatFeature({ storeRoot: root, electron: {
      ipcMain: { handle: (name, handler) => handlers.set(name, handler), on() {} },
      dialog: {}, BrowserWindow: class {}, shell: {},
    } });
    t.after(() => feature.shutdown());
    feature.registerIpcHandlers();
    const result = await handlers.get("chat:sessions:delete")({}, { sessionId: meta.id });
    if (mode === "writable") {
      assert.equal(result.ok, true);
      assert.equal(fs.existsSync(store.sessionDir(meta.id)), false);
      assert.equal(traceDiscards, 1);
      assert.equal(changeDiscards, 1);
    } else {
      assert.equal(result.ok, false);
      assert.match(result.error, /읽기 전용/);
      assert.equal(fs.existsSync(store.sessionDir(meta.id)), true);
      assert.equal(traceDiscards, 0);
      assert.equal(changeDiscards, 0);
    }
  });
}

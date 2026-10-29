const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { ChatStore } = require("../src/chat/chat-store");
const { createChatFeature } = require("../src/chat/chat-ipc");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-chat-routing-"));
  t.after(() => {
    assert.ok(fs.realpathSync(root).startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const store = new ChatStore({ root }).init();
  const first = store.createSession({}).id, second = store.createSession({}).id;
  const sent = [];
  class Window extends EventEmitter {
    constructor() { super(); this.minimized = false; this.webContents = { send: (channel, data) => sent.push({ channel, data }) }; }
    loadFile() {} setMenuBarVisibility() {} isDestroyed() { return false; }
    isMinimized() { return this.minimized; } restore() { this.minimized = false; }
    show() { this.shown = true; } focus() { this.focused = true; }
  }
  const handlers = new Map();
  const feature = createChatFeature({ store, storeRoot: root, electron: { BrowserWindow: Window, dialog: {}, shell: {},
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), on() {} } } });
  t.after(() => feature.shutdown());
  feature.registerIpcHandlers();
  return { store, first, second, sent, feature };
}

test("notifications select the exact room in new and minimized existing chat windows", t => {
  const f = fixture(t);
  const win = f.feature.openWindow(f.first);
  win.emit("ready-to-show");
  assert.equal(JSON.parse(fs.readFileSync(f.store.configPath(), "utf8")).activeSessionId, f.first);
  assert.deepEqual(f.sent.at(-1), { channel: "chat:open-session", data: { sessionId: f.first } });
  win.minimized = true;
  assert.equal(f.feature.openWindow(f.second), win);
  assert.equal(win.minimized, false); assert.equal(win.focused, true);
  assert.deepEqual(f.sent.at(-1), { channel: "chat:open-session", data: { sessionId: f.second } });
  assert.equal(JSON.parse(fs.readFileSync(f.store.configPath(), "utf8")).activeSessionId, f.second);
  const count = f.sent.length;
  assert.equal(f.feature.openWindow("../../not-a-room"), null);
  assert.equal(f.sent.length, count);
});

test("legacy native thread ownership is restored from disk and excludes unrelated providers", t => {
  const f = fixture(t), codexId = "11111111-2222-4333-8444-555555555555", claudeId = "22222222-2222-4333-8444-555555555555";
  f.store.appendEvent(f.first, { kind: "cli-session", providerId: "codex", cliSessionId: codexId });
  f.store.appendEvent(f.second, { kind: "cli-session", providerId: "claude", cliSessionId: claudeId });
  assert.equal(f.feature.findCodexSession(codexId), f.first);
  assert.equal(f.feature.findCodexSession(claudeId), null);
  assert.equal(f.feature.findCodexSession("malformed"), null);
});

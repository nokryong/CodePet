const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ChatStore } = require("../src/chat/chat-store");
const { createChatFeature } = require("../src/chat/chat-ipc");

test("chat:send는 replyTo를 메인 프로세스 정제 후 저장소까지 전달한다", async (t) => {
  const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-reply-ipc-"));
  t.after(() => fs.rmSync(storeRoot, { recursive: true, force: true }));

  const store = new ChatStore({ root: storeRoot }).init();
  const sessionId = store.createSession({}).id;
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

  const send = handlers.get("chat:send");
  assert.equal(typeof send, "function");
  const result = await send({}, {
    sessionId,
    text: "IPC 인용 답장",
    attachmentIds: [],
    replyTo: {
      messageId: "m-source",
      author: "codex",
      authorType: "agent",
      excerpt: "원문 발췌",
      injected: true,
    },
  });

  assert.equal(result.ok, true);
  const [message] = new ChatStore({ root: storeRoot }).init().readMessages(sessionId);
  assert.equal(message.text, "IPC 인용 답장");
  assert.deepEqual(message.replyTo, {
    messageId: "m-source",
    author: "codex",
    authorType: "agent",
    excerpt: "원문 발췌",
  });
});

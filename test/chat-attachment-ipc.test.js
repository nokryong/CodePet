const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ChatStore } = require("../src/chat/chat-store");
const { createChatFeature } = require("../src/chat/chat-ipc");

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

function createDroppedAttachmentHarness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-drop-ipc-"));
  const storeRoot = path.join(root, "store");
  const sourceDir = path.join(root, "source");
  fs.mkdirSync(sourceDir, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const store = new ChatStore({ root: storeRoot }).init();
  const sessionId = store.createSession({}).id;
  const handlers = new Map();
  const ipcMain = {
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
    on() {},
  };
  const feature = createChatFeature({
    storeRoot,
    electron: {
      ipcMain,
      dialog: {},
      BrowserWindow: class {},
      shell: {},
    },
  });
  feature.registerIpcHandlers();

  const handler = handlers.get("chat:attachments:add-dropped");
  assert.equal(typeof handler, "function");
  return {
    sourceDir,
    sessionId,
    invoke(paths) {
      return handler({}, { sessionId, paths });
    },
  };
}

function writeSource(sourceDir, name, data) {
  const filePath = path.join(sourceDir, name);
  fs.writeFileSync(filePath, data);
  return filePath;
}

test("드롭 IPC는 정상 경로 여러 개를 첨부로 등록한다", async (t) => {
  const harness = createDroppedAttachmentHarness(t);
  const note = writeSource(harness.sourceDir, "note.txt", "hello");
  const image = writeSource(harness.sourceDir, "screen.png", PNG_BYTES);

  const result = await harness.invoke([note, image]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.attachments.map((entry) => entry.name), ["note.txt", "screen.png"]);
  assert.equal(result.errors.length, 0);
  assert.equal(result.pendingAttachments.length, 2);
});

test("드롭 IPC는 경로를 최대 10개까지만 처리한다", async (t) => {
  const harness = createDroppedAttachmentHarness(t);
  const paths = Array.from({ length: 12 }, (_, index) =>
    writeSource(harness.sourceDir, `file-${index + 1}.txt`, `content-${index + 1}`)
  );

  const result = await harness.invoke(paths);

  assert.equal(result.ok, true);
  assert.equal(result.attachments.length, 10);
  assert.deepEqual(
    result.attachments.map((entry) => entry.name),
    paths.slice(0, 10).map((filePath) => path.basename(filePath))
  );
  assert.equal(result.pendingAttachments.length, 10);
});

test("드롭 IPC는 문자열이 아닌 항목과 빈 경로를 걸러낸다", async (t) => {
  const harness = createDroppedAttachmentHarness(t);
  const first = writeSource(harness.sourceDir, "first.txt", "first");
  const second = writeSource(harness.sourceDir, "second.txt", "second");

  const result = await harness.invoke([null, first, "", "   ", 42, {}, second]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.attachments.map((entry) => entry.name), ["first.txt", "second.txt"]);
  assert.equal(result.errors.length, 0);
});

test("드롭 IPC는 차단 파일을 errors로 돌리고 나머지는 계속 처리한다", async (t) => {
  const harness = createDroppedAttachmentHarness(t);
  const before = writeSource(harness.sourceDir, "before.txt", "before");
  const blocked = writeSource(harness.sourceDir, "blocked.exe", "MZ fake binary");
  const after = writeSource(harness.sourceDir, "after.txt", "after");

  const result = await harness.invoke([before, blocked, after]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.attachments.map((entry) => entry.name), ["before.txt", "after.txt"]);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].name, "blocked.exe");
  assert.match(result.errors[0].error, /실행 파일/);
  assert.equal(result.pendingAttachments.length, 2);
});

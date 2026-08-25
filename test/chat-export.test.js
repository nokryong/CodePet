const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  formatSessionMarkdown,
  safeExportFileName,
} = require("../src/chat/chat-export");
const { ChatStore } = require("../src/chat/chat-store");
const { createChatFeature } = require("../src/chat/chat-ipc");

function localTime(year, month, day, hours, minutes) {
  return new Date(year, month - 1, day, hours, minutes).getTime();
}

test("빈 세션을 제목과 날짜가 있는 마크다운으로 변환한다", () => {
  const markdown = formatSessionMarkdown({
    title: "빈 세션",
    createdAt: localTime(2026, 8, 8, 9, 5),
  }, []);

  assert.equal(
    markdown,
    "# 빈 세션\n\n_세션 날짜: 2026-08-08 09:05_\n\n_메시지가 없습니다._\n"
  );
});

test("일반 메시지와 인용, 첨부, 시스템 메시지를 보존한다", () => {
  const ts = localTime(2026, 8, 8, 10, 30);
  const markdown = formatSessionMarkdown({ title: "대화", createdAt: ts }, [
    {
      authorType: "user",
      author: "user",
      ts,
      text: "**좋습니다.**",
      replyTo: { authorType: "agent", author: "codex", excerpt: "원문 *발췌*" },
      attachments: [{ name: "화면[1].png", mime: "image/png", size: 128 }],
    },
    { authorType: "system", author: "system", ts, text: "연결이\n복구되었습니다." },
  ]);

  assert.match(markdown, /### 사용자 \(2026-08-08 10:30\)/);
  assert.match(markdown, /> 인용: @codex\n>\n> 원문 \\\*발췌\\\*/);
  assert.match(markdown, /\*\*좋습니다\.\*\*/);
  assert.match(markdown, /\*\*첨부\*\*\n- 화면\\\[1\\\]\.png \(image\/png, 128 bytes\)/);
  assert.match(markdown, /_시스템 \(2026-08-08 10:30\): 연결이 복구되었습니다\._/);
});

test("제목의 마크다운과 파일명 금지 문자를 안전하게 처리한다", () => {
  const title = "# [검토]: A/B*? <초안>.";
  const markdown = formatSessionMarkdown({ title, createdAt: 0 }, []);
  const fileName = safeExportFileName(title);

  assert.match(markdown, /^# \\# \\\[검토\\\]: A\/B\\\*\? \\<초안\\>\./);
  assert.equal(path.extname(fileName), ".md");
  assert.doesNotMatch(path.basename(fileName, ".md"), /[<>:"/\\|?*]|[. ]$/u);
  assert.equal(safeExportFileName("CON"), "_CON.md");
});

test("내보내기 IPC가 저장 위치를 묻고 최신 세션 내용을 UTF-8로 쓴다", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-export-ipc-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storeRoot = path.join(root, "store");
  const outputPath = path.join(root, "내보낸-대화.md");
  const store = new ChatStore({ root: storeRoot, now: () => localTime(2026, 8, 8, 11, 0) }).init();
  const session = store.createSession({ title: "회의: A/B" });
  store.appendEvent(session.id, {
    kind: "message",
    message: {
      id: "m1",
      ts: localTime(2026, 8, 8, 11, 5),
      authorType: "agent",
      author: "codex",
      text: "완료했습니다.",
    },
  });

  const handlers = new Map();
  let saveOptions = null;
  const feature = createChatFeature({
    storeRoot,
    electron: {
      ipcMain: {
        handle(channel, handler) {
          handlers.set(channel, handler);
        },
        on() {},
      },
      dialog: {
        async showSaveDialog(options) {
          saveOptions = options;
          return { canceled: false, filePath: outputPath };
        },
      },
      BrowserWindow: class {},
      shell: {},
    },
  });
  feature.registerIpcHandlers();

  const result = await handlers.get("chat:session:export")({}, { sessionId: session.id });

  assert.deepEqual(result, { ok: true, canceled: false, fileName: "내보낸-대화.md" });
  assert.equal(saveOptions.defaultPath, "회의- A-B.md");
  assert.deepEqual(saveOptions.filters, [{ name: "Markdown", extensions: ["md"] }]);
  assert.match(fs.readFileSync(outputPath, "utf8"), /### @codex \(2026-08-08 11:05\)\n\n완료했습니다\./);
});

test("내보내기 UI와 preload 호출이 현재 세션에 연결된다", () => {
  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "src", "chat.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "src", "chat.css"), "utf8");
  const preload = fs.readFileSync(path.join(root, "src", "chat-preload.js"), "utf8");
  const renderer = fs.readFileSync(path.join(root, "src", "chat.js"), "utf8");

  assert.match(html, /id="btn-export-session"/);
  assert.match(css, /@media \(max-width: 620px\)[\s\S]*?\.room-bar\s*\{[\s\S]*?flex-direction:\s*column/);
  assert.match(preload, /sessionExport: \(sessionId\) => ipcRenderer\.invoke\(INVOKE\.SESSION_EXPORT, \{ sessionId \}\)/);
  assert.match(renderer, /chatApi\.sessionExport\(sessionId\)/);
});

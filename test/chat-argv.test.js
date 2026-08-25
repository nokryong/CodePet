const test = require("node:test");
const assert = require("node:assert/strict");

const { buildAgentInvocation, assertSafeArgv, INLINE_TEXT_LIMIT } = require("../src/chat/chat-argv");

const CHAT_CWD = "C:\\Users\\u\\.code-pet\\runtime\\chat";
const WORKSPACE = "D:\\work\\my project";
const ATTACH_DIR = "C:\\Users\\u\\.code-pet\\sessions\\s1\\attachments";

function provider(id, overrides = {}) {
  const permissions = {
    claude: {
      chat: { supported: true, enforcement: "tool-policy" },
      "workspace-read": { supported: true, enforcement: "tool-policy" },
      "workspace-write": { supported: true, enforcement: "tool-policy" },
    },
    codex: {
      chat: { supported: true, enforcement: "sandbox" },
      "workspace-read": { supported: true, enforcement: "sandbox" },
      "workspace-write": { supported: true, enforcement: "sandbox" },
    },
    grok: { chat: { supported: true, enforcement: "tool-policy" }, "workspace-read": { supported: false, enforcement: "unavailable" }, "workspace-write": { supported: false, enforcement: "unavailable" } },
    agy: {
      chat: { supported: true, enforcement: "sandbox" },
      "workspace-read": { supported: true, enforcement: "sandbox" },
      "workspace-write": { supported: true, enforcement: "sandbox" },
    },
  }[id];
  return { id, name: id, status: "cli", permissions, ...overrides };
}

function build(id, input = {}) {
  return buildAgentInvocation({
    provider: provider(id),
    chatCwd: CHAT_CWD,
    ...input,
  });
}

test("claude chat 모드: 도구 전면 차단 + strict mcp + stream-json", () => {
  const result = build("claude");
  assert.equal(result.ok, true);
  assert.equal(result.cwd, CHAT_CWD);
  const argv = result.argv;
  const toolsIndex = argv.indexOf("--tools");
  assert.ok(toolsIndex >= 0);
  assert.equal(argv[toolsIndex + 1], "");
  assert.ok(argv.includes("--strict-mcp-config"));
  assert.ok(argv.includes("--no-session-persistence"));
  assert.deepEqual(argv.slice(argv.indexOf("--output-format"), argv.indexOf("--output-format") + 2), [
    "--output-format",
    "stream-json",
  ]);
  assert.equal(result.enforcement, "tool-policy");
});

test("claude workspace-read: 읽기 도구만 + add-dir", () => {
  const result = build("claude", { permissionMode: "workspace-read", workspace: WORKSPACE });
  assert.equal(result.ok, true);
  assert.equal(result.cwd, WORKSPACE);
  const argv = result.argv;
  const toolsIndex = argv.indexOf("--tools");
  assert.equal(argv[toolsIndex + 1], "Read,Grep,Glob");
  assert.ok(!argv.includes("--permission-mode"));
  const addDirIndex = argv.indexOf("--add-dir");
  assert.equal(argv[addDirIndex + 1], WORKSPACE);
});

test("claude workspace-write: acceptEdits까지만", () => {
  const result = build("claude", { permissionMode: "workspace-write", workspace: WORKSPACE });
  assert.equal(result.ok, true);
  const argv = result.argv;
  const modeIndex = argv.indexOf("--permission-mode");
  assert.equal(argv[modeIndex + 1], "acceptEdits");
});

test("claude 모델/노력 플래그", () => {
  const result = build("claude", { model: "fable", effort: "high" });
  const argv = result.argv;
  assert.equal(argv[argv.indexOf("--model") + 1], "fable");
  assert.equal(argv[argv.indexOf("--effort") + 1], "high");
});

test("default 모델/노력은 플래그를 생략한다", () => {
  const result = build("claude", { model: "default", effort: "default" });
  assert.ok(!result.argv.includes("--model"));
  assert.ok(!result.argv.includes("--effort"));
});

test("codex chat 모드: read-only 샌드박스 + 빈 채팅 cwd + json + ephemeral", () => {
  const result = build("codex", { outputFile: "C:\\tmp\\out.txt" });
  assert.equal(result.ok, true);
  assert.equal(result.cwd, CHAT_CWD);
  const argv = result.argv;
  assert.equal(argv[argv.indexOf("--sandbox") + 1], "read-only");
  assert.ok(argv.includes("--json"));
  assert.ok(argv.includes("--ephemeral"));
  assert.equal(argv[argv.indexOf("-o") + 1], "C:\\tmp\\out.txt");
  assert.ok(!argv.includes("--cd"));
  assert.equal(result.enforcement, "sandbox");
});

test("codex workspace-read/write 매핑", () => {
  const read = build("codex", { permissionMode: "workspace-read", workspace: WORKSPACE });
  assert.equal(read.argv[read.argv.indexOf("--sandbox") + 1], "read-only");
  assert.equal(read.argv[read.argv.indexOf("--cd") + 1], WORKSPACE);

  const write = build("codex", { permissionMode: "workspace-write", workspace: WORKSPACE });
  assert.equal(write.argv[write.argv.indexOf("--sandbox") + 1], "workspace-write");
  assert.equal(write.argv[write.argv.indexOf("--cd") + 1], WORKSPACE);
});

test("codex 모델/노력: --model과 config override", () => {
  const result = build("codex", { model: "gpt-5.3-codex", effort: "high" });
  const argv = result.argv;
  assert.equal(argv[argv.indexOf("--model") + 1], "gpt-5.3-codex");
  assert.equal(argv[argv.indexOf("-c") + 1], "model_reasoning_effort=high");
});

test("어떤 조합에서도 위험 플래그는 생성되지 않는다", () => {
  const providers = ["claude", "codex", "agy"];
  const modes = ["chat", "workspace-read", "workspace-write"];
  for (const id of providers) {
    for (const permissionMode of modes) {
      const result = build(id, {
        permissionMode,
        workspace: WORKSPACE,
        model: "x",
        effort: "high",
      });
      assert.equal(result.ok, true);
      for (const arg of result.argv) {
        assert.ok(!/dangerously|bypass|full-access|full-auto/i.test(arg), `${id}/${permissionMode}: ${arg}`);
      }
    }
  }
  const grok = build("grok", { model: "grok-4.5", effort: "high" });
  assert.equal(grok.ok, true);
  assert.ok(!grok.argv.some((arg) => /dangerously|bypass|full-access|full-auto/i.test(arg)));
  assert.throws(() => assertSafeArgv(["--dangerously-bypass-approvals-and-sandbox"]));
});

test("자동 승인은 workspace-write에서만 프로바이더별 명시 플래그를 쓴다", () => {
  const expected = {
    claude: "--dangerously-skip-permissions",
    codex: "--dangerously-bypass-approvals-and-sandbox",
    agy: "--dangerously-skip-permissions",
  };
  for (const id of Object.keys(expected)) {
    const result = build(id, { permissionMode: "workspace-write", workspace: WORKSPACE, autoApprove: true });
    assert.equal(result.ok, true);
    assert.ok(result.argv.includes(expected[id]));
  }
  assert.equal(build("claude", { autoApprove: true }).ok, false);
});

test("모델 문자열 검증: 셸 특수문자는 거부", () => {
  const bad = build("codex", { model: 'x" & del *' });
  assert.equal(bad.ok, false);
  const badEffort = build("claude", { effort: "high; rm -rf" });
  assert.equal(badEffort.ok, false);
});

test("워크스페이스 없이 workspace 모드를 요구하면 실패", () => {
  const result = build("claude", { permissionMode: "workspace-read" });
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("워크스페이스"));
});

test("agy: cli 상태가 아니면 실행 불가", () => {
  const absent = buildAgentInvocation({
    provider: { id: "agy", name: "Antigravity", status: "gui-only", reason: "설치 안내" },
    chatCwd: CHAT_CWD,
  });
  assert.equal(absent.ok, false);
});

test("agy chat 모드: plan + sandbox + 슬래시 명령 차단", () => {
  const result = build("agy", { model: "gemini-3.1-pro-high", effort: "high" });
  assert.equal(result.ok, true);
  assert.equal(result.cwd, CHAT_CWD);
  const argv = result.argv;
  assert.ok(!argv.includes("-p"));
  assert.equal(result.promptTransport, "argv");
  assert.ok(argv.includes("--sandbox"));
  assert.ok(argv.includes("--disable-slash-commands"));
  assert.equal(argv[argv.indexOf("--mode") + 1], "plan");
  assert.equal(argv[argv.indexOf("--model") + 1], "gemini-3.1-pro-high");
  assert.equal(argv[argv.indexOf("--effort") + 1], "high");
  assert.equal(result.enforcement, "sandbox");
});

test("agy workspace 모드 매핑: read는 plan, write는 accept-edits까지만", () => {
  const read = build("agy", { permissionMode: "workspace-read", workspace: WORKSPACE });
  assert.equal(read.ok, true);
  assert.equal(read.cwd, WORKSPACE);
  assert.equal(read.argv[read.argv.indexOf("--mode") + 1], "plan");
  assert.equal(read.argv[read.argv.indexOf("--add-dir") + 1], WORKSPACE);

  const write = build("agy", { permissionMode: "workspace-write", workspace: WORKSPACE });
  assert.equal(write.argv[write.argv.indexOf("--mode") + 1], "accept-edits");
  assert.ok(write.argv.includes("--sandbox"));
  assert.ok(!write.argv.some((arg) => /dangerously/.test(arg)));
});

test("agy 첨부 전달: 이미지는 항상 불가, 파일은 workspace 모드에서만 경로", () => {
  const image = { id: "a1", name: "shot.png", mime: "image/png", size: 100, path: "C:\\p\\a1.png", kind: "image" };
  const doc = { id: "a2", name: "big.bin", mime: "application/octet-stream", size: 500000, path: "C:\\p\\a2.bin", kind: "binary" };

  const chat = build("agy", { attachments: [image, doc] });
  assert.deepEqual(chat.deliveries.map((d) => d.method), ["unsupported", "unsupported"]);

  const ws = build("agy", {
    permissionMode: "workspace-read",
    workspace: WORKSPACE,
    attachmentsDir: ATTACH_DIR,
    attachments: [image, doc],
  });
  assert.deepEqual(ws.deliveries.map((d) => d.method), ["unsupported", "path"]);
  const addDirs = ws.argv
    .map((arg, index) => (arg === "--add-dir" ? ws.argv[index + 1] : null))
    .filter(Boolean);
  assert.ok(addDirs.includes(ATTACH_DIR));
});

test("첨부 전달 방식: codex 이미지 native, claude chat 모드 이미지는 unsupported", () => {
  const image = { id: "a1", name: "shot.png", mime: "image/png", size: 1000, path: "C:\\p\\a1.png", kind: "image" };
  const bigBinary = { id: "a2", name: "data.bin", mime: "application/octet-stream", size: 500000, path: "C:\\p\\a2.bin", kind: "binary" };
  const smallText = { id: "a3", name: "note.txt", mime: "text/plain", size: 100, path: "C:\\p\\a3.txt", kind: "text" };

  const codexResult = build("codex", { attachments: [image, bigBinary, smallText] });
  assert.deepEqual(
    codexResult.deliveries.map((d) => d.method),
    ["native-image", "path", "inline"]
  );
  assert.equal(codexResult.argv[codexResult.argv.indexOf("--image") + 1], "C:\\p\\a1.png");

  const claudeChat = build("claude", { attachments: [image, bigBinary, smallText] });
  assert.deepEqual(
    claudeChat.deliveries.map((d) => d.method),
    ["unsupported", "unsupported", "inline"]
  );

  const claudeRead = build("claude", {
    permissionMode: "workspace-read",
    workspace: WORKSPACE,
    attachmentsDir: ATTACH_DIR,
    attachments: [image, bigBinary],
  });
  assert.deepEqual(
    claudeRead.deliveries.map((d) => d.method),
    ["path", "path"]
  );
  // 경로 전달이 있을 때만 첨부 디렉터리가 add-dir에 포함된다.
  const addDirs = claudeRead.argv
    .map((arg, index) => (arg === "--add-dir" ? claudeRead.argv[index + 1] : null))
    .filter(Boolean);
  assert.ok(addDirs.includes(ATTACH_DIR));
});

test("인라인 한도보다 큰 텍스트는 인라인되지 않는다", () => {
  const bigText = {
    id: "t1",
    name: "big.txt",
    mime: "text/plain",
    size: INLINE_TEXT_LIMIT + 1,
    path: "C:\\p\\t1.txt",
    kind: "text",
  };
  const result = build("claude", { attachments: [bigText] });
  assert.equal(result.deliveries[0].method, "unsupported");
});

test("grok chat uses prompt-file and verified safe policy", () => {
  const result = build("grok", { model: "grok-4.5", effort: "high" });
  assert.equal(result.ok, true);
  assert.equal(result.promptTransport, "file");
  assert.equal(result.promptFileFlag, "--prompt-file");
  assert.equal(result.stdinPrompt, false);
  for (const flag of ["--output-format", "streaming-messages-json", "--include-partial-messages", "--tools", "todo_write", "--disallowed-tools", "search_tool,use_tool", "--disable-web-search", "--no-subagents", "--no-memory", "--permission-mode", "dontAsk", "--sandbox", "read-only", "--verbatim"]) assert.ok(result.argv.includes(flag));
  assert.equal(result.argv[result.argv.indexOf("--model") + 1], "grok-4.5");
  assert.equal(result.argv[result.argv.indexOf("--effort") + 1], "high");
  assert.equal(build("grok", { permissionMode: "workspace-read", workspace: WORKSPACE }).ok, false);

  const smallText = { id: "t", mime: "text/plain", size: 5, kind: "text" };
  const image = { id: "i", mime: "image/png", size: 5, kind: "image" };
  const largeText = { id: "l", mime: "text/plain", size: INLINE_TEXT_LIMIT + 1, kind: "text" };
  assert.deepEqual(
    build("grok", { attachments: [smallText, image, largeText] }).deliveries.map((item) => item.method),
    ["inline", "unsupported", "unsupported"]
  );
});

test("grok workspace-read는 Docker stdin 경로와 읽기 전용 이중 정책만 만든다", () => {
  const grok = provider("grok", {
    permissions: {
      chat: { supported: true, enforcement: "tool-policy" },
      "workspace-read": { supported: true, enforcement: "container" },
      "workspace-write": { supported: false, enforcement: "unavailable" },
    },
  });
  const result = buildAgentInvocation({
    provider: grok,
    permissionMode: "workspace-read",
    workspace: WORKSPACE,
    chatCwd: CHAT_CWD,
    model: "grok-4.5",
    effort: "high",
  });
  assert.equal(result.ok, true);
  assert.equal(result.promptTransport, "stdin");
  assert.equal(result.promptFileFlag, null);
  assert.equal(result.enforcement, "container");
  assert.equal(result.argv[result.argv.indexOf("--cwd") + 1], "/workspace");
  assert.equal(result.argv[result.argv.indexOf("--sandbox") + 1], "read-only");
  for (const rule of ["Read", "Grep", "Edit", "Bash", "WebFetch", "WebSearch"]) {
    assert.ok(result.argv.includes(rule), rule);
  }
  assert.equal(buildAgentInvocation({
    provider: grok,
    permissionMode: "workspace-write",
    workspace: WORKSPACE,
    chatCwd: CHAT_CWD,
  }).ok, false);
});

test("grok workspace-write는 전용 편집 도구만 열고 Bash와 인증 경로를 차단한다", () => {
  const grok = provider("grok", {
    permissions: {
      chat: { supported: true, enforcement: "tool-policy" },
      "workspace-read": { supported: true, enforcement: "container" },
      "workspace-write": { supported: true, enforcement: "container-copy-approval" },
    },
  });
  const result = buildAgentInvocation({
    provider: grok,
    permissionMode: "workspace-write",
    workspace: WORKSPACE,
    chatCwd: CHAT_CWD,
  });
  assert.equal(result.ok, true);
  assert.equal(result.promptTransport, "stdin");
  assert.equal(result.enforcement, "container-copy-approval");
  assert.equal(result.argv[result.argv.indexOf("--cwd") + 1], "/workspace");
  assert.equal(result.argv[result.argv.indexOf("--sandbox") + 1], "workspace");
  assert.match(result.argv[result.argv.indexOf("--tools") + 1], /write_file/);
  assert.doesNotMatch(result.argv[result.argv.indexOf("--tools") + 1], /bash/i);
  for (const denied of ["Bash", "Read(/home/node/.grok/**)", "Grep(/home/node/.grok/**)", "Edit(/home/node/.grok/**)"]) {
    assert.ok(result.argv.includes(denied), denied);
  }
});

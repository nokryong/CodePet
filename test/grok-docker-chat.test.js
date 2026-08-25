const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveAgentExecution } = require("../src/chat/chat-ipc");

const record = {
  commandPath: "C:\\Users\\u\\.grok\\bin\\grok.exe",
  needsShell: false,
};

test("Grok chat은 네이티브 실행과 prompt-file 전달을 그대로 유지한다", () => {
  const invocation = {
    argv: ["--output-format", "streaming-messages-json"],
    cwd: "C:\\chat",
    promptTransport: "file",
    promptFileFlag: "--prompt-file",
  };
  const execution = resolveAgentExecution({
    agentId: "grok",
    permissionMode: "chat",
    invocation,
    record,
  });
  assert.equal(execution.commandPath, record.commandPath);
  assert.equal(execution.promptTransport, "file");
  assert.equal(execution.promptFileFlag, "--prompt-file");
});

test("Grok workspace-read는 Docker 읽기 실행기로 교체한다", () => {
  const calls = [];
  const grokDockerRuntime = {
    buildReadExecution(input) {
      calls.push(input);
      return { commandPath: "docker.exe", argv: ["run"], promptTransport: "stdin" };
    },
  };
  const execution = resolveAgentExecution({
    agentId: "grok",
    permissionMode: "workspace-read",
    invocation: { argv: ["--allow", "Read"] },
    record,
    workspace: "D:\\repo",
    chatCwd: "C:\\chat",
    runId: "r1",
    grokDockerRuntime,
  });
  assert.equal(execution.commandPath, "docker.exe");
  assert.equal(execution.promptTransport, "stdin");
  assert.deepEqual(calls, [{ workspace: "D:\\repo", grokArgv: ["--allow", "Read"], runId: "r1", cwd: "C:\\chat" }]);
});

test("Grok workspace-write는 Docker 복제본 실행기로 교체한다", () => {
  const calls = [];
  const grokDockerRuntime = {
    buildWriteExecution(input) {
      calls.push(input);
      return {
        commandPath: "docker.exe",
        argv: ["run", "--volume", "D:\\repo:/workspace-src:ro"],
        promptTransport: "stdin",
        maxOutputBytes: 4 * 1024 * 1024,
      };
    },
  };
  const execution = resolveAgentExecution({
    agentId: "grok",
    permissionMode: "workspace-write",
    invocation: { argv: ["--allow", "Edit"] },
    record,
    workspace: "D:\\repo",
    chatCwd: "C:\\chat",
    runId: "r2",
    grokDockerRuntime,
  });
  assert.equal(execution.commandPath, "docker.exe");
  assert.equal(execution.promptTransport, "stdin");
  assert.equal(execution.maxOutputBytes, 4 * 1024 * 1024);
  assert.deepEqual(calls, [{
    workspace: "D:\\repo",
    grokArgv: ["--allow", "Edit"],
    runId: "r2",
    cwd: "C:\\chat",
  }]);
});

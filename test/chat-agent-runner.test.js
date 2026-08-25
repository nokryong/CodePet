const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  runAgentProcess,
  quoteArgForShell,
  compactArgvPrompt,
  DEFAULT_TIMEOUT_MS,
  MAX_ARGV_PROMPT_CHARS,
  createPromptFile,
} = require("../src/chat/chat-agent-runner");

const NODE = process.execPath;

function runNode(script, options = {}) {
  return runAgentProcess({
    commandPath: NODE,
    argv: ["-e", script],
    prompt: options.prompt || "",
    cwd: os.tmpdir(),
    timeoutMs: options.timeoutMs || 10000,
    ...options,
  });
}

test("stdin 프롬프트를 받아 stdout을 최종 답변으로 사용한다", async () => {
  const run = runNode(
    "let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{process.stdout.write('echo:'+input.trim())})",
    { prompt: "hello" }
  );
  const result = await run.promise;
  assert.equal(result.ok, true);
  assert.equal(result.text, "echo:hello");
});

test("UTF-8 한글 바이트가 청크 경계에서 갈려도 깨지지 않는다", async () => {
  const script = "const b=Buffer.from('한글 응답');process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.write(b.subarray(1)),20)";
  const result = await runNode(script).promise;
  assert.equal(result.ok, true);
  assert.equal(result.text, "한글 응답");
});

test("outputFile이 있으면 stdout보다 우선한다", async () => {
  const outputFile = path.join(os.tmpdir(), `codepet-runner-test-${Date.now()}.txt`);
  const script = `require('fs').writeFileSync(${JSON.stringify(outputFile)}, '파일 답변');process.stdout.write('무시될 stdout')`;
  const run = runNode(script, { outputFile });
  const result = await run.promise;
  assert.equal(result.ok, true);
  assert.equal(result.text, "파일 답변");
  // 임시 파일은 정리된다.
  assert.equal(fs.existsSync(outputFile), false);
});

test("parseLine이 delta/status/final 이벤트를 발생시키고 final을 답변으로 쓴다", async () => {
  const events = [];
  const script = [
    "console.log(JSON.stringify({kind:'status',label:'생각 중'}))",
    "console.log(JSON.stringify({kind:'delta',text:'부분'}))",
    "console.log(JSON.stringify({kind:'final',text:'파서 최종'}))",
  ].join(";");
  const run = runNode(script, {
    parseLine: (line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    },
    onEvent: (event) => events.push(event),
  });
  const result = await run.promise;
  assert.equal(result.ok, true);
  assert.equal(result.text, "파서 최종");
  assert.deepEqual(events.map((event) => event.kind), ["status", "delta", "final"]);
});

test("변경 manifest 이벤트는 renderer로 보내지 않고 성공 결과의 내부 필드로만 보존한다", async () => {
  const events = [];
  const manifest = { version: 1, changes: [], diff: "" };
  const script = [
    "console.log(JSON.stringify({kind:'final',text:'완료'}))",
    `console.log(${JSON.stringify(JSON.stringify({ kind: "workspace-change-manifest", manifest }))})`,
  ].join(";");
  const result = await runNode(script, {
    parseLine: (line) => JSON.parse(line),
    onEvent: (event) => events.push(event),
  }).promise;
  assert.equal(result.ok, true);
  assert.equal(result.text, "완료");
  assert.deepEqual(result.workspaceChangeManifest, manifest);
  assert.deepEqual(events.map((event) => event.kind), ["final"]);
});

test("여러 구조화 오류가 오면 마지막 종료 원인을 반환한다", async () => {
  const script = [
    "console.log(JSON.stringify({kind:'error',message:'재연결 중'}))",
    "console.log(JSON.stringify({kind:'error',message:'프록시 연결 거부'}))",
  ].join(";");
  const result = await runNode(script, {
    parseLine: (line) => JSON.parse(line),
  }).promise;
  assert.equal(result.ok, false);
  assert.equal(result.error, "프록시 연결 거부");
});

test("출력 상한을 넘으면 프로세스를 종료하고 오류를 반환한다", async () => {
  const run = runNode("setInterval(()=>process.stdout.write('x'.repeat(65536)),1)", {
    maxOutputBytes: 300000,
    timeoutMs: 15000,
  });
  const result = await run.promise;
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("출력이 너무 길어"));
});

test("cancel은 cancelled 플래그로 끝난다", async () => {
  const run = runNode("setTimeout(()=>{}, 60000)");
  setTimeout(() => run.cancel(), 150);
  const result = await run.promise;
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
});

test("실제 에이전트 실행은 기본 시간제한이 없다", async () => {
  assert.equal(DEFAULT_TIMEOUT_MS, null);
  const run = runAgentProcess({
    commandPath: NODE,
    argv: ["-e", "setTimeout(()=>process.stdout.write('완료'),50)"],
    prompt: "",
    cwd: os.tmpdir(),
  });
  const result = await run.promise;
  assert.equal(result.ok, true);
  assert.equal(result.text, "완료");
});

test("명시적으로 제한을 요청한 테스트 실행에서만 타임아웃이 동작한다", async () => {
  const run = runNode("setTimeout(()=>{}, 60000)", { timeoutMs: 300 });
  const result = await run.promise;
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("시간 초과"));
});

test("실패 종료 시 stderr 마지막 줄이 오류가 된다", async () => {
  const run = runNode("console.error('원인: 인증 필요');process.exit(3)");
  const result = await run.promise;
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("인증 필요"));
});

test("셸 인용: 공백/빈 문자열 인자", () => {
  assert.equal(quoteArgForShell(""), '""');
  assert.equal(quoteArgForShell("with space"), '"with space"');
  assert.equal(quoteArgForShell("plain"), "plain");
  assert.equal(quoteArgForShell('has"quote'), '"hasquote"');
});

test("argv 프롬프트는 옵션 뒤 --print 인자로 전달되고 stdin에는 쓰이지 않는다", async () => {
  const script = "process.stdout.write(JSON.stringify({argv:process.argv.slice(1)}));";
  const run = runNode(script, {
    argv: ["-e", script, "--"],
    prompt: "AGY prompt",
    promptTransport: "argv",
  });
  const result = await run.promise;
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(result.text).argv, ["--print", "AGY prompt"]);
});

test("긴 argv 프롬프트는 지침 앞부분과 최신 대화를 남기며 Windows 한도 아래로 줄인다", () => {
  const prompt = `RULES:${"a".repeat(10000)}LATEST:${"z".repeat(30000)}`;
  const compacted = compactArgvPrompt(prompt);
  assert.equal(compacted.length, MAX_ARGV_PROMPT_CHARS);
  assert.ok(compacted.startsWith("RULES:"));
  assert.ok(compacted.endsWith("z".repeat(100)));
  assert.ok(compacted.includes("이전 대화 일부 생략"));
});

test("성공한 실행은 stderr에 권한 문구가 있어도 성공으로 남는다", async () => {
  const script =
    "process.stderr.write('ERROR tools: Exit code 1 Output: 권한 요청을 거부했습니다. 승인이 필요합니다.');process.stdout.write('정상 답변')";
  const result = await runNode(script).promise;
  assert.equal(result.ok, true);
  assert.equal(result.text, "정상 답변");
  assert.equal(result.approvalRequired, undefined);
});

test("cancel과 timeout은 외부 컨테이너 정리 훅을 한 번만 호출한다", async () => {
  let cancelCalls = 0;
  const cancelled = runNode("setTimeout(()=>{}, 60000)", {
    onCancel: () => {
      cancelCalls += 1;
    },
  });
  cancelled.cancel();
  await cancelled.promise;
  cancelled.cancel();
  assert.equal(cancelCalls, 1);

  let timeoutCalls = 0;
  const timedOut = runNode("setTimeout(()=>{}, 60000)", {
    timeoutMs: 40,
    onCancel: () => {
      timeoutCalls += 1;
    },
  });
  await timedOut.promise;
  assert.equal(timeoutCalls, 1);
});

test("일반 permission denied 실패는 승인 요청이 아닌 실행 오류로 남는다", async () => {
  const script =
    "process.stderr.write('EACCES: permission denied, open /ws/file.txt');process.exit(1)";
  const result = await runNode(script).promise;
  assert.equal(result.ok, false);
  assert.equal(result.approvalRequired, undefined);
  assert.match(result.error, /permission denied/);
  assert.equal(result.diagnostics.exitCode, 1);
});

test("실패한 실행의 명시적 승인 요청 문구는 원문과 함께 승인 요청으로 승격된다", async () => {
  const script = "process.stderr.write('approval required: run_command');process.exit(1)";
  const result = await runNode(script, { provider: "codex", runId: "r-1" }).promise;
  assert.equal(result.ok, false);
  assert.equal(result.approvalRequired, true);
  assert.match(result.approval.detail, /종료 코드 1/);
  assert.match(result.approval.detail, /approval required/);
  assert.equal(result.diagnostics.provider, "codex");
  assert.equal(result.diagnostics.runId, "r-1");
});

test("샌드박스 차단 실패는 샌드박스 안내와 함께 승인 요청이 된다", async () => {
  const script =
    "process.stderr.write('exec error: windows sandbox: CreateProcessWithLogonW failed: 2');process.exit(1)";
  const result = await runNode(script).promise;
  assert.equal(result.ok, false);
  assert.equal(result.approvalRequired, true);
  assert.match(result.approval.summary, /샌드박스/);
});

test("실패 진단은 민감정보를 제거하고 provider와 종료 코드를 보존한다", async () => {
  const script =
    "process.stderr.write('OPENAI_API_KEY=sk-live-1234 인증 실패');process.exit(3)";
  const result = await runNode(script, { provider: "claude", runId: "r-9" }).promise;
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.provider, "claude");
  assert.equal(result.diagnostics.runId, "r-9");
  assert.equal(result.diagnostics.exitCode, 3);
  assert.match(result.diagnostics.stderrTail, /\[REDACTED\]/);
  assert.doesNotMatch(result.diagnostics.stderrTail, /sk-live-1234/);
  assert.doesNotMatch(result.error, /sk-live-1234/);
});

test("file prompt transport does not expose prompt in argv and cleans prompt file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-prompt-"));
  const script = "const fs=require('fs');const i=process.argv.indexOf('--prompt-file');const p=process.argv[i+1];let stdin='';process.stdin.on('data',d=>stdin+=d);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({text:fs.readFileSync(p,'utf8'),stdin,argv:process.argv.slice(1)})));";
  const run = runNode(script, {
    argv: ["-e", script, "--"],
    prompt: "hidden prompt",
    promptTransport: "file",
    promptFileDirectory: dir,
  });
  const result = await run.promise;
  assert.equal(result.ok, true);
  const observed = JSON.parse(result.text);
  assert.equal(observed.text, "hidden prompt");
  assert.equal(observed.stdin, "");
  assert.ok(!observed.argv.includes("hidden prompt"));
  assert.deepEqual(fs.readdirSync(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("file prompt transport cleans its temp file after process failure", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-prompt-fail-"));
  const marker = path.join(dir, "seen-path.txt");
  const script = `const fs=require('fs');const i=process.argv.indexOf('--prompt-file');fs.writeFileSync(${JSON.stringify(marker)},process.argv[i+1]);process.stderr.write('failed');process.exit(3)`;
  const result = await runNode(script, {
    argv: ["-e", script, "--"],
    prompt: "private",
    promptTransport: "file",
    promptFileDirectory: dir,
  }).promise;
  assert.equal(result.ok, false);
  const promptPath = fs.readFileSync(marker, "utf8");
  assert.equal(fs.existsSync(promptPath), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("file prompt transport cleans its temp file after cancellation", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-prompt-cancel-"));
  const marker = path.join(dir, "seen-path.txt");
  const script = `const fs=require('fs');const i=process.argv.indexOf('--prompt-file');fs.writeFileSync(${JSON.stringify(marker)},process.argv[i+1]);setInterval(()=>{},1000)`;
  const run = runNode(script, {
    argv: ["-e", script, "--"],
    prompt: "private",
    promptTransport: "file",
    promptFileDirectory: dir,
  });
  for (let attempt = 0; attempt < 100 && !fs.existsSync(marker); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(fs.existsSync(marker), true);
  run.cancel();
  const result = await run.promise;
  assert.equal(result.cancelled, true);
  const promptPath = fs.readFileSync(marker, "utf8");
  assert.equal(fs.existsSync(promptPath), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

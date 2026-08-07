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

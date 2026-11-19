const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PetCoordinator } = require("../src/chat/pet-coordinator");

const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-coordinator-"));
  const stateFile = path.join(directory, "pet-state.json");
  const messages = [];
  const runs = [];
  let time = Date.UTC(2026, 10, 19);
  let coordinator;
  const open = () => {
    coordinator = new PetCoordinator({
      stateFile,
      readMessages: () => [...messages],
      publish: (message) => messages.push(message),
      getScope: () => ({ workspace: null, permissionMode: "chat" }),
      runAgent(input) {
        let finish;
        const promise = new Promise((resolve) => { finish = resolve; });
        runs.push({ ...input, finish });
        return { promise, cancel: () => finish({ cancelled: true }) };
      },
      onError: (error) => assert.fail(error),
      now: () => time,
    });
    coordinator.wake();
    return coordinator;
  };
  t.after(() => {
    coordinator.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  open();
  return {
    stateFile,
    messages,
    runs,
    open,
    get coordinator() { return coordinator; },
    moveTime: (ms) => { time += ms; },
    send(text) {
      messages.push({ id: "user-" + messages.length, authorType: "user", text });
      coordinator.wake();
    },
  };
}

function decide(run, patch) {
  assert.ok(run.planning);
  run.finish({
    ok: true,
    text: JSON.stringify({ message: "", needsReply: false, checkAfterSeconds: 0, tasks: [], cancelTaskIds: [], ...patch }),
  });
}

test("CodePet manages distinct child sessions and publishes only its own report", async (t) => {
  const f = fixture(t);
  f.send("테스트와 문서를 확인해줘");
  await tick();
  decide(f.runs[0], {
    tasks: [
      { taskId: "", instruction: "Run the tests" },
      { taskId: "", instruction: "Check the docs" },
    ],
  });
  await tick();
  assert.match(f.runs[1].prompt, /Run the tests/);
  const testId = f.runs[1].taskId;
  f.runs[1].finish({ ok: false, error: "Raw test failure" });
  await tick();
  assert.match(f.runs[2].prompt, /Raw test failure/);
  decide(f.runs[2], { tasks: [{ taskId: testId, instruction: "Correct the failure and rerun" }] });
  await tick();
  assert.equal(f.runs[3].taskId, testId);
  f.runs[3].finish({ ok: true, text: "Raw test output" });
  await tick();
  decide(f.runs[4], {});
  await tick();
  assert.match(f.runs[5].prompt, /Check the docs/);
  assert.notEqual(f.runs[5].taskId, testId);
  f.runs[5].finish({ ok: true, text: "Raw docs output" });
  await tick();
  assert.equal(f.messages.length, 1);
  decide(f.runs[6], { message: "실패한 테스트를 수정했고, 테스트와 문서 확인을 마쳤어요." });
  await tick();
  assert.deepEqual(f.messages.map(({ authorType, text }) => [authorType, text]), [
    ["user", "테스트와 문서를 확인해줘"],
    ["agent", "실패한 테스트를 수정했고, 테스트와 문서 확인을 마쳤어요."],
  ]);
  assert.equal(f.coordinator.hasWork(), false);
});

test("a question goes to the pet chat and queued work waits for the reply", async (t) => {
  const f = fixture(t);
  f.send("선택이 필요하면 물어봐");
  await tick();
  decide(f.runs[0], {
    message: "어느 기준으로 확인할까요?",
    needsReply: true,
    checkAfterSeconds: 5,
    tasks: [{ taskId: "", instruction: "Check after receiving the decision" }],
  });
  await tick();
  assert.equal(f.messages.at(-1).text, "어느 기준으로 확인할까요?");
  f.moveTime(10_000);
  f.coordinator.wake();
  await tick();
  assert.equal(f.runs.length, 1);
  f.send("윈도우 기준으로 확인해줘");
  await tick();
  assert.match(f.runs[1].prompt, /윈도우 기준/);
  decide(f.runs[1], {});
  await tick();
  assert.ok(f.runs[2].taskId);
});

test("a due follow-up survives restart and a saved report is delivered at most once", async (t) => {
  const f = fixture(t);
  f.send("나중에 다시 확인해줘");
  await tick();
  decide(f.runs[0], { checkAfterSeconds: 60 });
  await tick();
  f.coordinator.close();
  f.moveTime(61_000);
  f.open();
  await tick();
  assert.match(f.runs[1].prompt, /"timerFired":true/);
  decide(f.runs[1], { message: "다시 확인했어요." });
  await tick();
  assert.equal(f.messages.length, 2);
  f.coordinator.close();

  // Simulate exit immediately after appending the chat report.
  const persisted = JSON.parse(fs.readFileSync(f.stateFile, "utf8"));
  persisted.report = f.messages.at(-1);
  fs.writeFileSync(f.stateFile, JSON.stringify(persisted));
  f.open();
  await tick();
  assert.equal(f.messages.length, 2);
  assert.equal(f.runs.length, 2);
  assert.equal(JSON.parse(fs.readFileSync(f.stateFile, "utf8")).report, null);
});

test("restart reports interrupted work to the coordinator before resuming anything", async (t) => {
  const f = fixture(t);
  f.send("실행해줘");
  await tick();
  decide(f.runs[0], { tasks: [{ taskId: "", instruction: "Run a command" }] });
  await tick();
  const workerId = f.runs[1].taskId;
  f.coordinator.close();
  f.open();
  await tick();
  assert.equal(f.runs.length, 3);
  assert.ok(f.runs[2].planning);
  assert.ok(f.runs[2].prompt.includes(workerId));
  assert.match(f.runs[2].prompt, /작업이 중단됐습니다/);
  decide(f.runs[2], { message: "이전 실행이 중단됐어요." });
  await tick();
  assert.equal(f.messages.at(-1).text, "이전 실행이 중단됐어요.");
});

test("stopping cancels work and timers without resurrecting them after restart", async (t) => {
  const f = fixture(t);
  f.send("작업해줘");
  await tick();
  decide(f.runs[0], {
    checkAfterSeconds: 30,
    tasks: [{ taskId: "", instruction: "Run the task" }],
  });
  await tick();
  assert.ok(f.runs[1].taskId);
  f.coordinator.stop();
  f.runs[1].finish({ ok: true, text: "Ignored result" });
  await tick();
  f.coordinator.close();
  f.moveTime(31_000);
  f.open();
  await tick();
  assert.equal(f.runs.length, 2);
  assert.equal(f.messages.length, 1);
  assert.equal(f.coordinator.hasWork(), false);
});

test("a new chat message can cancel a running child and queued work", async (t) => {
  const f = fixture(t);
  f.send("두 가지를 처리해줘");
  await tick();
  decide(f.runs[0], { tasks: [
    { taskId: "", instruction: "Run the first task" },
    { taskId: "", instruction: "Run the second task" },
  ] });
  await tick();
  assert.ok(f.runs[1].taskId);
  f.send("둘 다 멈춰줘");
  await tick();
  const state = JSON.parse(fs.readFileSync(f.stateFile, "utf8"));
  decide(f.runs[2], {
    cancelTaskIds: state.tasks.map((task) => task.id),
    message: "맡긴 작업을 중지했어요.",
  });
  await tick();
  assert.equal(f.messages.at(-1).text, "맡긴 작업을 중지했어요.");
  assert.equal(f.runs.length, 3);
  assert.equal(f.coordinator.hasWork(), false);
});

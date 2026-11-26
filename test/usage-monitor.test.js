const test = require("node:test");
const assert = require("node:assert/strict");
const { UsageMonitor, clampWindow, avoidWindows } = require("../src/usage-monitor");

const result = (key = "a", error = null) => ({ accounts: [{ key, active: true, email: "test@example.com" }],
  usage: { gauges: error ? [] : [{ label: "5시간", usedPercent: 25 }], error } });

test("usage refreshes providers independently and coalesces/rate-limits requests", async () => {
  let finish; let calls = 0; let now = 100000;
  const monitor = new UsageMonitor([
    { id: "a", label: "A", load: async () => { calls++; return result(); } },
    { id: "b", label: "B", load: () => new Promise((resolve) => { finish = resolve; }) },
  ], { now: () => now });
  const refresh = monitor.refresh();
  await new Promise(setImmediate);
  assert.equal(monitor.snapshot().providers[0].gauges[0].usedPercent, 25);
  assert.equal(monitor.snapshot().providers[1].loading, true);
  const duplicate = monitor.refresh(true); finish(result()); await Promise.all([refresh, duplicate]);
  assert.equal(calls, 1);
  now += 15001;
  const next = monitor.refresh(true); await new Promise(setImmediate); finish(result()); await next;
  assert.equal(calls, 2);
});

test("failed refresh preserves stale readings only for the same signed-in account", async () => {
  let now = 100000; let value = result();
  const monitor = new UsageMonitor([{ id: "a", label: "A", load: async () => value }], { now: () => now });
  await monitor.refresh(); now += 300001; value = result("a", "조회 불가"); await monitor.refresh();
  assert.equal(monitor.snapshot().providers[0].stale, true);
  assert.equal(monitor.snapshot().providers[0].updatedAt, 100000);
  now += 300001; value = result("b", "조회 불가"); await monitor.refresh();
  assert.deepEqual(monitor.snapshot().providers[0].gauges, []);
  now += 300001; value = result("b", "로그인 필요"); await monitor.refresh();
  assert.equal(monitor.snapshot().providers[0].connected, false);
});

test("AGY 인증이 끊기면 이전 한도 대신 조회 실패 상태를 게시한다", async () => {
  let response = result();
  let now = 0;
  const monitor = new UsageMonitor([{ id: "agy", label: "AGY", load: async () => response }], { now: () => now });
  await monitor.refresh();
  now += monitor.intervalMs;
  response = result("a", "조회 실패");
  response.usage.authRequired = true;
  await monitor.refresh();
  const [row] = monitor.snapshot().providers;
  assert.equal(row.error, "조회 실패");
  assert.equal(row.connected, false);
  assert.deepEqual(row.gauges, []);
});

test("account invalidation suppresses a late response from the previous account", async () => {
  let finish; let calls = 0;
  const monitor = new UsageMonitor([{ id: "a", label: "A", load: () => ++calls === 1
    ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(result("new")) }]);
  const first = monitor.refresh(); await new Promise(setImmediate);
  await monitor.invalidate(); finish(result("old")); await first;
  assert.equal(monitor.snapshot().providers[0].accountKey, "new");
});

test("missing and invalid limits never become 0 or 100 percent", async () => {
  const monitor = new UsageMonitor([{ id: "a", label: "A", load: async () => ({ accounts: result().accounts,
    usage: { gauges: [{ usedPercent: null }, { usedPercent: NaN }, { usedPercent: "" }] } }) }]);
  await monitor.refresh();
  assert.deepEqual(monitor.snapshot().providers[0].gauges, []);
  assert.equal(monitor.snapshot().providers[0].error, "한도 정보 없음");
});

test("usage windows stay inside small or negative-coordinate displays", () => {
  assert.deepEqual(clampWindow({ x: 5000, y: -200, width: 380, height: 560 }, { x:-800,y:0,width:800,height:600 }),
    { x:-380,y:0,width:380,height:560 });
  assert.deepEqual(clampWindow({ x:0,y:0,width:380,height:560 }, { x:0,y:0,width:300,height:400 }),
    { x:0,y:0,width:300,height:400 });
});

test("usage bar and popup avoid the pet and speech bubble when space is available", () => {
  const bounds = { x: 1520, y: 510, width: 380, height: 560 };
  const obstacles = [{ x: 1770, y: 950, width: 130, height: 130 }, { x: 1500, y: 830, width: 390, height: 120 }];
  const result = avoidWindows(bounds, obstacles, { x: 0, y: 0, width: 1920, height: 1080 });
  assert.equal(result.x + result.width <= 1500, true);
  assert.equal(result.y, 510);
});

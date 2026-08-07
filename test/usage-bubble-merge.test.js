const test = require("node:test");
const assert = require("node:assert/strict");
const { mergeUsageBubbleData, toResetSeconds } = require("../src/usage-bubble-merge");

const codexData = {
  kind: "usage",
  title: "Codex 사용량",
  gauges: [{ label: "5시간 한도", usedPercent: 40, resetText: "7/3 14:22 (3시간 후 초기화)" }],
  footer: "plus · 14:00 기준 · codex@example.com",
  actions: [],
};

const formatReset = (seconds) =>
  Number.isFinite(seconds) ? `reset:${Math.round(seconds)}` : "초기화 정보 없음";

test("ISO 문자열과 unix 초/밀리초를 모두 초 단위로 바꾼다", () => {
  assert.equal(toResetSeconds("1970-01-01T00:01:00.000Z"), 60);
  assert.equal(toResetSeconds(1750000000), 1750000000);
  assert.equal(toResetSeconds(1750000000000), 1750000000);
  assert.equal(toResetSeconds(""), null);
  assert.equal(toResetSeconds("올해 안"), null);
});

test("Codex와 Claude 게이지를 한 말풍선에 provider 이름을 붙여 담는다", () => {
  const data = mergeUsageBubbleData({
    codex: codexData,
    claude: [
      { label: "5시간", usedPercent: 12, resetText: "1970-01-01T00:01:00.000Z" },
      { label: "7일 · Opus", usedPercent: 90, resetText: "" },
    ],
    claudeAccount: { label: "claude@example.com", plan: "max" },
    formatReset,
  });

  assert.equal(data.kind, "usage");
  assert.equal(data.title, "사용량");
  assert.deepEqual(data.gauges.map((gauge) => gauge.label), [
    "Codex · 5시간 한도",
    "Claude · 5시간",
    "Claude · 7일 · Opus",
  ]);
  assert.deepEqual(data.gauges.map((gauge) => gauge.usedPercent), [40, 12, 90]);
  assert.equal(data.gauges[1].resetText, "reset:60");
  assert.equal(data.gauges[2].resetText, "초기화 정보 없음");
  assert.equal(
    data.footer,
    "Codex plus · 14:00 기준 · codex@example.com / Claude max · claude@example.com"
  );
});

test("Claude 조회가 실패해도 Codex 게이지는 그대로 남고 실패는 footer에 적는다", () => {
  const data = mergeUsageBubbleData({
    codex: codexData,
    claude: null,
    claudeError: "Claude 로그인 정보가 없습니다.",
    formatReset,
  });

  assert.deepEqual(data.gauges.map((gauge) => gauge.label), ["Codex · 5시간 한도"]);
  assert.match(data.footer, /Claude Claude 로그인 정보가 없습니다\./);
});

test("Codex 조회가 실패해도 Claude 게이지는 그대로 남는다", () => {
  const data = mergeUsageBubbleData({
    codex: null,
    codexError: "사용량 서버가 HTTP 401를 반환했습니다.",
    claude: [{ label: "5시간", usedPercent: 5, resetText: "1970-01-01T00:01:00.000Z" }],
    formatReset,
  });

  assert.deepEqual(data.gauges.map((gauge) => gauge.label), ["Claude · 5시간"]);
  assert.match(data.footer, /^Codex 사용량 서버가 HTTP 401를 반환했습니다\./);
});

test("양쪽 모두 실패하면 게이지 없이 두 실패 사유를 함께 보여준다", () => {
  const data = mergeUsageBubbleData({ formatReset });
  assert.deepEqual(data.gauges, []);
  assert.equal(data.footer, "Codex 한도 정보 없음 / Claude 한도 정보 없음");
});

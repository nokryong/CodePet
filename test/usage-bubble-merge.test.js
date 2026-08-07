const test = require("node:test");
const assert = require("node:assert/strict");
const { mergeUsageBubbleData, toResetSeconds } = require("../src/usage-bubble-merge");

const formatReset = (seconds) =>
  Number.isFinite(seconds) ? `reset:${Math.round(seconds)}` : "초기화 정보 없음";

const codexProvider = {
  name: "Codex",
  gauges: [{ label: "5시간 한도", usedPercent: 40, resetText: "7/3 14:22 (3시간 후 초기화)" }],
  footer: "plus · 14:00 기준 · codex@example.com",
};

const claudeProvider = {
  name: "Claude",
  gauges: [
    { label: "5시간", usedPercent: 12, resetText: "1970-01-01T00:01:00.000Z" },
    { label: "7일 · Opus", usedPercent: 90, resetText: "" },
  ],
  account: { label: "claude@example.com", plan: "max" },
  formatResetText: true,
};

const agyProvider = {
  name: "AGY",
  gauges: [{ label: "모델 · 5시간", usedPercent: 20, resetText: "1970-01-01T00:02:00.000Z" }],
  account: { email: "agy@example.com", plan: "Google AI Pro" },
  formatResetText: true,
};

test("AGY의 긴 영문 한도 이름을 말풍선 폭에 맞게 줄인다", () => {
  const data = mergeUsageBubbleData({
    providers: [
      {
        name: "AGY",
        gauges: [
          { label: "Gemini Models · Weekly Limit Remaining", usedPercent: 0 },
          { label: "Claude and GPT models · Five Hour Limit Remaining", usedPercent: 0 },
          { label: "특수 그룹 · Rolling Window", usedPercent: 0 },
        ],
        compactLabel: true,
      },
    ],
    formatReset,
  });

  assert.deepEqual(data.gauges.map((gauge) => gauge.label), [
    "AGY · Gemini · 주간 한도",
    "AGY · Claude and GPT · 5시간 한도",
    "AGY · 특수 그룹 · Rolling Window",
  ]);
});

test("compactLabel을 켜지 않은 provider의 라벨은 손대지 않는다", () => {
  const data = mergeUsageBubbleData({
    providers: [{ name: "AGY", gauges: [{ label: "Gemini Models · Weekly Limit Remaining" }] }],
    formatReset,
  });
  assert.equal(data.gauges[0].label, "AGY · Gemini Models · Weekly Limit Remaining");
});

test("ISO 문자열과 unix 초/밀리초를 모두 초 단위로 바꾼다", () => {
  assert.equal(toResetSeconds("1970-01-01T00:01:00.000Z"), 60);
  assert.equal(toResetSeconds(1750000000), 1750000000);
  assert.equal(toResetSeconds(1750000000000), 1750000000);
  assert.equal(toResetSeconds(""), null);
  assert.equal(toResetSeconds("올해 안"), null);
});

test("세 provider의 게이지를 한 말풍선에 이름을 붙여 순서대로 담는다", () => {
  const data = mergeUsageBubbleData({
    providers: [codexProvider, claudeProvider, agyProvider],
    formatReset,
  });

  assert.equal(data.kind, "usage");
  assert.equal(data.title, "사용량");
  assert.deepEqual(data.gauges.map((gauge) => gauge.label), [
    "Codex · 5시간 한도",
    "Claude · 5시간",
    "Claude · 7일 · Opus",
    "AGY · 모델 · 5시간",
  ]);
  assert.deepEqual(data.gauges.map((gauge) => gauge.usedPercent), [40, 12, 90, 20]);
  assert.equal(
    data.footer,
    "Codex plus · 14:00 기준 · codex@example.com" +
      " / Claude max · claude@example.com" +
      " / AGY Google AI Pro · agy@example.com"
  );
});

test("Codex의 resetText는 이미 표시용 문구라 다시 포맷하지 않는다", () => {
  const data = mergeUsageBubbleData({ providers: [codexProvider], formatReset });
  assert.equal(data.gauges[0].resetText, "7/3 14:22 (3시간 후 초기화)");
});

test("Claude/AGY의 resetText는 시각이면 포맷하고 빈 값은 안내 문구로 바꾼다", () => {
  const data = mergeUsageBubbleData({
    providers: [claudeProvider, agyProvider],
    formatReset,
  });
  assert.equal(data.gauges[0].resetText, "reset:60");
  assert.equal(data.gauges[1].resetText, "초기화 정보 없음");
  assert.equal(data.gauges[2].resetText, "reset:120");
});

test("시각으로 해석되지 않는 reset 문구는 원문을 그대로 보여준다", () => {
  const data = mergeUsageBubbleData({
    providers: [
      {
        name: "AGY",
        gauges: [{ label: "모델 · 주간", usedPercent: 5, resetText: "다음 주 월요일" }],
        formatResetText: true,
      },
    ],
    formatReset,
  });
  assert.equal(data.gauges[0].resetText, "다음 주 월요일");
});

test("한 provider가 실패해도 나머지 게이지는 남고 실패 사유는 footer로 간다", () => {
  const data = mergeUsageBubbleData({
    providers: [
      codexProvider,
      { name: "Claude", gauges: null, error: "Claude 로그인 정보가 없습니다." },
      { name: "AGY", gauges: [], error: "AGY 로그인 정보가 없습니다." },
    ],
    formatReset,
  });

  assert.deepEqual(data.gauges.map((gauge) => gauge.label), ["Codex · 5시간 한도"]);
  assert.equal(
    data.footer,
    "Codex plus · 14:00 기준 · codex@example.com" +
      " / Claude Claude 로그인 정보가 없습니다." +
      " / AGY AGY 로그인 정보가 없습니다."
  );
});

test("모두 실패하면 게이지 없이 provider별 실패 사유만 보여준다", () => {
  const data = mergeUsageBubbleData({
    providers: [{ name: "Codex" }, { name: "Claude" }, { name: "AGY" }],
    formatReset,
  });
  assert.deepEqual(data.gauges, []);
  assert.equal(data.footer, "Codex 한도 정보 없음 / Claude 한도 정보 없음 / AGY 한도 정보 없음");
});

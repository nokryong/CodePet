const test = require("node:test");
const assert = require("node:assert/strict");
const {
  USAGE_BUBBLE_PROVIDERS,
  isUsageBubbleProviderEnabled,
  normalizeUsageBubbleProviders,
  toggleUsageBubbleProvider,
} = require("../src/usage-bubble-providers");

test("provider 목록은 말풍선 표시 순서대로 codex, claude, agy이다", () => {
  assert.deepEqual(USAGE_BUBBLE_PROVIDERS.map((provider) => provider.id), [
    "codex",
    "claude",
    "agy",
  ]);
});

test("저장값이 없거나 깨졌으면 전부 표시한다", () => {
  assert.deepEqual(normalizeUsageBubbleProviders(undefined), ["codex", "claude", "agy"]);
  assert.deepEqual(normalizeUsageBubbleProviders("codex"), ["codex", "claude", "agy"]);
  assert.deepEqual(normalizeUsageBubbleProviders([]), ["codex", "claude", "agy"]);
  assert.deepEqual(normalizeUsageBubbleProviders(["없는것"]), ["codex", "claude", "agy"]);
});

test("알 수 없는 항목은 버리고 순서는 항상 표시 순서로 맞춘다", () => {
  assert.deepEqual(normalizeUsageBubbleProviders(["agy", "없는것", "codex"]), ["codex", "agy"]);
  assert.deepEqual(normalizeUsageBubbleProviders(["claude", "claude"]), ["claude"]);
});

test("항목을 켜고 끄면 표시 순서를 유지한 채 반영된다", () => {
  assert.deepEqual(toggleUsageBubbleProvider(["codex", "claude", "agy"], "claude", false), [
    "codex",
    "agy",
  ]);
  assert.deepEqual(toggleUsageBubbleProvider(["agy"], "codex", true), ["codex", "agy"]);
});

test("마지막 하나는 끄지 않는다", () => {
  assert.deepEqual(toggleUsageBubbleProvider(["claude"], "claude", false), ["claude"]);
});

test("알 수 없는 id로 토글하면 현재 선택을 그대로 둔다", () => {
  assert.deepEqual(toggleUsageBubbleProvider(["codex"], "없는것", true), ["codex"]);
});

test("선택 여부를 개별로 확인할 수 있다", () => {
  assert.equal(isUsageBubbleProviderEnabled(["codex"], "codex"), true);
  assert.equal(isUsageBubbleProviderEnabled(["codex"], "agy"), false);
  assert.equal(isUsageBubbleProviderEnabled(null, "agy"), true);
});

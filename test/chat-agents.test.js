const test = require("node:test");
const assert = require("node:assert/strict");
const { roomAgentFromCapability } = require("../src/chat/chat-agents");

function record(id, modelOptions, efforts = ["default", "low", "medium", "high"]) {
  return {
    id,
    name: id,
    status: "cli",
    aliases: [id],
    modelOptions,
    efforts,
  };
}

test("default 설정을 실제 Claude Fable 모델과 중간 추론으로 해석한다", () => {
  const agent = roomAgentFromCapability(record("claude", [
    { id: "default", efforts: ["default", "low", "medium", "high"] },
    { id: "fable", efforts: ["default", "low", "medium", "high"] },
    { id: "claude-fable-5", efforts: ["default", "low", "medium", "high"] },
  ]), { model: "default", effort: "default" });
  assert.equal(agent.model, "claude-fable-5");
  assert.equal(agent.effort, "medium");
});

test("Codex 카탈로그의 실제 기본 모델을 선택하고 default 문자열을 남기지 않는다", () => {
  const agent = roomAgentFromCapability(record("codex", [
    { id: "default", efforts: ["low", "medium", "high"] },
    { id: "gpt-5.6-sol", isDefault: true, efforts: ["low", "medium", "high"] },
    { id: "gpt-5.6-terra", efforts: ["medium"] },
  ]), {});
  assert.equal(agent.model, "gpt-5.6-sol");
  assert.equal(agent.effort, "medium");
});

test("AGY 모델명에 포함된 추론 강도를 실제 effort로 맞춘다", () => {
  const agent = roomAgentFromCapability(record("agy", [
    { id: "default", efforts: ["default", "low", "medium", "high"] },
    { id: "gemini-3.6-flash-high", efforts: ["default", "low", "medium", "high"] },
  ]), {});
  assert.equal(agent.model, "gemini-3.6-flash-high");
  assert.equal(agent.effort, "high");
});

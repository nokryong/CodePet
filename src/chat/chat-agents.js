// 채팅방 에이전트 구성 유틸.
// CLI 탐지/검증은 src/providers/provider-capabilities.js 한 곳에서만 수행하고,
// 이 모듈은 탐지 결과(capability record)와 세션별 설정을 방 참가자로 합칩니다.

const GROUP_ALIASES = Object.freeze(["all", "everyone", "모두", "전원", "얘들아"]);

function concreteModelOptions(record) {
  return (record.modelOptions || []).filter((option) => option.id && option.id !== "default");
}

function resolvedModel(record, configured) {
  const options = concreteModelOptions(record);
  if (configured && configured !== "default") {
    if (record.id === "claude" && configured === "fable") {
      return options.find((option) => /^claude-fable-/i.test(option.id))?.id || configured;
    }
    return configured;
  }
  if (record.id === "claude") {
    return options.find((option) => /^claude-fable-/i.test(option.id))?.id
      || options.find((option) => option.id === "fable")?.id
      || options[0]?.id;
  }
  return options.find((option) => option.isDefault)?.id || options[0]?.id || "unknown";
}

function resolvedEffort(record, model, configured) {
  if (configured && configured !== "default") return configured;
  const suffix = String(model).match(/-(low|medium|high)$/i)?.[1]?.toLowerCase();
  const option = concreteModelOptions(record).find((entry) => entry.id === model);
  const efforts = (option?.efforts?.length ? option.efforts : record.efforts || [])
    .filter((effort) => effort !== "default");
  if (suffix && efforts.includes(suffix)) return suffix;
  if (efforts.includes("medium")) return "medium";
  return efforts[0] || "unknown";
}

// capability record + 세션 설정 → 채팅방 참가자.
// commandPath/needsShell 같은 실행 정보는 여기서 제거되어 방/renderer로 가지 않습니다.
function roomAgentFromCapability(record, config = {}) {
  const model = resolvedModel(record, config.model);
  return {
    id: record.id,
    name: record.name,
    color: record.color,
    aliases: [...(record.aliases || [record.id])],
    available: record.status === "cli",
    enabled: config.enabled !== false,
    reason: record.reason || "",
    version: record.version || "",
    model,
    effort: resolvedEffort(record, model, config.effort),
    autoApprove: Boolean(config.autoApprove),
  };
}

function roomAgentsFromCapabilities(records, sessionAgents = {}) {
  return (records || []).map((record) =>
    roomAgentFromCapability(record, sessionAgents[record.id] || {})
  );
}

module.exports = {
  GROUP_ALIASES,
  concreteModelOptions,
  resolvedModel,
  resolvedEffort,
  roomAgentFromCapability,
  roomAgentsFromCapabilities,
};

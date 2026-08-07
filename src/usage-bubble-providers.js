// 사용량 말풍선에 어떤 provider를 띄울지 고르는 설정입니다.
// 트레이 메뉴와 설정 창이 같은 규칙을 쓰도록 순수 함수로 분리했습니다.

const USAGE_BUBBLE_PROVIDERS = Object.freeze([
  Object.freeze({ id: "codex", label: "Codex" }),
  Object.freeze({ id: "claude", label: "Claude" }),
  Object.freeze({ id: "agy", label: "AGY" }),
]);

const ALL_IDS = Object.freeze(USAGE_BUBBLE_PROVIDERS.map((provider) => provider.id));

// 저장된 값이 없거나 깨졌으면 전부 표시합니다. 순서는 항상 말풍선 표시 순서로 맞춥니다.
function normalizeUsageBubbleProviders(value) {
  if (!Array.isArray(value)) return [...ALL_IDS];
  const chosen = ALL_IDS.filter((id) => value.includes(id));
  return chosen.length > 0 ? chosen : [...ALL_IDS];
}

// 전부 끄면 빈 말풍선이 뜨므로 마지막 하나는 끄지 않습니다.
function toggleUsageBubbleProvider(value, id, enabled) {
  const current = normalizeUsageBubbleProviders(value);
  if (!ALL_IDS.includes(id)) return current;

  const next = enabled
    ? ALL_IDS.filter((candidate) => current.includes(candidate) || candidate === id)
    : current.filter((candidate) => candidate !== id);
  return next.length > 0 ? next : current;
}

function isUsageBubbleProviderEnabled(value, id) {
  return normalizeUsageBubbleProviders(value).includes(id);
}

module.exports = {
  USAGE_BUBBLE_PROVIDERS,
  isUsageBubbleProviderEnabled,
  normalizeUsageBubbleProviders,
  toggleUsageBubbleProvider,
};

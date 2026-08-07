// 펫 더블클릭 사용량 말풍선에 여러 provider의 한도를 함께 담는 순수 로직입니다.
// main.js는 이 파일의 함수 하나만 호출하므로 업스트림을 따라갈 때 충돌 범위가 작습니다.

// Codex는 reset을 unix 초로, Claude/AGY는 문자열로 돌려줍니다.
// 말풍선 표기를 맞추려고 파싱 가능한 값은 초 단위로 바꿔서 같은 포맷터에 넘깁니다.
function toResetSeconds(value) {
  if (value === null || value === undefined || value === "") return null;

  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    // 밀리초로 들어오는 경우도 초 단위로 맞춥니다.
    return numeric > 1e11 ? numeric / 1000 : numeric;
  }

  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed / 1000;
}

// 시각으로 해석되지 않는 문자열(AGY가 가끔 돌려주는 자유 문구)은 원문을 그대로 살립니다.
function resetText(value, formatReset) {
  const seconds = toResetSeconds(value);
  if (seconds !== null) return formatReset(seconds);
  const raw = String(value ?? "").trim();
  return raw || formatReset(null);
}

// AGY 한도 이름은 "Gemini Models · Weekly Limit Remaining"처럼 길어서
// 270px 말풍선에서 두 줄로 접힙니다. 뜻을 유지한 채 짧은 표기로 바꿉니다.
const COMPACT_WINDOW_LABELS = [
  [/^five\s*hour$/i, "5시간 한도"],
  [/^weekly$/i, "주간 한도"],
  [/^daily$/i, "일간 한도"],
  [/^monthly$/i, "월간 한도"],
];

function compactLabel(label) {
  return String(label)
    .split(" · ")
    .map((part, index, parts) => {
      // 마지막 조각이 한도 창 이름이고, 앞 조각들은 모델 그룹 이름입니다.
      if (index < parts.length - 1) return part.replace(/\s+models$/i, "");
      const window = part.replace(/\s*limit\s*remaining$/i, "").replace(/\s*remaining$/i, "").trim();
      const matched = COMPACT_WINDOW_LABELS.find(([pattern]) => pattern.test(window));
      return matched ? matched[1] : window || part;
    })
    .join(" · ");
}

function accountFooter(name, account) {
  const parts = [account?.plan, account?.label || account?.email].filter(Boolean);
  return parts.length ? `${name} ${parts.join(" · ")}` : null;
}

// provider 하나는 { name, gauges, footer, account, error, formatResetText, compactLabel } 형태입니다.
// gauges의 resetText가 이미 표시용 문구면 formatResetText를 켜지 않습니다. (Codex)
function providerRows(provider, formatReset) {
  return (provider.gauges || []).map((gauge) => ({
    ...gauge,
    label: `${provider.name} · ${provider.compactLabel ? compactLabel(gauge.label) : gauge.label}`,
    resetText: provider.formatResetText
      ? resetText(gauge.resetText, formatReset)
      : gauge.resetText,
  }));
}

// 한 provider의 조회가 실패해도 나머지 게이지는 그대로 두고 실패 사유만 footer에 적습니다.
function mergeUsageBubbleData({ providers = [], formatReset = () => "초기화 정보 없음" } = {}) {
  const gauges = [];
  const footerParts = [];

  for (const provider of providers) {
    const rows = providerRows(provider, formatReset);
    if (rows.length === 0) {
      footerParts.push(`${provider.name} ${provider.error || "한도 정보 없음"}`);
      continue;
    }

    gauges.push(...rows);
    const footer = provider.footer
      ? `${provider.name} ${provider.footer}`
      : accountFooter(provider.name, provider.account);
    if (footer) footerParts.push(footer);
  }

  return {
    kind: "usage",
    title: "사용량",
    gauges,
    footer: footerParts.join(" / "),
    actions: [],
  };
}

module.exports = { mergeUsageBubbleData, toResetSeconds };

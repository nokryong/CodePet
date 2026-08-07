// 펫 더블클릭 사용량 말풍선에 Codex와 Claude 한도를 함께 담는 순수 로직입니다.
// main.js는 이 파일의 함수 하나만 호출하므로 업스트림을 따라갈 때 충돌 범위가 작습니다.

const CODEX_LABEL = "Codex";
const CLAUDE_LABEL = "Claude";

// Codex는 reset을 unix 초로, Claude usage API는 ISO 문자열로 돌려줍니다.
// 말풍선 표기를 맞추려고 Claude 값도 초 단위로 바꿔서 같은 포맷터에 넘깁니다.
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

function prefixGauges(prefix, gauges) {
  return (gauges || []).map((gauge) => ({
    ...gauge,
    label: `${prefix} · ${gauge.label}`,
  }));
}

// Claude 게이지는 resetText가 ISO 문자열이므로 Codex와 같은 문구로 다시 만듭니다.
function claudeGauges(gauges, formatReset) {
  return prefixGauges(
    CLAUDE_LABEL,
    (gauges || []).map((gauge) => ({
      ...gauge,
      resetText: formatReset(toResetSeconds(gauge.resetText)),
    }))
  );
}

function accountFooter(prefix, account) {
  if (!account) return null;
  const parts = [account.plan, account.label || account.email].filter(Boolean);
  return parts.length ? `${prefix} ${parts.join(" · ")}` : null;
}

// codex는 buildUsageBubbleData()가 만든 { title, gauges, footer }를 그대로 받습니다.
// 한쪽 조회가 실패해도 다른 쪽 게이지는 그대로 보여주고 실패는 footer에 남깁니다.
function mergeUsageBubbleData({
  codex = null,
  codexError = null,
  claude = null,
  claudeError = null,
  claudeAccount = null,
  formatReset = () => "초기화 정보 없음",
} = {}) {
  const gauges = [];
  const footerParts = [];

  if (codex && (codex.gauges || []).length > 0) {
    gauges.push(...prefixGauges(CODEX_LABEL, codex.gauges));
    if (codex.footer) footerParts.push(`${CODEX_LABEL} ${codex.footer}`);
  } else {
    footerParts.push(`${CODEX_LABEL} ${codexError || "한도 정보 없음"}`);
  }

  const claudeRows = claudeGauges(claude, formatReset);
  if (claudeRows.length > 0) {
    gauges.push(...claudeRows);
    const footer = accountFooter(CLAUDE_LABEL, claudeAccount);
    if (footer) footerParts.push(footer);
  } else {
    footerParts.push(`${CLAUDE_LABEL} ${claudeError || "한도 정보 없음"}`);
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

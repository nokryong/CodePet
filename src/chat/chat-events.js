// 프로바이더 CLI의 구조화 출력(JSONL)을 공통 이벤트로 정규화합니다.
//   { kind: "delta", text }   — 실시간 본문 조각 (claude stream-json)
//   { kind: "status", label } — 도구 실행/사고 등 상태 표시
//   { kind: "final", text }   — 신뢰 가능한 최종 답변
//   { kind: "error", message }
// 알 수 없는 줄은 null(무시)로 처리해, CLI 버전이 바뀌어도 조용히 동작합니다.

function parseJsonLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed || trimmed[0] !== "{") return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function truncateLabel(text, limit = 80) {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit)}…` : compact;
}

const GROK_CHANGESET_PREFIX = "CODEPET_GROK_CHANGESET_V1 ";
const GROK_CHANGESET_LINE_LIMIT = 2 * 1024 * 1024;

// claude -p --output-format stream-json --include-partial-messages --verbose
function parseClaudeLine(line) {
  const event = parseJsonLine(line);
  if (!event || typeof event !== "object") return null;

  if (event.type === "stream_event" && event.event) {
    const inner = event.event;
    if (inner.type === "content_block_delta" && inner.delta?.type === "text_delta") {
      return { kind: "delta", text: String(inner.delta.text || "") };
    }
    if (inner.type === "content_block_start" && inner.content_block?.type === "tool_use") {
      return { kind: "status", label: `도구: ${truncateLabel(inner.content_block.name)}` };
    }
    return null;
  }

  if (event.type === "assistant" && Array.isArray(event.message?.content)) {
    for (const block of event.message.content) {
      if (block?.type === "tool_use" && block.name) {
        return { kind: "status", label: `도구: ${truncateLabel(block.name)}` };
      }
    }
    return null;
  }

  if (event.type === "result") {
    if (event.subtype === "success" && typeof event.result === "string") {
      return { kind: "final", text: event.result };
    }
    if (event.is_error || (event.subtype && event.subtype !== "success")) {
      return { kind: "error", message: truncateLabel(event.result || event.subtype || "실행 오류", 200) };
    }
    return null;
  }

  return null;
}

// codex exec --json (버전에 따라 이벤트 스키마가 달라 두 형태를 모두 처리합니다)
function parseCodexLine(line) {
  const event = parseJsonLine(line);
  if (!event || typeof event !== "object") return null;

  // 신형: {type:"item.completed", item:{type,text,...}}
  const item = event.item;
  if (typeof event.type === "string" && item && typeof item === "object") {
    if (event.type.startsWith("item.") && item.type === "agent_message" && item.text) {
      return event.type === "item.completed" ? { kind: "final", text: String(item.text) } : null;
    }
    if (item.type === "command_execution" && item.command) {
      return event.type === "item.started"
        ? { kind: "status", label: `실행: ${truncateLabel(item.command)}` }
        : null;
    }
    if (item.type === "reasoning") {
      return event.type === "item.started" ? { kind: "status", label: "생각 중" } : null;
    }
    if (item.type === "error") {
      const message = String(item.message || "");
      // Codex가 매 턴 시작에 error 아이템으로 보내는 스킬 컨텍스트 예산 경고는
      // 실행 오류가 아니므로 진단 기록을 오염시키지 않게 무시합니다.
      if (/skill descriptions were shortened/i.test(message)) return null;
      return { kind: "error", message: truncateLabel(message || "실행 오류", 200) };
    }
    return null;
  }

  if (event.type === "error" && event.message) {
    return { kind: "error", message: truncateLabel(event.message, 200) };
  }

  if (event.type === "turn.failed" && event.error?.message) {
    return { kind: "error", message: truncateLabel(event.error.message, 200) };
  }

  // 구형: {id, msg:{type:...}}
  const msg = event.msg;
  if (msg && typeof msg === "object") {
    if (msg.type === "agent_message" && msg.message) {
      return { kind: "final", text: String(msg.message) };
    }
    if (msg.type === "agent_reasoning") return { kind: "status", label: "생각 중" };
    if (msg.type === "exec_command_begin" && Array.isArray(msg.command)) {
      return { kind: "status", label: `실행: ${truncateLabel(msg.command.join(" "))}` };
    }
    if (msg.type === "error" && msg.message) {
      return { kind: "error", message: truncateLabel(msg.message, 200) };
    }
    return null;
  }

  return null;
}

function parseAgyLine(line) {
  const event = parseJsonLine(line);
  if (!event || typeof event !== "object") return null;
  if (event.event === "step_update") {
    const step = event.step_update || {};
    const tool = step.tool_name || step.tool_info?.name;
    const error = step.tool_info?.error?.message || step.error?.message || "";
    if (step.state === "ERROR" && /permission|approval|권한|승인/i.test(error)) {
      return {
        kind: "approval-required",
        summary: tool ? `도구 권한: ${tool}` : "도구 실행 권한",
        detail: String(error),
      };
    }
    if (tool) return { kind: "status", label: `도구: ${truncateLabel(tool)}` };
  }
  if (event.event === "result") {
    const result = event.result || {};
    if (result.response) return { kind: "final", text: String(result.response) };
    if (result.status && result.status !== "SUCCESS") {
      return { kind: "error", message: truncateLabel(result.error || `AGY ${result.status}`, 200) };
    }
  }
  return null;
}

function parseGrokLine(line) {
  const raw = String(line || "");
  if (raw.startsWith(GROK_CHANGESET_PREFIX)) {
    const payload = raw.slice(GROK_CHANGESET_PREFIX.length);
    if (Buffer.byteLength(payload, "utf8") > GROK_CHANGESET_LINE_LIMIT) {
      return { kind: "error", message: "Grok 변경 세트가 출력 상한을 초과했습니다." };
    }
    try {
      return { kind: "workspace-change-manifest", manifest: JSON.parse(payload) };
    } catch {
      return { kind: "error", message: "Grok 변경 세트 형식을 읽지 못했습니다." };
    }
  }
  const event = parseJsonLine(raw);
  if (!event || typeof event !== "object") {
    return raw.trim() ? { kind: "fallback", text: raw.trim() } : null;
  }
  if (event.type === "stream_event" && event.event) {
    const inner = event.event;
    if (inner.type === "content_block_delta" && inner.delta?.type === "text_delta") {
      return { kind: "delta", text: String(inner.delta.text || "") };
    }
    if (inner.type === "content_block_start" && inner.content_block?.type === "thinking") {
      return { kind: "status", label: "생각 중" };
    }
    if (inner.type === "content_block_start" && inner.content_block?.type === "tool_use") {
      return { kind: "status", label: `도구: ${truncateLabel(inner.content_block.name || "tool")}` };
    }
    return null;
  }
  if (event.type === "result") {
    if (event.subtype === "success" && event.is_error === false && typeof event.result === "string") {
      return { kind: "final", text: event.result };
    }
    if (event.is_error || event.subtype === "error_during_execution") {
      const errors = Array.isArray(event.errors)
        ? event.errors
            .map((error) => typeof error === "string" ? error : error?.message || error?.error || "")
            .filter(Boolean)
            .join("; ")
        : "";
      return {
        kind: "error",
        message: truncateLabel(event.result || errors || event.subtype || "Grok 실행 오류", 200),
      };
    }
  }
  return null;
}

function createLineParser(providerId) {
  if (providerId === "claude") return parseClaudeLine;
  if (providerId === "codex") return parseCodexLine;
  if (providerId === "agy") return parseAgyLine;
  if (providerId === "grok") return parseGrokLine;
  return null;
}

module.exports = {
  createLineParser,
  parseClaudeLine,
  parseCodexLine,
  parseAgyLine,
  parseGrokLine,
  GROK_CHANGESET_PREFIX,
};

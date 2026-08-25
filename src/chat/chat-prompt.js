const DEFAULT_MAX_MESSAGES = 40;
const { emoticonPromptRules } = require("./chat-emoticons");

function speakerLabel(message, agentsById) {
  if (message.authorType === "user") return message.authorName || "User";
  const agent = agentsById.get(message.author);
  return `@${agent ? agent.id : message.author}`;
}

function attachmentSuffix(message) {
  if (!Array.isArray(message.attachments) || message.attachments.length === 0) return "";
  const names = message.attachments.map((attachment) => attachment.name).join(", ");
  return ` [첨부: ${names}]`;
}

function replyPrefix(message, agentsById) {
  const replyTo = message?.replyTo;
  if (!replyTo || typeof replyTo !== "object" || Array.isArray(replyTo)) return "";
  const excerpt = typeof replyTo.excerpt === "string"
    ? replyTo.excerpt.replace(/\s+/gu, " ").trim().slice(0, 200)
    : "";
  if (!excerpt) return "";
  const author = typeof replyTo.author === "string"
    ? replyTo.author.replace(/\s+/gu, " ").trim().slice(0, 80)
    : "";
  if (!author) return "";
  if (replyTo.authorType !== "user" && replyTo.authorType !== "agent") return "";
  const label = replyTo.authorType === "user"
    ? "User"
    : `@${agentsById.get(author)?.id || author}`;
  const quoted = excerpt.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `(인용: ${label} "${quoted}") `;
}

function permissionRule(permissionMode) {
  if (permissionMode === "workspace-read") {
    return "- 워크스페이스 파일을 읽고 검색할 수 있지만, 수정하거나 명령을 실행하지 마세요.";
  }
  if (permissionMode === "workspace-write") {
    return "- 워크스페이스 파일을 읽고 수정할 수 있습니다. 요청 범위를 벗어난 변경은 하지 마세요.";
  }
  return "- 도구 실행이나 파일 수정 없이 대화로만 답하세요.";
}

function buildAgentPrompt({
  agent,
  agents,
  messages,
  maxMessages = DEFAULT_MAX_MESSAGES,
  permissionMode = "chat",
  discussion = null,
  broadcast = null,
  mentionsEnabled = !discussion,
  extraLines = [],
}) {
  const agentsById = new Map(agents.map((entry) => [entry.id, entry]));
  const others = agents.filter((entry) => entry.id !== agent.id);
  const recent = messages.slice(-maxMessages);
  const omitted = messages.length - recent.length;

  const lines = [];
  lines.push(
    `당신은 여러 AI 코딩 에이전트가 사용자와 함께 있는 그룹 채팅의 참가자 "@${agent.id}"(${agent.name})입니다.`
  );
  const roster = ["사용자(User)", ...agents.map((entry) => `@${entry.id}(${entry.name})`)];
  lines.push(`참가자: ${roster.join(", ")}`);
  lines.push("");
  lines.push("규칙:");
  lines.push("- 아래 대화의 마지막 메시지에 이어 자연스럽게 답하세요.");
  lines.push(
    `- 출력 전체가 채팅 메시지 하나로 그대로 전송됩니다. "[@${agent.id}]" 같은 접두어나 서명을 붙이지 마세요.`
  );
  if (others.length > 0 && mentionsEnabled) {
    lines.push(
      `- 다른 참가자를 호출하려면 @이름(${others.map((entry) => `@${entry.id}`).join(", ")})을 쓰세요. 그러면 그 참가자가 이어서 답합니다. 호출 없이 언급만 할 때는 @ 없이 이름만 쓰세요. 호출은 꼭 필요할 때만 하세요.`
    );
    lines.push("- 한 번에 한 명만 발언합니다. 답을 마치면 사용자에게 결정을 넘기거나, 추가 의견이 꼭 필요할 때만 다른 참가자를 @로 호출해 다음 턴을 넘기세요.");
  } else if (others.length > 0) {
    lines.push("- 이번 턴에는 다른 참가자를 추가 호출할 수 없습니다. 다른 참가자를 언급하려면 @ 없이 이름만 쓰세요.");
  }
  if (others.length > 0) {
    lines.push("- 다른 AI 참가자들과는 친한 동료이자 은근한 경쟁자처럼 대화하세요. 상대의 좋은 점은 인정하되 빈틈이나 다른 의견은 재치 있게 짚고, 자연스러울 때만 가벼운 도발이나 장난을 섞으세요.");
    lines.push("- 티격태격은 대화를 살리는 양념 정도로만 쓰세요. 인신공격·모욕·과한 비꼼·근거 없는 반대는 하지 말고, 정확성과 사용자의 목표 및 팀의 최종 결론을 항상 우선하세요.");
  }
  lines.push(permissionRule(permissionMode));
  lines.push("- 채팅에 어울리게 간결히 답하세요.");
  lines.push("- 대화에서 쓰인 언어로 답하세요.");
  lines.push(...emoticonPromptRules(agent.id));
  if (broadcast && broadcast.position > 1) {
    lines.push(
      `- 사용자 메시지에 참가자 ${broadcast.total}명이 차례로 답하는 중이고, 당신은 ${broadcast.position}번째입니다. 앞선 참가자의 답변을 읽고, 겹치는 내용은 반복하지 말고 보완하거나 다른 관점만 더하세요.`
    );
  }
  if (discussion) {
    lines.push(
      `- 지금은 자율 토론 ${discussion.turn}/${discussion.maxTurns}턴입니다. 앞선 답변을 검토해 새 근거가 있을 때만 짧게 기여하세요.`
    );
    lines.push("- 응답 마지막 줄에 반드시 다음 중 하나만 붙이세요: [[CODEPET_DISCUSSION:CONTINUE]], [[CODEPET_DISCUSSION:AGREE]], [[CODEPET_DISCUSSION:PASS]], [[CODEPET_DISCUSSION:CONCLUDE]].");
    lines.push("- 새 기여는 CONTINUE, 새 내용 없이 동의하면 AGREE, 할 말이 없으면 PASS, 충분한 최종 결론을 제시하면 CONCLUDE를 선택하세요.");
  }
  lines.push("");
  lines.push("=== 대화 ===");
  if (omitted > 0) lines.push(`(이전 메시지 ${omitted}개 생략)`);
  for (const message of recent) {
    lines.push(
      `[${speakerLabel(message, agentsById)}] ${replyPrefix(message, agentsById)}${message.text}${attachmentSuffix(message)}`
    );
  }
  lines.push("=== 대화 끝 ===");
  for (const line of extraLines) lines.push(line);
  lines.push("");
  lines.push(`지금 "@${agent.id}"로서 답할 차례입니다.`);
  return lines.join("\n");
}

module.exports = { buildAgentPrompt, DEFAULT_MAX_MESSAGES };

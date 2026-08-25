const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function compactLine(value) {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

function escapeInlineMarkdown(value) {
  return String(value || "").replace(/([\\`*_{}\[\]<>#])/gu, "\\$1");
}

function formatDateTime(value) {
  const date = new Date(Number(value));
  if (!Number.isFinite(date.getTime())) return "시간 미상";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

function messageAuthorLabel(message) {
  if (message?.authorType === "user") return "사용자";
  const author = compactLine(message?.author);
  return author ? `@${author}` : "에이전트";
}

function replyAuthorLabel(replyTo) {
  if (replyTo?.authorType === "user") return "사용자";
  const author = compactLine(replyTo?.author);
  return author ? `@${author}` : "에이전트";
}

function attachmentLines(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return [];
  const lines = ["**첨부**"];
  for (const attachment of attachments) {
    const name = compactLine(attachment?.name) || "이름 없는 첨부";
    const mime = compactLine(attachment?.mime);
    const size = Number(attachment?.size);
    const details = [mime, Number.isFinite(size) && size >= 0 ? `${size} bytes` : ""]
      .filter(Boolean)
      .join(", ");
    lines.push(`- ${escapeInlineMarkdown(name)}${details ? ` (${escapeInlineMarkdown(details)})` : ""}`);
  }
  return lines;
}

function formatReplyBlock(replyTo) {
  if (!replyTo || typeof replyTo !== "object" || Array.isArray(replyTo)) return "";
  const excerpt = compactLine(replyTo.excerpt);
  if (!excerpt) return "";
  return [
    `> 인용: ${escapeInlineMarkdown(replyAuthorLabel(replyTo))}`,
    ">",
    `> ${escapeInlineMarkdown(excerpt)}`,
  ].join("\n");
}

function formatMessage(message) {
  const time = formatDateTime(message?.ts);
  const text = String(message?.text || "").trim();

  if (message?.authorType === "system") {
    const oneLine = compactLine(text) || "내용 없음";
    return `_${escapeInlineMarkdown(`시스템 (${time}): ${oneLine}`)}_`;
  }

  const blocks = [
    `### ${escapeInlineMarkdown(messageAuthorLabel(message))} (${time})`,
  ];
  const replyBlock = formatReplyBlock(message?.replyTo);
  if (replyBlock) blocks.push(replyBlock);
  if (text) blocks.push(text);

  const attachments = attachmentLines(message?.attachments);
  if (attachments.length > 0) blocks.push(attachments.join("\n"));
  if (!text && attachments.length === 0) blocks.push("_내용 없음._");
  return blocks.join("\n\n");
}

function formatSessionMarkdown(meta = {}, messages = []) {
  const title = compactLine(meta.title) || "채팅 세션";
  const sessionDate = formatDateTime(meta.createdAt || meta.updatedAt);
  const sections = [
    `# ${escapeInlineMarkdown(title)}`,
    `_세션 날짜: ${sessionDate}_`,
  ];
  const entries = Array.isArray(messages) ? messages.filter(Boolean) : [];
  if (entries.length === 0) sections.push("_메시지가 없습니다._");
  else sections.push(...entries.map(formatMessage));
  return `${sections.join("\n\n")}\n`;
}

function safeExportFileName(title) {
  let base = compactLine(title)
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/gu, "-")
    .replace(/^[. ]+|[. ]+$/gu, "")
    .replace(/-+/gu, "-")
    .slice(0, 100)
    .replace(/[. ]+$/gu, "");
  if (!base) base = "채팅-세션";
  if (WINDOWS_RESERVED_NAME.test(base)) base = `_${base}`;
  return `${base}.md`;
}

module.exports = {
  formatDateTime,
  formatSessionMarkdown,
  safeExportFileName,
};

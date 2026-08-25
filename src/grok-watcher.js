const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ExternalWatcher, recursiveJsonl, text } = require("./external-watcher");

function eventIdFor(row) {
  const supplied = row?.params?._meta?.eventId;
  if (typeof supplied === "string" && supplied) return supplied;
  return crypto
    .createHash("sha1")
    .update(JSON.stringify(row || null))
    .digest("hex")
    .slice(0, 20);
}

function contentText(content) {
  if (content?.type === "text") return String(content.text || "");
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text")
    .map((part) => String(part.text || ""))
    .join("");
}

function cwdFromUpdateFile(file) {
  if (!file) return null;
  const groupDirectory = path.dirname(path.dirname(file));
  const encoded = path.basename(groupDirectory);
  try {
    const decoded = decodeURIComponent(encoded);
    if (decoded !== encoded || path.isAbsolute(decoded)) return decoded;
  } catch {}

  // 아주 긴 cwd는 slug+hash 디렉터리와 옆의 .cwd 파일로 저장됩니다.
  const cwdFile = path.join(groupDirectory, ".cwd");
  try {
    return fs.readFileSync(cwdFile, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function grokToolKind(kind, title) {
  const source = `${kind || ""} ${title || ""}`.toLowerCase();
  if (/edit|write|patch|replace/.test(source)) return "patch";
  if (/search|grep|find|glob/.test(source)) return "search";
  if (/read|view|list/.test(source)) return "read";
  return "command";
}

function completionReason(stopReason) {
  const source = String(stopReason || "").toLowerCase();
  if (/cancel|abort|interrupt/.test(source)) return "aborted";
  if (/error|fail/.test(source)) return "failed";
  return "done";
}

function parseGrokUpdate(row, file = "") {
  const params = row?.params;
  const update = params?.update;
  const sessionId = params?.sessionId;
  const kind = update?.sessionUpdate;
  if (typeof sessionId !== "string" || !sessionId || typeof kind !== "string") return null;

  const base = {
    sessionId,
    eventId: eventIdFor(row),
    cwd: cwdFromUpdateFile(file),
  };
  if (kind === "user_message_chunk") {
    const visible = contentText(update.content);
    return visible ? { ...base, type: "user", text: visible, append: true } : null;
  }
  if (kind === "agent_message_chunk") {
    const visible = contentText(update.content);
    return visible ? { ...base, type: "assistant", text: visible, append: true } : null;
  }
  if (kind === "agent_thought_chunk" || kind === "session_recap") return null;
  if (kind === "tool_call" || kind === "tool_call_update") {
    const title = text(update.title || update.kind || "도구 실행", 220);
    if (!title) return null;
    return {
      ...base,
      type: "tool",
      text: title,
      kind: grokToolKind(update.kind, update.title),
    };
  }
  if (kind === "turn_completed") {
    return {
      ...base,
      type: "complete",
      text: "",
      finished: true,
      reason: completionReason(update.stop_reason),
    };
  }
  return null;
}

function grokSessionsRoot(options = {}) {
  const home = options.home || os.homedir();
  const env = options.env || process.env;
  const grokHome = env.GROK_HOME || path.join(home, ".grok");
  return path.join(grokHome, "sessions");
}

class GrokWatcher extends ExternalWatcher {
  constructor(options = {}) {
    super({
      provider: "grok",
      roots: options.roots || [grokSessionsRoot(options)],
      findFiles: (root) =>
        recursiveJsonl(root).filter((file) => path.basename(file).toLowerCase() === "updates.jsonl"),
      parseRow: parseGrokUpdate,
      quietMs: 15000,
      ...options,
    });
  }
}

module.exports = {
  GrokWatcher,
  parseGrokUpdate,
  grokSessionsRoot,
  cwdFromUpdateFile,
  grokToolKind,
  completionReason,
};

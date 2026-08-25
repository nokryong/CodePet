const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// .code-pet 저장소 스키마 버전. 더 새로운 버전이 만든 데이터를 만나면
// 데이터를 깨뜨리지 않도록 읽기 전용으로 동작합니다.
const STORE_SCHEMA_VERSION = 1;
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const AUTO_TITLE_MAX_LENGTH = 30;
const DEFAULT_SESSION_TITLE = "새 채팅";
const SEARCH_RESULT_LIMIT = 50;
const SEARCH_RESULTS_PER_SESSION = 3;
const SEARCH_CONTEXT_LENGTH = 40;

let tmpSeq = 0;
let idSeq = 0;

function defaultRoot(env = process.env) {
  const override = env.CODE_PET_HOME;
  if (override && String(override).trim()) return path.resolve(String(override).trim());
  return path.join(os.homedir(), ".code-pet");
}

// 같은 디렉터리의 임시 파일에 쓴 뒤 rename 하므로, 도중에 죽어도
// 원본 파일은 이전 상태 그대로 남습니다.
function writeJsonAtomic(file, value) {
  const dir = path.dirname(file);
  tmpSeq += 1;
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${tmpSeq}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// 마지막 줄이 찢겨 있어도(쓰던 중 종료) 나머지 이벤트는 살립니다.
function readJsonlTolerant(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const events = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // 손상 라인은 건너뜁니다. (정상 경로에서는 마지막 한 줄뿐입니다.)
    }
  }
  return events;
}

function newSessionId(now) {
  idSeq += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `s${now.toString(36)}${String(idSeq % 1296).padStart(2, "0")}-${rand}`;
}

function sanitizeTitle(title) {
  const text = String(title || "").replace(/\s+/g, " ").trim();
  return text.slice(0, 80);
}

function autoTitleFrom(text) {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.length > AUTO_TITLE_MAX_LENGTH
    ? `${compact.slice(0, AUTO_TITLE_MAX_LENGTH)}…`
    : compact;
}

function previewFrom(text) {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  return compact.slice(0, 60);
}

function normalizeSearchText(text) {
  return String(text || "").replace(/\s+/gu, " ").trim();
}

function searchSnippet(text, matchIndex, matchLength) {
  const start = Math.max(0, matchIndex - SEARCH_CONTEXT_LENGTH);
  const end = Math.min(text.length, matchIndex + matchLength + SEARCH_CONTEXT_LENGTH);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

class ChatStore {
  constructor(options = {}) {
    this.root = options.root || defaultRoot(options.env);
    this.now = options.now || (() => Date.now());
    this.trashRetentionMs = Number.isFinite(options.trashRetentionMs)
      ? options.trashRetentionMs
      : TRASH_RETENTION_MS;
    this.readOnly = false;
    this.index = { schemaVersion: STORE_SCHEMA_VERSION, sessions: [] };
    this.config = { schemaVersion: STORE_SCHEMA_VERSION };
    this.initialized = false;
  }

  sessionsRoot() {
    return path.join(this.root, "sessions");
  }

  trashRoot() {
    return path.join(this.root, "trash");
  }

  sessionDir(id) {
    return path.join(this.sessionsRoot(), id);
  }

  attachmentsDir(id) {
    return path.join(this.sessionDir(id), "attachments");
  }

  transcriptPath(id) {
    return path.join(this.sessionDir(id), "transcript.jsonl");
  }

  metaPath(id) {
    return path.join(this.sessionDir(id), "meta.json");
  }

  configPath() {
    return path.join(this.root, "config.json");
  }

  indexPath() {
    return path.join(this.root, "index.json");
  }

  // 채팅 전용(권한 chat) 모드에서 프로바이더 프로세스의 cwd로 쓰는 빈 디렉터리.
  // 홈 디렉터리를 노출하지 않기 위해 존재합니다.
  runtimeChatDir() {
    return path.join(this.root, "runtime", "chat");
  }

  init() {
    if (this.initialized) return this;
    fs.mkdirSync(this.sessionsRoot(), { recursive: true });
    fs.mkdirSync(this.trashRoot(), { recursive: true });
    fs.mkdirSync(this.runtimeChatDir(), { recursive: true });

    const config = readJsonSafe(this.configPath());
    if (config && typeof config === "object") {
      this.config = config;
      if (Number(config.schemaVersion) > STORE_SCHEMA_VERSION) {
        // 더 새로운 앱이 만든 저장소: 손대지 않고 읽기만 합니다.
        this.readOnly = true;
      }
    } else {
      this.config = { schemaVersion: STORE_SCHEMA_VERSION };
      this.persistConfig();
    }

    this.loadIndex();
    this.markInterruptedSessions();
    this.purgeTrash();
    this.initialized = true;
    return this;
  }

  persistConfig() {
    if (this.readOnly) return;
    try {
      writeJsonAtomic(this.configPath(), this.config);
    } catch {}
  }

  getConfig() {
    return this.config;
  }

  patchConfig(patch) {
    this.config = { ...this.config, ...patch, schemaVersion: STORE_SCHEMA_VERSION };
    this.persistConfig();
    return this.config;
  }

  loadIndex() {
    const index = readJsonSafe(this.indexPath());
    if (
      index &&
      typeof index === "object" &&
      Array.isArray(index.sessions) &&
      Number(index.schemaVersion) <= STORE_SCHEMA_VERSION
    ) {
      this.index = index;
      return;
    }
    this.rebuildIndex();
  }

  // index.json은 캐시일 뿐이라, 없거나 깨졌으면 메타 파일에서 다시 만듭니다.
  rebuildIndex() {
    const sessions = [];
    let ids = [];
    try {
      ids = fs.readdirSync(this.sessionsRoot());
    } catch {
      ids = [];
    }
    for (const id of ids) {
      const meta = readJsonSafe(this.metaPath(id));
      if (!meta || meta.id !== id) continue;
      sessions.push(this.indexEntryFrom(meta));
    }
    this.index = { schemaVersion: STORE_SCHEMA_VERSION, sessions };
    this.persistIndex();
  }

  indexEntryFrom(meta) {
    return {
      id: meta.id,
      title: meta.title || DEFAULT_SESSION_TITLE,
      createdAt: meta.createdAt || 0,
      updatedAt: meta.updatedAt || 0,
      preview: meta.preview || "",
      workspace: meta.workspace || null,
      permissionMode: meta.permissionMode || "chat",
      status: meta.status || "idle",
    };
  }

  persistIndex() {
    if (this.readOnly) return;
    try {
      writeJsonAtomic(this.indexPath(), this.index);
    } catch {}
  }

  listSessions() {
    return [...this.index.sessions].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  searchSessions(query) {
    if (typeof query !== "string") return [];
    const needle = normalizeSearchText(query);
    if (!needle) return [];
    const foldedNeedle = needle.toLowerCase();
    const results = [];

    for (const session of this.listSessions()) {
      let sessionMatches = 0;
      const messages = this.readMessages(session.id);
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (!message || message.authorType === "system") continue;
        const text = normalizeSearchText(message.text);
        if (!text) continue;
        const matchIndex = text.toLowerCase().indexOf(foldedNeedle);
        if (matchIndex < 0) continue;

        results.push({
          sessionId: session.id,
          title: session.title || DEFAULT_SESSION_TITLE,
          snippet: searchSnippet(text, matchIndex, needle.length),
          messageId: typeof message.id === "string" ? message.id : "",
          ts: Number.isFinite(message.ts) ? message.ts : 0,
        });
        sessionMatches += 1;
        if (results.length >= SEARCH_RESULT_LIMIT) return results;
        if (sessionMatches >= SEARCH_RESULTS_PER_SESSION) break;
      }
    }
    return results;
  }

  hasSession(id) {
    return this.index.sessions.some((entry) => entry.id === id);
  }

  createSession(input = {}) {
    if (this.readOnly) throw new Error("저장소가 읽기 전용 상태입니다.");
    const now = this.now();
    const id = newSessionId(now);
    const meta = {
      schemaVersion: STORE_SCHEMA_VERSION,
      id,
      title: sanitizeTitle(input.title) || DEFAULT_SESSION_TITLE,
      autoTitle: !sanitizeTitle(input.title),
      createdAt: now,
      updatedAt: now,
      preview: "",
      workspace: input.workspace || null,
      permissionMode: input.permissionMode || "chat",
      agents: input.agents || {},
      discussion: { maxTurns: 9, ...(input.discussion || {}) },
      status: "idle",
    };
    fs.mkdirSync(this.attachmentsDir(id), { recursive: true });
    writeJsonAtomic(this.metaPath(id), meta);
    this.index.sessions.push(this.indexEntryFrom(meta));
    this.persistIndex();
    return meta;
  }

  readMeta(id) {
    const meta = readJsonSafe(this.metaPath(id));
    if (!meta || meta.id !== id) return null;
    if (Number(meta.schemaVersion) > STORE_SCHEMA_VERSION) {
      return { ...meta, readOnly: true };
    }
    return meta;
  }

  updateMeta(id, patch) {
    const meta = this.readMeta(id);
    if (!meta) return null;
    if (this.readOnly || meta.readOnly) return meta;
    const next = { ...meta, ...patch, id, updatedAt: this.now() };
    writeJsonAtomic(this.metaPath(id), next);
    const entryIndex = this.index.sessions.findIndex((entry) => entry.id === id);
    if (entryIndex >= 0) this.index.sessions[entryIndex] = this.indexEntryFrom(next);
    else this.index.sessions.push(this.indexEntryFrom(next));
    this.persistIndex();
    return next;
  }

  renameSession(id, title) {
    const clean = sanitizeTitle(title);
    if (!clean) return this.readMeta(id);
    return this.updateMeta(id, { title: clean, autoTitle: false });
  }

  appendEvent(id, event) {
    const meta = this.readMeta(id);
    if (!meta) return null;
    if (this.readOnly || meta.readOnly) return null;
    const entry = { v: 1, ts: this.now(), ...event };
    fs.appendFileSync(this.transcriptPath(id), `${JSON.stringify(entry)}\n`, "utf8");

    const patch = {};
    if (entry.kind === "message" && entry.message && !entry.message.error) {
      const message = entry.message;
      if (message.authorType !== "system") patch.preview = previewFrom(message.text);
      if (message.authorType === "user" && meta.autoTitle) {
        const title = autoTitleFrom(message.text);
        if (title) {
          patch.title = title;
          patch.autoTitle = false;
        }
      }
    }
    this.updateMeta(id, patch);
    return entry;
  }

  readTranscript(id) {
    return readJsonlTolerant(this.transcriptPath(id));
  }

  readMessages(id) {
    return this.readTranscript(id)
      .filter((event) => event && event.kind === "message" && event.message)
      .map((event) => event.message);
  }

  getSession(id) {
    const meta = this.readMeta(id);
    if (!meta) return null;
    return { meta, messages: this.readMessages(id) };
  }

  setSessionStatus(id, status) {
    return this.updateMeta(id, { status });
  }

  // 앱이 실행 중 종료되면 status가 "running"으로 남습니다.
  // 다음 시작 때 중단됨으로 표시하고 시스템 메시지를 남깁니다.
  markInterruptedSessions() {
    if (this.readOnly) return;
    for (const entry of this.index.sessions) {
      if (entry.status !== "running") continue;
      const meta = this.readMeta(entry.id);
      if (!meta || meta.readOnly || meta.status !== "running") continue;
      this.appendEvent(entry.id, {
        kind: "message",
        message: {
          id: `interrupt-${entry.id}-${this.now()}`,
          ts: this.now(),
          authorType: "system",
          author: "system",
          text: "이전 실행이 앱 종료로 중단되었습니다.",
        },
      });
      this.updateMeta(entry.id, { status: "interrupted" });
    }
  }

  deleteSession(id) {
    if (this.readOnly) return false;
    const source = this.sessionDir(id);
    if (!fs.existsSync(source)) {
      this.index.sessions = this.index.sessions.filter((entry) => entry.id !== id);
      this.persistIndex();
      return false;
    }
    const target = path.join(this.trashRoot(), id);
    fs.rmSync(target, { recursive: true, force: true });
    try {
      fs.renameSync(source, target);
    } catch {
      // Windows에서 파일이 잠겨 rename이 실패하면 복사 후 삭제로 대체합니다.
      fs.cpSync(source, target, { recursive: true });
      fs.rmSync(source, { recursive: true, force: true });
    }
    try {
      writeJsonAtomic(path.join(target, "trash.json"), { deletedAt: this.now() });
    } catch {}
    this.index.sessions = this.index.sessions.filter((entry) => entry.id !== id);
    this.persistIndex();
    return true;
  }

  listTrash() {
    let ids = [];
    try {
      ids = fs.readdirSync(this.trashRoot());
    } catch {
      return [];
    }
    const entries = [];
    for (const id of ids) {
      const meta = readJsonSafe(path.join(this.trashRoot(), id, "meta.json"));
      const trashInfo = readJsonSafe(path.join(this.trashRoot(), id, "trash.json"));
      if (!meta) continue;
      entries.push({
        id,
        title: meta.title || DEFAULT_SESSION_TITLE,
        deletedAt: trashInfo?.deletedAt || 0,
      });
    }
    return entries.sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
  }

  restoreSession(id) {
    if (this.readOnly) return null;
    const source = path.join(this.trashRoot(), id);
    const target = this.sessionDir(id);
    if (!fs.existsSync(source) || fs.existsSync(target)) return null;
    try {
      fs.renameSync(source, target);
    } catch {
      fs.cpSync(source, target, { recursive: true });
      fs.rmSync(source, { recursive: true, force: true });
    }
    fs.rmSync(path.join(target, "trash.json"), { force: true });
    const meta = this.readMeta(id);
    if (!meta) return null;
    this.index.sessions.push(this.indexEntryFrom(meta));
    this.persistIndex();
    return meta;
  }

  purgeTrash() {
    if (this.readOnly) return;
    const cutoff = this.now() - this.trashRetentionMs;
    for (const entry of this.listTrash()) {
      if ((entry.deletedAt || 0) < cutoff) {
        fs.rmSync(path.join(this.trashRoot(), entry.id), { recursive: true, force: true });
      }
    }
  }

  sessionAttachmentsSize(id) {
    let total = 0;
    let files = [];
    try {
      files = fs.readdirSync(this.attachmentsDir(id));
    } catch {
      return 0;
    }
    for (const name of files) {
      try {
        const stat = fs.statSync(path.join(this.attachmentsDir(id), name));
        if (stat.isFile()) total += stat.size;
      } catch {}
    }
    return total;
  }
}

module.exports = {
  ChatStore,
  STORE_SCHEMA_VERSION,
  DEFAULT_SESSION_TITLE,
  defaultRoot,
  writeJsonAtomic,
  readJsonlTolerant,
};

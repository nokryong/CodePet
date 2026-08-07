const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// 첨부 파일 검증/복사 모듈.
// - 원본은 세션 attachments 디렉터리로 복사되고(내용 해시 기반 이름),
//   renderer에는 경로가 아닌 id/이름/타입 메타데이터만 전달됩니다.
// - MIME은 매직 바이트 우선, 보수적인 확장자 보조로 판정합니다.
// - 실행 파일류는 확장자와 매직 바이트 양쪽에서 거부합니다.

const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MiB
const MAX_SESSION_BYTES = 200 * 1024 * 1024; // 200 MiB
const PREVIEW_MAX_BYTES = 5 * 1024 * 1024;
const COPY_NAME_PATTERN = /^[a-f0-9]{16}\.[a-z0-9]{1,10}$/;

const DANGEROUS_EXTENSIONS = new Set([
  ".exe", ".dll", ".msi", ".bat", ".cmd", ".com", ".scr", ".pif", ".cpl",
  ".msc", ".jar", ".vbs", ".vbe", ".wsf", ".wsh", ".ps1", ".psm1", ".lnk", ".sys",
]);

const TEXT_EXTENSIONS = new Map([
  [".txt", "text/plain"], [".md", "text/markdown"], [".markdown", "text/markdown"],
  [".json", "application/json"], [".jsonl", "application/json"],
  [".js", "text/plain"], [".mjs", "text/plain"], [".cjs", "text/plain"],
  [".ts", "text/plain"], [".tsx", "text/plain"], [".jsx", "text/plain"],
  [".py", "text/plain"], [".rb", "text/plain"], [".go", "text/plain"],
  [".rs", "text/plain"], [".java", "text/plain"], [".kt", "text/plain"],
  [".c", "text/plain"], [".h", "text/plain"], [".cpp", "text/plain"], [".hpp", "text/plain"],
  [".cs", "text/plain"], [".css", "text/plain"], [".html", "text/plain"], [".htm", "text/plain"],
  [".xml", "text/plain"], [".yml", "text/plain"], [".yaml", "text/plain"],
  [".toml", "text/plain"], [".ini", "text/plain"], [".csv", "text/csv"],
  [".log", "text/plain"], [".sql", "text/plain"], [".sh", "text/plain"],
  [".svg", "text/plain"],
]);

const IMAGE_MIME_BY_EXTENSION = new Map([
  [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"],
  [".gif", "image/gif"], [".webp", "image/webp"], [".bmp", "image/bmp"],
]);

function startsWith(buffer, bytes, offset = 0) {
  if (buffer.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i += 1) {
    if (buffer[offset + i] !== bytes[i]) return false;
  }
  return true;
}

// 매직 바이트로 판정되는 이미지 형식만 이미지로 취급합니다.
function sniffImageMime(buffer) {
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(buffer, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (startsWith(buffer, [0x42, 0x4d])) return "image/bmp";
  if (
    startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(buffer, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return "image/webp";
  }
  return null;
}

function isExecutableMagic(buffer) {
  return (
    startsWith(buffer, [0x4d, 0x5a]) || // Windows PE (MZ)
    startsWith(buffer, [0x7f, 0x45, 0x4c, 0x46]) || // ELF
    startsWith(buffer, [0xcf, 0xfa, 0xed, 0xfe]) || // Mach-O 64
    startsWith(buffer, [0xfe, 0xed, 0xfa, 0xce]) // Mach-O 32
  );
}

function detectMime(buffer, extension) {
  const image = sniffImageMime(buffer);
  if (image) return { mime: image, kind: "image" };
  const text = TEXT_EXTENSIONS.get(extension);
  if (text) return { mime: text, kind: "text" };
  return { mime: "application/octet-stream", kind: "binary" };
}

function sanitizeDisplayName(name) {
  const base = path.basename(String(name || "첨부파일"));
  // 제어 문자 제거: 정규식 범위 대신 코드포인트 비교로 명시합니다.
  let clean = "";
  for (const ch of base) {
    if (ch.codePointAt(0) >= 32) clean += ch;
  }
  return clean.slice(0, 120) || "첨부파일";
}

function safeCopyExtension(extension, kind, mime) {
  const clean = String(extension || "").toLowerCase();
  if (kind === "image") {
    for (const [ext, imageMime] of IMAGE_MIME_BY_EXTENSION) {
      if (imageMime === mime) return ext.slice(1);
    }
  }
  if (/^\.[a-z0-9]{1,10}$/.test(clean) && !DANGEROUS_EXTENSIONS.has(clean)) return clean.slice(1);
  return "bin";
}

function importAttachment({
  sourcePath,
  attachmentsDir,
  currentSessionBytes = 0,
  maxFileBytes = MAX_FILE_BYTES,
  maxSessionBytes = MAX_SESSION_BYTES,
  fsApi = fs,
}) {
  let stat;
  try {
    stat = fsApi.statSync(sourcePath);
  } catch {
    return { ok: false, error: "파일을 읽을 수 없습니다." };
  }
  if (!stat.isFile()) {
    return { ok: false, error: "일반 파일만 첨부할 수 있습니다." };
  }
  if (stat.size > maxFileBytes) {
    return {
      ok: false,
      error: `파일이 너무 큽니다. (최대 ${Math.floor(maxFileBytes / 1024 / 1024)}MiB)`,
    };
  }
  if (currentSessionBytes + stat.size > maxSessionBytes) {
    return {
      ok: false,
      error: `세션 첨부 용량 한도를 초과합니다. (최대 ${Math.floor(maxSessionBytes / 1024 / 1024)}MiB)`,
    };
  }

  const extension = path.extname(sourcePath).toLowerCase();
  if (DANGEROUS_EXTENSIONS.has(extension)) {
    return { ok: false, error: "실행 파일 형식은 첨부할 수 없습니다." };
  }

  let content;
  try {
    content = fsApi.readFileSync(sourcePath);
  } catch {
    return { ok: false, error: "파일을 읽을 수 없습니다." };
  }
  if (isExecutableMagic(content)) {
    return { ok: false, error: "실행 파일 형식은 첨부할 수 없습니다." };
  }

  const { mime, kind } = detectMime(content, extension);
  const hash = crypto.createHash("sha256").update(content).digest("hex");
  const id = hash.slice(0, 16);
  const fileName = `${id}.${safeCopyExtension(extension, kind, mime)}`;
  const targetPath = path.join(attachmentsDir, fileName);

  try {
    fsApi.mkdirSync(attachmentsDir, { recursive: true });
    if (!fsApi.existsSync(targetPath)) {
      // 임시 파일에 쓴 뒤 rename: 복사 도중 종료돼도 깨진 첨부가 남지 않습니다.
      const tmpPath = `${targetPath}.${process.pid}.tmp`;
      fsApi.writeFileSync(tmpPath, content);
      fsApi.renameSync(tmpPath, targetPath);
    }
  } catch {
    return { ok: false, error: "첨부 파일을 저장하지 못했습니다." };
  }

  return {
    ok: true,
    attachment: {
      id,
      name: sanitizeDisplayName(sourcePath),
      mime,
      kind,
      size: stat.size,
      fileName,
      sha256: hash,
    },
  };
}

// 이미지 미리보기: attachments 디렉터리 안의 검증된 파일명만, 데이터 응답으로 제공합니다.
// renderer에 파일 경로나 file:// 접근을 열지 않습니다.
function readImagePreview({ attachmentsDir, fileName, fsApi = fs }) {
  const clean = String(fileName || "");
  if (!COPY_NAME_PATTERN.test(clean)) return { ok: false, error: "잘못된 첨부 이름입니다." };
  const filePath = path.join(attachmentsDir, clean);
  if (path.dirname(filePath) !== path.normalize(attachmentsDir)) {
    return { ok: false, error: "잘못된 첨부 경로입니다." };
  }
  let content;
  try {
    content = fsApi.readFileSync(filePath);
  } catch {
    return { ok: false, error: "첨부 파일이 없습니다." };
  }
  if (content.length > PREVIEW_MAX_BYTES) return { ok: false, error: "미리보기 용량 초과" };
  const mime = sniffImageMime(content);
  if (!mime) return { ok: false, error: "이미지 형식이 아닙니다." };
  return { ok: true, dataUrl: `data:${mime};base64,${content.toString("base64")}` };
}

function readInlineText({ attachmentsDir, fileName, limit, fsApi = fs }) {
  const clean = String(fileName || "");
  if (!COPY_NAME_PATTERN.test(clean)) return null;
  try {
    const content = fsApi.readFileSync(path.join(attachmentsDir, clean));
    if (limit && content.length > limit) return null;
    return content.toString("utf8");
  } catch {
    return null;
  }
}

module.exports = {
  MAX_FILE_BYTES,
  MAX_SESSION_BYTES,
  PREVIEW_MAX_BYTES,
  DANGEROUS_EXTENSIONS,
  importAttachment,
  readImagePreview,
  readInlineText,
  sniffImageMime,
  detectMime,
};

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  importAttachment,
  importAttachmentBuffer,
  readImagePreview,
  readInlineText,
  sniffImageMime,
  MAX_FILE_BYTES,
} = require("../src/chat/chat-attachments");

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

function makeDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-attach-"));
  const source = path.join(root, "source");
  const attachments = path.join(root, "attachments");
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(attachments, { recursive: true });
  return { root, source, attachments };
}

test("PNG 매직 바이트 스니핑", () => {
  assert.equal(sniffImageMime(PNG_BYTES), "image/png");
  assert.equal(sniffImageMime(Buffer.from("plain text")), null);
});

test("이미지 첨부: 복사 + 내용 주소 파일명 + 메타데이터", () => {
  const { source, attachments } = makeDirs();
  const filePath = path.join(source, "스크린샷 사진.png");
  fs.writeFileSync(filePath, PNG_BYTES);

  const result = importAttachment({ sourcePath: filePath, attachmentsDir: attachments });
  assert.equal(result.ok, true);
  const record = result.attachment;
  assert.equal(record.kind, "image");
  assert.equal(record.mime, "image/png");
  assert.match(record.fileName, /^[a-f0-9]{16}\.png$/);
  assert.ok(fs.existsSync(path.join(attachments, record.fileName)));
  // renderer로 넘어가는 레코드에 원본 경로가 없어야 한다.
  assert.ok(!JSON.stringify(record).includes(source.replace(/\\/g, "\\\\")));
});

test("붙여넣은 이미지 바이트를 기존 첨부 저장소에 저장한다", () => {
  const { attachments } = makeDirs();
  const result = importAttachmentBuffer({
    name: "붙여넣은 화면.png",
    data: PNG_BYTES.buffer.slice(PNG_BYTES.byteOffset, PNG_BYTES.byteOffset + PNG_BYTES.byteLength),
    attachmentsDir: attachments,
    requireImage: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.attachment.name, "붙여넣은 화면.png");
  assert.equal(result.attachment.kind, "image");
  assert.equal(result.attachment.mime, "image/png");
  assert.ok(fs.existsSync(path.join(attachments, result.attachment.fileName)));
});

test("붙여넣기 전용 경로는 이미지가 아닌 바이트와 용량 초과를 거부한다", () => {
  const { attachments } = makeDirs();
  const fakeImage = importAttachmentBuffer({
    name: "fake.png",
    data: Buffer.from("plain text"),
    attachmentsDir: attachments,
    requireImage: true,
  });
  assert.equal(fakeImage.ok, false);
  assert.match(fakeImage.error, /이미지 형식/);

  const tooBig = importAttachmentBuffer({
    name: "large.png",
    data: PNG_BYTES,
    attachmentsDir: attachments,
    maxFileBytes: 3,
    requireImage: true,
  });
  assert.equal(tooBig.ok, false);
  assert.match(tooBig.error, /너무 큽니다/);
});

test("같은 내용은 같은 id로 중복 제거된다", () => {
  const { source, attachments } = makeDirs();
  const a = path.join(source, "a.png");
  const b = path.join(source, "b.png");
  fs.writeFileSync(a, PNG_BYTES);
  fs.writeFileSync(b, PNG_BYTES);
  const first = importAttachment({ sourcePath: a, attachmentsDir: attachments });
  const second = importAttachment({ sourcePath: b, attachmentsDir: attachments });
  assert.equal(first.attachment.id, second.attachment.id);
  assert.equal(fs.readdirSync(attachments).length, 1);
});

test("확장자를 속인 이미지(.png 안의 텍스트)는 이미지로 취급하지 않는다", () => {
  const { source, attachments } = makeDirs();
  const fake = path.join(source, "fake.png");
  fs.writeFileSync(fake, "<script>alert(1)</script>");
  const result = importAttachment({ sourcePath: fake, attachmentsDir: attachments });
  assert.equal(result.ok, true);
  assert.notEqual(result.attachment.kind, "image");
});

test("실행 파일은 확장자로 거부한다", () => {
  const { source, attachments } = makeDirs();
  const exe = path.join(source, "tool.exe");
  fs.writeFileSync(exe, "MZ fake binary");
  const result = importAttachment({ sourcePath: exe, attachmentsDir: attachments });
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("실행 파일"));
});

test("확장자를 바꾼 실행 파일은 매직 바이트로 거부한다", () => {
  const { source, attachments } = makeDirs();
  const disguised = path.join(source, "totally-a-doc.txt");
  fs.writeFileSync(disguised, Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.from("PE junk")]));
  const result = importAttachment({ sourcePath: disguised, attachmentsDir: attachments });
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("실행 파일"));
});

test("파일/세션 용량 한도", () => {
  const { source, attachments } = makeDirs();
  const filePath = path.join(source, "note.txt");
  fs.writeFileSync(filePath, "hello world");

  const tooBig = importAttachment({
    sourcePath: filePath,
    attachmentsDir: attachments,
    maxFileBytes: 3,
  });
  assert.equal(tooBig.ok, false);
  assert.ok(tooBig.error.includes("너무 큽니다"));

  const sessionFull = importAttachment({
    sourcePath: filePath,
    attachmentsDir: attachments,
    currentSessionBytes: 200,
    maxSessionBytes: 205,
  });
  assert.equal(sessionFull.ok, false);
  assert.ok(sessionFull.error.includes("한도"));

  assert.equal(MAX_FILE_BYTES, 20 * 1024 * 1024);
});

test("디렉터리는 첨부할 수 없다", () => {
  const { source, attachments } = makeDirs();
  const result = importAttachment({ sourcePath: source, attachmentsDir: attachments });
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("일반 파일"));
});

test("이미지 미리보기는 검증된 파일명만 데이터 URL로 응답한다", () => {
  const { source, attachments } = makeDirs();
  const filePath = path.join(source, "img.png");
  fs.writeFileSync(filePath, PNG_BYTES);
  const { attachment } = importAttachment({ sourcePath: filePath, attachmentsDir: attachments });

  const preview = readImagePreview({ attachmentsDir: attachments, fileName: attachment.fileName });
  assert.equal(preview.ok, true);
  assert.ok(preview.dataUrl.startsWith("data:image/png;base64,"));

  // 경로 탈출/임의 파일명 거부
  const traversal = readImagePreview({ attachmentsDir: attachments, fileName: "..\\meta.json" });
  assert.equal(traversal.ok, false);
  const arbitrary = readImagePreview({ attachmentsDir: attachments, fileName: "no-such.png" });
  assert.equal(arbitrary.ok, false);
});

test("텍스트 인라인 읽기는 파일명 검증과 한도를 지킨다", () => {
  const { source, attachments } = makeDirs();
  const filePath = path.join(source, "note.txt");
  fs.writeFileSync(filePath, "인라인 텍스트 내용");
  const { attachment } = importAttachment({ sourcePath: filePath, attachmentsDir: attachments });

  const text = readInlineText({ attachmentsDir: attachments, fileName: attachment.fileName });
  assert.equal(text, "인라인 텍스트 내용");
  assert.equal(readInlineText({ attachmentsDir: attachments, fileName: "../../etc/passwd" }), null);
  assert.equal(
    readInlineText({ attachmentsDir: attachments, fileName: attachment.fileName, limit: 3 }),
    null
  );
});

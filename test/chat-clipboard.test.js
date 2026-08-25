const test = require("node:test");
const assert = require("node:assert/strict");
const {
  clipboardImageFiles,
  serializeClipboardImages,
} = require("../src/chat-clipboard");

const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function fakeFile({ name = "", type = "image/png", bytes = PNG_BYTES, size = bytes.byteLength } = {}) {
  return {
    name,
    type,
    size,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

test("클립보드 항목에서 이미지만 순서대로 고른다", () => {
  const first = fakeFile({ name: "first.png" });
  const second = fakeFile({ name: "second.png" });
  const result = clipboardImageFiles({
    items: [
      { kind: "string", type: "text/plain", getAsFile: () => null },
      { kind: "file", type: "image/png", getAsFile: () => first },
      { kind: "file", type: "application/pdf", getAsFile: () => fakeFile({ type: "application/pdf" }) },
      { kind: "file", type: "image/png", getAsFile: () => second },
    ],
  });

  assert.deepEqual(result, [first, second]);
});

test("items가 없으면 clipboardData.files의 이미지를 사용한다", () => {
  const image = fakeFile({ name: "fallback.png" });
  const result = clipboardImageFiles({
    files: [fakeFile({ name: "note.txt", type: "text/plain" }), image],
  });
  assert.deepEqual(result, [image]);
});

test("붙여넣은 이미지를 IPC용 ArrayBuffer payload로 직렬화한다", async () => {
  const result = await serializeClipboardImages([
    fakeFile(),
    fakeFile({ name: "named.png" }),
  ], { now: () => 1234 });

  assert.deepEqual(result.errors, []);
  assert.equal(result.images[0].name, "붙여넣은-이미지-1234-1.png");
  assert.equal(result.images[1].name, "named.png");
  assert.equal(result.images[0].mime, "image/png");
  assert.deepEqual(new Uint8Array(result.images[0].data), PNG_BYTES);
});

test("너무 크거나 읽을 수 없는 클립보드 이미지는 오류로 분리한다", async () => {
  const unreadable = fakeFile({ name: "broken.png" });
  unreadable.arrayBuffer = async () => { throw new Error("broken"); };
  const result = await serializeClipboardImages([
    fakeFile({ name: "large.png", size: 9 }),
    unreadable,
  ], { maxFileBytes: 8 });

  assert.deepEqual(result.images, []);
  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0].error, /너무 큽니다/);
  assert.match(result.errors[1].error, /읽지 못했습니다/);
});

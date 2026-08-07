const test = require("node:test");
const assert = require("node:assert/strict");
const { tokenizeBlocks, tokenizeInline } = require("../src/chat-markdown");

test("문단과 코드 펜스를 분리하고 언어를 보존한다", () => {
  const blocks = tokenizeBlocks("설명입니다.\n\n```js\nconst a = 1;\nconsole.log(a);\n```\n끝.");
  assert.deepEqual(blocks.map((block) => block.type), ["paragraph", "fence", "paragraph"]);
  assert.equal(blocks[1].lang, "js");
  assert.equal(blocks[1].code, "const a = 1;\nconsole.log(a);");
});

test("닫히지 않은 펜스도 끝까지 코드로 취급한다", () => {
  const blocks = tokenizeBlocks("```python\nprint(1)");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "fence");
  assert.equal(blocks[0].code, "print(1)");
});

test("순서/비순서 목록", () => {
  const blocks = tokenizeBlocks("- 하나\n- 둘\n\n1. 첫째\n2. 둘째");
  assert.equal(blocks[0].type, "list");
  assert.equal(blocks[0].ordered, false);
  assert.equal(blocks[0].items.length, 2);
  assert.equal(blocks[1].ordered, true);
});

test("인라인 코드/굵게/링크/멘션 토큰", () => {
  const tokens = tokenizeInline("`code` **bold** https://example.com/x @claude 끝");
  assert.deepEqual(tokens.map((token) => token.type), [
    "code", "text", "bold", "text", "link", "text", "mention", "text",
  ]);
  assert.equal(tokens[0].text, "code");
  assert.equal(tokens[2].text, "bold");
  assert.equal(tokens[4].href, "https://example.com/x");
  assert.equal(tokens[6].text, "@claude");
});

test("http 이외 스킴은 링크로 인식하지 않는다", () => {
  const tokens = tokenizeInline("javascript:alert(1) file:///etc/passwd");
  assert.ok(tokens.every((token) => token.type !== "link"));
});

test("HTML 마크업은 일반 텍스트 토큰으로만 나온다 (XSS 안전)", () => {
  const payload = '<img src=x onerror=alert(1)> <script>alert(2)</script>';
  const blocks = tokenizeBlocks(payload);
  assert.equal(blocks.length, 1);
  for (const lineTokens of blocks[0].lines) {
    for (const token of lineTokens) {
      assert.equal(token.type, "text");
    }
  }
  // 토큰을 모두 이어 붙이면 원문 그대로다(변조/해석 없음).
  const joined = blocks[0].lines[0].map((token) => token.text).join("");
  assert.equal(joined, payload);
});

test("빈 입력은 빈 블록 배열", () => {
  assert.deepEqual(tokenizeBlocks(""), []);
  assert.deepEqual(tokenizeInline(""), []);
});

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

test("1~3단계 제목을 각각의 블록으로 토큰화한다", () => {
  const blocks = tokenizeBlocks("# 큰 제목\n## 중간 **굵게**\n### 작은 제목\n#### 일반 문단");
  assert.deepEqual(blocks.map((block) => block.type), [
    "heading", "heading", "heading", "paragraph",
  ]);
  assert.deepEqual(blocks.slice(0, 3).map((block) => block.level), [1, 2, 3]);
  assert.deepEqual(blocks[1].tokens.map((token) => token.type), ["text", "bold"]);
  assert.equal(blocks[3].lines[0][0].text, "#### 일반 문단");
});

test("이어진 인용구 줄과 빈 인용구 줄을 하나의 블록으로 묶는다", () => {
  const blocks = tokenizeBlocks("> 첫 줄\n> 둘째 *기울임*\n>\n> 마지막\n\n본문");
  assert.deepEqual(blocks.map((block) => block.type), ["quote", "paragraph"]);
  assert.equal(blocks[0].lines.length, 4);
  assert.deepEqual(blocks[0].lines[1].map((token) => token.type), ["text", "italic"]);
  assert.deepEqual(blocks[0].lines[2], []);
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

test("이름 있는 링크/기울임/취소선을 인라인 토큰으로 만든다", () => {
  const tokens = tokenizeInline(
    "[문서](https://example.com/docs) *별표* _밑줄_ ~~삭제~~"
  );
  assert.deepEqual(tokens.map((token) => token.type), [
    "link", "text", "italic", "text", "italic", "text", "strike",
  ]);
  assert.deepEqual(tokens[0], {
    type: "link",
    href: "https://example.com/docs",
    text: "문서",
  });
  assert.equal(tokens[2].text, "별표");
  assert.equal(tokens[4].text, "밑줄");
  assert.equal(tokens[6].text, "삭제");
});

test("인라인 코드 안의 마크다운 표시는 추가 해석하지 않는다", () => {
  assert.deepEqual(tokenizeInline("`*기울임 아님* ~~취소 아님~~`"), [{
    type: "code",
    text: "*기울임 아님* ~~취소 아님~~",
  }]);
});

test("http 이외 스킴은 링크로 인식하지 않는다", () => {
  const source = "[위험](javascript:alert(1)) file:///etc/passwd";
  const tokens = tokenizeInline(source);
  assert.ok(tokens.every((token) => token.type !== "link"));
  assert.equal(tokens.map((token) => token.text).join(""), source);
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

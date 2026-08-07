const test = require("node:test");
const assert = require("node:assert/strict");
const { parseMentions, tokenMatchesAlias } = require("../src/chat/chat-mention");

const AGENTS = [
  { id: "claude", aliases: ["claude"] },
  { id: "codex", aliases: ["codex"] },
  { id: "agy", aliases: ["agy", "antigravity"] },
];

test("여러 에이전트를 한 메시지에서 순서대로 찾는다", () => {
  assert.deepEqual(parseMentions("@codex, @claude 응답해라", AGENTS), ["codex", "claude"]);
});

test("한국어 조사가 붙어도 멘션을 인식한다", () => {
  assert.deepEqual(parseMentions("@claude야 네 생각은 어때?", AGENTS), ["claude"]);
  assert.deepEqual(parseMentions("@codex한테 물어봐", AGENTS), ["codex"]);
});

test("별칭 뒤에 영문이 이어지면 다른 이름으로 보고 제외한다", () => {
  assert.deepEqual(parseMentions("@claudette 안녕", AGENTS), []);
  assert.equal(tokenMatchesAlias("claudette", "claude"), false);
  assert.equal(tokenMatchesAlias("claude", "claude"), true);
});

test("보조 별칭(@antigravity)도 같은 에이전트로 연결한다", () => {
  assert.deepEqual(parseMentions("@antigravity 상태 알려줘", AGENTS), ["agy"]);
});

test("같은 에이전트를 여러 번 불러도 한 번만 반환한다", () => {
  assert.deepEqual(parseMentions("@codex @codex야 @codex!", AGENTS), ["codex"]);
});

test("그룹 별칭은 모든 에이전트를 부른다", () => {
  assert.deepEqual(parseMentions("@모두 회의 시작", AGENTS, ["all", "모두"]), [
    "claude",
    "codex",
    "agy",
  ]);
  assert.deepEqual(parseMentions("@all standup", AGENTS, ["all", "모두"]), [
    "claude",
    "codex",
    "agy",
  ]);
});

test("멘션이 없으면 빈 배열을 반환한다", () => {
  assert.deepEqual(parseMentions("그냥 혼잣말입니다", AGENTS), []);
  assert.deepEqual(parseMentions("", AGENTS), []);
});

test("코드 블록과 인라인 코드 안의 이름은 실제 멘션으로 보지 않는다", () => {
  assert.deepEqual(parseMentions("`@codex` 예시와 ```\n@claude 검토\n```", AGENTS), []);
  assert.deepEqual(parseMentions("```\n@codex 닫히지 않은 예시", AGENTS), []);
});

test("이메일 주소 안의 @는 실제 멘션으로 보지 않는다", () => {
  assert.deepEqual(parseMentions("contact@claude.ai로 보내고 @codex는 불러줘", AGENTS), ["codex"]);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  EMOTICON_KEYS,
  EMOTICON_MEANINGS,
  MAX_EMOTICONS_PER_MESSAGE,
  extractEmoticons,
} = require("../src/chat/chat-emoticons");

test("매니페스트의 42개 이모티콘 키를 제공한다", () => {
  assert.equal(EMOTICON_KEYS.length, 42);
  assert.ok(EMOTICON_KEYS.includes("검토완료"));
  assert.ok(EMOTICON_KEYS.includes("???"));
});

test("모든 이모티콘 키에 구체적인 사용 의미가 정의되어 있다", () => {
  assert.deepEqual(Object.keys(EMOTICON_MEANINGS), EMOTICON_KEYS);
  assert.match(EMOTICON_MEANINGS["AGI"], /AGI/);
  assert.match(EMOTICON_MEANINGS["G.O.A.T"], /최고/);
  assert.match(EMOTICON_MEANINGS["J.O.A.T"], /최악/);
  assert.match(EMOTICON_MEANINGS["꺼져"], /사용 금지/);
});

test("본문 사이 이모티콘 위치를 글 조각과 분리해 보존한다", () => {
  const result = extractEmoticons(
    "검토를 시작할게요.\n[[CODEPET_EMOTE:내가볼게]]\n확인 결과 문제없어요."
  );
  assert.equal(result.text, "검토를 시작할게요.\n확인 결과 문제없어요.");
  assert.deepEqual(result.emoticons, [
    { key: "내가볼게", file: "내가볼게.png" },
  ]);
  assert.deepEqual(result.parts, [
    { type: "text", text: "검토를 시작할게요." },
    { type: "emoticon", key: "내가볼게", file: "내가볼게.png" },
    { type: "text", text: "확인 결과 문제없어요." },
  ]);
});

test("한 답변에는 이모티콘을 최대 한 개만 허용한다", () => {
  const result = extractEmoticons(
    "본문\n[[CODEPET_EMOTE:윙크]]\n[[CODEPET_EMOTE:윙크]]\n[[CODEPET_EMOTE:하트]]\n[[CODEPET_EMOTE:좋은데]]"
  );
  assert.equal(result.emoticons.length, MAX_EMOTICONS_PER_MESSAGE);
  assert.deepEqual(result.emoticons.map((item) => item.key), ["윙크"]);
});

test("허용되지 않은 키와 코드 속 표기는 이미지로 처리하지 않는다", () => {
  const result = extractEmoticons(
    "`[[CODEPET_EMOTE:좋은데]]`\n```text\n[[CODEPET_EMOTE:검토완료]]\n```\n[[CODEPET_EMOTE:없는키]]"
  );
  assert.match(result.text, /`\[\[CODEPET_EMOTE:좋은데\]\]`/);
  assert.match(result.text, /```text\n\[\[CODEPET_EMOTE:검토완료\]\]\n```/);
  assert.deepEqual(result.emoticons, []);
});

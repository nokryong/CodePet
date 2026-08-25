const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const manifest = require("../src/chat-icon/emoticons/manifest.json");
const chatCss = fs.readFileSync(path.join(__dirname, "..", "src", "chat.css"), "utf8");
const {
  EMOTICON_KEYS,
  EMOTICON_MEANINGS,
  MAX_EMOTICONS_PER_MESSAGE,
  availableEmoticonKeys,
  emoticonPromptRules,
  extractEmoticons,
} = require("../src/chat/chat-emoticons");

test("매니페스트의 새 15개 이모티콘 키를 제공한다", () => {
  assert.equal(EMOTICON_KEYS.length, 15);
  assert.ok(EMOTICON_KEYS.includes("검토완료"));
  assert.ok(EMOTICON_KEYS.includes("몰루"));
  assert.ok(EMOTICON_KEYS.includes("우헤헤"));
  assert.ok(EMOTICON_KEYS.includes("주인님"));
  assert.ok(EMOTICON_KEYS.includes("멍청"));
});

test("모든 이모티콘 키에 구체적인 사용 의미가 정의되어 있다", () => {
  assert.deepEqual(Object.keys(EMOTICON_MEANINGS), EMOTICON_KEYS);
  assert.match(EMOTICON_MEANINGS["몰루"], /부족|유보/);
  assert.match(EMOTICON_MEANINGS["주인님"], /사용자/);
  assert.match(EMOTICON_MEANINGS["멍청"], /사용자를 모욕.*사용 금지/);
});

test("네 캐릭터 폴더는 매니페스트와 정확히 같은 15개 RGBA PNG만 가진다", () => {
  const expectedFiles = Object.values(manifest).sort();
  const assetRoot = path.join(__dirname, "..", "src", "chat-icon", "emoticons");

  for (const folder of ["gpt", "claude", "gemini", "grok"]) {
    const folderPath = path.join(assetRoot, folder);
    const actualFiles = fs.readdirSync(folderPath).filter((file) => file.endsWith(".png")).sort();
    assert.deepEqual(actualFiles, expectedFiles, `${folder} 이모티콘 파일 구성이 다릅니다.`);

    for (const file of actualFiles) {
      const png = fs.readFileSync(path.join(folderPath, file));
      assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      assert.equal(png.readUInt32BE(16), 256);
      assert.equal(png.readUInt32BE(20), 256);
      assert.equal(png[25], 6, `${folder}/${file}은 RGBA PNG가 아닙니다.`);
    }
  }
});

test("투명 이모티콘은 흰 사각 배경 없이 contain으로 표시한다", () => {
  const rule = chatCss.match(/\.message-emoticon\s*\{[^}]+\}/s)?.[0] || "";
  assert.match(rule, /object-fit:\s*contain/);
  assert.match(rule, /background:\s*transparent/);
  assert.doesNotMatch(rule, /background:\s*#fff/);
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
    "본문\n[[CODEPET_EMOTE:우헤헤]]\n[[CODEPET_EMOTE:우헤헤]]\n[[CODEPET_EMOTE:하트]]\n[[CODEPET_EMOTE:좋은데]]"
  );
  assert.equal(result.emoticons.length, MAX_EMOTICONS_PER_MESSAGE);
  assert.deepEqual(result.emoticons.map((item) => item.key), ["우헤헤"]);
});

test("허용되지 않은 키와 코드 속 표기는 이미지로 처리하지 않는다", () => {
  const result = extractEmoticons(
    "`[[CODEPET_EMOTE:좋은데]]`\n```text\n[[CODEPET_EMOTE:검토완료]]\n```\n[[CODEPET_EMOTE:없는키]]"
  );
  assert.match(result.text, /`\[\[CODEPET_EMOTE:좋은데\]\]`/);
  assert.match(result.text, /```text\n\[\[CODEPET_EMOTE:검토완료\]\]\n```/);
  assert.deepEqual(result.emoticons, []);
});

test("Grok은 실제 폴더에 있는 이모티콘만 안내하고 저장한다", () => {
  const keys = availableEmoticonKeys("grok");
  assert.ok(keys.length > 0);

  const rules = emoticonPromptRules("grok").join("\n");
  for (const key of keys) assert.ok(rules.includes(`${key}=`));
  const unavailableKey = EMOTICON_KEYS.find((key) => !keys.includes(key));
  if (unavailableKey) assert.ok(!rules.includes(`${unavailableKey}=`));

  const availableKey = keys[0];
  const result = extractEmoticons(
    `${unavailableKey ? `[[CODEPET_EMOTE:${unavailableKey}]]\n` : ""}[[CODEPET_EMOTE:${availableKey}]]`,
    MAX_EMOTICONS_PER_MESSAGE,
    "grok"
  );
  assert.equal(result.emoticons.length, 1);
  assert.equal(result.emoticons[0].key, availableKey);
  assert.match(result.emoticons[0].file, /\.png$/);
});

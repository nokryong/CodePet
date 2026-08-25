const manifest = require("../chat-icon/emoticons/manifest.json");
const fs = require("node:fs");
const path = require("node:path");
const { maskNonCallingText } = require("./chat-mention");

const MAX_EMOTICONS_PER_MESSAGE = 1;
const EMOTICON_KEYS = Object.freeze(Object.keys(manifest));
const EMOTICON_PATTERN = /\[\[CODEPET_EMOTE:([^\]\r\n]+)\]\]/g;

const EMOTICON_MEANINGS = Object.freeze({
  "검토완료": "코드·문서·결과의 검토를 끝냈을 때",
  "그건안돼": "안전·권한·기술상 불가능하여 분명히 거절할 때",
  "그정돈아님": "상대의 과장된 평가를 차분히 낮춰 말할 때",
  "좋은데": "제안이나 결과에 명확히 동의하고 만족할 때",
  "내가볼게": "직접 확인하거나 작업을 맡겠다고 나설 때",
  "파일줘봐": "판단에 필요한 파일이나 첨부를 요청할 때",
  "하트": "고마움·애정·강한 호의를 따뜻하게 표현할 때",
  "잠깐만": "확인이나 처리에 잠깐 시간이 필요함을 알릴 때",
  "이건웃기네": "상황이 명백히 재미있거나 어이없어 웃길 때",
  "오류났다": "실제 실행이나 처리에서 오류가 발생했을 때",
  "수정완료": "요청된 수정을 실제로 끝냈을 때",
  "몰루": "확인 정보가 부족해 아직 모르거나 판단을 유보할 때",
  "우헤헤": "작은 성공이나 장난스러운 만족감에 은근히 득의양양할 때",
  "주인님": "사용자를 친근하게 부르며 요청을 받거나 반가움을 표현할 때",
  "멍청": "자신의 단순 실수나 착각을 가볍게 자책할 때만 사용하고 사용자를 모욕하는 용도로는 사용 금지",
});

function availableEmoticonKeys(agentId) {
  if (agentId !== "grok") return EMOTICON_KEYS;
  let files;
  try {
    files = new Set(
      fs.readdirSync(path.join(__dirname, "..", "chat-icon", "emoticons", "grok"))
    );
  } catch {
    return [];
  }
  return EMOTICON_KEYS.filter((key) => files.has(manifest[key]));
}

function emoticonPromptRules(agentId) {
  const guide = availableEmoticonKeys(agentId)
    .map((key) => `${key}=${EMOTICON_MEANINGS[key]}`)
    .join("; ");
  return [
    "- 매 답변에는 현재 감정과 상황에 가장 잘 맞는 캐릭터 이모티콘을 1개만 사용하세요.",
    `- 이모티콘 의미 사전(키=사용 상황): ${guide}`,
    "- 단어가 답변에 등장했다는 이유만으로 고르지 말고, 답변 전체의 실제 태도와 완료 상태에 의미가 정확히 맞는 키를 고르세요.",
    "- 본문 처음·문단 사이·끝 등 자연스러운 위치에 [[CODEPET_EMOTE:키]] 형식으로 넣으세요. 표기 앞뒤는 줄바꿈하여 글과 같은 줄에 두지 말고, 같은 이모티콘을 한 답변에서 반복하지 마세요.",
    "- 이 표기는 앱이 이미지로 바꾸므로 설명하거나 코드 블록·인라인 코드 안에 넣지 마세요. 공격적이거나 장난스러운 키는 대화 맥락에 정말 맞을 때만 고르세요.",
  ];
}

function extractEmoticons(value, limit = MAX_EMOTICONS_PER_MESSAGE, agentId = "") {
  const emoticons = [];
  const seen = new Set();
  const parts = [];
  const source = String(value || "");
  const scanSource = maskNonCallingText(source);
  const allowedKeys = new Set(availableEmoticonKeys(agentId));
  let lastIndex = 0;
  for (const match of scanSource.matchAll(EMOTICON_PATTERN)) {
    const preceding = source.slice(lastIndex, match.index).trim();
    if (preceding) parts.push({ type: "text", text: preceding });
    const key = String(match[1] || "").trim();
    const file = manifest[key];
    if (file && allowedKeys.has(key) && emoticons.length < limit && !seen.has(key)) {
      seen.add(key);
      const emoticon = { key, file };
      emoticons.push(emoticon);
      parts.push({ type: "emoticon", ...emoticon });
    }
    lastIndex = match.index + match[0].length;
  }
  const trailing = source.slice(lastIndex).trim();
  if (trailing) parts.push({ type: "text", text: trailing });

  const text = parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return {
    text,
    emoticons,
    parts,
  };
}

module.exports = {
  EMOTICON_KEYS,
  EMOTICON_MEANINGS,
  MAX_EMOTICONS_PER_MESSAGE,
  emoticonPromptRules,
  availableEmoticonKeys,
  extractEmoticons,
};

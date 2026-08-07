const manifest = require("../chat-icon/emoticons/manifest.json");
const { maskNonCallingText } = require("./chat-mention");

const MAX_EMOTICONS_PER_MESSAGE = 1;
const EMOTICON_KEYS = Object.freeze(Object.keys(manifest));
const EMOTICON_PATTERN = /\[\[CODEPET_EMOTE:([^\]\r\n]+)\]\]/g;

const EMOTICON_MEANINGS = Object.freeze({
  "좋은질문": "사용자의 질문이 핵심을 찌르거나 통찰력 있을 때",
  "내가볼게": "직접 확인하거나 작업을 맡겠다고 나설 때",
  "근거있음": "주장에 확인된 근거가 있음을 강조할 때",
  "찾아오는중": "자료나 원인을 실제로 찾고 있거나 조사 결과를 이어서 제시할 때",
  "바로가능": "요청을 지금 바로 처리할 수 있을 때",
  "검토완료": "코드·문서·결과의 검토를 끝냈을 때",
  "계산끝": "계산이나 분석을 마쳐 결과를 제시할 때",
  "수정완료": "요청된 수정을 실제로 끝냈을 때",
  "파일줘봐": "판단에 필요한 파일이나 첨부를 요청할 때",
  "그건안돼": "안전·권한·기술상 불가능하여 분명히 거절할 때",
  "이건쉬움": "문제가 단순하고 해결이 명확할 때",
  "잠깐만": "확인에 잠깐 시간이 필요함을 알릴 때",
  "이건웃기네": "상황이 명백히 재미있거나 어이없어 웃길 때",
  "꽤괜찮은데": "제안이나 결과를 꽤 긍정적으로 평가할 때",
  "대충맞음": "큰 방향은 맞지만 세부 수정이 필요할 때",
  "확인해봄": "추측이 아니라 직접 확인한 사실을 보고할 때",
  "출처있음": "출처나 인용 근거를 함께 제시할 때",
  "조금애매함": "판단 근거가 부족하거나 경계가 모호할 때",
  "그건별로": "제안이나 결과가 좋지 않다고 평가할 때",
  "잠시로딩": "복잡한 내용을 생각하거나 처리 중임을 표현할 때",
  "오류났다": "실제 실행이나 처리에서 오류가 발생했을 때",
  "다시해봐": "실패한 시도를 수정해 재시도해야 할 때",
  "버그발견": "구체적인 소프트웨어 결함을 발견했을 때",
  "좋은데": "제안이나 결과에 명확히 동의하고 만족할 때",
  "좀웃긴데": "가볍게 웃기거나 묘하게 재미있는 상황일 때",
  "하트": "고마움·애정·강한 호의를 따뜻하게 표현할 때",
  "윙크": "가벼운 자신감·농담·친근한 약속을 표현할 때",
  "어흐~": "민망하거나 당황스럽고 난처할 때",
  "ㄹㅇ이가;": "믿기 어려워 놀라거나 황당할 때",
  "ㄹㅇㅋㅋ": "강하게 공감하면서 웃길 때",
  "똥ㅋㅋ": "결과가 형편없음을 장난스럽게 놀릴 때만 사용",
  "개추": "아주 좋은 제안에 강하게 추천·찬성할 때",
  "비추": "좋지 않은 선택을 분명히 비추천할 때",
  "AGI": "대화 주제가 AGI·인공지능 정체성 자체일 때만 사용",
  "AI인 제가 이런걸 봐야할까요?": "터무니없거나 질 낮은 내용을 보고 어이없을 때",
  "잘자": "대화를 마치며 잠자리 인사를 할 때",
  "???": "내용을 이해하지 못했거나 추가 설명이 필요할 때",
  "아닌데?": "상대의 전제나 결론을 부드럽게 정정할 때",
  "꺼져": "사용자가 명시적으로 허용한 친한 장난 맥락 외에는 사용 금지",
  "그정돈아님": "상대의 과장된 평가를 차분히 낮춰 말할 때",
  "G.O.A.T": "성과나 아이디어를 최고 수준이라고 강하게 칭찬할 때",
  "J.O.A.T": "결과가 최악 수준이라고 강하게 혹평할 때",
});

function emoticonPromptRules() {
  const guide = EMOTICON_KEYS
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

function extractEmoticons(value, limit = MAX_EMOTICONS_PER_MESSAGE) {
  const emoticons = [];
  const seen = new Set();
  const parts = [];
  const source = String(value || "");
  const scanSource = maskNonCallingText(source);
  let lastIndex = 0;
  for (const match of scanSource.matchAll(EMOTICON_PATTERN)) {
    const preceding = source.slice(lastIndex, match.index).trim();
    if (preceding) parts.push({ type: "text", text: preceding });
    const key = String(match[1] || "").trim();
    const file = manifest[key];
    if (file && emoticons.length < limit && !seen.has(key)) {
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
  extractEmoticons,
};

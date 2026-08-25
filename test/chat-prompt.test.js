const test = require("node:test");
const assert = require("node:assert/strict");
const { buildAgentPrompt } = require("../src/chat/chat-prompt");

const AGENTS = [
  { id: "claude", name: "Claude", aliases: ["claude"] },
  { id: "codex", name: "Codex", aliases: ["codex"] },
];

function message(author, text, authorType = "agent") {
  return { author, authorType, text };
}

test("프롬프트에 역할, 참가자, 대화 기록이 화자 라벨과 함께 들어간다", () => {
  const prompt = buildAgentPrompt({
    agent: AGENTS[1],
    agents: AGENTS,
    messages: [
      message("user", "@codex, @claude 응답해라", "user"),
      message("claude", "안녕하세요!"),
    ],
  });

  assert.match(prompt, /참가자 "@codex"\(Codex\)/);
  assert.match(prompt, /사용자\(User\), @claude\(Claude\), @codex\(Codex\)/);
  assert.match(prompt, /\[User\] @codex, @claude 응답해라/);
  assert.match(prompt, /\[@claude\] 안녕하세요!/);
  assert.match(prompt, /지금 "@codex"로서 답할 차례입니다\./);
});

test("@멘션은 실제 호출이고 이름만 쓰면 언급이라는 규칙이 들어간다", () => {
  const prompt = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages: [message("user", "안녕", "user")],
  });
  assert.match(prompt, /그러면 그 참가자가 이어서 답합니다/);
  assert.match(prompt, /@ 없이 이름만 쓰세요/);
  assert.doesNotMatch(prompt, /자동으로 호출되지는 않습니다/);
});

test("여러 AI는 친한 경쟁자처럼 가볍게 견제하되 협업 목표를 우선한다", () => {
  const prompt = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages: [message("user", "같이 검토해줘", "user")],
  });
  assert.match(prompt, /친한 동료이자 은근한 경쟁자/);
  assert.match(prompt, /가벼운 도발이나 장난/);
  assert.match(prompt, /인신공격·모욕·과한 비꼼·근거 없는 반대는 하지 말고/);
  assert.match(prompt, /사용자의 목표 및 팀의 최종 결론을 항상 우선/);
});

test("긴 대화는 최근 메시지만 남기고 생략 안내를 넣는다", () => {
  const messages = Array.from({ length: 50 }, (_, index) =>
    message("user", `메시지 ${index}`, "user")
  );
  const prompt = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages,
    maxMessages: 10,
  });

  assert.match(prompt, /\(이전 메시지 40개 생략\)/);
  assert.doesNotMatch(prompt, /\[User\] 메시지 39\n/);
  assert.match(prompt, /\[User\] 메시지 49/);
});

test("다른 참가자가 없으면 멘션 규칙을 생략한다", () => {
  const prompt = buildAgentPrompt({
    agent: AGENTS[0],
    agents: [AGENTS[0]],
    messages: [message("user", "안녕", "user")],
  });
  assert.doesNotMatch(prompt, /다른 참가자/);
});

test("권한 모드에 따라 도구 규칙이 달라진다", () => {
  const chat = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages: [message("user", "안녕", "user")],
    permissionMode: "chat",
  });
  assert.match(chat, /대화로만 답하세요/);

  const read = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages: [message("user", "안녕", "user")],
    permissionMode: "workspace-read",
  });
  assert.match(read, /읽고 검색할 수 있지만/);

  const write = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages: [message("user", "안녕", "user")],
    permissionMode: "workspace-write",
  });
  assert.match(write, /읽고 수정할 수 있습니다/);
});

test("토론 컨텍스트가 자율 종료 신호와 함께 들어간다", () => {
  const prompt = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages: [message("user", "주제", "user")],
    discussion: { turn: 2, maxTurns: 9 },
  });
  assert.match(prompt, /자율 토론 2\/9턴/);
  assert.match(prompt, /CODEPET_DISCUSSION:CONCLUDE/);
});

test("첨부가 있는 메시지는 첨부 이름이 함께 표기된다", () => {
  const prompt = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages: [
      {
        author: "user",
        authorType: "user",
        text: "이 파일 봐줘",
        attachments: [{ name: "정리.md" }, { name: "shot.png" }],
      },
    ],
  });
  assert.match(prompt, /\[첨부: 정리\.md, shot\.png\]/);
});

test("extraLines가 대화 끝 뒤에 추가된다", () => {
  const prompt = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages: [message("user", "안녕", "user")],
    extraLines: ["=== 첨부 내용 ===", "파일: note.txt"],
  });
  assert.match(prompt, /=== 대화 끝 ===\n=== 첨부 내용 ===\n파일: note\.txt/);
});

test("에이전트가 매 답변에 이모티콘 한 개를 선택하도록 안내한다", () => {
  const prompt = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages: [message("user", "검토해줘", "user")],
  });
  assert.match(prompt, /이모티콘을 1개만 사용하세요/);
  assert.match(prompt, /CODEPET_EMOTE:키/);
  assert.match(prompt, /이모티콘 의미 사전/);
  assert.match(prompt, /주인님=사용자를 친근하게/);
  assert.match(prompt, /멍청=.*사용자를 모욕하는 용도로는 사용 금지/);
  assert.match(prompt, /단어가 답변에 등장했다는 이유만으로 고르지 말고/);
  assert.match(prompt, /본문 처음·문단 사이·끝/);
  assert.match(prompt, /표기 앞뒤는 줄바꿈/);
  assert.match(prompt, /검토완료/);
});

test("인용 답장은 대상 발언과 발췌를 사용자 메시지 앞에 표시한다", () => {
  const prompt = buildAgentPrompt({
    agent: AGENTS[0],
    agents: AGENTS,
    messages: [
      {
        author: "user",
        authorType: "user",
        text: "이 의견을 검토해줘",
        replyTo: {
          messageId: "m-original",
          author: "codex",
          authorType: "agent",
          excerpt: "첫 줄\n둘째 줄",
        },
      },
    ],
  });

  assert.match(prompt, /\[User\] \(인용: @codex "첫 줄 둘째 줄"\) 이 의견을 검토해줘/);
});

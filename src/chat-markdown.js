// 안전한 마크다운-라이트 토크나이저.
// HTML을 만들지 않고 토큰만 반환합니다. 렌더링은 chat.js가 DOM API(textContent)로만 수행하므로
// 에이전트 출력에 어떤 마크업이 있어도 스크립트/HTML로 해석되지 않습니다.
// 지원: 문단, 순서/비순서 목록, ``` 코드 펜스(언어 라벨), `인라인 코드`, **굵게**, http(s) 링크, @멘션.
(function attachChatMarkdown(global) {
  const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)\s*$/;
  const LIST_ITEM = /^(\s*)([-*]|\d+[.)])\s+(.*)$/;
  const INLINE_PATTERN =
    /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(https?:\/\/[^\s<>"'`)\]]+)|(@[\p{L}\p{N}_-]+)/gu;

  function tokenizeInline(text) {
    const source = String(text || "");
    const tokens = [];
    let lastIndex = 0;
    for (const match of source.matchAll(INLINE_PATTERN)) {
      if (match.index > lastIndex) {
        tokens.push({ type: "text", text: source.slice(lastIndex, match.index) });
      }
      const [full, code, bold, link, mention] = match;
      if (code) tokens.push({ type: "code", text: code.slice(1, -1) });
      else if (bold) tokens.push({ type: "bold", text: bold.slice(2, -2) });
      else if (link) tokens.push({ type: "link", href: link, text: link });
      else if (mention) tokens.push({ type: "mention", text: mention });
      lastIndex = match.index + full.length;
    }
    if (lastIndex < source.length) {
      tokens.push({ type: "text", text: source.slice(lastIndex) });
    }
    return tokens;
  }

  function tokenizeBlocks(text) {
    const lines = String(text || "").split(/\r?\n/);
    const blocks = [];
    let paragraph = [];
    let index = 0;

    const flushParagraph = () => {
      if (paragraph.length === 0) return;
      blocks.push({ type: "paragraph", lines: paragraph.map(tokenizeInline) });
      paragraph = [];
    };

    while (index < lines.length) {
      const line = lines[index];
      const fenceMatch = line.match(FENCE_OPEN);
      if (fenceMatch) {
        flushParagraph();
        const lang = fenceMatch[1] || "";
        const codeLines = [];
        index += 1;
        while (index < lines.length && !/^```\s*$/.test(lines[index])) {
          codeLines.push(lines[index]);
          index += 1;
        }
        index += 1; // 닫는 펜스(또는 EOF) 건너뛰기
        blocks.push({ type: "fence", lang, code: codeLines.join("\n") });
        continue;
      }

      const listMatch = line.match(LIST_ITEM);
      if (listMatch) {
        flushParagraph();
        const ordered = /^\d/.test(listMatch[2]);
        const items = [];
        while (index < lines.length) {
          const itemMatch = lines[index].match(LIST_ITEM);
          if (!itemMatch || /^\d/.test(itemMatch[2]) !== ordered) break;
          items.push(tokenizeInline(itemMatch[3]));
          index += 1;
        }
        blocks.push({ type: "list", ordered, items });
        continue;
      }

      if (!line.trim()) {
        flushParagraph();
        index += 1;
        continue;
      }

      paragraph.push(line);
      index += 1;
    }
    flushParagraph();
    return blocks;
  }

  const api = { tokenizeBlocks, tokenizeInline };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    global.chatMarkdown = api;
  }
})(typeof window !== "undefined" ? window : globalThis);

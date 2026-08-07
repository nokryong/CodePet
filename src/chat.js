/* global chatMarkdown */
const chatScroll = document.getElementById("chat-scroll");
const messageList = document.getElementById("message-list");
const typingRow = document.getElementById("typing-row");
const agentChips = document.getElementById("agent-chips");
const composerInput = document.getElementById("composer-input");
const composerBox = document.getElementById("composer-box");
const sendButton = document.getElementById("btn-send");
const stopButton = document.getElementById("btn-stop");
const attachButton = document.getElementById("btn-attach");
const mentionPopup = document.getElementById("mention-popup");
const attachmentRow = document.getElementById("attachment-row");
const sessionListEl = document.getElementById("session-list");
const newSessionButton = document.getElementById("btn-new-session");
const refreshProvidersButton = document.getElementById("btn-refresh-providers");
const doctorButton = document.getElementById("btn-doctor");
const sessionTitleEl = document.getElementById("session-title");
const workspaceButton = document.getElementById("btn-workspace");
const workspaceLabel = document.getElementById("workspace-label");
const permissionSelect = document.getElementById("permission-select");
const enforcementHint = document.getElementById("enforcement-hint");
const discussionButton = document.getElementById("btn-discussion");
const storeWarning = document.getElementById("store-warning");
const popover = document.getElementById("popover");
const popoverBackdrop = document.getElementById("popover-backdrop");
const appEl = document.querySelector(".app");
const sidebarEl = document.getElementById("sidebar");
const sidebarResizer = document.getElementById("sidebar-resizer");
const sidebarToggle = document.getElementById("sidebar-toggle");
const approvalBackdrop = document.getElementById("approval-backdrop");
const approvalSummary = document.getElementById("approval-summary");
const approvalDetail = document.getElementById("approval-detail");
const approvalApprove = document.getElementById("approval-approve");
const approvalDeny = document.getElementById("approval-deny");
const doctorBackdrop = document.getElementById("doctor-backdrop");
const doctorList = document.getElementById("doctor-list");
const doctorSummary = document.getElementById("doctor-summary");
const doctorRefresh = document.getElementById("doctor-refresh");
const doctorClose = document.getElementById("doctor-close");
const doctorDone = document.getElementById("doctor-done");

let providers = [];
let diagnostics = [];
let sessions = [];
let activeSessionId = null;
let sessionMeta = null;
let agents = [];
let pendingAttachments = [];
const approvalQueue = [];
let activeApproval = null;
const typingAgents = new Set();
const liveRuns = new Map(); // runId → { item, textEl, statusEl, text }
let mentionState = null;
let noticeTimer = null;

const SIDEBAR_WIDTH_KEY = "codepet.chat.sidebarWidth";
const SIDEBAR_COLLAPSED_KEY = "codepet.chat.sidebarCollapsed";
const DOCTOR_SEEN_KEY = "codepet.chat.doctorSeen.v1";
const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_MAX_WIDTH = 420;

function clampSidebarWidth(value) {
  const viewportMax = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, window.innerWidth * 0.46));
  return Math.round(Math.min(viewportMax, Math.max(SIDEBAR_MIN_WIDTH, Number(value) || 220)));
}

function applySidebarWidth(value, persist = true) {
  const width = clampSidebarWidth(value);
  appEl.style.setProperty("--sidebar-width", `${width}px`);
  sidebarResizer.setAttribute("aria-valuemin", String(SIDEBAR_MIN_WIDTH));
  sidebarResizer.setAttribute("aria-valuemax", String(clampSidebarWidth(SIDEBAR_MAX_WIDTH)));
  sidebarResizer.setAttribute("aria-valuenow", String(width));
  if (persist) localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
}

function setSidebarCollapsed(collapsed, persist = true) {
  appEl.classList.toggle("is-sidebar-collapsed", collapsed);
  sidebarToggle.textContent = collapsed ? "›" : "‹";
  sidebarToggle.setAttribute("aria-expanded", String(!collapsed));
  sidebarToggle.setAttribute("aria-label", collapsed ? "세션 사이드바 펼치기" : "세션 사이드바 접기");
  sidebarToggle.title = collapsed ? "사이드바 펼치기" : "사이드바 접기";
  if (persist) localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
}

applySidebarWidth(localStorage.getItem(SIDEBAR_WIDTH_KEY), false);
setSidebarCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true", false);

sidebarToggle.addEventListener("click", (event) => {
  event.stopPropagation();
  setSidebarCollapsed(!appEl.classList.contains("is-sidebar-collapsed"));
});

sidebarResizer.addEventListener("pointerdown", (event) => {
  if (event.target === sidebarToggle || appEl.classList.contains("is-sidebar-collapsed")) return;
  event.preventDefault();
  sidebarResizer.setPointerCapture(event.pointerId);
  appEl.classList.add("is-resizing");
});

sidebarResizer.addEventListener("pointermove", (event) => {
  if (!sidebarResizer.hasPointerCapture(event.pointerId)) return;
  applySidebarWidth(event.clientX - appEl.getBoundingClientRect().left, false);
});

function finishSidebarResize(event) {
  if (!sidebarResizer.hasPointerCapture(event.pointerId)) return;
  sidebarResizer.releasePointerCapture(event.pointerId);
  appEl.classList.remove("is-resizing");
  const width = parseFloat(getComputedStyle(appEl).getPropertyValue("--sidebar-width"));
  applySidebarWidth(width, true);
}
sidebarResizer.addEventListener("pointerup", finishSidebarResize);
sidebarResizer.addEventListener("pointercancel", finishSidebarResize);
sidebarResizer.addEventListener("keydown", (event) => {
  if (event.target === sidebarToggle) return;
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    setSidebarCollapsed(!appEl.classList.contains("is-sidebar-collapsed"));
    return;
  }
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  if (appEl.classList.contains("is-sidebar-collapsed")) setSidebarCollapsed(false);
  const current = parseFloat(getComputedStyle(appEl).getPropertyValue("--sidebar-width"));
  applySidebarWidth(current + (event.key === "ArrowRight" ? 12 : -12));
});

window.addEventListener("resize", () => {
  const current = parseFloat(getComputedStyle(appEl).getPropertyValue("--sidebar-width"));
  applySidebarWidth(current, false);
});

const ENFORCEMENT_LABEL = {
  sandbox: "샌드박스",
  "tool-policy": "도구 정책",
  "prompt-only": "프롬프트 안내만",
  unavailable: "미지원",
};

const AGENT_VISUALS = Object.freeze({
  claude: { src: "./chat-assets/claude.png", background: "#f7d9c8" },
  codex: { src: "./chat-assets/gpt.png", background: "#d8f3ea" },
  agy: { src: "./chat-assets/gemini.png", background: "#dceaff" },
});

const AGENT_EMOTICON_FOLDERS = Object.freeze({
  claude: "claude",
  codex: "gpt",
  agy: "gemini",
});

function safeEmoticonFile(value) {
  const file = String(value || "");
  return file.length > 0
    && file.length <= 100
    && file.endsWith(".png")
    && !file.includes("..")
    && !/[\\/:*?"<>|\x00-\x1f]/.test(file)
    ? file
    : null;
}

function makeMessageEmoticon(folder, emoticon) {
  const file = safeEmoticonFile(emoticon?.file);
  if (!file) return null;
  const image = document.createElement("img");
  image.className = "message-emoticon";
  image.src = `./chat-icon/emoticons/${folder}/${encodeURIComponent(file)}`;
  image.alt = emoticon.key || "이모티콘";
  image.title = emoticon.key || "";
  image.loading = "lazy";
  image.draggable = false;
  return image;
}

function renderAgentMessageContent(bubble, message) {
  const folder = AGENT_EMOTICON_FOLDERS[message.author];
  if (!folder || !Array.isArray(message.contentParts)) {
    renderRichText(bubble, message.text);
    return;
  }

  let rendered = false;
  let emoticonCount = 0;
  let emoticonRow = null;
  for (const part of message.contentParts.slice(0, 20)) {
    if (part?.type === "text" && part.text) {
      const segment = document.createElement("div");
      segment.className = "message-text-segment";
      renderRichText(segment, part.text);
      bubble.append(segment);
      rendered = true;
      emoticonRow = null;
      continue;
    }
    if (part?.type !== "emoticon" || emoticonCount >= 1) continue;
    const image = makeMessageEmoticon(folder, part);
    if (!image) continue;
    if (!emoticonRow) {
      emoticonRow = document.createElement("div");
      emoticonRow.className = "message-emoticons";
      emoticonRow.setAttribute("aria-label", "에이전트 이모티콘");
      bubble.append(emoticonRow);
    }
    emoticonRow.append(image);
    emoticonCount += 1;
    rendered = true;
  }
  if (!rendered) renderRichText(bubble, message.text);
}

const EFFORT_LABELS = Object.freeze({
  minimal: "최소",
  low: "낮음",
  medium: "중간",
  high: "높음",
  xhigh: "매우 높음",
  max: "최대",
  ultra: "극대",
});

function effortLabel(value) {
  return EFFORT_LABELS[value] || value;
}

function applyAppearance(appearance) {
  const root = document.documentElement;
  const fontFamily = appearance && appearance.fontFamily;
  if (fontFamily) root.style.setProperty("--user-font", `"${fontFamily}"`);
  else root.style.removeProperty("--user-font");
}

function agentById(id) {
  return agents.find((agent) => agent.id === id) || null;
}

function providerById(id) {
  return providers.find((provider) => provider.id === id) || null;
}

function doctorStatus(diagnostic) {
  if (diagnostic.installed !== true) {
    return {
      tone: "error",
      label: diagnostic.errorCode === "gui-only" ? "CLI 필요" : diagnostic.installed === null ? "실행 오류" : "설치 필요",
      detail: diagnostic.message || "CLI를 사용할 수 없습니다.",
    };
  }
  if (diagnostic.loggedIn === false) {
    return { tone: "error", label: "로그인 필요", detail: diagnostic.message || "로그인이 필요합니다." };
  }
  if (diagnostic.loggedIn === null) {
    return { tone: "warning", label: "CLI 확인됨", detail: diagnostic.message || "로그인 상태는 자동 확인할 수 없습니다." };
  }
  return { tone: "ready", label: "준비됨", detail: diagnostic.version || "CLI와 로그인을 확인했습니다." };
}

function renderDoctor() {
  doctorList.textContent = "";
  const readyCount = diagnostics.filter((diagnostic) => doctorStatus(diagnostic).tone === "ready").length;
  const attentionCount = diagnostics.length - readyCount;
  doctorSummary.textContent = attentionCount > 0
    ? `${readyCount}개 준비됨 · ${attentionCount}개 확인이 필요해요.`
    : `${readyCount}개 에이전트가 모두 준비됐어요.`;

  for (const diagnostic of diagnostics) {
    const status = doctorStatus(diagnostic);
    const item = document.createElement("article");
    item.className = `doctor-item is-${status.tone}`;

    const marker = document.createElement("span");
    marker.className = "doctor-marker";
    marker.setAttribute("aria-hidden", "true");

    const body = document.createElement("div");
    body.className = "doctor-item-body";
    const title = document.createElement("div");
    title.className = "doctor-item-title";
    const name = document.createElement("strong");
    name.textContent = diagnostic.name;
    const badge = document.createElement("span");
    badge.className = "doctor-badge";
    badge.textContent = status.label;
    title.append(name, badge);
    const detail = document.createElement("p");
    detail.textContent = status.detail;
    body.append(title, detail);

    const actions = document.createElement("div");
    actions.className = "doctor-item-actions";
    if (diagnostic.installed !== true && diagnostic.installUrl) {
      const install = document.createElement("button");
      install.className = "button button-small";
      install.type = "button";
      install.textContent = "설치 안내";
      install.addEventListener("click", () => call(window.chatApi.openExternal(diagnostic.installUrl)));
      actions.append(install);
    } else if (diagnostic.loggedIn === false && diagnostic.loginCommand) {
      const login = document.createElement("button");
      login.className = "button button-small";
      login.type = "button";
      login.textContent = "로그인 명령 복사";
      login.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(diagnostic.loginCommand);
          flashNotice(`${diagnostic.loginCommand} 명령을 복사했습니다.`, false);
        } catch {
          flashNotice(`터미널에서 ${diagnostic.loginCommand} 명령을 실행해 주세요.`);
        }
      });
      actions.append(login);
    }
    item.append(marker, body, actions);
    doctorList.append(item);
  }
}

function openDoctor({ firstRun = false } = {}) {
  renderDoctor();
  doctorBackdrop.hidden = false;
  if (firstRun) doctorBackdrop.dataset.firstRun = "true";
  doctorDone.focus();
}

function closeDoctor() {
  doctorBackdrop.hidden = true;
  delete doctorBackdrop.dataset.firstRun;
  localStorage.setItem(DOCTOR_SEEN_KEY, "true");
}

function makeAgentAvatar(agent, className = "avatar") {
  const visual = AGENT_VISUALS[agent?.id];
  const avatar = document.createElement("span");
  avatar.className = className;
  avatar.style.setProperty("--agent-color", agent?.color || "#52525b");
  avatar.style.setProperty("--agent-bg", visual?.background || agent?.color || "#e4e4e7");
  if (visual) {
    const image = document.createElement("img");
    image.src = visual.src;
    image.alt = `${agent.name} 프로필`;
    image.draggable = false;
    avatar.append(image);
  } else {
    avatar.textContent = (agent?.name || agent?.id || "?").slice(0, 1).toUpperCase();
  }
  return avatar;
}

function flashNotice(text, isError = true) {
  storeWarning.textContent = text;
  storeWarning.classList.toggle("is-error", isError);
  storeWarning.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    storeWarning.hidden = true;
  }, 5000);
}

async function call(promise) {
  try {
    const result = await promise;
    if (result && result.ok === false) {
      if (result.error) flashNotice(result.error);
      return null;
    }
    return result;
  } catch (error) {
    flashNotice(error?.message || String(error));
    return null;
  }
}

// --- 세션 사이드바 ---
function formatRelativeTime(ts) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "방금";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}분 전`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}시간 전`;
  return new Date(ts).toLocaleDateString();
}

function baseName(dirPath) {
  const parts = String(dirPath || "").split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || dirPath || "";
}

function renderSessions() {
  sessionListEl.textContent = "";
  for (const entry of sessions) {
    const item = document.createElement("li");
    item.className = "session-item";
    if (entry.id === activeSessionId) item.classList.add("is-active");

    const main = document.createElement("button");
    main.type = "button";
    main.className = "session-select";

    const titleLine = document.createElement("span");
    titleLine.className = "session-title-line";
    if (entry.status === "running") {
      const dot = document.createElement("i");
      dot.className = "session-status is-running";
      dot.title = "실행 중";
      titleLine.append(dot);
    } else if (entry.status === "interrupted") {
      const dot = document.createElement("i");
      dot.className = "session-status is-interrupted";
      dot.title = "이전 실행이 중단되었습니다";
      titleLine.append(dot);
    }
    const titleText = document.createElement("span");
    titleText.className = "session-name";
    titleText.textContent = entry.title;
    titleLine.append(titleText);

    const metaLine = document.createElement("span");
    metaLine.className = "session-meta";
    const time = document.createElement("span");
    time.textContent = formatRelativeTime(entry.updatedAt);
    metaLine.append(time);
    if (entry.workspace) {
      const workspace = document.createElement("span");
      workspace.className = "session-workspace";
      workspace.textContent = `📁 ${baseName(entry.workspace)}`;
      workspace.title = entry.workspace;
      metaLine.append(workspace);
    }
    main.append(titleLine, metaLine);
    main.addEventListener("click", () => selectSession(entry.id));
    main.addEventListener("dblclick", () => startInlineRename(titleText, entry.id));

    const actions = document.createElement("span");
    actions.className = "session-actions";
    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.className = "session-action";
    renameBtn.title = "이름 바꾸기";
    renameBtn.textContent = "✎";
    renameBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      startInlineRename(titleText, entry.id);
    });
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "session-action";
    deleteBtn.title = "휴지통으로 이동 (30일 후 정리)";
    deleteBtn.textContent = "🗑";
    deleteBtn.addEventListener("click", async (event) => {
      event.stopPropagation();
      const yes = window.confirm(
        `"${entry.title}" 세션을 휴지통으로 옮길까요?\n첨부 사본도 함께 이동하며 30일 후 정리됩니다.`
      );
      if (!yes) return;
      const result = await call(window.chatApi.sessionsDelete(entry.id));
      if (result) applyFullState(result);
    });
    actions.append(renameBtn, deleteBtn);

    item.append(main, actions);
    sessionListEl.append(item);
  }
}

function startInlineRename(titleTextEl, sessionId) {
  const current = titleTextEl.textContent;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "session-rename-input";
  input.value = current;
  input.maxLength = 80;
  titleTextEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const commit = async (save) => {
    if (done) return;
    done = true;
    const next = input.value.trim();
    input.replaceWith(titleTextEl);
    if (save && next && next !== current) {
      const result = await call(window.chatApi.sessionsRename(sessionId, next));
      if (result) {
        sessions = result.sessions || sessions;
        if (sessionMeta && sessionMeta.id === sessionId) {
          sessionMeta = { ...sessionMeta, title: next };
        }
        renderSessions();
        renderHeader();
      }
    }
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) commit(true);
    if (event.key === "Escape") commit(false);
  });
  input.addEventListener("blur", () => commit(true));
}

async function selectSession(sessionId) {
  if (sessionId === activeSessionId) return;
  const result = await call(window.chatApi.sessionsSelect(sessionId));
  if (result) applyFullState(result);
}

// --- 헤더 ---
function activeSessionEntry() {
  return sessions.find((entry) => entry.id === activeSessionId) || null;
}

function renderHeader() {
  const entry = activeSessionEntry();
  sessionTitleEl.textContent = sessionMeta?.title || entry?.title || "세션";

  const workspace = sessionMeta?.workspace || null;
  workspaceLabel.textContent = workspace ? baseName(workspace) : "워크스페이스 없음";
  workspaceButton.title = workspace
    ? `${workspace}\n클릭해 변경 · 우클릭으로 해제`
    : "세션에서 사용할 폴더를 선택합니다";

  const mode = sessionMeta?.permissionMode || "chat";
  permissionSelect.value = mode;
  for (const option of permissionSelect.options) {
    if (option.value !== "chat") {
      option.disabled = !workspace;
      option.title = workspace ? "" : "먼저 워크스페이스를 선택하세요";
    }
  }

  const hints = [];
  for (const provider of providers) {
    if (provider.status !== "cli") continue;
    const info = provider.permissions?.[mode];
    if (info) {
      hints.push(`${provider.name}: ${ENFORCEMENT_LABEL[info.enforcement] || info.enforcement}`);
    }
  }
  enforcementHint.textContent = hints.length > 0 ? `적용 방식 — ${hints.join(" · ")}` : "";

  const discussable = agents.filter((agent) => agent.available && agent.enabled).length >= 2;
  discussionButton.disabled = !discussable;
  discussionButton.title = discussable
    ? "활성 에이전트들이 정해진 라운드만큼 토론합니다"
    : "토론에는 사용 가능한 에이전트가 두 명 이상 필요합니다";
}

// --- 에이전트 칩 + 팝오버 ---
function renderAgents() {
  agentChips.textContent = "";
  for (const agent of agents) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "agent-chip";
    chip.dataset.agentId = agent.id;
    chip.style.setProperty("--agent-color", agent.color);
    if (!agent.available || !agent.enabled) chip.classList.add("is-unavailable");
    if (typingAgents.has(agent.id)) chip.classList.add("is-typing");
    chip.title = agent.available
      ? agent.enabled
        ? "클릭해 모델/속도 설정"
        : "이 세션에서 비활성화됨 · 클릭해 설정"
      : agent.reason || "CLI를 찾지 못했습니다";

    const avatar = makeAgentAvatar(agent, "agent-avatar");
    chip.append(avatar, document.createTextNode(`@${agent.id}`));
    chip.addEventListener("click", () => openAgentPopover(chip, agent.id));
    agentChips.append(chip);
  }
}

function closePopover() {
  popover.hidden = true;
  popover.textContent = "";
  popoverBackdrop.hidden = true;
}

function openPopover(anchor, build) {
  popover.textContent = "";
  build(popover);
  popover.hidden = false;
  popoverBackdrop.hidden = false;
  const rect = anchor.getBoundingClientRect();
  const popRect = popover.getBoundingClientRect();
  let left = Math.min(rect.left, window.innerWidth - popRect.width - 12);
  let top = rect.bottom + 6;
  if (top + popRect.height > window.innerHeight - 8) {
    top = Math.max(8, rect.top - popRect.height - 6);
  }
  popover.style.left = `${Math.max(8, left)}px`;
  popover.style.top = `${top}px`;
}

popoverBackdrop.addEventListener("click", closePopover);
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !popover.hidden) closePopover();
});

function makeField(labelText, control) {
  const field = document.createElement("label");
  field.className = "popover-field";
  const label = document.createElement("span");
  label.textContent = labelText;
  field.append(label, control);
  return field;
}

function openAgentPopover(anchor, agentId) {
  const agent = agentById(agentId);
  const provider = providerById(agentId);
  if (!agent || !provider) return;
  const config = sessionMeta?.agents?.[agentId] || {};

  openPopover(anchor, (root) => {
    const head = document.createElement("div");
    head.className = "popover-head";
    const dot = makeAgentAvatar(agent, "popover-avatar");
    const name = document.createElement("strong");
    name.textContent = `${agent.name} (@${agent.id})`;
    head.append(dot, name);
    root.append(head);

    const status = document.createElement("p");
    status.className = "popover-status";
    if (provider.status === "cli") {
      status.textContent = `CLI 확인됨 · ${provider.version || ""}`;
    } else {
      status.classList.add("is-warning");
      status.textContent = provider.reason || "CLI를 사용할 수 없습니다.";
    }
    root.append(status);

    // 참가 토글
    const enableToggle = document.createElement("input");
    enableToggle.type = "checkbox";
    enableToggle.checked = agent.enabled;
    enableToggle.disabled = !provider.available;
    enableToggle.addEventListener("change", () => {
      configureAgent(agentId, { enabled: enableToggle.checked });
    });
    root.append(makeField("이 세션에 참여", enableToggle));

    // 모델 선택
    const modelSelect = document.createElement("select");
    const modelOptions = (provider.modelOptions || (provider.models || []).map((id) => ({ id, label: id })))
      .filter((model) => model.id !== "default");
    for (const model of modelOptions) {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.label || model.id;
      modelSelect.append(option);
    }
    const currentModel = agent.model;
    if (!modelOptions.some((option) => option.id === currentModel)) {
      const legacyOption = document.createElement("option");
      legacyOption.value = currentModel;
      legacyOption.textContent = `${currentModel} (현재 설정 · 목록에 없음)`;
      modelSelect.append(legacyOption);
    }
    modelSelect.value = currentModel;
    modelSelect.disabled = !provider.available;
    modelSelect.addEventListener("change", () => {
      const availableEfforts = effortsForModel(modelSelect.value);
      const suffixEffort = modelSelect.value.match(/-(low|medium|high)$/i)?.[1]?.toLowerCase();
      const nextEffort = availableEfforts.includes(suffixEffort)
        ? suffixEffort
        : availableEfforts.includes("medium") ? "medium" : availableEfforts[0];
      populateEfforts(modelSelect.value, nextEffort);
      configureAgent(agentId, { model: modelSelect.value, effort: nextEffort });
    });
    root.append(makeField("모델", modelSelect));

    // 속도/노력 선택
    const effortSelect = document.createElement("select");
    function effortsForModel(modelId) {
      const option = modelOptions.find((entry) => entry.id === modelId);
      const efforts = option?.efforts?.length ? option.efforts : provider.efforts || [];
      return efforts.filter((effort) => effort !== "default");
    }
    function populateEfforts(modelId, selected) {
      effortSelect.textContent = "";
      const efforts = effortsForModel(modelId);
      for (const effort of efforts) {
        const option = document.createElement("option");
        option.value = effort;
        option.textContent = effortLabel(effort);
        effortSelect.append(option);
      }
      effortSelect.value = efforts.includes(selected) ? selected : efforts[0] || "";
      effortSelect.disabled = !provider.available || efforts.length <= 1;
    }
    populateEfforts(currentModel, agent.effort);
    if (effortSelect.disabled && provider.status !== "cli") {
      effortSelect.title = "CLI 설치 후 사용할 수 있습니다";
    } else if (effortsForModel(currentModel).length <= 1) {
      effortSelect.title = "이 CLI에서 검증된 속도 옵션이 없습니다";
    }
    effortSelect.addEventListener("change", () => {
      configureAgent(agentId, { effort: effortSelect.value });
    });
    root.append(makeField("속도/노력", effortSelect));

    const autoApproveToggle = document.createElement("input");
    autoApproveToggle.type = "checkbox";
    autoApproveToggle.checked = Boolean(config.autoApprove);
    autoApproveToggle.disabled = !provider.available || sessionMeta?.permissionMode !== "workspace-write";
    autoApproveToggle.title = autoApproveToggle.disabled
      ? "워크스페이스 쓰기 권한에서만 사용할 수 있습니다"
      : "이 에이전트가 요청하는 도구 권한을 개별 확인 없이 승인합니다";
    autoApproveToggle.addEventListener("change", async () => {
      if (autoApproveToggle.checked) {
        const confirmed = window.confirm(
          `${agent.name}의 도구 자동 승인을 켤까요?\n명령 실행과 파일 변경이 개별 확인 없이 진행됩니다. 신뢰하는 워크스페이스에서만 사용하세요.`
        );
        if (!confirmed) { autoApproveToggle.checked = false; return; }
      }
      await configureAgent(agentId, { autoApprove: autoApproveToggle.checked });
    });
    root.append(makeField("도구 자동 승인", autoApproveToggle));

    if (provider.status === "gui-only" || provider.status === "absent") {
      const hint = document.createElement("p");
      hint.className = "popover-hint";
      hint.textContent =
        provider.status === "gui-only"
          ? "GUI 앱은 감지되었지만 CLI가 없어 채팅에는 참여할 수 없습니다."
          : "CLI가 설치되어 있지 않습니다.";
      root.append(hint);
    }
  });
}

async function configureAgent(agentId, patch) {
  const result = await call(window.chatApi.agentConfigure(activeSessionId, agentId, patch));
  if (result?.meta) {
    sessionMeta = result.meta;
    renderHeader();
  }
}

// --- 토론 팝오버 ---
discussionButton.addEventListener("click", () => {
  openPopover(discussionButton, (root) => {
    const head = document.createElement("div");
    head.className = "popover-head";
    const title = document.createElement("strong");
    title.textContent = "에이전트 토론";
    head.append(title);
    root.append(head);

    const desc = document.createElement("p");
    desc.className = "popover-status";
    desc.textContent = "한 턴씩 차례로 말하고, 합의·결론·패스가 이어지면 스스로 끝냅니다.";
    root.append(desc);

    const checkboxes = [];
    for (const agent of agents) {
      if (!agent.available || !agent.enabled) continue;
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = true;
      checkbox.dataset.agentId = agent.id;
      checkboxes.push(checkbox);
      root.append(makeField(`@${agent.id} (${agent.name})`, checkbox));
    }

    const startBtn = document.createElement("button");
    startBtn.type = "button";
    startBtn.className = "button button-primary popover-submit";
    startBtn.textContent = "토론 시작";
    startBtn.addEventListener("click", async () => {
      const agentIds = checkboxes
        .filter((checkbox) => checkbox.checked)
        .map((checkbox) => checkbox.dataset.agentId);
      if (agentIds.length < 2) {
        flashNotice("토론에는 두 명 이상을 선택해야 합니다.");
        return;
      }
      closePopover();
      await call(window.chatApi.discussionStart(activeSessionId, agentIds));
    });
    root.append(startBtn);
  });
});

// --- 워크스페이스 / 권한 ---
workspaceButton.addEventListener("click", async () => {
  const result = await call(window.chatApi.workspaceChoose(activeSessionId));
  if (result && !result.canceled && result.meta) {
    sessionMeta = result.meta;
    sessions = result.sessions || sessions;
    renderSessions();
    renderHeader();
  }
});

workspaceButton.addEventListener("contextmenu", async (event) => {
  event.preventDefault();
  if (!sessionMeta?.workspace) return;
  const result = await call(window.chatApi.workspaceClear(activeSessionId));
  if (result?.meta) {
    sessionMeta = result.meta;
    sessions = result.sessions || sessions;
    renderSessions();
    renderHeader();
  }
});

permissionSelect.addEventListener("change", async () => {
  const result = await call(window.chatApi.permissionSet(activeSessionId, permissionSelect.value));
  if (result?.meta) {
    sessionMeta = result.meta;
  }
  renderHeader();
});

// --- 메시지 렌더링 (모든 텍스트는 textContent로만 삽입) ---
function renderInlineTokens(container, tokens) {
  for (const token of tokens) {
    if (token.type === "code") {
      const code = document.createElement("code");
      code.className = "inline-code";
      code.textContent = token.text;
      container.append(code);
    } else if (token.type === "bold") {
      const strong = document.createElement("strong");
      strong.textContent = token.text;
      container.append(strong);
    } else if (token.type === "link") {
      const anchor = document.createElement("a");
      anchor.href = token.href;
      anchor.textContent = token.text;
      anchor.rel = "noreferrer noopener";
      anchor.addEventListener("click", (event) => event.preventDefault());
      anchor.title = "외부 링크는 채팅창에서 열리지 않습니다";
      container.append(anchor);
    } else if (token.type === "mention") {
      const span = document.createElement("span");
      span.className = "mention";
      span.textContent = token.text;
      container.append(span);
    } else {
      container.append(document.createTextNode(token.text));
    }
  }
}

function renderRichText(container, text) {
  const blocks = chatMarkdown.tokenizeBlocks(text);
  if (blocks.length === 0) {
    container.textContent = text;
    return;
  }
  for (const block of blocks) {
    if (block.type === "fence") {
      const wrap = document.createElement("div");
      wrap.className = "code-block";
      const bar = document.createElement("div");
      bar.className = "code-bar";
      const lang = document.createElement("span");
      lang.textContent = block.lang || "code";
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "code-copy";
      copyBtn.textContent = "복사";
      copyBtn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(block.code);
          copyBtn.textContent = "복사됨";
          setTimeout(() => {
            copyBtn.textContent = "복사";
          }, 1500);
        } catch {}
      });
      bar.append(lang, copyBtn);
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = block.code;
      pre.append(code);
      wrap.append(bar, pre);
      container.append(wrap);
    } else if (block.type === "list") {
      const list = document.createElement(block.ordered ? "ol" : "ul");
      list.className = "md-list";
      for (const itemTokens of block.items) {
        const item = document.createElement("li");
        renderInlineTokens(item, itemTokens);
        list.append(item);
      }
      container.append(list);
    } else {
      const paragraph = document.createElement("p");
      paragraph.className = "md-paragraph";
      block.lines.forEach((lineTokens, lineIndex) => {
        if (lineIndex > 0) paragraph.append(document.createElement("br"));
        renderInlineTokens(paragraph, lineTokens);
      });
      container.append(paragraph);
    }
  }
}

function renderTextWithMentions(container, text) {
  renderInlineTokens(
    container,
    chatMarkdown.tokenizeInline(text).map((token) =>
      token.type === "mention" ? token : { type: "text", text: token.text ?? token.href ?? "" }
    )
  );
}

function formatBytes(size) {
  if (size < 1024) return `${size}B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)}KB`;
  return `${(size / 1024 / 1024).toFixed(1)}MB`;
}

function makeAttachmentPill(attachment, { removable = false } = {}) {
  const pill = document.createElement("span");
  pill.className = "attachment-pill";
  pill.title = `${attachment.name} · ${attachment.mime} · ${formatBytes(attachment.size)}`;

  if (attachment.kind === "image") {
    const img = document.createElement("img");
    img.className = "attachment-thumb";
    img.alt = attachment.name;
    window.chatApi
      .attachmentsPreview(activeSessionId, attachment.id)
      .then((result) => {
        if (result?.ok && result.dataUrl) img.src = result.dataUrl;
      })
      .catch(() => {});
    pill.append(img);
  } else {
    const icon = document.createElement("span");
    icon.className = "attachment-icon";
    icon.textContent = attachment.kind === "text" ? "📄" : "📦";
    pill.append(icon);
  }

  const name = document.createElement("span");
  name.className = "attachment-name";
  name.textContent = attachment.name;
  pill.append(name);

  if (removable) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "attachment-remove";
    remove.textContent = "×";
    remove.title = "첨부 제거";
    remove.addEventListener("click", async () => {
      const result = await call(window.chatApi.attachmentsRemove(activeSessionId, attachment.id));
      if (result) {
        pendingAttachments = result.pendingAttachments || [];
        renderPendingAttachments();
      }
    });
    pill.append(remove);
  }
  return pill;
}

function formatTime(ts) {
  const date = new Date(ts);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function isNearBottom() {
  return chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 80;
}

function scrollToBottom(force = false) {
  if (force || isNearBottom()) chatScroll.scrollTop = chatScroll.scrollHeight;
}

function renderMessage(message) {
  const item = document.createElement("li");
  item.className = "message";

  if (message.authorType === "system") {
    item.classList.add("is-system");
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = message.text;
    item.append(bubble);
    return item;
  }

  const isUser = message.authorType === "user";
  if (isUser) item.classList.add("is-user");
  if (message.error) item.classList.add("is-error");

  const agent = isUser ? null : agentById(message.author);
  const name = isUser ? "나" : agent ? agent.name : message.author;
  const color = isUser ? "var(--accent)" : agent ? agent.color : "#52525b";

  const body = document.createElement("div");
  body.className = "body";

  const meta = document.createElement("div");
  meta.className = "meta";
  const nameEl = document.createElement("span");
  nameEl.className = "name";
  const agentMeta = message.agentMeta || {};
  const metaParts = isUser ? [name] : [name, `@${message.author}`];
  if (!isUser) {
    const shownModel = agentMeta.model && agentMeta.model !== "default" ? agentMeta.model : agent?.model;
    const shownEffort = agentMeta.effort && agentMeta.effort !== "default" ? agentMeta.effort : agent?.effort;
    metaParts.push(shownModel || "모델 확인 불가", effortLabel(shownEffort || "추론 강도 확인 불가"));
  }
  nameEl.textContent = metaParts.join(" · ");
  const timeEl = document.createElement("span");
  timeEl.textContent = formatTime(message.ts);
  meta.append(nameEl, timeEl);

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (message.error) {
    bubble.textContent = `⚠ ${message.text}`;
  } else if (isUser) {
    renderTextWithMentions(bubble, message.text);
  } else {
    bubble.classList.add("is-rich");
    renderAgentMessageContent(bubble, message);
  }

  if (Array.isArray(message.attachments) && message.attachments.length > 0) {
    const attachWrap = document.createElement("div");
    attachWrap.className = "message-attachments";
    for (const attachment of message.attachments) {
      attachWrap.append(makeAttachmentPill(attachment));
    }
    bubble.append(attachWrap);
  }

  // 전달 배지: 일부 첨부가 이 에이전트로 전달되지 못한 경우 표시
  if (Array.isArray(message.deliveries)) {
    const failed = message.deliveries.filter((delivery) => delivery.method === "unsupported");
    if (failed.length > 0) {
      const badge = document.createElement("div");
      badge.className = "delivery-badge";
      badge.textContent = `⚠ 첨부 ${failed.length}개는 이 에이전트에 전달되지 않았습니다`;
      bubble.append(badge);
    }
  }

  body.append(meta, bubble);

  if (!isUser) {
    const avatar = makeAgentAvatar(agent || { id: message.author, name, color });
    item.append(avatar, body);
  } else {
    item.append(body);
  }
  return item;
}

function appendMessage(message) {
  const stick = isNearBottom();
  // 같은 runId의 라이브 초안이 있으면 정식 메시지로 대체합니다.
  if (message.runId && liveRuns.has(message.runId)) {
    const live = liveRuns.get(message.runId);
    live.item.remove();
    liveRuns.delete(message.runId);
  }
  messageList.append(renderMessage(message));
  scrollToBottom(stick || message.authorType === "user");
}

function renderAllMessages(messages) {
  messageList.textContent = "";
  liveRuns.clear();
  for (const message of messages || []) {
    messageList.append(renderMessage(message));
  }
}

// --- 실시간 실행 이벤트 (스트리밍/상태) ---
function handleRunEvent(payload) {
  if (payload.sessionId !== activeSessionId) return;
  const { runId, agentId, kind } = payload;

  if (kind === "run-start") {
    const agent = agentById(agentId);
    const item = document.createElement("li");
    item.className = "message is-live";
    const avatar = makeAgentAvatar(agent || { id: agentId, name: agentId });
    const body = document.createElement("div");
    body.className = "body";
    const meta = document.createElement("div");
    meta.className = "meta";
    const nameEl = document.createElement("span");
    nameEl.className = "name";
    const liveMeta = [agent?.name || agentId, `@${agentId}`];
    liveMeta.push(agent?.model || "모델 확인 중");
    liveMeta.push(effortLabel(agent?.effort || "추론 강도 확인 중"));
    liveMeta.push("응답 중");
    nameEl.textContent = liveMeta.join(" · ");
    meta.append(nameEl);
    const bubble = document.createElement("div");
    bubble.className = "bubble is-live-bubble";
    const statusEl = document.createElement("div");
    statusEl.className = "live-status";
    statusEl.textContent = "…";
    const textEl = document.createElement("div");
    textEl.className = "live-text";
    bubble.append(statusEl, textEl);
    body.append(meta, bubble);
    item.append(avatar, body);
    messageList.append(item);
    liveRuns.set(runId, { item, statusEl, textEl, text: "" });
    scrollToBottom();
    return;
  }

  const live = liveRuns.get(runId);
  if (!live) return;
  if (kind === "status") {
    live.statusEl.textContent = payload.label || "";
  } else if (kind === "delta") {
    live.text += payload.text || "";
    live.textEl.textContent = live.text;
    live.statusEl.textContent = "";
    scrollToBottom();
  } else if (kind === "run-end") {
    // 정식 메시지가 곧 도착하므로 초안은 짧게 유지하되, 실패 시 즉시 제거합니다.
    if (!payload.ok) {
      live.item.remove();
      liveRuns.delete(runId);
    }
  }
}

// --- 타이핑 표시 ---
function renderTyping() {
  typingRow.textContent = "";
  const active = [...typingAgents].map(agentById).filter(Boolean);
  typingRow.hidden = active.length === 0;
  stopButton.hidden = active.length === 0;
  for (const agent of active) {
    const pill = document.createElement("span");
    pill.className = "typing-pill";
    pill.style.setProperty("--agent-color", agent.color);
    const dots = document.createElement("span");
    dots.className = "dots";
    dots.append(document.createElement("i"), document.createElement("i"), document.createElement("i"));
    pill.append(dots, document.createTextNode(`${agent.name} 입력 중`));
    typingRow.append(pill);
  }
  renderAgents();
  scrollToBottom();
}

// --- 첨부 (작성 중) ---
function renderPendingAttachments() {
  attachmentRow.textContent = "";
  attachmentRow.hidden = pendingAttachments.length === 0;
  for (const attachment of pendingAttachments) {
    attachmentRow.append(makeAttachmentPill(attachment, { removable: true }));
  }
}

attachButton.addEventListener("click", async () => {
  const result = await call(window.chatApi.attachmentsAdd(activeSessionId));
  if (!result) return;
  pendingAttachments = result.pendingAttachments || pendingAttachments;
  for (const failure of result.errors || []) {
    flashNotice(`${failure.name}: ${failure.error}`);
  }
  renderPendingAttachments();
});

composerBox.addEventListener("dragover", (event) => {
  event.preventDefault();
  composerBox.classList.add("is-dragover");
});
composerBox.addEventListener("dragleave", () => composerBox.classList.remove("is-dragover"));
composerBox.addEventListener("drop", async (event) => {
  event.preventDefault();
  composerBox.classList.remove("is-dragover");
  const paths = [...(event.dataTransfer?.files || [])]
    .map((file) => window.chatApi.pathForFile(file))
    .filter(Boolean);
  if (paths.length === 0) return;
  const result = await call(window.chatApi.attachmentsAddDropped(activeSessionId, paths));
  if (!result) return;
  pendingAttachments = result.pendingAttachments || pendingAttachments;
  for (const failure of result.errors || []) {
    flashNotice(`${failure.name}: ${failure.error}`);
  }
  renderPendingAttachments();
});

// --- 멘션 자동완성 ---
function mentionTargets() {
  return [
    ...agents.map((agent) => ({
      alias: agent.aliases[0],
      label: agent.name,
      color: agent.color,
      available: agent.available && agent.enabled,
    })),
    {
      alias: "모두",
      label: "모든 에이전트",
      color: "#52525b",
      available: agents.some((agent) => agent.available && agent.enabled),
    },
  ];
}

function closeMentionPopup() {
  mentionState = null;
  mentionPopup.hidden = true;
  mentionPopup.textContent = "";
}

function updateMentionPopup() {
  const caret = composerInput.selectionStart;
  const value = composerInput.value.slice(0, caret);
  const match = value.match(/(^|[\s([{])@([\p{L}\p{N}_-]*)$/u);
  if (!match) {
    closeMentionPopup();
    return;
  }
  const query = match[2].toLowerCase();
  const options = mentionTargets().filter((target) =>
    target.alias.toLowerCase().startsWith(query)
  );
  if (options.length === 0) {
    closeMentionPopup();
    return;
  }
  const start = caret - query.length;
  const previousAlias =
    mentionState && mentionState.options[mentionState.index]
      ? mentionState.options[mentionState.index].alias
      : null;
  const keptIndex = options.findIndex((option) => option.alias === previousAlias);
  mentionState = { start, query, options, index: keptIndex >= 0 ? keptIndex : 0 };

  mentionPopup.textContent = "";
  options.forEach((option, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mention-option";
    button.setAttribute("role", "option");
    if (index === mentionState.index) button.classList.add("is-active");
    if (!option.available) button.classList.add("is-unavailable");
    button.style.setProperty("--agent-color", option.color);

    const dot = document.createElement("i");
    dot.className = "dot";
    const alias = document.createElement("span");
    alias.className = "alias";
    alias.textContent = `@${option.alias}`;
    const desc = document.createElement("span");
    desc.className = "desc";
    desc.textContent = option.available ? option.label : `${option.label} · 사용 불가`;
    button.append(dot, alias, desc);
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      acceptMention(index);
    });
    mentionPopup.append(button);
  });
  mentionPopup.hidden = false;
}

function acceptMention(index) {
  if (!mentionState) return;
  const option = mentionState.options[index];
  if (!option) return;
  const caret = composerInput.selectionStart;
  const before = composerInput.value.slice(0, mentionState.start);
  const after = composerInput.value.slice(caret);
  const inserted = `${option.alias} `;
  composerInput.value = `${before}${inserted}${after}`;
  const nextCaret = mentionState.start + inserted.length;
  composerInput.setSelectionRange(nextCaret, nextCaret);
  closeMentionPopup();
  autoresize();
  composerInput.focus();
}

function moveMentionSelection(delta) {
  if (!mentionState) return;
  const count = mentionState.options.length;
  mentionState.index = (mentionState.index + delta + count) % count;
  [...mentionPopup.children].forEach((child, index) => {
    child.classList.toggle("is-active", index === mentionState.index);
  });
}

// --- 입력창 ---
function autoresize() {
  composerInput.style.height = "auto";
  composerInput.style.height = `${Math.min(composerInput.scrollHeight, 132)}px`;
}

async function sendCurrentMessage() {
  const text = composerInput.value.trim();
  if (!text && pendingAttachments.length === 0) return;
  const attachmentIds = pendingAttachments.map((attachment) => attachment.id);
  composerInput.value = "";
  closeMentionPopup();
  autoresize();
  const result = await call(window.chatApi.send(activeSessionId, text, attachmentIds));
  if (result) {
    pendingAttachments = [];
    renderPendingAttachments();
  }
  composerInput.focus();
}

composerInput.addEventListener("input", () => {
  autoresize();
  updateMentionPopup();
});

composerInput.addEventListener("click", updateMentionPopup);

composerInput.addEventListener("keydown", (event) => {
  if (mentionState && !mentionPopup.hidden) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveMentionSelection(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveMentionSelection(-1);
      return;
    }
    if (event.key === "Tab" || event.key === "Enter") {
      event.preventDefault();
      acceptMention(mentionState.index);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeMentionPopup();
      return;
    }
  }
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendCurrentMessage();
  }
});

composerInput.addEventListener("blur", () => {
  setTimeout(closeMentionPopup, 120);
});

sendButton.addEventListener("click", sendCurrentMessage);
stopButton.addEventListener("click", () => call(window.chatApi.stop(activeSessionId)));

newSessionButton.addEventListener("click", async () => {
  const result = await call(window.chatApi.sessionsCreate());
  if (result) applyFullState(result);
});

refreshProvidersButton.addEventListener("click", async () => {
  const result = await call(window.chatApi.providersRefresh());
  if (result?.providers) {
    providers = result.providers;
    diagnostics = result.diagnostics || diagnostics;
    flashNotice("CLI 탐지를 새로 고쳤습니다.", false);
    renderHeader();
    if (!doctorBackdrop.hidden) renderDoctor();
  }
});

doctorButton.addEventListener("click", () => openDoctor());
doctorClose.addEventListener("click", closeDoctor);
doctorDone.addEventListener("click", closeDoctor);
doctorBackdrop.addEventListener("click", (event) => {
  if (event.target === doctorBackdrop) closeDoctor();
});
doctorRefresh.addEventListener("click", async () => {
  doctorRefresh.disabled = true;
  doctorRefresh.textContent = "진단 중…";
  const result = await call(window.chatApi.providersRefresh());
  if (result?.providers) providers = result.providers;
  if (result?.diagnostics) diagnostics = result.diagnostics;
  renderDoctor();
  renderHeader();
  doctorRefresh.disabled = false;
  doctorRefresh.textContent = "다시 진단";
});

sessionTitleEl.addEventListener("dblclick", () => {
  const entry = activeSessionEntry();
  if (!entry) return;
  const span = document.createElement("span");
  span.textContent = sessionTitleEl.textContent;
  sessionTitleEl.textContent = "";
  sessionTitleEl.append(span);
  startInlineRename(span, entry.id);
});

// --- 타이틀바 ---
document.getElementById("btn-minimize").addEventListener("click", () => window.chatApi.minimize());
document.getElementById("btn-maximize").addEventListener("click", () => window.chatApi.maximize());
document.getElementById("btn-close").addEventListener("click", () => window.chatApi.close());
window.chatApi.onMaximizedState((isMaximized) => {
  document.querySelector(".icon-maximize").style.display = isMaximized ? "none" : "";
  document.querySelector(".icon-restore").style.display = isMaximized ? "" : "none";
});

// --- 상태 적용 ---
function applyFullState(full) {
  if (full.providers) providers = full.providers;
  if (full.diagnostics) diagnostics = full.diagnostics;
  if (full.sessions) sessions = full.sessions;
  if (Object.hasOwn(full, "activeSessionId")) activeSessionId = full.activeSessionId;

  if (full.session) {
    sessionMeta = full.session.meta;
    agents = full.session.agents || [];
    typingAgents.clear();
    for (const agentId of full.session.typing || []) typingAgents.add(agentId);
    pendingAttachments = full.session.pendingAttachments || [];
    renderAllMessages(full.session.messages);
    scrollToBottom(true);
  }

  if (full.error) {
    storeWarning.textContent = `저장소 문제: ${full.error} — 대화가 저장되지 않을 수 있습니다.`;
    storeWarning.classList.add("is-error");
    storeWarning.hidden = false;
  } else if (full.readOnly) {
    storeWarning.textContent =
      "이 .code-pet 저장소는 더 새로운 버전이 만든 것이라 읽기 전용으로 열렸습니다.";
    storeWarning.classList.add("is-error");
    storeWarning.hidden = false;
  }

  renderSessions();
  renderHeader();
  renderAgents();
  renderTyping();
  renderPendingAttachments();
}

// --- 이벤트 구독 ---
window.chatApi.onMessage(({ sessionId, message }) => {
  if (sessionId !== activeSessionId) return;
  appendMessage(message);
});
window.chatApi.onTyping(({ sessionId, agentId, busy }) => {
  if (sessionId !== activeSessionId) return;
  if (busy) typingAgents.add(agentId);
  else typingAgents.delete(agentId);
  renderTyping();
});
window.chatApi.onReset(({ sessionId }) => {
  if (sessionId !== activeSessionId) return;
  renderAllMessages([]);
  typingAgents.clear();
  renderTyping();
});
window.chatApi.onRunEvent(handleRunEvent);
window.chatApi.onSessionsChanged((payload) => {
  sessions = payload.sessions || sessions;
  renderSessions();
  const entry = activeSessionEntry();
  if (entry && sessionMeta && entry.title !== sessionMeta.title) {
    sessionMeta = { ...sessionMeta, title: entry.title };
    renderHeader();
  }
});
window.chatApi.onAgents(({ sessionId, agents: nextAgents }) => {
  if (sessionId !== activeSessionId) return;
  agents = nextAgents || [];
  renderAgents();
  renderHeader();
});
function showNextApproval() {
  if (activeApproval || approvalQueue.length === 0) return;
  activeApproval = approvalQueue.shift();
  const agent = agentById(activeApproval.agentId);
  approvalSummary.textContent = `${agent?.name || activeApproval.agentId}: ${activeApproval.summary}`;
  approvalDetail.textContent = activeApproval.detail || "세부 정보가 없습니다.";
  approvalBackdrop.hidden = false;
}
async function answerApproval(decision) {
  if (!activeApproval) return;
  const current = activeApproval;
  activeApproval = null;
  approvalBackdrop.hidden = true;
  await call(window.chatApi.approvalRespond(current.sessionId, current.approvalId, decision));
  showNextApproval();
}
approvalApprove.addEventListener("click", () => answerApproval("approve"));
approvalDeny.addEventListener("click", () => answerApproval("deny"));
window.chatApi.onApprovalRequest((payload) => {
  approvalQueue.push(payload);
  showNextApproval();
});
window.chatApi.onAppearance(applyAppearance);

// --- 초기화 ---
(async () => {
  const full = await call(window.chatApi.state());
  if (full) {
    applyFullState(full);
    if (localStorage.getItem(DOCTOR_SEEN_KEY) !== "true") openDoctor({ firstRun: true });
  }
  composerInput.focus();
})();

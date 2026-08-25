const { EventEmitter } = require("node:events");
const { GROUP_ALIASES } = require("./chat-agents");
const { parseMentions } = require("./chat-mention");
const { buildAgentPrompt } = require("./chat-prompt");
const { extractEmoticons } = require("./chat-emoticons");

// 채팅방 오케스트레이션.
// - 멘션이 없으면 세션 참가자 전체, 있으면 멘션된 참가자만 응답합니다.
// - 모든 에이전트 발화는 방 전체의 단일 턴 큐를 통과합니다. 한 번에
//   한 명만 말하고, 뒤 순서는 앞 답변이 끝난 뒤 대화 기록을 읽습니다.
// - 에이전트 답변 속 @멘션은 실제 호출입니다: 호출된 에이전트가 이어서
//   응답합니다. 무한 연쇄는 사용자 발화 기준 연쇄 깊이 상한
//   (mentionChainLimit, 기본 2)으로 차단합니다. @ 없이 이름만 쓰면 언급입니다.
// - 에이전트 간 토론은 startDiscussion()으로만, 라운드(1~3)와
//   총 실행 예산 두 가지 상한 아래에서만 진행됩니다.
const DEFAULT_DISCUSSION_RUN_BUDGET = 9;
const DEFAULT_MENTION_CHAIN_LIMIT = 2;
const REPLY_EXCERPT_LIMIT = 200;

let messageSeq = 0;
function nextMessageId() {
  messageSeq += 1;
  return `m${Date.now()}-${messageSeq}`;
}

function cleanReplyField(value, limit) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, limit);
}

function sanitizeReplyTo(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const messageId = cleanReplyField(value.messageId, 160);
  const author = cleanReplyField(value.author, 80);
  const authorType = value.authorType === "user" || value.authorType === "agent"
    ? value.authorType
    : "";
  const excerpt = typeof value.excerpt === "string"
    ? value.excerpt.replace(/\s+/gu, " ").trim().slice(0, REPLY_EXCERPT_LIMIT)
    : "";
  if (!messageId || !author || !authorType || !excerpt) return null;
  return { messageId, author, authorType, excerpt };
}

// 실패 결과를 항상 설명 가능한 문장으로 정규화합니다.
// 우선순위: 명시적 error → 승인 관련 전용 문구 + 실제 원인(detail→summary)
// → 내부 오류 식별자. 어떤 경로로도 "알 수 없는 오류"만 남기지 않습니다.
function describeRunFailure(result, { autoApprove = false, approvedRetry = false } = {}) {
  const explicit = String(result?.error || "").trim();
  if (explicit) return explicit;
  if (result?.approvalRequired) {
    const approval = result.approval || {};
    const cause =
      String(approval.detail || approval.summary || "").trim().slice(0, 600) ||
      "원인이 기록되지 않았습니다";
    if (approvedRetry) return `승인 후 재시도에도 권한을 획득하지 못했습니다: ${cause}`;
    if (autoApprove) return `자동 승인으로 실행했지만 권한 요청이 다시 발생했습니다: ${cause}`;
    return `권한 요청이 처리되지 않았습니다: ${cause}`;
  }
  return "실행이 실패했지만 원인이 기록되지 않았습니다. (내부 오류: run-result-unexplained)";
}

class ChatRoom extends EventEmitter {
  constructor(options = {}) {
    super();
    this.sessionId = options.sessionId || null;
    this.agents = options.agents || [];
    this.maxPromptMessages = options.maxPromptMessages;
    // runAgent({agent, prompt, runId, attachments, emitEvent}) => { promise, cancel }
    this.runAgent = options.runAgent;
    this.prepareAgent = options.prepareAgent;
    this.meta = {
      permissionMode: "chat",
      ...(options.meta || {}),
    };
    this.discussionRunBudget = Number.isInteger(options.discussionRunBudget)
      ? options.discussionRunBudget
      : DEFAULT_DISCUSSION_RUN_BUDGET;
    this.mentionChainLimit = Number.isInteger(options.mentionChainLimit)
      ? options.mentionChainLimit
      : DEFAULT_MENTION_CHAIN_LIMIT;
    // 브로드캐스트 응답 순서 셔플에 쓰는 난수원. 테스트에서 고정 순서를
    // 만들 수 있도록 주입 가능합니다.
    this.random = typeof options.random === "function" ? options.random : Math.random;
    this.messages = Array.isArray(options.initialMessages) ? [...options.initialMessages] : [];
    this.generation = 0;
    this.runSeq = 0;
    this.turnSeq = 0;
    this.turnQueue = [];
    this.deferredTurnQueue = [];
    this.pendingTurns = new Map();
    this.broadcastPositions = new Map();
    this.turnActive = false;
    this.currentTurn = null;
    // 사용자가 "잠깐"으로 개입하면 다음 사용자 발화 전까지 에이전트발
    // 멘션 호출을 만들지 않습니다. (현재 발언자의 답변 속 @도 포함)
    this.mentionsMuted = false;
    this.discussionInterrupted = false;
    this.idleWaiters = [];
    this.discussionActive = false;
    this.discussionRequested = false;
    this.cancels = new Set();
    this.typingCounts = new Map();
    this.activeRuns = 0;
    this.approvalSeq = 0;
    this.pendingApprovals = new Map();
  }

  setAgents(agents) {
    this.agents = agents || [];
    this.emit("agents", this.publicAgents());
  }

  setMeta(patch) {
    this.meta = { ...this.meta, ...patch };
  }

  enabledAgents() {
    return this.agents.filter((agent) => agent.available && agent.enabled !== false);
  }

  // renderer로 나가는 뷰: 실행 경로/셸 정보는 포함하지 않습니다.
  publicAgents() {
    return this.agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      color: agent.color,
      aliases: agent.aliases,
      available: Boolean(agent.available),
      enabled: agent.enabled !== false,
      reason: agent.reason || "",
      model: agent.model || "default",
      effort: agent.effort || "default",
      version: agent.version || "",
      autoApprove: Boolean(agent.autoApprove),
    }));
  }

  state() {
    return {
      sessionId: this.sessionId,
      agents: this.publicAgents(),
      messages: this.messages,
      typing: [...this.typingCounts.keys()],
    };
  }

  appendMessage(message) {
    const entry = { id: nextMessageId(), ts: Date.now(), ...message };
    this.messages.push(entry);
    this.emit("message", entry);
    return entry;
  }

  appendSystem(text) {
    return this.appendMessage({ authorType: "system", author: "system", text });
  }

  findAgent(agentId) {
    return this.agents.find((agent) => agent.id === agentId) || null;
  }

  sendUserMessage(input) {
    const payload = typeof input === "string" ? { text: input } : input || {};
    const trimmed = String(payload.text || "").trim();
    const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
    const replyTo = sanitizeReplyTo(payload.replyTo);
    if (!trimmed && attachments.length === 0) return null;

    const entry = this.appendMessage({
      authorType: "user",
      author: "user",
      text: trimmed,
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(replyTo ? { replyTo } : {}),
    });

    this.mentionsMuted = false;
    const mentionedIds = parseMentions(trimmed, this.agents, GROUP_ALIASES);
    const targets = mentionedIds.length > 0
      ? mentionedIds.map((agentId) => this.findAgent(agentId)).filter(Boolean)
      : this.enabledAgents();
    const respondents = [];
    for (const agent of targets) {
      if (!agent.available) {
        this.appendSystem(
          agent.reason || `@${agent.id} (${agent.name})는 이 컴퓨터에서 CLI를 찾지 못했습니다.`
        );
        continue;
      }
      if (agent.enabled === false) {
        this.appendSystem(`@${agent.id} (${agent.name})는 이 세션에서 비활성화되어 있습니다.`);
        continue;
      }
      respondents.push(agent);
    }

    if (respondents.length > 0) {
      const hasMentions = mentionedIds.length > 0;
      const order = hasMentions
        ? respondents
        : respondents.length > 1 ? this.shuffle(respondents) : respondents;
      order.forEach((agent, index) => {
        this.scheduleResponse(agent, {
          attachments,
          turnRootId: entry.id,
          ...(order.length > 1
            ? { broadcast: { position: index + 1, total: order.length } }
            : {}),
        }, hasMentions ? { priorityIndex: index } : {});
      });
    }
    return entry;
  }

  shuffle(list) {
    const result = [...list];
    for (let i = result.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  requestApproval(agent, approval) {
    this.approvalSeq += 1;
    const approvalId = `a${this.sessionId || "s"}-${this.approvalSeq}`;
    return new Promise((resolve) => {
      this.pendingApprovals.set(approvalId, resolve);
      this.emit("approval-request", {
        approvalId,
        agentId: agent.id,
        summary: approval?.summary || "도구 실행 권한이 필요합니다.",
        detail: approval?.detail || "",
        retryScope: "turn",
      });
    });
  }

  resolveApproval(approvalId, decision) {
    const resolve = this.pendingApprovals.get(approvalId);
    if (!resolve) return false;
    this.pendingApprovals.delete(approvalId);
    resolve(decision === "approve");
    return true;
  }

  // 방 전체 단일 턴 큐. 일반 응답과 멘션 호출은 대기 중인 같은 에이전트의
  // 턴을 공유해, 한 릴레이에서 같은 발언권이 중복 예약되지 않게 합니다.
  scheduleResponse(agent, context = {}, options = {}) {
    const generation = this.generation;
    const dedupeKey = context.discussion || !context.turnRootId
      ? null
      : `${context.turnRootId}:${agent.id}`;
    if (dedupeKey && this.pendingTurns.has(dedupeKey)) {
      const pending = this.pendingTurns.get(dedupeKey);
      const queueIndex = this.turnQueue.indexOf(pending);
      const isMention = Number.isInteger(context.mentionDepth) && context.mentionDepth > 0;
      if (isMention && queueIndex >= 0) {
        pending.context = {
          ...pending.context,
          ...context,
          turnRootId: pending.context.turnRootId,
        };
        if (Number.isInteger(options.priorityIndex)) {
          this.turnQueue.splice(queueIndex, 1);
          const priorityIndex = Math.max(0, Math.min(options.priorityIndex, this.turnQueue.length));
          this.turnQueue.splice(priorityIndex, 0, pending);
        }
        this.emitTurnState();
      }
      return pending.promise;
    }

    let resolveTurn;
    const promise = new Promise((resolve) => {
      resolveTurn = resolve;
    });
    this.turnSeq += 1;
    const item = {
      turnId: `t${this.turnSeq}`,
      agent,
      context,
      generation,
      dedupeKey,
      promise,
      resolve: resolveTurn,
    };
    if (dedupeKey) this.pendingTurns.set(dedupeKey, item);
    const queue = this.discussionActive && !context.discussion
      ? this.deferredTurnQueue
      : this.turnQueue;
    if (queue === this.turnQueue && Number.isInteger(options.priorityIndex)) {
      const priorityIndex = Math.max(0, Math.min(options.priorityIndex, queue.length));
      queue.splice(priorityIndex, 0, item);
    } else {
      queue.push(item);
    }
    this.emitTurnState();
    this.pumpTurnQueue();
    return promise;
  }

  // 발언 큐 UI가 구독하는 방 전체 턴 상태 스냅숏.
  turnState() {
    const view = (item) => ({
      turnId: item.turnId,
      agentId: item.agent.id,
      discussion: Boolean(item.context.discussion),
    });
    return {
      current: this.currentTurn ? this.currentTurn.agent.id : null,
      queue: this.turnQueue.map(view),
      deferred: this.deferredTurnQueue.map(view),
    };
  }

  emitTurnState() {
    this.emit("turn-state", this.turnState());
  }

  // 사용자 개입("잠깐"): 현재 실행과 대기 턴을 모두 중지하고 발언권을
  // 사용자에게 돌려줍니다. 중지 직전에 도착한 응답이나 @멘션도 세대 가드로
  // 버리며, 다음 사용자 발화 전까지 에이전트발 호출을 만들지 않습니다.
  interject() {
    const dropped = this.turnQueue.length + this.deferredTurnQueue.length;
    const interrupted = dropped > 0 || this.currentTurn !== null || this.cancels.size > 0;
    this.stopAllSilently();
    this.mentionsMuted = true;
    if (interrupted) {
      this.appendSystem("사용자가 개입해 진행 중인 응답과 대기 턴을 중지했습니다. 다음 차례는 사용자입니다.");
    }
    this.emitTurnState();
    return { dropped, interrupted };
  }

  // 발언 큐 UI에서 대기 중인 턴 하나를 콕 집어 취소합니다.
  cancelTurn(turnId) {
    for (const queue of [this.turnQueue, this.deferredTurnQueue]) {
      const index = queue.findIndex((item) => item.turnId === turnId);
      if (index < 0) continue;
      const [item] = queue.splice(index, 1);
      if (item.dedupeKey && this.pendingTurns.get(item.dedupeKey) === item) {
        this.pendingTurns.delete(item.dedupeKey);
      }
      item.resolve(undefined);
      this.emitTurnState();
      return true;
    }
    return false;
  }

  async pumpTurnQueue() {
    if (this.turnActive) return;
    this.turnActive = true;
    try {
      while (this.turnQueue.length > 0) {
        const item = this.turnQueue.shift();
        if (item.dedupeKey && this.pendingTurns.get(item.dedupeKey) === item) {
          this.pendingTurns.delete(item.dedupeKey);
        }
        if (item.generation !== this.generation) {
          item.resolve(undefined);
          this.emitTurnState();
          continue;
        }
        this.currentTurn = item;
        this.emitTurnState();
        let outcome;
        try {
          outcome = await this.respond(item.agent, item.context, item.generation);
        } catch {
          outcome = undefined;
        }
        this.currentTurn = null;
        const broadcastRootId = item.context.broadcast && item.context.turnRootId;
        if (broadcastRootId) {
          const hasRemainingBroadcastTurn = [...this.turnQueue, ...this.deferredTurnQueue]
            .some((queued) => queued.context.broadcast
              && queued.context.turnRootId === broadcastRootId);
          if (!hasRemainingBroadcastTurn) this.broadcastPositions.delete(broadcastRootId);
        }
        this.emitTurnState();
        item.resolve(outcome);
      }
    } finally {
      this.turnActive = false;
      this.resolveIdleWaiters();
      // finally 직전에 새 턴이 들어온 극히 짧은 경합도 놓치지 않습니다.
      if (this.turnQueue.length > 0) this.pumpTurnQueue();
    }
  }

  waitForIdle() {
    if (!this.turnActive && this.turnQueue.length === 0 && this.deferredTurnQueue.length === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  resolveIdleWaiters() {
    if (this.turnActive || this.turnQueue.length > 0 || this.deferredTurnQueue.length > 0) return;
    const waiters = this.idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  setTyping(agentId, busy) {
    const count = this.typingCounts.get(agentId) || 0;
    const nextCount = busy ? count + 1 : Math.max(0, count - 1);
    if (nextCount === 0) this.typingCounts.delete(agentId);
    else this.typingCounts.set(agentId, nextCount);
    this.emit("typing", { agentId, busy: nextCount > 0 });
  }

  trackRunStart() {
    this.activeRuns += 1;
    if (this.activeRuns === 1) this.emit("busy", true);
  }

  trackRunEnd() {
    this.activeRuns = Math.max(0, this.activeRuns - 1);
    if (this.activeRuns === 0) this.emit("busy", false);
  }

  promptMessages() {
    return this.messages.filter(
      (message) => message.authorType !== "system" && !message.error
    );
  }

  async respond(agent, context = {}, generation = this.generation) {
    if (generation !== this.generation) return;
    if (typeof this.runAgent !== "function") return;

    // 큐에서 기다리는 사이 참가자가 비활성화되거나 CLI가 사라졌다면 실행하지 않습니다.
    const currentAgent = this.findAgent(agent.id);
    if (!currentAgent || !currentAgent.available || currentAgent.enabled === false) return;
    agent = currentAgent;

    const mentionDepth = context.mentionDepth || 0;
    let broadcast = context.broadcast || null;
    if (broadcast && context.turnRootId) {
      const position = (this.broadcastPositions.get(context.turnRootId) || 0) + 1;
      this.broadcastPositions.set(context.turnRootId, position);
      broadcast = { ...broadcast, position };
    }

    const prompt = buildAgentPrompt({
      agent,
      agents: this.enabledAgents(),
      messages: this.promptMessages(),
      maxMessages: this.maxPromptMessages,
      permissionMode: this.meta.permissionMode,
      discussion: context.discussion || null,
      broadcast,
      mentionsEnabled: !context.discussion && mentionDepth < this.mentionChainLimit,
    });

    let result;
    let runId;
    let approvedRetry = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      this.runSeq += 1;
      runId = `r${this.sessionId || "s"}-${this.runSeq}`;
      const emitEvent = (event) => {
        if (generation !== this.generation || !event) return;
        this.emit("run-event", { runId, agentId: agent.id, ...event });
      };
      this.setTyping(agent.id, true);
      this.trackRunStart();
      emitEvent({ kind: "run-start" });
      let run;
      try {
        if (typeof this.prepareAgent === "function") {
          await this.prepareAgent({ agent, runId });
          if (generation !== this.generation) return;
        }
        run = this.runAgent({
          agent,
          prompt,
          runId,
          attachments: context.attachments || [],
          emitEvent,
          autoApprove: agent.autoApprove || approvedRetry,
        });
        this.cancels.add(run.cancel);
        result = await run.promise;
      } catch (error) {
        const detail = error?.message || (error == null ? "" : String(error));
        result = { ok: false, error: detail || "에이전트 실행 중 내부 오류가 발생했습니다." };
      } finally {
        if (run) this.cancels.delete(run.cancel);
        this.setTyping(agent.id, false);
        this.trackRunEnd();
      }
      if (generation !== this.generation || result?.cancelled) return;
      emitEvent({ kind: "run-end", ok: Boolean(result?.ok) });
      if (!result?.approvalRequired || agent.autoApprove || approvedRetry) break;
      const approved = await this.requestApproval(agent, result.approval);
      if (generation !== this.generation) return;
      if (!approved) {
        result = { ok: false, error: "권한 요청을 거부했습니다." };
        break;
      }
      approvedRetry = true;
    }

    // 세대가 바뀌었으면(중지/초기화) 결과를 버립니다. 늦게 도착한 응답이
    // 새 대화에 끼어드는 것을 막는 stale-run 가드입니다.
    if (generation !== this.generation || result?.cancelled) return;

    if (!result?.ok) {
      // 진단 기록에 자동 승인/재시도 맥락을 더해 transcript에 함께 저장합니다.
      const diagnostics = result?.diagnostics
        ? { ...result.diagnostics, autoApprove: Boolean(agent.autoApprove), approvedRetry }
        : null;
      this.appendMessage({
        authorType: "agent",
        author: agent.id,
        text: describeRunFailure(result, {
          autoApprove: Boolean(agent.autoApprove),
          approvedRetry,
        }),
        error: true,
        runId,
        ...(diagnostics ? { diagnostics } : {}),
      });
      return { ok: false };
    }

    let rawText = String(result.text || "").trim();
    let discussionSignal = null;
    if (context.discussion) {
      const match = rawText.match(/\[\[CODEPET_DISCUSSION:(CONTINUE|AGREE|PASS|CONCLUDE)\]\]\s*$/i);
      discussionSignal = match ? match[1].toUpperCase() : "CONTINUE";
      if (match) rawText = rawText.slice(0, match.index).trim();
    }

    const extracted = extractEmoticons(rawText, undefined, agent.id);
    let text = extracted.text;
    const emoticons = extracted.emoticons;
    if (context.discussion) {
      if (discussionSignal === "AGREE" && !text) {
        text = "동의합니다.";
        extracted.parts.unshift({ type: "text", text });
      }
      if (discussionSignal === "PASS" && !text) return { ok: true, discussionSignal };
    }

    this.appendMessage({
      authorType: "agent",
      author: agent.id,
      text,
      runId,
      agentMeta: {
        model: agent.model || "default",
        effort: agent.effort || "default",
        version: agent.version || "",
      },
      ...(emoticons.length > 0 ? { emoticons } : {}),
      ...(emoticons.length > 0 ? { contentParts: extracted.parts } : {}),
      ...(result.deliveries ? { deliveries: result.deliveries } : {}),
      ...(result.workspaceChangeSet ? { workspaceChangeSet: result.workspaceChangeSet } : {}),
    });
    // 토론 모드는 자체 턴 오케스트레이션이 있으므로 멘션 호출을 만들지 않습니다.
    if (!context.discussion) {
      this.scheduleMentionReplies(
        agent,
        text,
        mentionDepth,
        context.attachments || [],
        context.turnRootId
      );
    }
    return { ok: true, discussionSignal };
  }

  // 에이전트가 @이름으로 부르면 그 에이전트가 실제로 이어서 응답합니다.
  // 자기 자신은 제외하고, 그룹 별칭 호출은 허용하지 않으며(폭주 방지),
  // 연쇄 깊이 상한으로 무한 호출을 막습니다.
  scheduleMentionReplies(agent, text, depth, attachments = [], turnRootId = null) {
    if (this.mentionsMuted) return;
    if (depth >= this.mentionChainLimit) return;
    const mentionedIds = parseMentions(text, this.agents).filter((id) => id !== agent.id);
    let priorityIndex = 0;
    for (const agentId of mentionedIds) {
      const target = this.findAgent(agentId);
      if (!target || !target.available || target.enabled === false) continue;
      this.scheduleResponse(
        target,
        { mentionDepth: depth + 1, attachments, turnRootId },
        { priorityIndex }
      );
      priorityIndex += 1;
    }
  }

  // 자율 토론: 차례대로 말하되 합의/패스/결론 신호에 따라 일찍 끝냅니다.
  async startDiscussion(options = {}) {
    let pool = this.enabledAgents();
    if (Array.isArray(options.agentIds) && options.agentIds.length > 0) {
      const wanted = new Set(options.agentIds);
      pool = pool.filter((agent) => wanted.has(agent.id));
    }
    if (pool.length < 2) {
      return { ok: false, error: "토론에는 사용 가능한 에이전트가 두 명 이상 필요합니다." };
    }
    if (this.discussionRequested || this.discussionActive) {
      return { ok: false, error: "이미 토론이 진행 중입니다." };
    }

    const requestedGeneration = this.generation;
    this.discussionRequested = true;
    await this.waitForIdle();
    if (requestedGeneration !== this.generation) {
      this.discussionRequested = false;
      return { ok: false, cancelled: true };
    }
    this.discussionActive = true;

    const budget = this.discussionRunBudget;
    this.appendSystem(
      `자율 토론 시작 · ${pool.map((agent) => `@${agent.id}`).join(", ")} · 최대 ${budget}턴`
    );

    const generation = this.generation;
    let completed = 0;
    let settled = 0;
    let concluded = false;
    try {
      for (let turn = 1; turn <= budget; turn += 1) {
        if (generation !== this.generation) break;
        if (this.discussionInterrupted) { concluded = true; break; }
        const agent = pool[(turn - 1) % pool.length];
        const outcome = await this.scheduleResponse(agent, {
          discussion: { turn, maxTurns: budget },
        });
        completed += 1;
        const signal = outcome?.discussionSignal || "CONTINUE";
        if (signal === "CONCLUDE") { concluded = true; break; }
        if (signal === "AGREE" || signal === "PASS") settled += 1;
        else settled = 0;
        if (settled >= pool.length) { concluded = true; break; }
      }

      if (generation === this.generation) {
        if (this.discussionInterrupted) {
          this.appendSystem("사용자 개입으로 토론을 여기서 마쳤습니다.");
        } else if (!concluded && completed >= budget) {
          this.appendSystem(`토론 실행 예산(${budget}회)에 도달해 여기서 마쳤습니다.`);
        } else {
          this.appendSystem("참가자들이 합의하거나 결론에 도달해 토론을 마쳤습니다.");
        }
      }
    } finally {
      this.discussionActive = false;
      this.discussionRequested = false;
      this.discussionInterrupted = false;
      this.turnQueue.push(...this.deferredTurnQueue.splice(0));
      this.emitTurnState();
      this.pumpTurnQueue();
    }
    return { ok: true, completed, truncated: !concluded && completed >= budget, concluded };
  }

  stopAll() {
    const hadWork = this.cancels.size > 0 || this.typingCounts.size > 0
      || this.turnQueue.length > 0 || this.deferredTurnQueue.length > 0;
    this.stopAllSilently();
    if (hadWork) this.appendSystem("응답을 중지했습니다.");
  }

  clear() {
    this.stopAllSilently();
    this.messages = [];
    this.emit("reset");
  }

  stopAllSilently() {
    this.generation += 1;
    for (const item of [...this.turnQueue, ...this.deferredTurnQueue]) item.resolve(undefined);
    this.turnQueue = [];
    this.deferredTurnQueue = [];
    this.pendingTurns.clear();
    this.broadcastPositions.clear();
    this.mentionsMuted = false;
    this.emitTurnState();
    for (const resolve of this.pendingApprovals.values()) resolve(false);
    this.pendingApprovals.clear();
    for (const cancel of this.cancels) {
      try {
        cancel();
      } catch {}
    }
    this.cancels.clear();
    for (const agentId of [...this.typingCounts.keys()]) {
      this.typingCounts.delete(agentId);
      this.emit("typing", { agentId, busy: false });
    }
    if (this.activeRuns > 0) {
      this.activeRuns = 0;
      this.emit("busy", false);
    }
    this.resolveIdleWaiters();
  }
}

module.exports = { ChatRoom, describeRunFailure, DEFAULT_DISCUSSION_RUN_BUDGET };

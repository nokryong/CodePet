const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ChatStore, readJsonlTolerant } = require("./chat-store");
const {
  createCapabilityService,
  toPublicProviders,
} = require("../providers/provider-capabilities");
const { toDiagnostics } = require("../providers/provider-diagnostics");
const { roomAgentsFromCapabilities } = require("./chat-agents");
const { identityPatch, aliasKey } = require("./chat-agent-identity");
const { selectionError } = require("../providers/provider-model-catalog");
const { ChatRoom } = require("./chat-room");
const { ChatActivity } = require("./chat-activity");
const { CodexChatAccounts, FILE_AUTH_ARGS } = require("./codex-chat-accounts");
const { CodexChatRuntime } = require("./codex-chat-runtime");
const { SavedChatAccounts } = require("./saved-chat-accounts");
const { buildAgentInvocation, PERMISSION_MODES, INLINE_TEXT_LIMIT } = require("./chat-argv");
const { createLineParser } = require("./chat-events");
const { runAgentProcess } = require("./chat-agent-runner");
const { withRealPwshPath } = require("./windows-pwsh-path");
const { ChatTraceStore } = require("./chat-traces");
const { runWithTraceAccess } = require("./chat-trace-access");
const { DEFAULT_MAX_MESSAGES, buildAgentPrompt } = require("./chat-prompt");
const { NativeSessionLink } = require("./chat-native-sessions");
const { readMessageRange } = require("./chat-history");
const { GrokDockerRuntime } = require("../grok-docker-runtime");
const {
  importAttachment,
  importAttachmentBuffer,
  readImagePreview,
  readInlineText,
} = require("./chat-attachments");
const { createChatWindow } = require("./chat-window");
const { formatSessionMarkdown, safeExportFileName } = require("./chat-export");


// 채팅 기능 전체(저장소·세션·프로바이더 실행·IPC·창)를 묶는 조립 모듈.
// main.js는 createChatFeature() 한 번과 openWindow()/shutdown()만 호출합니다.

function publicMeta(meta) {
  if (!meta) return null;
  return {
    id: meta.id,
    title: meta.title,
    workspace: meta.workspace || null,
    permissionMode: meta.permissionMode || "chat",
    agents: meta.agents || {},
    status: meta.status || "idle",
    readOnly: Boolean(meta.readOnly),
  };
}

// renderer로 보내는 첨부 레코드: 원본 경로/저장 경로는 제외합니다.
// fileName은 내용 해시라 경로 정보가 없지만, 뷰에서는 쓰지 않습니다.
function publicAttachment(record) {
  return {
    id: record.id,
    name: record.name,
    mime: record.mime,
    kind: record.kind,
    size: record.size,
  };
}

function attachmentContextLines({ attachments, deliveries, attachmentsDir }) {
  const lines = [];
  for (let index = 0; index < attachments.length; index += 1) {
    const attachment = attachments[index];
    const delivery = deliveries[index];
    if (!delivery) continue;
    if (delivery.method === "inline") {
      const text = readInlineText({
        attachmentsDir,
        fileName: attachment.fileName,
        limit: INLINE_TEXT_LIMIT,
      });
      if (text !== null) {
        lines.push(`=== 첨부 파일: ${attachment.name} ===`);
        lines.push(text);
        lines.push("=== 첨부 끝 ===");
      } else {
        delivery.method = "unsupported";
      }
    } else if (delivery.method === "path") {
      lines.push(
        `첨부 파일 "${attachment.name}" 경로: ${path.join(attachmentsDir, attachment.fileName)} (읽기 도구로 열 수 있습니다)`
      );
    } else if (delivery.method === "native-image") {
      lines.push(`(이미지 "${attachment.name}"가 함께 전달되었습니다.)`);
    } else if (delivery.method === "unsupported") {
      lines.push(`(첨부 "${attachment.name}"는 이 에이전트로 전달할 수 없었습니다.)`);
    }
  }
  return lines;
}

function resolveAgentExecution({
  agentId,
  permissionMode,
  invocation,
  record,
  workspace,
  chatCwd,
  runId,
  grokDockerRuntime,
}) {
  if (agentId === "grok" && permissionMode === "workspace-read") {
    if (!grokDockerRuntime) throw new Error("Grok Docker 실행기가 준비되지 않았습니다.");
    return grokDockerRuntime.buildReadExecution({
      workspace,
      grokArgv: invocation.argv,
      runId,
      cwd: chatCwd,
    });
  }
  if (agentId === "grok" && permissionMode === "workspace-write") {
    if (!grokDockerRuntime) throw new Error("Grok Docker 실행기가 준비되지 않았습니다.");
    return grokDockerRuntime.buildWriteExecution({ workspace, grokArgv: invocation.argv, runId, cwd: chatCwd });
  }
  return {
    commandPath: record.commandPath,
    needsShell: record.needsShell,
    argv: invocation.argv,
    cwd: invocation.cwd,
    promptTransport: invocation.promptTransport,
    promptFileFlag: invocation.promptFileFlag || undefined,
    onCancel: null,
  };
}

function createChatFeature(options) {
  const { electron, onWindowReady, openSettings } = options;
  const { ipcMain, dialog, BrowserWindow, shell } = electron;

  let store = null;
  const pendingProcesses = new Set();
  let codexRuntime = null;
  const codexRooms = new Map();
  const indexedRooms = new Set();
  let traceStore = null;
  let storeError = null;
  let capabilityService = null;
  let providerRefresh = null;
  const accountServices = new Map();
  const accountProviders = ["codex", "claude", "grok"];
  function accountService(providerId = "codex") {
    if (!accountProviders.includes(providerId)) return null;
    if (accountServices.has(providerId)) return accountServices.get(providerId);
    const injected = options[`${providerId}Accounts`];
    const switcher = providerId === "codex" ? options.getCodexAccountSwitcher?.() : options.getAccountSwitcher?.(providerId);
    const service = injected || (switcher && (providerId === "codex"
      ? new CodexChatAccounts({ switcher })
      : new SavedChatAccounts({ providerId, switcher, dockerRuntime: grokDockerRuntime })));
    if (service) accountServices.set(providerId, service);
    return service;
  }

  function participantRecord(meta, id) {
    const base = ensureCapabilityService().getRecord(id);
    if (base) return base;
    const config = meta?.agents?.[id];
    if (!config?.profileKey) return null;
    const service = accountService(config.providerId);
    const provider = ensureCapabilityService().getRecord(config.providerId);
    if (!service || !provider) return null;
    const profile = service.list().find((entry) => entry.key === config.profileKey);
    return {
      ...service.record(config.profileKey, provider), id, providerId: config.providerId,
      name: `${provider.name} ${id.slice(config.providerId.length + 1)}`, aliases: [id], accountLabel: profile?.label || "계정 없음",
    };
  }

  async function discoverParticipants(meta, force = false) {
    await Promise.all(accountProviders.map(async (providerId) => {
      const service = accountService(providerId);
      if (!service) return;
      const keys = new Set(Object.values(meta?.agents || {})
        .filter((config) => config?.providerId === providerId && config.profileKey).map((config) => config.profileKey));
      await Promise.all([...keys].map((key) => service.discover(key, ensureCapabilityService().getRecord(providerId), { force })));
    }));
  }

  function participantProviders(meta) {
    const records = ensureCapabilityService().defs.map((def) => ensureCapabilityService().getRecord(def.id)).filter(Boolean);
    for (const id of Object.keys(meta?.agents || {})) {
      if (!records.some((record) => record.id === id)) {
        const record = participantRecord(meta, id);
        if (record) records.push(record);
      }
    }
    return records;
  }
  const grokDockerRuntime = options.grokDockerRuntime || new GrokDockerRuntime();
  let chatWindow = null;
  let shuttingDown = false;
  const rooms = new Map();
  const activity = new ChatActivity(options.onActivity);
  // 세션별 "아직 전송 전" 첨부: id → 내부 레코드(fileName 포함)
  const pendingAttachments = new Map();

  function ensureStore() {
    if (store || storeError) return store;
    try {
      store = options.store || new ChatStore({ root: options.storeRoot }).init();
      codexRuntime = options.codexRuntime || new CodexChatRuntime({ root: path.join(store.root, "runtime", "codex"), platform: options.platform });
      if (!store.readOnly) traceStore = new ChatTraceStore({ root: store.root, hasSession: (id) => store.hasSession(id) });
    } catch (error) {
      storeError = error?.message || String(error);
      console.warn("[code-pet] 채팅 저장소 초기화 실패:", storeError);
    }
    return store;
  }

  function ensureCapabilityService() {
    if (capabilityService) return capabilityService;
    capabilityService = createCapabilityService({
      cache: {
        get: () => ensureStore()?.getConfig()?.capabilityCache || null,
        set: (value) => ensureStore()?.patchConfig({ capabilityCache: value }),
      },
      grokDockerProbe: () => grokDockerRuntime.probe({ force: true }),
    });
    return capabilityService;
  }

  function providerRecords() {
    const service = ensureCapabilityService();
    return service.defs.map((def) => service.getRecord(def.id)).filter(Boolean);
  }

  function refreshProvidersInBackground() {
    if (providerRefresh || shuttingDown) return;
    // Yield so session selection/creation can paint before any CLI startup work.
    providerRefresh = new Promise((resolve) => setImmediate(resolve)).then(async () => {
      await ensureCapabilityService().discover();
      for (const sessionId of rooms.keys()) {
        if (shuttingDown) return;
        await discoverParticipants(store.readMeta(sessionId));
        refreshRoomAgents(sessionId);
      }
    }).catch((error) => {
      console.warn("[code-pet] CLI 탐지 실패:", error?.message || String(error));
    }).finally(() => {
      providerRefresh = null;
      if (shuttingDown) return;
      const sessionId = getActiveSessionId();
      broadcast("chat:providers-changed", {
        sessionId,
        providers: toPublicProviders(participantProviders(store?.readMeta(sessionId))),
        diagnostics: toDiagnostics(providerRecords()),
      });
    });
  }

  function broadcast(channel, payload) {
    if (chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.webContents.send(channel, payload);
    }
  }

  function sessionsPayload() {
    const list = ensureStore() ? store.listSessions() : [];
    return {
      sessions: list,
      activeSessionId: getActiveSessionId(),
      readOnly: Boolean(store?.readOnly || storeError),
    };
  }

  function getActiveSessionId() {
    if (!ensureStore()) return null;
    const configured = store.getConfig().activeSessionId;
    if (configured && store.hasSession(configured)) return configured;
    const first = store.listSessions()[0];
    return first ? first.id : null;
  }

  function setActiveSessionId(sessionId) {
    if (!ensureStore() || store.readOnly) return;
    store.patchConfig({ activeSessionId: sessionId });
  }

  function findCodexSession(threadId) {
    if (!/^[0-9a-f-]{36}$/i.test(String(threadId || "")) || !ensureStore()) return null;
    for (const room of store.listSessions()) {
      if (indexedRooms.has(room.id)) continue;
      for (const event of readJsonlTolerant(store.transcriptPath(room.id))) {
        if (event.kind === "cli-session" && event.providerId === "codex") codexRooms.set(event.cliSessionId, room.id);
      }
      indexedRooms.add(room.id);
    }
    const id = codexRooms.get(threadId);
    return id && store.hasSession(id) ? id : null;
  }

  function activeAccountKey(providerId, config) {
    const switcher = providerId === "codex" ? options.getCodexAccountSwitcher?.() : options.getAccountSwitcher?.(providerId);
    return config.profileKey || switcher?.listProfiles?.().find(profile => profile.active)?.key
      || switcher?.currentAccountHint?.() || null;
  }

  function notifyChat(sessionId, agentId, kind, text) {
    if (shuttingDown || !store?.hasSession(sessionId)) return;
    options.onChatNotification?.({ sessionId, agentId, kind, text,
      agentName: rooms.get(sessionId)?.findAgent(agentId)?.name || agentId });
  }

  function pendingFor(sessionId) {
    if (!pendingAttachments.has(sessionId)) pendingAttachments.set(sessionId, new Map());
    return pendingAttachments.get(sessionId);
  }

  // 세션 대화에 이미 저장된 첨부에서 id로 내부 레코드를 찾습니다(미리보기용).
  function findAttachmentRecord(sessionId, attachmentId) {
    const pending = pendingFor(sessionId).get(attachmentId);
    if (pending) return pending;
    if (!ensureStore()) return null;
    let before = null;
    do {
      const page = store.readMessagesPage(sessionId, { before });
      for (const message of page.messages) {
        for (const attachment of message.attachments || []) {
          if (attachment.id === attachmentId) return attachment;
        }
      }
      if (!page.hasMore) break;
      before = page.before;
    } while (before !== null);
    return null;
  }

  function makeRunAgent(sessionId) {
    return ({ agent, prompt, promptContext, runId, attachments, emitEvent, autoApprove = false }) => {
      const meta = store?.readMeta(sessionId);
      const record = participantRecord(meta, agent.id);
      const providerId = agent.providerId || agent.id;
      if (!record || !meta) {
        return {
          promise: Promise.resolve({ ok: false, error: "세션 정보를 읽지 못했습니다." }),
          cancel: () => {},
        };
      }
      const config = meta.agents?.[agent.id] || {};
      const attachmentsDir = store.attachmentsDir(sessionId);
      const enriched = (attachments || []).map((attachment) => ({
        ...attachment,
        path: path.join(attachmentsDir, attachment.fileName || ""),
      }));

      let outputFile = null;
      if (providerId === "codex") {
        outputFile = path.join(
          os.tmpdir(),
          `codepet-chat-${agent.id}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`
        );
      }

      const invocationInput = {
        provider: { ...record, id: providerId },
        permissionMode: meta.permissionMode || "chat",
        workspace: meta.workspace || null,
        model: agent.model,
        effort: agent.effort,
        attachments: enriched,
        chatCwd: store.runtimeChatDir(),
        attachmentsDir,
        outputFile,
        autoApprove: (meta.permissionMode || "chat") === "workspace-write" && Boolean(config.autoApprove || autoApprove),
      };
      const invocation = buildAgentInvocation(invocationInput);
      if (!invocation.ok) {
        return {
          promise: Promise.resolve({ ok: false, error: invocation.error }),
          cancel: () => {},
        };
      }

      let fullPrompt = prompt;
      const extraLines = attachmentContextLines({
        attachments: enriched,
        deliveries: invocation.deliveries,
        attachmentsDir,
      });
      if (extraLines.length > 0) fullPrompt = `${prompt}\n${extraLines.join("\n")}`;

      const permissionMode = meta.permissionMode || "chat";
      let native = null;
      let cancelled = false;
      const throughId = promptContext?.messages?.at(-1)?.id || null;
      const run = runWithTraceAccess({
        traceStore,
        sessionId,
        agentId: agent.id,
        runId,
        prompt: fullPrompt,
        emitEvent,
        startRun: ({ prompt: nextPrompt, continuationPrompt, traceContext, onTrace, onEvent }) => {
          const service = config.profileKey ? accountService(providerId) : null;
          const account = service?.prepare(config.profileKey);
          const docker = providerId === "grok" && config.profileKey && permissionMode !== "chat" ? service.runtime(config.profileKey) : grokDockerRuntime;
          const env = account?.env || options.env || process.env;
          const sourceHome = providerId === "codex" ? env.CODEX_HOME || path.join(os.homedir(), ".codex")
            : providerId === "claude" ? env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude")
              : providerId === "grok" ? (permissionMode === "chat" ? env.GROK_HOME || path.join(os.homedir(), ".grok") : docker.authVolume)
                : os.homedir();
          const activeKey = activeAccountKey(providerId, config);
          const runtime = providerId === "codex" ? codexRuntime.prepare({ sourceHome, identity: activeKey, env }) : null;
          const home = runtime?.home || sourceHome;
          if (!native) {
            const scope = {
              providerId, profileKey: config.profileKey || null, activeKey, home,
              cwd: invocation.cwd, permissionMode, autoApprove: invocationInput.autoApprove,
              model: agent.model || "default", effort: agent.effort || "default",
            };
            native = new NativeSessionLink(store, sessionId, agent.id, scope, runtime
              ? { legacyScope: { ...scope, home: sourceHome }, migrate: runtime.migrate } : {});
            if (providerId === "codex" && native.cliSessionId) codexRooms.set(native.cliSessionId, sessionId);
          }
          let processPrompt = nextPrompt;
          if (continuationPrompt && native.cliSessionId) {
            processPrompt = continuationPrompt;
          } else if (!continuationPrompt && native.cliSessionId && native.lastMessageId && promptContext) {
            const messages = readMessageRange(store.transcriptPath(sessionId), {
              afterId: native.lastMessageId, throughId, agentId: agent.id,
            });
            if (messages === null) throw new Error("CLI 세션의 대화 연결 위치를 찾지 못했습니다.");
            processPrompt = [buildAgentPrompt({ ...promptContext, messages, maxMessages: Infinity, continued: true }),
              ...extraLines, traceContext].filter(Boolean).join("\n");
          }
          const continuedInvocation = buildAgentInvocation({ ...invocationInput, cliSessionId: native.cliSessionId });
          if (!continuedInvocation.ok) throw new Error(continuedInvocation.error);
          const execution = resolveAgentExecution({
            agentId: providerId,
            permissionMode,
            invocation: continuedInvocation,
            record,
            workspace: meta.workspace || null,
            chatCwd: store.runtimeChatDir(),
            runId,
            grokDockerRuntime: docker,
          });

          const nativeSessions = new Set();
          let linkError = null;
          let performedWork = false;
          const processRun = runAgentProcess({
            commandPath: execution.commandPath,
            needsShell: execution.needsShell,
            argv: runtime ? [...execution.argv, ...(account ? FILE_AUTH_ARGS : []), ...runtime.argv] : execution.argv,
            env: runtime?.env || (providerId === "claude" ? withRealPwshPath(env) : account?.env),
            prompt: processPrompt,
            promptTransport: execution.promptTransport,
            promptFileFlag: execution.promptFileFlag,
            cwd: execution.cwd,
            outputFile,
            parseLine: createLineParser(providerId, (event) => {
              performedWork = true;
              if (!cancelled) native.delivered(throughId);
              return onTrace(event);
            }, (cliSessionId) => {
              if (cancelled) return;
              if (nativeSessions.has(cliSessionId)) return;
              nativeSessions.add(cliSessionId);
              try { native.observe(cliSessionId); }
              catch (error) { linkError = error; }
              if (providerId === "codex") codexRooms.set(cliSessionId, sessionId);
              store.appendEvent(sessionId, {
                kind: "cli-session", providerId, agentId: agent.id, runId, cliSessionId,
                profileKey: config.profileKey || null,
                cwd: execution.cwd,
                home,
              });
            }),
            onEvent: (event) => {
              if (!cancelled && ["delta", "final"].includes(event?.kind)) native.delivered(throughId);
              onEvent(event);
            },
            timeoutMs: options.timeoutMs,
            maxOutputBytes: execution.maxOutputBytes,
            provider: providerId,
            runId,
            onCancel: execution.onCancel,
          });
          const completion = processRun.promise.then((result) => {
            result = { ...result, sideEffectsPossible: performedWork };
            if (linkError) return { ...result, ok: false, error: linkError.message };
            if (result.ok && !result.cancelled && !cancelled) native.delivered(throughId);
            return result;
          }).finally(async () => {
            try { await runtime?.finish(); }
            finally { await account?.finish?.(providerId === "grok" && permissionMode !== "chat" ? docker : null); }
          });
          pendingProcesses.add(completion);
          completion.then(() => pendingProcesses.delete(completion), () => pendingProcesses.delete(completion));
          return { ...processRun, promise: completion };
        },
      });
      return {
        promise: run.promise.then(async (result) => {
          if (!result.ok) return result;
          let workspaceChangeSet = null;
          if (providerId === "grok" && permissionMode === "workspace-write") {
            if (!result.workspaceChangeManifest) {
              throw new Error("Grok이 검증 가능한 변경 세트를 만들지 못했습니다.");
            }
            workspaceChangeSet = grokDockerRuntime.stageWriteChangeSet({
              sessionId,
              workspace: meta.workspace,
              manifest: result.workspaceChangeManifest,
            });
          }
          const { workspaceChangeManifest: _privateManifest, ...publicResult } = result;
          return {
            ...publicResult,
            deliveries: invocation.deliveries,
            ...(workspaceChangeSet ? { workspaceChangeSet } : {}),
          };
        }),
        cancel: () => { cancelled = true; run.cancel(); },
      };
    };
  }

  function buildRoomAgents(meta) {
    const discovered = participantProviders(meta);
    return roomAgentsFromCapabilities(discovered, meta?.agents || {}, meta?.permissionMode || "chat");
  }

  function getRoom(sessionId) {
    if (rooms.has(sessionId)) {
      const existing = rooms.get(sessionId);
      existing.setMeta({ workMode: Boolean(options.getAppearance?.().workMode) });
      return existing;
    }
    if (!ensureStore()) return null;
    const meta = store.readMeta(sessionId);
    if (!meta) return null;

    const room = new ChatRoom({
      sessionId,
      agents: buildRoomAgents(meta),
      initialMessages: store.readMessagesPage(sessionId).messages,
      maxStoredMessages: 100,
      // 화면의 페이지와 모델의 최근 대화 문맥은 독립적으로 유지합니다.
      loadPromptMessages: () => store.readMessagesPage(sessionId, {
        limit: DEFAULT_MAX_MESSAGES,
        maxBytes: Infinity,
        filter: (message) => message.authorType !== "system" && !message.error,
      }).messages,
      runAgent: makeRunAgent(sessionId),
      prepareAgent: async (payload) => {
        const latestMeta = store?.readMeta(sessionId);
        const providerId = payload?.agent?.providerId || payload?.agent?.id;
        const participant = latestMeta?.agents?.[payload?.agent?.id];
        if (providerId === "codex" && !(latestMeta.permissionMode === "workspace-write" && (participant?.autoApprove || payload.autoApprove))) {
          const account = participant?.profileKey ? accountService("codex")?.prepare(participant.profileKey) : null;
          const env = account?.env || options.env || process.env;
          const sourceHome = env.CODEX_HOME || path.join(os.homedir(), ".codex");
          await codexRuntime.prepareSandbox({ sourceHome, identity: activeAccountKey(providerId, participant || {}),
            sandboxSource: options.getCodexAccountSwitcher?.()?.codexHome || sourceHome,
            record: participantRecord(latestMeta, payload.agent.id), cwd: latestMeta.workspace || store.runtimeChatDir() });
        }
        if ((payload?.agent?.providerId || payload?.agent?.id) === "grok" && ["workspace-read", "workspace-write"].includes(latestMeta?.permissionMode)) {
          const config = latestMeta.agents?.[payload.agent.id];
          const docker = config?.profileKey ? accountService("grok").runtime(config.profileKey) : grokDockerRuntime;
          await docker.ensureReady();
        }
        if (typeof options.prepareAgent === "function") await options.prepareAgent(payload);
      },
      meta: { permissionMode: meta.permissionMode || "chat", workMode: Boolean(options.getAppearance?.().workMode) },
    });

    room.on("message", (message) => {
      store.appendEvent(sessionId, { kind: "message", message });
      // renderer로는 첨부 내부 레코드(fileName/sha256)를 제거한 사본만 보냅니다.
      const outbound = message.attachments
        ? { ...message, attachments: message.attachments.map(publicAttachment) }
        : message;
      broadcast("chat:message", { sessionId, message: outbound });
      broadcast("chat:sessions-changed", sessionsPayload());
      if (message.authorType === "agent") notifyChat(sessionId, message.author, message.error ? "failed" : "completed", message.text);
    });
    room.on("typing", (payload) => {
      activity.typing(sessionId, payload);
      notifyChat(sessionId, payload.agentId, payload.busy ? "working" : "cancelled");
      broadcast("chat:typing", { sessionId, ...payload });
    });
    room.on("turn-state", (payload) => broadcast("chat:turn-state", { sessionId, ...payload }));
    room.on("reset", () => broadcast("chat:reset", { sessionId }));
    room.on("run-event", (payload) => {
      activity.event(sessionId, payload);
      if (payload.kind === "status") notifyChat(sessionId, payload.agentId, "progress", payload.label);
      broadcast("chat:run-event", { sessionId, ...payload });
    });
    room.on("agents", (agents) => broadcast("chat:agents", { sessionId, agents }));
    room.on("approval-request", (payload) => {
      notifyChat(sessionId, payload.agentId, "waiting", "작업 승인을 기다리고 있습니다.");
      broadcast("chat:approval-request", { sessionId, ...payload });
    });
    room.on("busy", (busy) => {
      if (shuttingDown) return;
      store.setSessionStatus(sessionId, busy ? "running" : "idle");
      broadcast("chat:sessions-changed", sessionsPayload());
    });

    rooms.set(sessionId, room);
    return room;
  }

  function refreshRoomAgents(sessionId) {
    const room = rooms.get(sessionId);
    if (!room || !store) return;
    const meta = store.readMeta(sessionId);
    room.setAgents(buildRoomAgents(meta));
    if (meta) room.setMeta({ permissionMode: meta.permissionMode || "chat" });
  }

  function sessionState(sessionId) {
    const room = getRoom(sessionId);
    const meta = store?.readMeta(sessionId);
    if (!room || !meta) return null;
    const page = publicMessagePage(store.readMessagesPage(sessionId));
    return {
      meta: publicMeta(meta),
      providers: toPublicProviders(participantProviders(meta)),
      agents: room.publicAgents(),
      messages: page.messages,
      history: { before: page.before, hasMore: page.hasMore },
      typing: room.state().typing,
      turnState: room.turnState(),
      pendingAttachments: [...pendingFor(sessionId).values()].map(publicAttachment),
    };
  }

  function publicMessagePage(page) {
    return {
      ...page,
      messages: page.messages.map((message) => ({
        ...message,
        attachments: (message.attachments || []).map(publicAttachment),
      })),
    };
  }

  async function fullState({ refreshProviders = false, backgroundProviders = false } = {}) {
    ensureStore();
    const service = ensureCapabilityService();
    if (backgroundProviders && !refreshProviders) refreshProvidersInBackground();
    else await service.discover({ force: refreshProviders });
    const records = providerRecords();

    if (store && !store.readOnly && store.listSessions().length === 0) {
      store.createSession({});
    }
    const activeSessionId = getActiveSessionId();
    if (activeSessionId) {
      if (!backgroundProviders || refreshProviders) await discoverParticipants(store.readMeta(activeSessionId), refreshProviders);
      refreshRoomAgents(activeSessionId);
    }
    return {
      // 저장소 문제는 하드 실패가 아니라 경고 배너로 전달합니다.
      error: storeError || null,
      appearance: options.getAppearance?.(),
      providers: toPublicProviders(records),
      providersLoading: Boolean(providerRefresh),
      diagnostics: toDiagnostics(records),
      permissionModes: PERMISSION_MODES,
      ...sessionsPayload(),
      activeSessionId,
      session: activeSessionId ? sessionState(activeSessionId) : null,
    };
  }

  function requireSession(sessionId) {
    if (!ensureStore()) throw new Error(storeError || "저장소를 사용할 수 없습니다.");
    if (!sessionId || !store.hasSession(sessionId)) throw new Error("세션을 찾을 수 없습니다.");
  }

  function wrap(handler) {
    return async (_event, input) => {
      try {
        const data = await handler(input || {});
        return { ok: true, ...(data || {}) };
      } catch (error) {
        return { ok: false, error: error?.message || String(error) };
      }
    };
  }

  function registerIpcHandlers() {
    ipcMain.handle("chat:state", wrap(async (input) => fullState(input)));

    ipcMain.handle("chat:messages:history", wrap(async ({ sessionId, before }) => {
      requireSession(sessionId);
      return publicMessagePage(store.readMessagesPage(sessionId, { before }));
    }));

    ipcMain.handle(
      "chat:providers:refresh",
      wrap(async () => {
        const records = await ensureCapabilityService().discover({ force: true });
        for (const sessionId of rooms.keys()) {
          await discoverParticipants(store.readMeta(sessionId), true);
          refreshRoomAgents(sessionId);
        }
        return { providers: toPublicProviders(participantProviders(store?.readMeta(getActiveSessionId()))), diagnostics: toDiagnostics(records) };
      })
    );

    ipcMain.handle(
      "chat:open-external",
      wrap(async ({ url }) => {
        const allowedUrls = new Set(
          ensureCapabilityService().defs.map((def) => def.installUrl).filter(Boolean)
        );
        if (!allowedUrls.has(url)) throw new Error("허용되지 않은 외부 주소입니다.");
        await shell.openExternal(url);
        return {};
      })
    );

    ipcMain.handle(
      "chat:sessions:create",
      wrap(async () => {
        if (!ensureStore()) throw new Error(storeError || "저장소를 사용할 수 없습니다.");
        const meta = store.createSession({});
        setActiveSessionId(meta.id);
        refreshProvidersInBackground();
        return { ...sessionsPayload(), providersLoading: Boolean(providerRefresh), session: sessionState(meta.id) };
      })
    );

    ipcMain.handle(
      "chat:sessions:select",
      wrap(async ({ sessionId }) => {
        requireSession(sessionId);
        setActiveSessionId(sessionId);
        refreshProvidersInBackground();
        refreshRoomAgents(sessionId);
        return { ...sessionsPayload(), providersLoading: Boolean(providerRefresh), session: sessionState(sessionId) };
      })
    );

    ipcMain.handle(
      "chat:sessions:search",
      wrap(async ({ query }) => {
        if (!ensureStore()) return { results: [] };
        const cleanQuery = typeof query === "string" ? query.trim() : "";
        return { results: cleanQuery ? await store.searchSessionsAsync(cleanQuery) : [] };
      })
    );

    ipcMain.handle(
      "chat:sessions:rename",
      wrap(async ({ sessionId, title }) => {
        requireSession(sessionId);
        store.renameSession(sessionId, title);
        return { ...sessionsPayload(), meta: publicMeta(store.readMeta(sessionId)) };
      })
    );

    ipcMain.handle(
      "chat:sessions:delete",
      wrap(async ({ sessionId }) => {
        requireSession(sessionId);
        if (store.readOnly || store.readMeta(sessionId)?.readOnly) throw new Error("읽기 전용 저장소입니다.");
        const room = rooms.get(sessionId);
        if (room) {
          room.stopAllSilently();
          rooms.delete(sessionId);
        }
        pendingAttachments.delete(sessionId);
        grokDockerRuntime.discardSessionChanges(sessionId);
        store.deleteSession(sessionId);
        await traceStore?.discard(sessionId).catch(() => {});
        let nextId = getActiveSessionId();
        if (!nextId && !store.readOnly) {
          nextId = store.createSession({}).id;
        }
        if (nextId) setActiveSessionId(nextId);
        return { ...sessionsPayload(), session: nextId ? sessionState(nextId) : null };
      })
    );

    ipcMain.handle(
      "chat:session:export",
      wrap(async ({ sessionId }) => {
        requireSession(sessionId);
        const meta = store.readMeta(sessionId);
        const saveOptions = {
          title: "채팅 세션 내보내기",
          defaultPath: safeExportFileName(meta?.title),
          buttonLabel: "내보내기",
          filters: [{ name: "Markdown", extensions: ["md"] }],
          properties: ["createDirectory", "showOverwriteConfirmation"],
        };
        const owner = chatWindow && !chatWindow.isDestroyed() ? chatWindow : null;
        const result = owner
          ? await dialog.showSaveDialog(owner, saveOptions)
          : await dialog.showSaveDialog(saveOptions);
        if (result.canceled || !result.filePath) return { canceled: true };

        const session = store.getSession(sessionId);
        if (!session) throw new Error("세션을 찾을 수 없습니다.");
        const markdown = formatSessionMarkdown(session.meta, session.messages);
        await fs.promises.writeFile(result.filePath, markdown, "utf8");
        return { canceled: false, fileName: path.basename(result.filePath) };
      })
    );

    ipcMain.handle(
      "chat:send",
      wrap(async ({ sessionId, text, attachmentIds, replyTo }) => {
        requireSession(sessionId);
        const room = getRoom(sessionId);
        const pending = pendingFor(sessionId);
        const attachments = [];
        for (const id of Array.isArray(attachmentIds) ? attachmentIds : []) {
          const record = pending.get(id);
          if (record) {
            attachments.push(record);
            pending.delete(id);
          }
        }
        const entry = room.sendUserMessage({ text, attachments, replyTo });
        if (!entry) throw new Error("보낼 내용이 없습니다.");
        return {};
      })
    );

    ipcMain.handle(
      "chat:stop",
      wrap(async ({ sessionId }) => {
        requireSession(sessionId);
        getRoom(sessionId)?.stopAll();
        return {};
      })
    );

    ipcMain.handle(
      "chat:turn:interject",
      wrap(async ({ sessionId }) => {
        requireSession(sessionId);
        return getRoom(sessionId).interject();
      })
    );

    ipcMain.handle(
      "chat:turn:cancel",
      wrap(async ({ sessionId, turnId }) => {
        requireSession(sessionId);
        if (!getRoom(sessionId).cancelTurn(String(turnId || ""))) {
          throw new Error("이미 시작되었거나 존재하지 않는 턴입니다.");
        }
        return {};
      })
    );

    ipcMain.handle(
      "chat:discussion:start",
      wrap(async ({ sessionId, agentIds }) => {
        requireSession(sessionId);
        const room = getRoom(sessionId);
        const cleanIds = Array.isArray(agentIds)
          ? agentIds.filter((id) => typeof id === "string")
          : undefined;
        // 토론은 오래 걸리므로 시작 확인만 동기로 반환하고, 진행은 이벤트로 전달됩니다.
        const started = room.startDiscussion({ agentIds: cleanIds });
        const result = await Promise.race([
          started,
          new Promise((resolve) => setImmediate(() => resolve({ ok: true, pending: true }))),
        ]);
        started.catch(() => {});
        if (result && result.ok === false) throw new Error(result.error);
        return {};
      })
    );

    ipcMain.handle(
      "chat:approval:respond",
      wrap(async ({ sessionId, approvalId, decision }) => {
        requireSession(sessionId);
        if (!getRoom(sessionId)?.resolveApproval(approvalId, decision)) {
          throw new Error("이미 처리되었거나 존재하지 않는 권한 요청입니다.");
        }
        return {};
      })
    );

    ipcMain.handle(
      "chat:workspace:choose",
      wrap(async ({ sessionId }) => {
        requireSession(sessionId);
        // 워크스페이스 경로의 유일한 출처: OS 폴더 선택 대화상자.
        const result = await dialog.showOpenDialog(chatWindow || undefined, {
          properties: ["openDirectory"],
          title: "세션 워크스페이스 선택",
        });
        if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
        let workspace = result.filePaths[0];
        try {
          workspace = fs.realpathSync(workspace);
          if (!fs.statSync(workspace).isDirectory()) throw new Error("폴더가 아닙니다.");
        } catch {
          throw new Error("선택한 폴더를 확인할 수 없습니다.");
        }
        grokDockerRuntime.discardSessionChanges(sessionId);
        store.updateMeta(sessionId, { workspace });
        refreshRoomAgents(sessionId);
        return { meta: publicMeta(store.readMeta(sessionId)), ...sessionsPayload() };
      })
    );

    ipcMain.handle(
      "chat:workspace:clear",
      wrap(async ({ sessionId }) => {
        requireSession(sessionId);
        grokDockerRuntime.discardSessionChanges(sessionId);
        // 워크스페이스가 없으면 workspace 권한 모드도 의미가 없어 chat으로 되돌립니다.
        store.updateMeta(sessionId, { workspace: null, permissionMode: "chat" });
        refreshRoomAgents(sessionId);
        return { meta: publicMeta(store.readMeta(sessionId)), ...sessionsPayload() };
      })
    );

    ipcMain.handle(
      "chat:permission:set",
      wrap(async ({ sessionId, mode }) => {
        requireSession(sessionId);
        if (!PERMISSION_MODES.includes(mode)) throw new Error("알 수 없는 권한 모드입니다.");
        const meta = store.readMeta(sessionId);
        if (mode !== "chat" && !meta.workspace) {
          throw new Error("먼저 워크스페이스 폴더를 선택해 주세요.");
        }
        store.updateMeta(sessionId, { permissionMode: mode });
        refreshRoomAgents(sessionId);
        return { meta: publicMeta(store.readMeta(sessionId)) };
      })
    );

    ipcMain.handle(
      "chat:agent:configure",
      wrap(async ({ sessionId, agentId, patch }) => {
        requireSession(sessionId);
        const meta = store.readMeta(sessionId);
        if (store.readOnly || meta.readOnly) throw new Error("읽기 전용 저장소입니다.");
        const record = participantRecord(meta, agentId);
        if (!record) throw new Error("알 수 없는 에이전트입니다.");
        const current = meta.agents?.[agentId] || {};
        const next = { ...current };
        Object.assign(next, identityPatch(patch, agentId, buildRoomAgents(meta)));
        if (typeof patch?.enabled === "boolean") next.enabled = patch.enabled;
        if (typeof patch?.model === "string") next.model = patch.model.slice(0, 64);
        if (typeof patch?.effort === "string") next.effort = patch.effort.slice(0, 16);
        if (typeof patch?.model === "string" || typeof patch?.effort === "string") {
          const invalidSelection = selectionError(record, next.model, next.effort);
          if (invalidSelection) throw new Error(invalidSelection);
        }
        if (typeof patch?.autoApprove === "boolean") {
          if (patch.autoApprove && (store.readMeta(sessionId)?.agents?.[agentId]?.providerId || agentId) === "grok") {
            throw new Error("Grok 변경은 Docker 복제본 검토 승인을 생략할 수 없습니다.");
          }
          if (patch.autoApprove && meta.permissionMode !== "workspace-write") {
            throw new Error("자동 승인은 워크스페이스 쓰기 권한에서만 켤 수 있습니다.");
          }
          next.autoApprove = patch.autoApprove;
        }
        store.updateMeta(sessionId, { agents: { ...meta.agents, [agentId]: next } });
        refreshRoomAgents(sessionId);
        return { meta: publicMeta(store.readMeta(sessionId)) };
      })
    );

    ipcMain.handle("chat:accounts:list", wrap(async () => {
      await ensureCapabilityService().discover();
      const candidates = accountProviders.flatMap((providerId) => {
        const base = ensureCapabilityService().getRecord(providerId);
        if (base?.status !== "cli" || !base.commandPath) return [];
        return (accountService(providerId)?.list() || []).map((profile) => ({ ...profile, providerId }));
      });
      const available = new Array(candidates.length).fill(false);
      let next = 0;
      // Bound process count when many logins are saved. Each service caches its catalog.
      await Promise.all(Array.from({ length: Math.min(2, candidates.length) }, async () => {
        while (next < candidates.length) {
          const index = next++;
          const account = candidates[index];
          try {
            const record = await accountService(account.providerId).discover(account.key, ensureCapabilityService().getRecord(account.providerId));
            available[index] = record.catalogStatus === "ready";
          } catch { /* Unavailable accounts do not appear in the picker. */ }
        }
      }));
      return { accounts: candidates.filter((_profile, index) => available[index]) };
    }));

    ipcMain.handle("chat:agent:add", wrap(async ({ sessionId, profileKey, name, providerId = "codex" }) => {
      requireSession(sessionId);
      if (store.readOnly || store.readMeta(sessionId)?.readOnly) throw new Error("읽기 전용 저장소입니다.");
      const service = accountService(providerId);
      if (!service?.list().some((profile) => profile.key === profileKey)) throw new Error("저장된 계정을 선택해 주세요.");
      const duplicate = (config) => config.profileKey === profileKey && config.providerId === providerId;
      const meta = store.readMeta(sessionId);
      if (Object.values(meta.agents || {}).some(duplicate)) throw new Error("이 계정은 이미 참여 중입니다.");
      await ensureCapabilityService().discover();
      const record = await service.discover(profileKey, ensureCapabilityService().getRecord(providerId));
      if (record.catalogStatus !== "ready") throw new Error(record.reason || record.catalogReason);
      // Re-read after async discovery to preserve other configuration edits.
      const latest = store.readMeta(sessionId);
      if (!latest || latest.readOnly) throw new Error("세션을 수정할 수 없습니다.");
      if (Object.values(latest.agents || {}).some(duplicate)) throw new Error("이 계정은 이미 참여 중입니다.");
      let index = Math.max(2, Number(latest.nextAccountAgentIndex?.[providerId]) || 2,
        providerId === "codex" ? Number(latest.nextCodexAgentIndex) || 2 : 2);
      const occupiedAliases = new Set(buildRoomAgents(latest).flatMap((agent) => agent.aliases.map(aliasKey)));
      while (latest.agents?.[`${providerId}-${index}`] || occupiedAliases.has(aliasKey(`${providerId}-${index}`))) index += 1;
      const id = `${providerId}-${index}`;
      const label = typeof name === "string" ? name.replace(/[\r\n\t]/g, " ").trim().slice(0, 40) : "";
      store.updateMeta(sessionId, { nextAccountAgentIndex: { ...latest.nextAccountAgentIndex, [providerId]: index + 1 }, agents: { ...latest.agents, [id]: {
        providerId, profileKey, name: label || `${record.name} ${index}`, enabled: true,
      } } });
      refreshRoomAgents(sessionId);
      return { session: sessionState(sessionId) };
    }));

    ipcMain.handle("chat:agent:remove", wrap(async ({ sessionId, agentId }) => {
      requireSession(sessionId);
      if (store.readOnly || store.readMeta(sessionId)?.readOnly) throw new Error("읽기 전용 저장소입니다.");
      const meta = store.readMeta(sessionId);
      if (!meta.agents?.[agentId]?.profileKey) throw new Error("추가한 계정 참가자만 삭제할 수 있습니다.");
      const room = getRoom(sessionId);
      if (room.turnActive || room.discussionRequested) throw new Error("진행 중인 작업을 마치거나 중지한 후 삭제해 주세요.");
      const next = { ...meta.agents };
      delete next[agentId];
      store.updateMeta(sessionId, { agents: next });
      refreshRoomAgents(sessionId);
      return { session: sessionState(sessionId) };
    }));

    ipcMain.handle(
      "chat:attachments:add",
      wrap(async ({ sessionId }) => {
        requireSession(sessionId);
        const result = await dialog.showOpenDialog(chatWindow || undefined, {
          properties: ["openFile", "multiSelections"],
          title: "첨부할 파일 선택",
        });
        if (result.canceled) return { attachments: [], errors: [] };
        return importPaths(sessionId, result.filePaths || []);
      })
    );

    ipcMain.handle(
      "chat:attachments:add-dropped",
      wrap(async ({ sessionId, paths }) => {
        requireSession(sessionId);
        const cleanPaths = (Array.isArray(paths) ? paths : [])
          .filter((entry) => typeof entry === "string" && entry.trim())
          .slice(0, 10);
        return importPaths(sessionId, cleanPaths);
      })
    );

    ipcMain.handle(
      "chat:workspace-changes:apply",
      wrap(async ({ sessionId, approvalId }) => {
        requireSession(sessionId);
        if (store.readOnly || store.readMeta(sessionId)?.readOnly) {
          throw new Error("읽기 전용 세션에서는 변경을 적용할 수 없습니다.");
        }
        return grokDockerRuntime.applyWorkspaceChanges(String(approvalId || ""), sessionId);
      })
    );
    ipcMain.handle(
      "chat:workspace-changes:cancel",
      wrap(async ({ sessionId, approvalId }) => {
        requireSession(sessionId);
        return grokDockerRuntime.cancelWorkspaceChanges(String(approvalId || ""), sessionId);
      })
    );

    ipcMain.handle(
      "chat:attachments:add-pasted",
      wrap(async ({ sessionId, images }) => {
        requireSession(sessionId);
        return importPastedImages(sessionId, Array.isArray(images) ? images.slice(0, 10) : []);
      })
    );

    ipcMain.handle(
      "chat:attachments:remove",
      wrap(async ({ sessionId, attachmentId }) => {
        requireSession(sessionId);
        pendingFor(sessionId).delete(String(attachmentId || ""));
        return { pendingAttachments: [...pendingFor(sessionId).values()].map(publicAttachment) };
      })
    );

    ipcMain.handle(
      "chat:attachments:preview",
      wrap(async ({ sessionId, attachmentId }) => {
        requireSession(sessionId);
        const record = findAttachmentRecord(sessionId, String(attachmentId || ""));
        if (!record || !record.fileName) throw new Error("첨부를 찾을 수 없습니다.");
        const preview = readImagePreview({
          attachmentsDir: store.attachmentsDir(sessionId),
          fileName: record.fileName,
        });
        if (!preview.ok) throw new Error(preview.error);
        return { dataUrl: preview.dataUrl };
      })
    );

    ipcMain.on("chat:open-settings", () => {
      if (typeof openSettings === "function") openSettings();
    });
    ipcMain.on("chat:minimize", () => {
      if (chatWindow && !chatWindow.isDestroyed()) chatWindow.minimize();
    });
    ipcMain.on("chat:maximize", () => {
      if (chatWindow && !chatWindow.isDestroyed()) {
        if (chatWindow.isMaximized()) chatWindow.unmaximize();
        else chatWindow.maximize();
      }
    });
    ipcMain.on("chat:close", () => {
      if (chatWindow && !chatWindow.isDestroyed()) chatWindow.close();
    });
  }

  function importPaths(sessionId, filePaths) {
    const pending = pendingFor(sessionId);
    const attachments = [];
    const errors = [];
    let sessionBytes = store.sessionAttachmentsSize(sessionId);
    for (const filePath of filePaths.slice(0, 10)) {
      const result = importAttachment({
        sourcePath: filePath,
        attachmentsDir: store.attachmentsDir(sessionId),
        currentSessionBytes: sessionBytes,
      });
      if (result.ok) {
        sessionBytes += result.addedBytes;
        pending.set(result.attachment.id, result.attachment);
        attachments.push(publicAttachment(result.attachment));
      } else {
        errors.push({ name: path.basename(String(filePath)), error: result.error });
      }
    }
    return {
      attachments,
      errors,
      pendingAttachments: [...pending.values()].map(publicAttachment),
    };
  }

  function importPastedImages(sessionId, images) {
    const pending = pendingFor(sessionId);
    const attachments = [];
    const errors = [];
    let sessionBytes = store.sessionAttachmentsSize(sessionId);
    for (const [index, image] of images.entries()) {
      const name = typeof image?.name === "string" && image.name.trim()
        ? image.name.slice(0, 160)
        : `붙여넣은-이미지-${index + 1}.png`;
      const result = importAttachmentBuffer({
        name,
        data: image?.data,
        attachmentsDir: store.attachmentsDir(sessionId),
        currentSessionBytes: sessionBytes,
        requireImage: true,
      });
      if (result.ok) {
        sessionBytes += result.addedBytes;
        pending.set(result.attachment.id, result.attachment);
        attachments.push(publicAttachment(result.attachment));
      } else {
        errors.push({ name: path.basename(name), error: result.error });
      }
    }
    return {
      attachments,
      errors,
      pendingAttachments: [...pending.values()].map(publicAttachment),
    };
  }

  function openWindow(sessionId = null) {
    if (sessionId !== null) {
      if (!ensureStore()?.hasSession(sessionId)) return null;
      setActiveSessionId(sessionId);
    }
    if (chatWindow && !chatWindow.isDestroyed()) {
      if (chatWindow.isMinimized?.()) chatWindow.restore();
      chatWindow.show();
      chatWindow.focus();
      if (sessionId) chatWindow.webContents.send("chat:open-session", { sessionId });
      return chatWindow;
    }
    chatWindow = createChatWindow({
      BrowserWindow,
      onReady: () => {
        if (sessionId) chatWindow.webContents.send("chat:open-session", { sessionId: getActiveSessionId() });
        if (typeof onWindowReady === "function") onWindowReady(chatWindow);
      },
      onClosed: () => {
        chatWindow = null;
      },
    });
    return chatWindow;
  }

  function getWindow() {
    return chatWindow && !chatWindow.isDestroyed() ? chatWindow : null;
  }

  // 앱 종료: 진행 중이던 세션은 interrupted로 남겨 다음 시작 때 안내합니다.
  function shutdown() {
    shuttingDown = true;
    activity.clear();
    grokDockerRuntime.clearWorkspaceChanges();
    for (const [sessionId, room] of rooms) {
      try {
        if (room.activeRuns > 0 && store && !store.readOnly) {
          store.setSessionStatus(sessionId, "running");
        } else if (store && !store.readOnly) {
          const meta = store.readMeta(sessionId);
          if (meta && meta.status === "running") store.setSessionStatus(sessionId, "idle");
        }
        room.stopAllSilently();
      } catch {}
    }
    const release = () => { if (!options.store) store?.close(); };
    if (!pendingProcesses.size) { release(); return Promise.resolve(); }
    return Promise.allSettled([...pendingProcesses]).then(release);
  }

  return { registerIpcHandlers, openWindow, getWindow, findCodexSession, shutdown };
}

module.exports = {
  createChatFeature,
  publicMeta,
  publicAttachment,
  attachmentContextLines,
  resolveAgentExecution,
};

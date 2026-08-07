const { contextBridge, ipcRenderer, webUtils } = require("electron");

// invoke 채널은 모두 { ok, ... } 형태로 응답합니다.
const INVOKE = Object.freeze({
  STATE: "chat:state",
  PROVIDERS_REFRESH: "chat:providers:refresh",
  OPEN_EXTERNAL: "chat:open-external",
  SESSIONS_CREATE: "chat:sessions:create",
  SESSIONS_SELECT: "chat:sessions:select",
  SESSIONS_RENAME: "chat:sessions:rename",
  SESSIONS_DELETE: "chat:sessions:delete",
  SEND: "chat:send",
  STOP: "chat:stop",
  TURN_INTERJECT: "chat:turn:interject",
  TURN_CANCEL: "chat:turn:cancel",
  DISCUSSION_START: "chat:discussion:start",
  APPROVAL_RESPOND: "chat:approval:respond",
  WORKSPACE_CHOOSE: "chat:workspace:choose",
  WORKSPACE_CLEAR: "chat:workspace:clear",
  PERMISSION_SET: "chat:permission:set",
  AGENT_CONFIGURE: "chat:agent:configure",
  ATTACH_ADD: "chat:attachments:add",
  ATTACH_ADD_DROPPED: "chat:attachments:add-dropped",
  ATTACH_REMOVE: "chat:attachments:remove",
  ATTACH_PREVIEW: "chat:attachments:preview",
});

function subscribe(channel, handler) {
  if (typeof handler !== "function") return () => {};
  const listener = (_event, value) => handler(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("chatApi", {
  state: (input) => ipcRenderer.invoke(INVOKE.STATE, input),
  providersRefresh: () => ipcRenderer.invoke(INVOKE.PROVIDERS_REFRESH),
  openExternal: (url) => ipcRenderer.invoke(INVOKE.OPEN_EXTERNAL, { url }),

  sessionsCreate: () => ipcRenderer.invoke(INVOKE.SESSIONS_CREATE),
  sessionsSelect: (sessionId) => ipcRenderer.invoke(INVOKE.SESSIONS_SELECT, { sessionId }),
  sessionsRename: (sessionId, title) =>
    ipcRenderer.invoke(INVOKE.SESSIONS_RENAME, { sessionId, title }),
  sessionsDelete: (sessionId) => ipcRenderer.invoke(INVOKE.SESSIONS_DELETE, { sessionId }),

  send: (sessionId, text, attachmentIds) =>
    ipcRenderer.invoke(INVOKE.SEND, { sessionId, text, attachmentIds }),
  stop: (sessionId) => ipcRenderer.invoke(INVOKE.STOP, { sessionId }),
  turnInterject: (sessionId) => ipcRenderer.invoke(INVOKE.TURN_INTERJECT, { sessionId }),
  turnCancel: (sessionId, turnId) =>
    ipcRenderer.invoke(INVOKE.TURN_CANCEL, { sessionId, turnId }),
  discussionStart: (sessionId, agentIds) =>
    ipcRenderer.invoke(INVOKE.DISCUSSION_START, { sessionId, agentIds }),
  approvalRespond: (sessionId, approvalId, decision) =>
    ipcRenderer.invoke(INVOKE.APPROVAL_RESPOND, { sessionId, approvalId, decision }),

  workspaceChoose: (sessionId) => ipcRenderer.invoke(INVOKE.WORKSPACE_CHOOSE, { sessionId }),
  workspaceClear: (sessionId) => ipcRenderer.invoke(INVOKE.WORKSPACE_CLEAR, { sessionId }),
  permissionSet: (sessionId, mode) =>
    ipcRenderer.invoke(INVOKE.PERMISSION_SET, { sessionId, mode }),
  agentConfigure: (sessionId, agentId, patch) =>
    ipcRenderer.invoke(INVOKE.AGENT_CONFIGURE, { sessionId, agentId, patch }),

  attachmentsAdd: (sessionId) => ipcRenderer.invoke(INVOKE.ATTACH_ADD, { sessionId }),
  attachmentsAddDropped: (sessionId, paths) =>
    ipcRenderer.invoke(INVOKE.ATTACH_ADD_DROPPED, { sessionId, paths }),
  attachmentsRemove: (sessionId, attachmentId) =>
    ipcRenderer.invoke(INVOKE.ATTACH_REMOVE, { sessionId, attachmentId }),
  attachmentsPreview: (sessionId, attachmentId) =>
    ipcRenderer.invoke(INVOKE.ATTACH_PREVIEW, { sessionId, attachmentId }),

  // 드래그된 File 객체 → 절대 경로 (main에서 다시 검증됩니다)
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return null;
    }
  },

  onMessage: (handler) => subscribe("chat:message", handler),
  onTyping: (handler) => subscribe("chat:typing", handler),
  onTurnState: (handler) => subscribe("chat:turn-state", handler),
  onReset: (handler) => subscribe("chat:reset", handler),
  onRunEvent: (handler) => subscribe("chat:run-event", handler),
  onSessionsChanged: (handler) => subscribe("chat:sessions-changed", handler),
  onAgents: (handler) => subscribe("chat:agents", handler),
  onApprovalRequest: (handler) => subscribe("chat:approval-request", handler),
  onAppearance: (handler) => subscribe("appearance:update", handler),
  onMaximizedState: (handler) => subscribe("chat:maximized-state", handler),

  minimize: () => ipcRenderer.send("chat:minimize"),
  maximize: () => ipcRenderer.send("chat:maximize"),
  close: () => ipcRenderer.send("chat:close"),
});

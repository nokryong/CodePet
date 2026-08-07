// 프로바이더별 실행 인자를 만드는 순수 모듈입니다.
// - 사용자 프롬프트는 절대 argv에 싣지 않습니다(항상 stdin).
// - 위험 플래그는 사용자가 에이전트별 자동 승인을 명시한 workspace-write에서만 허용합니다.
// - 모델/노력 문자열은 허용 문자만 통과시켜 .cmd 셸 경유 시 주입을 차단합니다.

const PERMISSION_MODES = Object.freeze(["chat", "workspace-read", "workspace-write"]);
const INLINE_TEXT_LIMIT = 16 * 1024;

const SAFE_OPTION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;
const AUTO_APPROVE_FLAGS = new Set([
  "--dangerously-skip-permissions",
  "--dangerously-bypass-approvals-and-sandbox",
]);

function normalizeChoice(value) {
  const text = String(value || "").trim();
  if (!text || text === "default") return null;
  if (!SAFE_OPTION_PATTERN.test(text)) return undefined; // 검증 실패
  return text;
}

function assertSafeArgv(argv, { autoApprove = false } = {}) {
  for (const arg of argv) {
    const text = String(arg);
    if (/dangerously|bypass/i.test(text) && !(autoApprove && AUTO_APPROVE_FLAGS.has(text))) {
      throw new Error(`금지된 실행 플래그가 생성되었습니다: ${arg}`);
    }
  }
  return argv;
}

function attachmentKind(attachment) {
  if (attachment.kind) return attachment.kind;
  const mime = String(attachment.mime || "");
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("text/") || mime === "application/json") return "text";
  return "binary";
}

function canInline(attachment) {
  return attachmentKind(attachment) === "text" && Number(attachment.size) <= INLINE_TEXT_LIMIT;
}

function claudeArgv({ permissionMode, workspace, model, effort, attachmentsDir, hasPathDeliveries, autoApprove }) {
  const argv = [
    "-p",
    "--no-session-persistence",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
  ];
  if (model) argv.push("--model", model);
  if (effort) argv.push("--effort", effort);

  if (permissionMode === "chat") {
    // 도구 전면 차단: 파일/셸 접근이 불가능한 순수 대화 모드.
    argv.push("--tools", "", "--strict-mcp-config");
    return argv;
  }
  if (permissionMode === "workspace-read") {
    argv.push("--tools", "Read,Grep,Glob", "--strict-mcp-config");
    argv.push("--add-dir", workspace);
    if (hasPathDeliveries && attachmentsDir) argv.push("--add-dir", attachmentsDir);
    return argv;
  }
  // workspace-write: 편집 자동 승인까지만. Bash 등 파괴 가능 도구는 기본 정책에 맡기고
  // 위험 우회 플래그는 절대 쓰지 않습니다.
  argv.push("--permission-mode", "acceptEdits", "--strict-mcp-config");
  if (autoApprove) argv.push("--dangerously-skip-permissions");
  argv.push("--add-dir", workspace);
  if (hasPathDeliveries && attachmentsDir) argv.push("--add-dir", attachmentsDir);
  return argv;
}

function codexArgv({ permissionMode, workspace, model, effort, outputFile, imagePaths, autoApprove }) {
  const argv = ["exec", "-", "--skip-git-repo-check", "--ephemeral", "--color", "never", "--json"];
  if (outputFile) argv.push("-o", outputFile);
  if (model) argv.push("--model", model);
  if (effort) argv.push("-c", `model_reasoning_effort=${effort}`);
  for (const imagePath of imagePaths) argv.push("--image", imagePath);

  if (permissionMode === "chat") {
    argv.push("--sandbox", "read-only");
    return argv;
  }
  if (permissionMode === "workspace-read") {
    argv.push("--sandbox", "read-only", "--cd", workspace);
    return argv;
  }
  if (autoApprove) argv.push("--dangerously-bypass-approvals-and-sandbox", "--cd", workspace);
  else argv.push("--sandbox", "workspace-write", "--cd", workspace);
  return argv;
}

// agy 1.1.10 검증 플래그 기반 매핑. 위험 플래그(--dangerously-skip-permissions)는
// 어떤 모드에서도 사용하지 않습니다.
// - chat: plan 모드(수정 불가) + 샌드박스 + 슬래시 명령 차단
// - workspace-read: plan 모드 + 샌드박스 + add-dir
// - workspace-write: accept-edits 모드 + 샌드박스 + add-dir
function agyArgv({ permissionMode, workspace, model, effort, attachmentsDir, hasPathDeliveries, autoApprove }) {
  // agy 1.1.10의 --print는 다음 argv를 필수 프롬프트로 소비합니다. 실제
  // 프롬프트는 runner가 모든 옵션 뒤에 붙입니다.
  const argv = ["--sandbox", "--disable-slash-commands", "--output-format", "stream-json"];
  if (model) argv.push("--model", model);
  if (effort) argv.push("--effort", effort);

  if (permissionMode === "chat") {
    argv.push("--mode", "plan");
    return argv;
  }
  if (permissionMode === "workspace-read") {
    argv.push("--mode", "plan", "--add-dir", workspace);
    if (hasPathDeliveries && attachmentsDir) argv.push("--add-dir", attachmentsDir);
    return argv;
  }
  argv.push("--mode", "accept-edits", "--add-dir", workspace);
  if (autoApprove) argv.push("--dangerously-skip-permissions");
  if (hasPathDeliveries && attachmentsDir) argv.push("--add-dir", attachmentsDir);
  return argv;
}

function buildDeliveries({ providerId, permissionMode, attachments }) {
  return attachments.map((attachment) => {
    const kind = attachmentKind(attachment);
    if (providerId === "codex") {
      if (kind === "image") return { id: attachment.id, method: "native-image" };
      if (canInline(attachment)) return { id: attachment.id, method: "inline" };
      // codex 샌드박스는 읽기 전용이라 어떤 모드든 첨부 사본 경로를 읽을 수 있습니다.
      return { id: attachment.id, method: "path" };
    }
    if (providerId === "claude") {
      if (permissionMode === "chat") {
        // 도구가 없어 파일을 열 수 없습니다. 작은 텍스트만 프롬프트에 인라인합니다.
        if (canInline(attachment)) return { id: attachment.id, method: "inline" };
        return { id: attachment.id, method: "unsupported" };
      }
      return { id: attachment.id, method: "path" };
    }
    if (providerId === "agy") {
      // 이미지 전달 플래그가 없어 이미지는 전달 불가. 파일은 add-dir가 있는
      // workspace 모드에서만 경로로 전달할 수 있습니다.
      if (kind === "image") return { id: attachment.id, method: "unsupported" };
      if (permissionMode === "chat") {
        if (canInline(attachment)) return { id: attachment.id, method: "inline" };
        return { id: attachment.id, method: "unsupported" };
      }
      return { id: attachment.id, method: "path" };
    }
    // 그 외 확인되지 않은 CLI: 작은 텍스트 인라인 외에는 전달 불가로 배지 처리합니다.
    if (canInline(attachment)) return { id: attachment.id, method: "inline" };
    return { id: attachment.id, method: "unsupported" };
  });
}

function buildAgentInvocation(input = {}) {
  const {
    provider, // capability record: {id, status, ...}
    permissionMode = "chat",
    workspace = null,
    model,
    effort,
    attachments = [],
    chatCwd,
    attachmentsDir = null,
    outputFile = null,
    autoApprove = false,
  } = input;

  if (!provider || provider.status !== "cli") {
    return { ok: false, error: provider?.reason || "CLI를 사용할 수 없습니다." };
  }
  if (!PERMISSION_MODES.includes(permissionMode)) {
    return { ok: false, error: `알 수 없는 권한 모드: ${permissionMode}` };
  }
  if (permissionMode !== "chat" && !workspace) {
    return { ok: false, error: "워크스페이스가 선택되지 않았습니다." };
  }
  if (autoApprove && permissionMode !== "workspace-write") {
    return { ok: false, error: "자동 승인은 workspace-write 모드에서만 사용할 수 있습니다." };
  }
  if (!chatCwd) {
    return { ok: false, error: "채팅 전용 작업 디렉터리가 없습니다." };
  }

  const permissionInfo = provider.permissions?.[permissionMode];
  if (!permissionInfo || !permissionInfo.supported) {
    return {
      ok: false,
      error: `${provider.name}는 "${permissionMode}" 권한 모드를 지원하지 않습니다.`,
    };
  }

  const normalizedModel = normalizeChoice(model);
  if (normalizedModel === undefined) return { ok: false, error: "모델 이름 형식이 올바르지 않습니다." };
  const normalizedEffort = normalizeChoice(effort);
  if (normalizedEffort === undefined) return { ok: false, error: "속도/노력 값 형식이 올바르지 않습니다." };

  const deliveries = buildDeliveries({
    providerId: provider.id,
    permissionMode,
    attachments,
  });
  const imagePaths = attachments
    .filter((attachment, index) => deliveries[index].method === "native-image")
    .map((attachment) => attachment.path);
  const hasPathDeliveries = deliveries.some((delivery) => delivery.method === "path");

  let argv;
  const cwd = permissionMode === "chat" ? chatCwd : workspace;
  if (provider.id === "claude") {
    argv = claudeArgv({
      permissionMode,
      workspace,
      model: normalizedModel,
      effort: normalizedEffort,
      attachmentsDir,
      hasPathDeliveries,
      autoApprove,
    });
  } else if (provider.id === "codex") {
    argv = codexArgv({
      permissionMode,
      workspace,
      model: normalizedModel,
      effort: normalizedEffort,
      outputFile,
      imagePaths,
      autoApprove,
    });
  } else if (provider.id === "agy") {
    argv = agyArgv({
      permissionMode,
      workspace,
      model: normalizedModel,
      effort: normalizedEffort,
      attachmentsDir,
      hasPathDeliveries,
      autoApprove,
    });
  } else {
    // 알 수 없는 프로바이더: 플래그 없이 stdin 대화만 시도합니다.
    argv = [];
  }

  return {
    ok: true,
    argv: assertSafeArgv(argv, { autoApprove }),
    cwd,
    stdinPrompt: provider.id !== "agy",
    promptTransport: provider.id === "agy" ? "argv" : "stdin",
    deliveries,
    enforcement: permissionInfo.enforcement,
  };
}

module.exports = {
  PERMISSION_MODES,
  INLINE_TEXT_LIMIT,
  buildAgentInvocation,
  assertSafeArgv,
  normalizeChoice,
  attachmentKind,
};

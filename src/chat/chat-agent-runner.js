const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { StringDecoder } = require("node:string_decoder");
const { buildRunDiagnostics, redactSensitiveText } = require("./chat-run-diagnostics");

// 에이전트 작업은 며칠간 이어질 수도 있으므로 기본 실행 시간 제한을 두지 않습니다.
// timeoutMs는 테스트나 명시적인 호출자가 양수를 전달한 경우에만 적용됩니다.
const DEFAULT_TIMEOUT_MS = null;
// 정상적인 장기 실행은 누적 로그량으로 종료하지 않습니다.
// 테스트 등 명시적인 호출자가 지정한 상한만 적용합니다.
const DEFAULT_MAX_OUTPUT_BYTES = null;
const MAX_CAPTURE_CHARS = 2 * 1024 * 1024;
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;
const MAX_ARGV_PROMPT_CHARS = 24 * 1024;

function textTail(previous, text, limit = MAX_CAPTURE_CHARS) {
  const combined = previous + text;
  if (combined.length <= limit) return combined;
  const marker = "[앞부분 출력 생략]\n";
  let tail = combined.slice(-(limit - marker.length));
  if (/^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1);
  return marker + tail;
}
function createPromptFile(prompt, directory = os.tmpdir()) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const file = path.join(directory, `codepet-chat-prompt-${process.pid}-${randomUUID()}.txt`);
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      try {
        fs.writeFileSync(fd, String(prompt || ""), "utf8");
      } finally {
        fs.closeSync(fd);
      }
      return file;
    } catch (error) {
      if (error?.code !== "EEXIST" || attempt === 7) throw error;
    }
  }
  throw new Error("prompt file creation failed");
}

// 실패한 실행에서만 쓰는 승인 요청 추정 패턴입니다. 명시적인 "승인/권한 요청"
// 문구만 매칭하며, 일반적인 "permission denied" 파일 오류는 실행 오류로
// 남겨 승인 UI로 승격하지 않습니다. (단어 조합 휴리스틱은 성공한 실행까지
// 오분류하는 사고가 있어 제거했습니다 — CODEPET_UNKNOWN_ERROR_HANDOFF.md 참고)
const APPROVAL_HINT_PATTERNS = [
  /approval (?:is )?required/i,
  /requires? approval/i,
  /approval request/i,
  /permission request/i,
  /requested permissions?/i,
  /(?:has|have)n'?t (?:been )?granted/i,
  /권한 ?요청/,
  /권한(?:이|을)? ?(?:필요|승인)/,
  /승인(?:이|을)? ?(?:필요|요청)/,
];

// 샌드박스가 실행 자체를 차단한 경우도 승인(=샌드박스 해제 재시도)으로 풀 수
// 있으므로 별도 안내 문구와 함께 승인 요청으로 취급합니다.
const SANDBOX_BLOCK_PATTERNS = [
  /windows sandbox/i,
  /blocked by (?:the )?sandbox/i,
  /sandbox (?:denied|prevented|blocked)/i,
  /샌드박스.{0,20}(?:차단|거부|실패)/,
];

function matchApprovalHint(text) {
  if (!text) return null;
  // Setup failures need sandbox repair, not an approval that disables isolation.
  if (/helper_sandbox_lock_failed|setup refresh had errors|SetNamedSecurityInfoW.*failed/i.test(text)) return null;
  if (/a tool required the ["'][^"']+["'] permission that headless mode cannot prompt for, so it was auto-denied/i.test(text)) {
    return { summary: "명령 실행 승인이 필요합니다." };
  }
  if (APPROVAL_HINT_PATTERNS.some((pattern) => pattern.test(text))) {
    return { summary: "도구 실행 권한이 필요합니다." };
  }
  if (SANDBOX_BLOCK_PATTERNS.some((pattern) => pattern.test(text))) {
    return {
      summary: "샌드박스 제한으로 실행이 차단되었습니다. 승인하면 샌드박스 없이 다시 시도합니다.",
    };
  }
  return null;
}

function quoteForShell(commandPath) {
  return /\s/.test(commandPath) ? `"${commandPath}"` : commandPath;
}

// cmd.exe(shell:true) 경유 시 인자를 개별 인용합니다.
// 참고: cmd는 따옴표 안에서도 %VAR% 확장을 수행하지만, 우리 인자는
// 검증된 플래그/경로뿐이라 %를 포함한 사용자 텍스트가 argv에 실릴 일이 없습니다.
function quoteArgForShell(arg) {
  const text = String(arg);
  if (text === "") return '""';
  if (/[\s&|<>^()"]/.test(text)) return `"${text.replace(/"/g, "")}"`;
  return text;
}

function compactArgvPrompt(prompt, limit = MAX_ARGV_PROMPT_CHARS) {
  const text = String(prompt || "");
  if (text.length <= limit) return text;
  const marker = "\n\n[AGY CLI 명령줄 한도로 이전 대화 일부 생략]\n\n";
  const headLength = Math.min(6000, Math.floor((limit - marker.length) / 3));
  const tailLength = limit - marker.length - headLength;
  return text.slice(0, headLength) + marker + text.slice(-tailLength);
}

function killTree(child, platform = process.platform, spawnKiller = spawn) {
  if (!child || child.exitCode !== null || child.signalCode != null) return;
  if (platform === "win32") {
    // shell(cmd.exe) 경유 실행 시 자식까지 함께 종료해야 합니다.
    let fallbackTimer;
    const fallback = () => {
      clearTimeout(fallbackTimer);
      try { child.kill(); } catch {}
    };
    try {
      const killer = spawnKiller("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
      });
      // Keep the parent alive until taskkill can enumerate its descendants.
      fallbackTimer = setTimeout(fallback, 3000);
      fallbackTimer.unref?.();
      killer.once("error", fallback);
      killer.once("close", (code) => {
        clearTimeout(fallbackTimer);
        if (code !== 0) fallback();
      });
    } catch { fallback(); }
  } else {
    child.kill("SIGTERM");
  }
}

function groupRunning(pid, platform) {
  if (platform === "linux") {
    for (const name of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = fs.readFileSync(`/proc/${name}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        if (Number(fields[2]) === pid && fields[0] !== "Z") return true;
      } catch (error) { if (!["ENOENT", "ESRCH"].includes(error.code)) throw error; }
    }
    return false;
  }
  try { process.kill(-pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

// 프로바이더 프로세스 1회 실행.
// - argv는 chat-argv가 만든 검증된 배열이며, 프롬프트는 stdin/임시 파일 또는
//   제한된 AGY 호환 argv 경로 중 하나로 전달합니다.
// - parseLine이 있으면 stdout을 줄 단위로 정규화 이벤트로 바꿔 onEvent로 알립니다.
// - 최종 답변 우선순위: outputFile(codex -o) → parser final → delta → fallback → stdout.
function runAgentProcess({
  commandPath,
  needsShell = false,
  argv = [],
  prompt,
  cwd,
  env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  platform = process.platform,
  outputFile = null,
  parseLine = null,
  onEvent = null,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  maxLineBytes = MAX_LINE_BYTES,
  promptTransport = "stdin",
  promptFileFlag = "--prompt-file",
  promptFileDirectory = os.tmpdir(),
  provider = "",
  runId = "",
  onCancel = null,
  cancelGraceMs = 500,
}) {
  let child = null;
  let settled = false;
  let cancelled = false;
  let userCancelled = false;
  let timer = null;
  let promptFile = null;
  let cancelCleanupStarted = false;
  let cancellation = null;
  let cancelCleanup = Promise.resolve();
  let closing;
  const closed = new Promise((resolve) => { closing = resolve; });

  const requestCancelCleanup = () => {
    if (cancelCleanupStarted || typeof onCancel !== "function") return;
    cancelCleanupStarted = true;
    try {
      cancelCleanup = Promise.resolve(onCancel());
      cancelCleanup.catch(() => {});
    } catch (error) { cancelCleanup = Promise.reject(error); cancelCleanup.catch(() => {}); }
  };

  const terminate = () => {
    if (cancellation) return cancellation;
    requestCancelCleanup();
    child?.stdout?.resume();
    child?.stderr?.resume();
    cancellation = (async () => {
      if (!child?.pid) { await cancelCleanup; return; }
      if (platform === "win32") {
        killTree(child, platform);
        await closed;
      } else {
        const signalGroup = (signal) => {
          try { process.kill(-child.pid, signal); return true; }
          catch (error) { if (error.code === "ESRCH") return false; throw error; }
        };
        signalGroup("SIGTERM");
        await new Promise((resolve) => setTimeout(resolve, cancelGraceMs));
        signalGroup("SIGKILL");
        await closed;
        const deadline = Date.now() + 2000;
        while (groupRunning(child.pid, platform)) {
          if (Date.now() >= deadline) throw new Error("프로세스 그룹 종료를 확인하지 못했습니다.");
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      }
      await cancelCleanup;
    })();
    cancellation.catch(() => {});
    return cancellation;
  };

  const cleanup = () => {
    if (timer) clearTimeout(timer);
    if (outputFile) {
      try {
        fs.rmSync(outputFile, { force: true });
      } catch {}
    }
    if (promptFile) {
      try {
        fs.rmSync(promptFile, { force: true });
      } catch {}
      promptFile = null;
    }
  };

  const promise = new Promise((resolve) => {
    const finish = async (result) => {
      if (settled) return;
      settled = true;
      result = { status: result.ok ? "completed" : result.text ? "partial" : "failed", ...result };
      if (userCancelled) result = { ...result, ok: false, cancelled: true, status: "cancelled" };
      try { await cancellation; }
      catch (error) { result = { ...result, ok: false, error: redactSensitiveText(error.message) }; }
      cleanup();
      resolve(result);
    };

    if (!["stdin", "argv", "file"].includes(promptTransport)) {
      finish({ ok: false, error: `알 수 없는 프롬프트 전달 방식: ${promptTransport}` });
      return;
    }
    if (promptTransport === "argv" && needsShell) {
      finish({ ok: false, error: "셸 래퍼에는 argv 프롬프트를 안전하게 전달할 수 없습니다." });
      return;
    }
    const executionArgv = [...argv];
    if (promptTransport === "argv") {
      executionArgv.push("--print", compactArgvPrompt(prompt));
    } else if (promptTransport === "file") {
      if (!/^--[a-z0-9-]+$/i.test(String(promptFileFlag || ""))) {
        finish({ ok: false, error: "프롬프트 파일 플래그가 올바르지 않습니다." });
        return;
      }
      try {
        promptFile = createPromptFile(prompt, promptFileDirectory);
        executionArgv.push(promptFileFlag, promptFile);
      } catch (error) {
        finish({ ok: false, error: `프롬프트 파일 생성 실패: ${error.message}` });
        return;
      }
    }
    const command = needsShell ? quoteForShell(commandPath) : commandPath;
    const args = needsShell ? executionArgv.map(quoteArgForShell) : executionArgv;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        shell: Boolean(needsShell),
        windowsHide: true,
        detached: platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      finish({ ok: false, error: `실행 실패: ${error.message}` });
      return;
    }

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let lineParts = [];
    let lineBytes = 0;
    let parsedFinal = null;
    let parsedError = null;
    let parsedApproval = null;
    let parsedWorkspaceChangeManifest = null;
    let deltaText = "";
    let fallbackText = "";
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");

    const emit = (event) => {
      if (!event || settled || cancelled) return;
      if (event.kind === "workspace-change-manifest") {
        parsedWorkspaceChangeManifest = event.manifest;
        return;
      }
      if (event.kind === "final") parsedFinal = event.text;
      // 재연결 과정에서는 여러 오류가 연속으로 옵니다. 첫 경고보다 마지막
      // turn.failed 원인이 사용자에게 더 유용하므로 최신 오류를 보존합니다.
      if (event.kind === "error") parsedError = event.message;
      if (event.kind === "approval-required" && !parsedApproval) parsedApproval = event;
      if (event.kind === "delta") deltaText = textTail(deltaText, event.text);
      if (event.kind === "fallback") {
        fallbackText = textTail(fallbackText, `${fallbackText ? "\n" : ""}${String(event.text || "")}`);
        return;
      }
      if (typeof onEvent === "function") {
        try {
          onEvent(event);
        } catch {}
      }
    };

    const handleLines = (chunk, flush = false) => {
      if (!parseLine || settled) return;
      let start = 0;
      while (start < chunk.length || (flush && lineParts.length)) {
        const end = chunk.indexOf("\n", start);
        const part = chunk.slice(start, end < 0 ? undefined : end);
        lineBytes += Buffer.byteLength(part, "utf8");
        if (lineBytes > maxLineBytes) {
          cancelled = true;
          terminate();
          finish({ ok: false, error: "단일 실행 이벤트가 너무 큽니다. 파일·도구 출력을 나눠서 다시 시도해 주세요." });
          return;
        }
        lineParts.push(part);
        if (end < 0 && !flush) break;
        const line = lineParts.join("").replace(/\r$/, "");
        lineParts = [];
        lineBytes = 0;
        try {
          emit(parseLine(line));
        } catch (error) {
          cancelled = true;
          terminate();
          finish({ ok: false, error: `실행 이벤트 처리 실패: ${redactSensitiveText(error.message)}` });
          return;
        }
        if (end < 0) break;
        start = end + 1;
      }
    };

    child.stdout.on("data", (chunk) => {
      if (settled || cancelled) return;
      const text = stdoutDecoder.write(chunk);
      stdoutBytes += chunk.length;
      if (Number.isFinite(maxOutputBytes) && maxOutputBytes > 0 && stdoutBytes > maxOutputBytes) {
        cancelled = true;
        terminate();
        finish({ ok: false, error: "출력이 너무 길어 실행을 중단했습니다." });
        return;
      }
      if (!parseLine) stdout = textTail(stdout, text);
      handleLines(text);
      if (cancelled || settled) return;
      const traceWrites = parseLine?.flushTraces?.();
      if (traceWrites) {
        // Let the pipe provide backpressure while batched trace writes finish.
        // Long runs keep their full history without building a memory queue.
        child.stdout.pause();
        traceWrites.catch(() => {}).finally(() => { if (!settled) child.stdout.resume(); });
      }
    });
    child.stderr.on("data", (chunk) => {
      if (!settled) stderr = textTail(stderr, stderrDecoder.write(chunk), MAX_STDERR_BYTES);
    });
    child.on("error", (error) => {
      if (!child.pid) closing();
      else terminate();
      finish({ ok: false, error: `실행 실패: ${error.message}` });
    });
    child.on("close", (code) => {
      closing();
      if (settled) return;
      if (cancelled) {
        finish({ ok: false, status: "cancelled", error: "중지됨", cancelled: true });
        return;
      }
      const stdoutTail = stdoutDecoder.end();
      const stderrTail = stderrDecoder.end();
      if (stdoutTail) {
        if (!parseLine) stdout = textTail(stdout, stdoutTail);
        handleLines(stdoutTail);
      }
      if (stderrTail) stderr = textTail(stderr, stderrTail, MAX_STDERR_BYTES);
      if (lineParts.length) handleLines("", true);
      if (settled) return;

      let text = "";
      if (outputFile) {
        try {
          text = fs.readFileSync(outputFile, "utf8");
        } catch {
          text = "";
        }
      }
      if (!String(text || "").trim() && parsedFinal) text = parsedFinal;
      if (!String(text || "").trim() && deltaText) text = deltaText;
      if (!String(text || "").trim() && fallbackText) text = fallbackText;
      if (!String(text || "").trim() && !parseLine) text = stdout;
      text = String(text || "").trim();

      // 실패 결과에는 항상 정제된 진단 기록을 붙여 transcript만으로 원인을
      // 추적할 수 있게 합니다. (민감정보 제거·길이 제한은 diagnostics 모듈 담당)
      const failWith = (partial) => {
        finish({
          ...partial,
          text,
          exitCode: code,
          status: text ? "partial" : "failed",
          diagnostics: buildRunDiagnostics({
            provider,
            runId,
            exitCode: code,
            lastError: parsedError,
            stderr,
            approvalSummary: partial.approval?.summary,
            approvalDetail: partial.approval?.detail,
          }),
        });
      };

      // 1) 파서가 만든 구조화 승인 이벤트는 그대로 신뢰합니다.
      if (parsedApproval) {
        failWith({ ok: false, approvalRequired: true, approval: parsedApproval });
        return;
      }
      // 2) 정상 종료 + 최종 답변이면 stderr 내용과 무관하게 성공입니다.
      //    Codex는 실패한 도구 실행의 출력 전체를 stderr에 에코하므로, stderr
      //    문자열 검사로 성공한 실행을 승인 요청으로 승격하면 안 됩니다.
      if (code === 0 && text) {
        finish({
          ok: true,
          status: "completed",
          exitCode: code,
          text,
          ...(parsedWorkspaceChangeManifest ? { workspaceChangeManifest: parsedWorkspaceChangeManifest } : {}),
        });
        return;
      }
      // 3) 실패한 실행에서 명시적인 승인 요청 문구가 보일 때만 승인 UI로
      //    승격합니다. 판정 근거는 마지막 구조화 오류와 stderr 끝부분만 봅니다.
      const permissionText = `${parsedError || ""}\n${String(stderr || "").slice(-4000)}`.trim();
      const approvalHint = matchApprovalHint(permissionText);
      if (approvalHint) {
        failWith({
          ok: false,
          approvalRequired: true,
          approval: {
            kind: "approval-required",
            summary: approvalHint.summary,
            // 사용자에게 보이는 문구이므로 민감정보를 제거해 담습니다.
            detail: `종료 코드 ${code} · ${redactSensitiveText(permissionText).slice(-2000)}`,
          },
        });
        return;
      }
      const detail = redactSensitiveText(
        parsedError || String(stderr || "").trim().split(/\r?\n/).slice(-3).join(" ")
      ).trim();
      failWith({ ok: false, error: detail || (code !== 0 ? `종료 코드 ${code}` : "빈 응답") });
    });

    child.stdin.on("error", () => {});
    child.stdin.end(promptTransport === "stdin" ? prompt : "", "utf8");

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        cancelled = true;
        terminate();
        finish({ ok: false, error: `시간 초과 (${Math.round(timeoutMs / 1000)}초)` });
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    }
  });

  const cancel = () => {
    if (settled || cancelled) return;
    userCancelled = true;
    cancelled = true;
    terminate();
  };

  return { promise, cancel };
}

module.exports = {
  runAgentProcess,
  matchApprovalHint,
  killTree,
  quoteForShell,
  quoteArgForShell,
  compactArgvPrompt,
  createPromptFile,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  MAX_ARGV_PROMPT_CHARS,
};

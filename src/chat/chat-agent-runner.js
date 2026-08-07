const { spawn } = require("node:child_process");
const fs = require("node:fs");
const { StringDecoder } = require("node:string_decoder");

// 에이전트 작업은 며칠간 이어질 수도 있으므로 기본 실행 시간 제한을 두지 않습니다.
// timeoutMs는 테스트나 명시적인 호출자가 양수를 전달한 경우에만 적용됩니다.
const DEFAULT_TIMEOUT_MS = null;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024; // stdout 누적 상한
const MAX_STDERR_BYTES = 256 * 1024;
const MAX_ARGV_PROMPT_CHARS = 24 * 1024;

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

function killTree(child, platform = process.platform) {
  if (!child || child.killed || child.exitCode !== null) return;
  if (platform === "win32") {
    // shell(cmd.exe) 경유 실행 시 자식까지 함께 종료해야 합니다.
    try {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
      });
      killer.on("error", () => {});
    } catch {}
    // taskkill 자체가 보안 정책으로 막히는 경우에도 직계 프로세스는 닫습니다.
    try {
      child.kill();
    } catch {}
  } else {
    child.kill("SIGTERM");
  }
}

// 프로바이더 프로세스 1회 실행.
// - argv는 chat-argv가 만든 검증된 배열이며, 프롬프트는 항상 stdin으로 전달합니다.
// - parseLine이 있으면 stdout을 줄 단위로 정규화 이벤트로 바꿔 onEvent로 알립니다.
// - 최종 답변 우선순위: outputFile(codex -o) → parser의 final → stdout 원문.
function runAgentProcess({
  commandPath,
  needsShell = false,
  argv = [],
  prompt,
  cwd,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  platform = process.platform,
  outputFile = null,
  parseLine = null,
  onEvent = null,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  promptTransport = "stdin",
}) {
  let child = null;
  let settled = false;
  let cancelled = false;
  let timer = null;

  const cleanup = () => {
    if (timer) clearTimeout(timer);
    if (outputFile) {
      try {
        fs.rmSync(outputFile, { force: true });
      } catch {}
    }
  };

  const promise = new Promise((resolve) => {
    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    if (promptTransport === "argv" && needsShell) {
      finish({ ok: false, error: "셸 래퍼에는 argv 프롬프트를 안전하게 전달할 수 없습니다." });
      return;
    }
    const executionArgv = [...argv];
    if (promptTransport === "argv") {
      executionArgv.push("--print", compactArgvPrompt(prompt));
    }
    const command = needsShell ? quoteForShell(commandPath) : commandPath;
    const args = needsShell ? executionArgv.map(quoteArgForShell) : executionArgv;
    try {
      child = spawn(command, args, {
        cwd,
        shell: Boolean(needsShell),
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      finish({ ok: false, error: `실행 실패: ${error.message}` });
      return;
    }

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let lineBuffer = "";
    let parsedFinal = null;
    let parsedError = null;
    let parsedApproval = null;
    let deltaText = "";
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");

    const emit = (event) => {
      if (!event || settled) return;
      if (event.kind === "final") parsedFinal = event.text;
      // 재연결 과정에서는 여러 오류가 연속으로 옵니다. 첫 경고보다 마지막
      // turn.failed 원인이 사용자에게 더 유용하므로 최신 오류를 보존합니다.
      if (event.kind === "error") parsedError = event.message;
      if (event.kind === "approval-required" && !parsedApproval) parsedApproval = event;
      if (event.kind === "delta") deltaText += event.text;
      if (typeof onEvent === "function") {
        try {
          onEvent(event);
        } catch {}
      }
    };

    const handleLines = (chunk, flush = false) => {
      if (!parseLine) return;
      lineBuffer += chunk;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = flush ? "" : lines.pop() || "";
      for (const line of lines) {
        emit(parseLine(line));
      }
      if (flush && lines.length === 0 && chunk) emit(parseLine(chunk));
    };

    child.stdout.on("data", (chunk) => {
      const text = stdoutDecoder.write(chunk);
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        cancelled = true;
        killTree(child, platform);
        finish({ ok: false, error: "출력이 너무 길어 실행을 중단했습니다." });
        return;
      }
      stdout += text;
      handleLines(text);
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_STDERR_BYTES) stderr += stderrDecoder.write(chunk);
    });
    child.on("error", (error) => {
      finish({ ok: false, error: `실행 실패: ${error.message}` });
    });
    child.on("close", (code) => {
      if (cancelled) {
        finish({ ok: false, error: "중지됨", cancelled: true });
        return;
      }
      const stdoutTail = stdoutDecoder.end();
      const stderrTail = stderrDecoder.end();
      if (stdoutTail) {
        stdout += stdoutTail;
        handleLines(stdoutTail);
      }
      if (stderrTail && stderr.length < MAX_STDERR_BYTES) stderr += stderrTail;
      if (lineBuffer) handleLines("", true);

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
      if (!String(text || "").trim() && !parseLine) text = stdout;
      text = String(text || "").trim();

      const permissionText = `${parsedError || ""}\n${stderr || ""}`;
      if (!parsedApproval && /permission|approval|권한|승인/i.test(permissionText) && /denied|required|prompt|거부|필요/i.test(permissionText)) {
        parsedApproval = {
          kind: "approval-required",
          summary: "도구 실행 권한이 필요합니다.",
          detail: permissionText.trim().slice(-2000),
        };
      }
      if (parsedApproval) {
        finish({ ok: false, approvalRequired: true, approval: parsedApproval });
        return;
      }

      if (code !== 0 && !text) {
        const detail =
          parsedError || String(stderr || "").trim().split(/\r?\n/).slice(-3).join(" ");
        finish({ ok: false, error: detail || `종료 코드 ${code}` });
        return;
      }
      if (!text) {
        finish({ ok: false, error: parsedError || "빈 응답" });
        return;
      }
      finish({ ok: true, text });
    });

    child.stdin.on("error", () => {});
    child.stdin.end(promptTransport === "stdin" ? prompt : "", "utf8");

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        cancelled = true;
        killTree(child, platform);
        finish({ ok: false, error: `시간 초과 (${Math.round(timeoutMs / 1000)}초)` });
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    }
  });

  const cancel = () => {
    cancelled = true;
    killTree(child, platform);
  };

  return { promise, cancel };
}

module.exports = {
  runAgentProcess,
  killTree,
  quoteForShell,
  quoteArgForShell,
  compactArgvPrompt,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  MAX_ARGV_PROMPT_CHARS,
};

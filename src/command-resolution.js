const path = require("node:path");

const WINDOWS_EXECUTABLE_EXTENSIONS = new Set([".exe", ".com"]);
const WINDOWS_SHELL_EXTENSIONS = new Set([".cmd", ".bat"]);

function commandCandidates(whereOutput) {
  return String(whereOutput || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function selectCommandPath(whereOutput, platform = process.platform) {
  const candidates = commandCandidates(whereOutput);
  if (platform !== "win32") return candidates[0] || null;

  const runnable = candidates.filter((candidate) => {
    const extension = path.extname(candidate).toLocaleLowerCase("en");
    return WINDOWS_EXECUTABLE_EXTENSIONS.has(extension) || WINDOWS_SHELL_EXTENSIONS.has(extension);
  });
  const first = runnable[0];
  if (!first) return null;

  // 같은 설치 위치/이름이라면 네이티브 실행 파일을 우선합니다. 서로 다른
  // 설치본이면 PATH 순서를 지켜 Microsoft Store 내부의 접근 제한 exe가
  // 앞선 npm shim을 가로채지 않게 합니다.
  const firstBase = path.join(path.dirname(first), path.basename(first, path.extname(first))).toLowerCase();
  const nativeSibling = runnable.find((candidate) => {
    const extension = path.extname(candidate).toLocaleLowerCase("en");
    const base = path.join(
      path.dirname(candidate),
      path.basename(candidate, path.extname(candidate))
    ).toLowerCase();
    return base === firstBase && WINDOWS_EXECUTABLE_EXTENSIONS.has(extension);
  });
  return nativeSibling || first;
}

function commandNeedsShell(command, platform = process.platform) {
  if (platform !== "win32") return false;
  return WINDOWS_SHELL_EXTENSIONS.has(path.extname(String(command || "")).toLocaleLowerCase("en"));
}

module.exports = { commandNeedsShell, selectCommandPath };

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { grokCredential } = require("./grok-account-switcher");
const { parseGrokAuthStatus } = require("./providers/provider-capabilities");
const { GrokWorkspaceChangeStore } = require("./grok-workspace-changes");

const GROK_DOCKER_IMAGE = "codepet/grok:1.0.0-isolated-write-v5";
const GROK_DOCKER_AUTH_VOLUME = "codepet-grok-auth-v1";
const GROK_DOCKER_LABEL = "app.codepet.grok-runtime=workspace-read";
const DOCKER_PROBE_TIMEOUT_MS = 10_000;
const DOCKER_SETUP_TIMEOUT_MS = 10 * 60_000;
const DOCKER_AUTH_TIMEOUT_MS = 45_000;
const AUTH_CACHE_MS = 5 * 60_000;
const MAX_AUTH_DOCUMENT_BYTES = 256 * 1024;
const MAX_DOCKER_OUTPUT_BYTES = 1024 * 1024;
const GROK_WRITE_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function dockerCommandCandidates(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === "win32") {
    const winPath = path.win32;
    return unique([
      winPath.join(env.LOCALAPPDATA || winPath.join(home, "AppData", "Local"), "Programs", "DockerDesktop", "resources", "bin", "docker.exe"),
      winPath.join(env.ProgramFiles || "", "Docker", "Docker", "resources", "bin", "docker.exe"),
      winPath.join(env.ProgramW6432 || "", "Docker", "Docker", "resources", "bin", "docker.exe"),
    ]).filter((candidate) => winPath.isAbsolute(candidate));
  }
  return unique([
    "/usr/local/bin/docker",
    "/usr/bin/docker",
    platform === "darwin" ? "/opt/homebrew/bin/docker" : null,
  ]);
}

function dockerEnvironment(dockerPath, env = process.env) {
  const directory = path.dirname(dockerPath);
  const entries = String(env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean);
  const nextPath = [directory, ...entries.filter((entry) => path.resolve(entry) !== path.resolve(directory))]
    .join(path.delimiter);
  return { ...env, PATH: nextPath };
}

function parseDockerEndpoint(value) {
  const line = String(value || "").trim().split(/\r?\n/).find(Boolean) || "";
  if (!line) return "";
  try {
    const parsed = JSON.parse(line);
    return typeof parsed === "string" ? parsed.trim() : "";
  } catch {
    return line;
  }
}

function isLocalDockerEndpoint(endpoint, platform = process.platform) {
  const normalized = String(endpoint || "").trim().toLocaleLowerCase("en");
  if (platform === "linux") return normalized.startsWith("unix://");
  if (platform === "win32") return normalized.startsWith("npipe://");
  return false;
}

function defaultGrokDockerAuthVolume(platform = process.platform, home = os.homedir(), getuid = os.getuid) {
  if (platform !== "linux") return GROK_DOCKER_AUTH_VOLUME;
  let userIdentity = "";
  try {
    if (typeof getuid === "function") userIdentity = `uid:${getuid()}`;
  } catch {}
  if (!userIdentity) userIdentity = `home:${path.resolve(home)}`;
  const suffix = crypto.createHash("sha256").update(userIdentity).digest("hex").slice(0, 12);
  return `${GROK_DOCKER_AUTH_VOLUME}-${suffix}`;
}

function defaultRunCommand(file, args, options = {}) {
  const {
    input = null,
    timeoutMs = 30_000,
    env = process.env,
    cwd,
    maxOutputBytes = MAX_DOCKER_OUTPUT_BYTES,
  } = options;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, {
        cwd,
        env,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ ok: false, code: null, stdout: "", stderr: error.message || String(error) });
      return;
    }

    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const append = (target, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        try {
          child.kill();
        } catch {}
        finish({ ok: false, code: null, stdout, stderr: "Docker 출력이 제한을 초과했습니다." });
        return target;
      }
      return target + chunk.toString("utf8");
    };

    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", (error) => {
      finish({ ok: false, code: null, stdout, stderr: error.message || String(error) });
    });
    child.once("close", (code) => {
      finish({ ok: code === 0, code, stdout, stderr });
    });

    child.stdin.on("error", () => {});
    child.stdin.end(input === null ? "" : input);
    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish({ ok: false, code: null, stdout, stderr: `Docker 명령 시간 초과 (${Math.round(timeoutMs / 1000)}초)` });
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
  });
}

function safeDockerError(result, fallback) {
  const detail = String(result?.stderr || result?.stdout || "")
    .trim()
    .split(/\r?\n/)
    .slice(-4)
    .join(" ")
    .slice(0, 800);
  return detail || fallback;
}

function parseAuthDocument(raw) {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text || Buffer.byteLength(text, "utf8") > MAX_AUTH_DOCUMENT_BYTES) return null;

  let document;
  try {
    document = JSON.parse(text);
  } catch {
    return null;
  }
  const credential = grokCredential(document);
  if (!credential || typeof credential.refresh_token !== "string" || !credential.refresh_token.trim()) {
    return null;
  }

  const userId = typeof credential.user_id === "string" ? credential.user_id.trim() : "";
  const principalId = typeof credential.principal_id === "string" ? credential.principal_id.trim() : "";
  const email = typeof credential.email === "string"
    ? credential.email.trim().toLocaleLowerCase("en")
    : "";
  const identity = userId
    ? `user:${userId}`
    : principalId
      ? `principal:${principalId}`
      : email
        ? `email:${email}`
        : `token:${crypto.createHash("sha256").update(credential.refresh_token).digest("hex")}`;

  return { raw: text, identity };
}

function validateWorkspaceMount(workspace, home = os.homedir()) {
  const resolved = path.resolve(String(workspace || ""));
  if (!path.isAbsolute(resolved)) throw new Error("Grok Docker 워크스페이스는 절대 경로여야 합니다.");
  const root = path.parse(resolved).root;
  if (resolved.toLocaleLowerCase("en") === root.toLocaleLowerCase("en")) {
    throw new Error("드라이브 전체는 Grok Docker 워크스페이스로 지정할 수 없습니다.");
  }
  if (home && resolved.toLocaleLowerCase("en") === path.resolve(home).toLocaleLowerCase("en")) {
    throw new Error("사용자 홈 전체는 Grok Docker 워크스페이스로 지정할 수 없습니다.");
  }
  return resolved;
}

function cleanContainerSuffix(value, fallback = "run") {
  return String(value || fallback)
    .toLocaleLowerCase("en")
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 24) || fallback;
}

function createContainerName(runId, randomUUID = crypto.randomUUID) {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 8);
  return `codepet-grok-read-${process.pid}-${cleanContainerSuffix(runId)}-${suffix}`;
}

function createWriteContainerName(runId, randomUUID = crypto.randomUUID) {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 8);
  return `codepet-grok-write-${process.pid}-${cleanContainerSuffix(runId)}-${suffix}`;
}

function createLoginContainerName(randomUUID = crypto.randomUUID) {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  return `codepet-grok-login-${process.pid}-${suffix}`;
}

function assertContainerName(value, prefix) {
  if (!new RegExp(`^${prefix}[a-z0-9_.-]+$`).test(String(value || ""))) {
    throw new Error("Grok Docker 컨테이너 이름이 올바르지 않습니다.");
  }
}

function baseRestrictedContainerArgs({ containerName, pidsLimit }) {
  return [
    "run",
    "--rm",
    "--init",
    "--name",
    containerName,
    "--label",
    GROK_DOCKER_LABEL,
    "--read-only",
    "--network",
    "bridge",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(pidsLimit),
    "--user",
    "1000:1000",
    "--env",
    "HOME=/home/node",
    "--env",
    "GROK_HOME=/home/node/.grok",
    "--env",
    "NO_COLOR=1",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,nodev,size=67108864",
  ];
}

function buildReadContainerArgs({
  workspace,
  grokArgv,
  containerName,
  image = GROK_DOCKER_IMAGE,
  authVolume = GROK_DOCKER_AUTH_VOLUME,
  home = os.homedir(),
}) {
  const project = validateWorkspaceMount(workspace, home);
  assertContainerName(containerName, "codepet-grok-read-");
  return [
    ...baseRestrictedContainerArgs({ containerName, pidsLimit: 256 }),
    "--interactive",
    // Grok's Linux path deny rules use bubblewrap. Docker's default seccomp
    // profile blocks the unprivileged user namespace it needs, so only the
    // disposable read container relaxes seccomp. The outer boundary remains
    // non-root, cap-drop=ALL, no-new-privileges, read-only, and mount-limited.
    "--security-opt",
    "seccomp=unconfined",
    "--volume",
    `${project}:/workspace:ro`,
    "--volume",
    `${authVolume}:/home/node/.grok:rw`,
    "--workdir",
    "/workspace",
    "--entrypoint",
    "/usr/local/bin/codepet-grok-stdin",
    image,
    ...grokArgv,
  ];
}

function buildWriteContainerArgs({
  workspace,
  grokArgv,
  containerName,
  image = GROK_DOCKER_IMAGE,
  authVolume = GROK_DOCKER_AUTH_VOLUME,
  home = os.homedir(),
}) {
  const project = validateWorkspaceMount(workspace, home);
  assertContainerName(containerName, "codepet-grok-write-");
  return [
    ...baseRestrictedContainerArgs({ containerName, pidsLimit: 256 }),
    "--interactive",
    "--security-opt",
    "seccomp=unconfined",
    "--memory",
    "384m",
    "--memory-swap",
    "384m",
    "--tmpfs",
    "/workspace:rw,noexec,nosuid,nodev,size=134217728,uid=1000,gid=1000,mode=0700",
    "--volume",
    `${project}:/workspace-src:ro`,
    "--volume",
    `${authVolume}:/home/node/.grok:rw`,
    "--workdir",
    "/workspace",
    "--entrypoint",
    "/usr/local/bin/codepet-grok-write",
    image,
    ...grokArgv,
  ];
}

function buildLoginContainerArgs({
  containerName,
  image = GROK_DOCKER_IMAGE,
  authVolume = GROK_DOCKER_AUTH_VOLUME,
}) {
  assertContainerName(containerName, "codepet-grok-login-");
  return [
    ...baseRestrictedContainerArgs({ containerName, pidsLimit: 64 }),
    "-it",
    "--volume",
    `${authVolume}:/home/node/.grok:rw`,
    "--workdir",
    "/home/node",
    "--entrypoint",
    "/usr/local/bin/grok-build",
    image,
    "login",
    "--device-auth",
  ];
}

function quoteCmdArgument(value) {
  return `"${String(value).replace(/%/g, "%%").replace(/"/g, '\\"')}"`;
}

function buildWindowsLoginScript(dockerPath, dockerArgs) {
  const command = [dockerPath, ...dockerArgs].map(quoteCmdArgument).join(" ");
  return [
    "@echo off",
    "title CodePet Grok Docker Login",
    "echo CodePet Grok Docker workspace login",
    "echo Complete the device authorization shown below.",
    "echo.",
    command,
    "set CODEPET_LOGIN_EXIT=%ERRORLEVEL%",
    "echo.",
    "if %CODEPET_LOGIN_EXIT% EQU 0 (",
    "  echo Login finished. Return to CodePet and refresh Accounts.",
    ") else (",
    "  echo Login failed with exit code %CODEPET_LOGIN_EXIT%.",
    ")",
    "pause",
    "exit /b %CODEPET_LOGIN_EXIT%",
    "",
  ].join("\r\n");
}

class GrokDockerRuntime {
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
    this.env = options.env || process.env;
    this.home = options.home || os.homedir();
    this.fs = options.fsApi || fs;
    this.runCommand = options.runCommand || defaultRunCommand;
    this.image = options.image || GROK_DOCKER_IMAGE;
    this.authVolume = options.authVolume || defaultGrokDockerAuthVolume(
      this.platform,
      this.home,
      options.getuid || os.getuid
    );
    this.assetsDir = options.assetsDir || path.join(__dirname, "docker", "grok");
    this.tempRoot = options.tempRoot || os.tmpdir();
    this.randomUUID = options.randomUUID || crypto.randomUUID;
    this.dockerPath = options.dockerPath || null;
    this.probeResult = null;
    this.setupPromise = null;
    this.preparePromise = null;
    this.authConfirmedAt = 0;
    this.changeStore = options.changeStore || new GrokWorkspaceChangeStore({ fsApi: this.fs });
  }

  resolveDockerPath() {
    if (this.dockerPath && this.fs.existsSync(this.dockerPath)) return this.dockerPath;
    for (const candidate of dockerCommandCandidates(this.platform, this.env, this.home)) {
      try {
        if (this.fs.existsSync(candidate)) {
          this.dockerPath = candidate;
          return candidate;
        }
      } catch {}
    }
    return null;
  }

  async docker(args, options = {}) {
    const dockerPath = this.resolveDockerPath();
    if (!dockerPath) return { ok: false, code: null, stdout: "", stderr: "Docker CLI를 찾지 못했습니다." };
    return this.runCommand(dockerPath, args, {
      ...options,
      env: dockerEnvironment(dockerPath, this.env),
    });
  }

  async resolveDockerEndpoint() {
    const contextName = String(this.env.DOCKER_CONTEXT || "").trim();
    if (contextName) {
      const result = await this.docker(
        ["context", "inspect", contextName, "--format", "{{json .Endpoints.docker.Host}}"],
        { timeoutMs: DOCKER_PROBE_TIMEOUT_MS, maxOutputBytes: 64 * 1024 }
      );
      if (!result.ok) return "";
      return parseDockerEndpoint(result.stdout);
    }
    const configured = String(this.env.DOCKER_HOST || "").trim();
    if (configured) return configured;
    const result = await this.docker(
      ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"],
      { timeoutMs: DOCKER_PROBE_TIMEOUT_MS, maxOutputBytes: 64 * 1024 }
    );
    if (!result.ok) return "";
    return parseDockerEndpoint(result.stdout);
  }

  async probe({ force = false } = {}) {
    if (this.probeResult && !force) return this.probeResult;
    if (!["win32", "linux"].includes(this.platform)) {
      this.probeResult = {
        available: false,
        reason: "Grok Docker 워크스페이스 통합은 현재 Windows와 Linux에서만 지원합니다.",
      };
      return this.probeResult;
    }
    const dockerPath = this.resolveDockerPath();
    if (!dockerPath) {
      this.probeResult = {
        available: false,
        reason: this.platform === "win32"
          ? "Docker Desktop CLI를 찾지 못했습니다."
          : "Docker CLI를 찾지 못했습니다.",
      };
      return this.probeResult;
    }
    const endpoint = await this.resolveDockerEndpoint();
    if (!isLocalDockerEndpoint(endpoint, this.platform)) {
      this.probeResult = {
        available: false,
        reason: endpoint
          ? "원격 Docker context는 Grok 인증과 로컬 워크스페이스를 안전하게 격리할 수 없어 지원하지 않습니다. 로컬 Docker 소켓을 선택해 주세요."
          : "Docker context의 로컬 endpoint를 확인하지 못했습니다.",
      };
      return this.probeResult;
    }
    const result = await this.docker(["info", "--format", "{{.OSType}}|{{.ServerVersion}}"], {
      timeoutMs: DOCKER_PROBE_TIMEOUT_MS,
    });
    const [osType, version] = String(result.stdout || "").trim().split("|");
    if (!result.ok || osType !== "linux") {
      this.probeResult = {
        available: false,
        reason: result.ok
          ? "Docker의 Linux 컨테이너 백엔드가 필요합니다."
          : `${this.platform === "win32" ? "Docker Desktop" : "Docker daemon"}을 사용할 수 없습니다. ${safeDockerError(result, "")}`.trim(),
      };
      return this.probeResult;
    }
    this.probeResult = { available: true, dockerPath, version: version || "unknown", reason: "" };
    return this.probeResult;
  }

  async imageExists() {
    return (await this.docker(["image", "inspect", this.image], { timeoutMs: DOCKER_PROBE_TIMEOUT_MS })).ok;
  }

  async volumeExists() {
    return (await this.docker(["volume", "inspect", this.authVolume], { timeoutMs: DOCKER_PROBE_TIMEOUT_MS })).ok;
  }

  async ensureImage() {
    if (await this.imageExists()) return;

    const buildDir = this.fs.mkdtempSync(path.join(this.tempRoot, "codepet-grok-build-"));
    try {
      this.fs.copyFileSync(path.join(this.assetsDir, "Dockerfile"), path.join(buildDir, "Dockerfile"));
      this.fs.copyFileSync(path.join(this.assetsDir, "codepet-grok-stdin"), path.join(buildDir, "codepet-grok-stdin"));
      this.fs.copyFileSync(path.join(this.assetsDir, "codepet-grok-write"), path.join(buildDir, "codepet-grok-write"));
      const result = await this.docker(
        ["build", "--pull", "--tag", this.image, "--label", "app.codepet.grok-image=isolated-write-v5", buildDir],
        { timeoutMs: DOCKER_SETUP_TIMEOUT_MS, maxOutputBytes: 4 * MAX_DOCKER_OUTPUT_BYTES }
      );
      if (!result.ok) throw new Error(`Grok Docker 이미지 빌드 실패: ${safeDockerError(result, "알 수 없는 오류")}`);
    } finally {
      const root = path.resolve(this.tempRoot);
      const target = path.resolve(buildDir);
      if (target.startsWith(`${root}${path.sep}`) && path.basename(target).startsWith("codepet-grok-build-")) {
        this.fs.rmSync(target, { recursive: true, force: true });
      }
    }
  }

  readHostAuth() {
    try {
      return parseAuthDocument(
        this.fs.readFileSync(path.join(this.home, ".grok", "auth.json"), "utf8")
      );
    } catch {
      return null;
    }
  }

  async readVolumeAuth() {
    const result = await this.docker([
      "run", "--rm", "--network", "none", "--read-only",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "16",
      "--user", "1000:1000", "--volume", `${this.authVolume}:/home/node/.grok:ro`,
      "--entrypoint", "/bin/sh", this.image,
      "-ceu",
      "if [ -f /home/node/.grok/auth.json ]; then cat /home/node/.grok/auth.json; fi",
    ], { timeoutMs: DOCKER_AUTH_TIMEOUT_MS, maxOutputBytes: MAX_AUTH_DOCUMENT_BYTES });
    if (!result.ok) throw new Error("Grok Docker 인증 볼륨을 읽지 못했습니다.");
    return parseAuthDocument(result.stdout || "");
  }

  async seedVolumeAuth(raw) {
    const auth = parseAuthDocument(raw);
    if (!auth) throw new Error("동기화할 Grok 로그인 정보가 올바르지 않습니다.");
    const result = await this.docker([
      "run", "--rm", "--interactive", "--network", "none", "--read-only",
      "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "FOWNER", "--cap-add", "DAC_OVERRIDE",
      "--security-opt", "no-new-privileges", "--pids-limit", "32",
      "--user", "0:0", "--volume", `${this.authVolume}:/home/node/.grok:rw`,
      "--entrypoint", "/bin/sh", this.image,
      "-ceu",
      [
        "umask 077",
        "target=/home/node/.grok/auth.json",
        "temp=/home/node/.grok/.auth.json.codepet.$$",
        "trap 'rm -f \"$temp\"' EXIT HUP INT TERM",
        "cat > \"$temp\"",
        "chown 1000:1000 \"$temp\"",
        "chmod 600 \"$temp\"",
        "mv -f \"$temp\" \"$target\"",
        "trap - EXIT HUP INT TERM",
      ].join("; "),
    ], {
      input: auth.raw,
      timeoutMs: DOCKER_AUTH_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024,
    });
    if (!result.ok) throw new Error(`Grok Docker 로그인 동기화 실패: ${safeDockerError(result, "알 수 없는 오류")}`);
    return auth;
  }

  async syncAuth() {
    const [hostAuth, volumeAuth] = await Promise.all([
      Promise.resolve(this.readHostAuth()),
      this.readVolumeAuth(),
    ]);
    if (!hostAuth || hostAuth.identity === volumeAuth?.identity) {
      return { seeded: false, auth: volumeAuth || hostAuth || null };
    }
    const auth = await this.seedVolumeAuth(hostAuth.raw);
    this.authConfirmedAt = 0;
    return { seeded: true, auth };
  }

  async prepareVolumeOwnership() {
    const result = await this.docker([
      "run", "--rm", "--network", "none", "--read-only",
      "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "FOWNER", "--cap-add", "DAC_OVERRIDE",
      "--security-opt", "no-new-privileges", "--pids-limit", "32",
      "--user", "0:0", "--volume", `${this.authVolume}:/home/node/.grok:rw`,
      "--entrypoint", "/bin/sh", this.image,
      "-ceu",
      "chown 1000:1000 /home/node/.grok; chmod 700 /home/node/.grok; find /home/node/.grok -maxdepth 1 -type f -exec chown 1000:1000 {} + -exec chmod go-rwx {} +",
    ], { timeoutMs: DOCKER_AUTH_TIMEOUT_MS });
    if (!result.ok) throw new Error(`Grok 인증 볼륨 준비 실패: ${safeDockerError(result, "알 수 없는 오류")}`);
  }

  async ensureVolume() {
    if (!(await this.volumeExists())) {
      const created = await this.docker(
        ["volume", "create", "--label", "app.codepet.scope=grok-auth", this.authVolume],
        { timeoutMs: DOCKER_PROBE_TIMEOUT_MS }
      );
      if (!created.ok) throw new Error(`Grok 인증 볼륨 생성 실패: ${safeDockerError(created, "알 수 없는 오류")}`);
    }
    await this.prepareVolumeOwnership();
  }

  async ensureSetup() {
    if (this.setupPromise) return this.setupPromise;
    this.setupPromise = (async () => {
      const probe = await this.probe({ force: true });
      if (!probe.available) throw new Error(probe.reason || "Docker를 사용할 수 없습니다.");
      await this.ensureImage();
      await this.ensureVolume();
      return true;
    })();
    try {
      return await this.setupPromise;
    } finally {
      this.setupPromise = null;
    }
  }

  async probeContainerAuth() {
    const result = await this.docker([
      "run", "--rm", "--init", "--read-only", "--network", "bridge",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "64",
      "--user", "1000:1000", "--env", "HOME=/home/node", "--env", "GROK_HOME=/home/node/.grok",
      "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=33554432",
      "--volume", `${this.authVolume}:/home/node/.grok:rw`,
      "--entrypoint", "/usr/local/bin/grok-build", this.image, "models",
    ], { timeoutMs: DOCKER_AUTH_TIMEOUT_MS });
    const status = parseGrokAuthStatus(`${result.stdout || ""}\n${result.stderr || ""}`);
    return { ok: result.ok && status === "authenticated", status, result };
  }

  async probeContainerAuthWithHostRecovery() {
    let auth = await this.probeContainerAuth();
    if (auth.ok || auth.status !== "unauthenticated") return auth;

    // The container can refresh its own token, so syncAuth intentionally keeps
    // a same-account volume document. After an unclean shutdown that document
    // may be stale or incomplete even while the native Grok login is healthy.
    // Retry once from the host credential, but never replace it for an unknown
    // probe failure such as a network outage.
    const hostAuth = this.readHostAuth();
    if (!hostAuth) return auth;
    await this.seedVolumeAuth(hostAuth.raw);
    auth = await this.probeContainerAuth();
    return auth;
  }

  async status({ force = false } = {}) {
    const loginMode = this.platform === "win32" ? "interactive" : "host-sync";
    const probe = await this.probe({ force });
    if (!probe.available) {
      return { available: false, setupReady: false, authenticated: false, loginMode, reason: probe.reason };
    }
    const [imageReady, volumeReady] = await Promise.all([this.imageExists(), this.volumeExists()]);
    if (!imageReady || !volumeReady) {
      return {
        available: true,
        setupReady: false,
        authenticated: false,
        loginMode,
        reason: this.platform === "win32"
          ? "Docker 전용 Grok 로그인이 필요합니다. 최초 준비에는 이미지 빌드가 포함됩니다."
          : "최초 실행 시 Docker 이미지를 준비하고 호스트 Grok 로그인을 자동으로 동기화합니다.",
      };
    }
    try {
      await this.syncAuth();
    } catch (error) {
      return {
        available: true,
        setupReady: true,
        authenticated: false,
        loginMode,
        reason: error?.message || "Docker Grok 로그인 동기화에 실패했습니다.",
      };
    }
    const auth = await this.probeContainerAuthWithHostRecovery();
    if (auth.ok) this.authConfirmedAt = Date.now();
    return {
      available: true,
      setupReady: true,
      authenticated: auth.ok,
      loginMode,
      reason: auth.ok
        ? "프로젝트 하나만 읽기 전용으로 노출합니다."
        : auth.status === "unauthenticated"
          ? this.platform === "win32"
            ? "Docker 전용 Grok 로그인이 필요합니다."
            : "호스트 Grok CLI 로그인을 새로 완료한 뒤 인증을 다시 동기화해 주세요."
          : `Docker Grok 로그인 상태를 확인하지 못했습니다. ${safeDockerError(auth.result, "")}`.trim(),
    };
  }

  async ensureReady() {
    if (this.authConfirmedAt && Date.now() - this.authConfirmedAt < AUTH_CACHE_MS) return true;
    if (this.preparePromise) return this.preparePromise;
    this.preparePromise = (async () => {
      await this.ensureSetup();
      await this.syncAuth();
      const auth = await this.probeContainerAuthWithHostRecovery();
      if (!auth.ok) {
        this.authConfirmedAt = 0;
        if (this.platform !== "win32" && !this.readHostAuth()) {
          throw new Error(
            "호스트 Grok CLI 로그인이 필요합니다. `grok login`을 완료한 뒤 다시 시도해 주세요."
          );
        }
        throw new Error(
          this.platform === "win32"
            ? "Docker Grok 전용 로그인이 필요합니다. 설정 > 계정 > Grok에서 ‘Docker 로그인’을 완료한 뒤 다시 시도해 주세요."
            : "호스트 Grok 인증을 Docker 실행기에 동기화했지만 로그인 상태를 확인하지 못했습니다. `grok login`을 새로 완료한 뒤 다시 시도해 주세요."
        );
      }
      this.authConfirmedAt = Date.now();
      return true;
    })();
    try {
      return await this.preparePromise;
    } finally {
      this.preparePromise = null;
    }
  }

  buildLoginExecution() {
    const dockerPath = this.resolveDockerPath();
    if (!dockerPath) throw new Error("Docker CLI를 찾지 못했습니다.");
    const containerName = createLoginContainerName(this.randomUUID);
    return {
      dockerPath,
      containerName,
      argv: buildLoginContainerArgs({
        containerName,
        image: this.image,
        authVolume: this.authVolume,
      }),
    };
  }

  async prepareLoginScript(directory) {
    if (this.platform !== "win32") throw new Error("Docker Grok 로그인 스크립트는 현재 Windows에서만 지원합니다.");
    await this.ensureSetup();
    this.authConfirmedAt = 0;
    const execution = this.buildLoginExecution();
    const scriptPath = path.join(directory, "codepet-grok-docker-login.cmd");
    this.fs.writeFileSync(
      scriptPath,
      buildWindowsLoginScript(execution.dockerPath, execution.argv),
      "utf8"
    );
    return scriptPath;
  }

  buildReadExecution({ workspace, grokArgv, runId, cwd }) {
    const dockerPath = this.resolveDockerPath();
    if (!dockerPath) throw new Error("Docker CLI를 찾지 못했습니다.");
    const containerName = createContainerName(runId, this.randomUUID);
    return {
      commandPath: dockerPath,
      needsShell: false,
      argv: buildReadContainerArgs({
        workspace,
        grokArgv,
        containerName,
        image: this.image,
        authVolume: this.authVolume,
        home: this.home,
      }),
      cwd: cwd || this.tempRoot,
      promptTransport: "stdin",
      containerName,
      onCancel: () => this.stopContainer(containerName),
    };
  }

  buildWriteExecution({ workspace, grokArgv, runId, cwd }) {
    const dockerPath = this.resolveDockerPath();
    if (!dockerPath) throw new Error("Docker CLI를 찾지 못했습니다.");
    const containerName = createWriteContainerName(runId, this.randomUUID);
    return {
      commandPath: dockerPath,
      needsShell: false,
      argv: buildWriteContainerArgs({
        workspace,
        grokArgv,
        containerName,
        image: this.image,
        authVolume: this.authVolume,
        home: this.home,
      }),
      cwd: cwd || this.tempRoot,
      promptTransport: "stdin",
      maxOutputBytes: GROK_WRITE_MAX_OUTPUT_BYTES,
      containerName,
      onCancel: () => this.stopContainer(containerName),
    };
  }

  stageWriteChangeSet({ sessionId, workspace, manifest }) {
    return this.changeStore.stage({
      sessionId,
      workspace,
      manifest,
      diff: manifest?.diff || "",
    });
  }

  applyWorkspaceChanges(id, sessionId) {
    return this.changeStore.apply(id, sessionId);
  }

  cancelWorkspaceChanges(id, sessionId) {
    return this.changeStore.cancel(id, sessionId);
  }

  discardSessionChanges(sessionId) {
    this.changeStore.discardSession(sessionId);
  }

  clearWorkspaceChanges() {
    this.changeStore.clear();
  }

  async stopContainer(containerName) {
    if (!/^codepet-grok-(?:read|write)-[a-z0-9_.-]+$/.test(String(containerName || ""))) return false;
    const result = await this.docker(["rm", "-f", containerName], { timeoutMs: DOCKER_PROBE_TIMEOUT_MS });
    return result.ok;
  }
}

module.exports = {
  GrokDockerRuntime,
  GROK_DOCKER_IMAGE,
  GROK_DOCKER_AUTH_VOLUME,
  GROK_DOCKER_LABEL,
  GROK_WRITE_MAX_OUTPUT_BYTES,
  dockerCommandCandidates,
  dockerEnvironment,
  defaultGrokDockerAuthVolume,
  defaultRunCommand,
  parseAuthDocument,
  validateWorkspaceMount,
  createContainerName,
  createWriteContainerName,
  createLoginContainerName,
  buildReadContainerArgs,
  buildWriteContainerArgs,
  buildLoginContainerArgs,
  buildWindowsLoginScript,
};

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  GrokDockerRuntime,
  GROK_DOCKER_IMAGE,
  GROK_DOCKER_AUTH_VOLUME,
  GROK_WRITE_MAX_OUTPUT_BYTES,
  dockerCommandCandidates,
  defaultGrokDockerAuthVolume,
  parseAuthDocument,
  validateWorkspaceMount,
  createContainerName,
  buildReadContainerArgs,
  buildWriteContainerArgs,
} = require("../src/grok-docker-runtime");

const HOME = path.join(os.tmpdir(), "codepet-home");
const WORKSPACE = path.join(os.tmpdir(), "codepet-project");

test("workspace-write는 읽기 전용 원본과 인증 볼륨 외 호스트 경로를 마운트하지 않는다", () => {
  const args = buildWriteContainerArgs({
    workspace: WORKSPACE,
    grokArgv: ["--allow", "Edit"],
    containerName: "codepet-grok-write-1-r1-12345678",
    home: HOME,
  });
  const volumes = args.map((arg, index) => arg === "--volume" ? args[index + 1] : null).filter(Boolean);
  assert.deepEqual(volumes, [
    `${path.resolve(WORKSPACE)}:/workspace-src:ro`,
    `${GROK_DOCKER_AUTH_VOLUME}:/home/node/.grok:rw`,
  ]);
  assert.doesNotMatch(volumes.join(" "), /docker\.sock|\/mnt\/host|codepet-grok-stage|C:\\Users\\u/i);
  for (const required of [
    "--rm",
    "--read-only",
    "--cap-drop",
    "ALL",
    "no-new-privileges",
    "seccomp=unconfined",
    "--memory",
    "384m",
    "--memory-swap",
    "/workspace:rw,noexec,nosuid,nodev,size=134217728,uid=1000,gid=1000,mode=0700",
    "1000:1000",
  ]) {
    assert.ok(args.includes(required), required);
  }
  assert.equal(args[args.indexOf("--entrypoint") + 1], "/usr/local/bin/codepet-grok-write");
});

test("workspace-write 실행은 구조화 변경 세트를 위한 제한된 출력 상한을 쓴다", () => {
  const dockerPath = path.join(HOME, "docker.exe");
  const runtime = new GrokDockerRuntime({
    platform: "win32",
    home: HOME,
    dockerPath,
    randomUUID: () => "12345678-1234-1234-1234-123456789abc",
    fsApi: { existsSync: (file) => file === dockerPath },
  });
  const execution = runtime.buildWriteExecution({
    workspace: WORKSPACE,
    grokArgv: ["--allow", "Edit"],
    runId: "r1",
  });
  assert.equal(execution.maxOutputBytes, GROK_WRITE_MAX_OUTPUT_BYTES);
  assert.equal(execution.promptTransport, "stdin");
  assert.match(execution.containerName, /^codepet-grok-write-/);
});

function auth(identity, token) {
  return JSON.stringify({
    "https://auth.x.ai::client": {
      user_id: identity,
      email: `${identity}@example.com`,
      refresh_token: token,
    },
  });
}

test("Docker Desktop 후보에 사용자 설치와 표준 설치 경로가 모두 포함된다", () => {
  const env = {
    LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
    ProgramFiles: "C:\\Program Files",
  };
  const candidates = dockerCommandCandidates("win32", env, "C:\\Users\\u");
  assert.ok(candidates.includes(path.win32.join(env.LOCALAPPDATA, "Programs", "DockerDesktop", "resources", "bin", "docker.exe")));
  assert.ok(candidates.includes(path.win32.join(env.ProgramFiles, "Docker", "Docker", "resources", "bin", "docker.exe")));
});

test("Linux Grok 인증 볼륨은 OS 사용자별로 분리된다", () => {
  const first = defaultGrokDockerAuthVolume("linux", "/home/alpha", () => 1000);
  const same = defaultGrokDockerAuthVolume("linux", "/different/home", () => 1000);
  const second = defaultGrokDockerAuthVolume("linux", "/home/beta", () => 1001);
  assert.equal(first, same);
  assert.notEqual(first, second);
  assert.match(first, /^codepet-grok-auth-v1-[a-f0-9]{12}$/);
  assert.equal(defaultGrokDockerAuthVolume("win32", "C:\\Users\\u", () => 1000), GROK_DOCKER_AUTH_VOLUME);
});

test("Docker daemon 프로브는 Linux 백엔드만 workspace-read 가능으로 인정한다", async () => {
  const dockerPath = path.join(HOME, "DockerDesktop", "resources", "bin", "docker.exe");
  const calls = [];
  const runtime = new GrokDockerRuntime({
    platform: "win32",
    env: {
      LOCALAPPDATA: path.join(HOME, "DockerDesktop", "..", ".."),
      PATH: "C:\\Windows\\System32",
      DOCKER_HOST: "npipe:////./pipe/docker_engine",
    },
    home: HOME,
    dockerPath,
    fsApi: { existsSync: (file) => file === dockerPath },
    runCommand: async (file, args, options) => {
      calls.push({ file, args, options });
      return { ok: true, code: 0, stdout: "linux|29.6.2\n", stderr: "" };
    },
  });
  const result = await runtime.probe();
  assert.equal(result.available, true);
  assert.equal(result.version, "29.6.2");
  assert.deepEqual(calls[0].args, ["info", "--format", "{{.OSType}}|{{.ServerVersion}}"]);
  assert.ok(calls[0].options.env.PATH.startsWith(path.dirname(dockerPath)));
});

test("Linux Docker daemon 프로브가 통과하면 workspace 실행기를 노출한다", async () => {
  const dockerPath = "/usr/bin/docker";
  const calls = [];
  const runtime = new GrokDockerRuntime({
    platform: "linux",
    env: { PATH: "/usr/bin", DOCKER_HOST: "unix:///var/run/docker.sock" },
    home: "/home/person",
    dockerPath,
    fsApi: { existsSync: (file) => file === dockerPath },
    runCommand: async (file, args, options) => {
      calls.push({ file, args, options });
      return { ok: true, code: 0, stdout: "linux|29.6.2\n", stderr: "" };
    },
  });

  assert.deepEqual(await runtime.probe(), {
    available: true,
    dockerPath,
    version: "29.6.2",
    reason: "",
  });
  assert.deepEqual(calls[0].args, ["info", "--format", "{{.OSType}}|{{.ServerVersion}}"]);
});

test("Linux Docker daemon 접근 거부를 Windows 전용 안내로 오표하지 않는다", async () => {
  const dockerPath = "/usr/bin/docker";
  const runtime = new GrokDockerRuntime({
    platform: "linux",
    env: { DOCKER_HOST: "unix:///var/run/docker.sock" },
    dockerPath,
    fsApi: { existsSync: (file) => file === dockerPath },
    runCommand: async () => ({
      ok: false,
      code: 1,
      stdout: "",
      stderr: "permission denied while trying to connect to the docker API",
    }),
  });

  const result = await runtime.probe();
  assert.equal(result.available, false);
  assert.match(result.reason, /Docker daemon/);
  assert.match(result.reason, /permission denied/);
  assert.doesNotMatch(result.reason, /Windows|Docker Desktop/);
});

test("Linux 원격 Docker context는 인증이나 workspace를 보내기 전에 거부한다", async () => {
  const dockerPath = "/usr/bin/docker";
  const calls = [];
  const runtime = new GrokDockerRuntime({
    platform: "linux",
    env: { DOCKER_HOST: "ssh://builder@example.invalid" },
    dockerPath,
    fsApi: { existsSync: (file) => file === dockerPath },
    runCommand: async (_file, args) => {
      calls.push(args);
      return { ok: true, code: 0, stdout: "linux|29.6.2\n", stderr: "" };
    },
  });

  const result = await runtime.probe();
  assert.equal(result.available, false);
  assert.match(result.reason, /원격 Docker context/);
  assert.deepEqual(calls, []);
});

test("DOCKER_CONTEXT는 DOCKER_HOST보다 우선하여 원격 endpoint를 검증한다", async () => {
  const dockerPath = "/usr/bin/docker";
  const calls = [];
  const runtime = new GrokDockerRuntime({
    platform: "linux",
    env: {
      DOCKER_CONTEXT: "remote-builder",
      DOCKER_HOST: "unix:///var/run/docker.sock",
    },
    dockerPath,
    fsApi: { existsSync: (file) => file === dockerPath },
    runCommand: async (_file, args) => {
      calls.push(args);
      if (args[0] === "context") {
        return { ok: true, code: 0, stdout: '"ssh://builder@example.invalid"\n', stderr: "" };
      }
      return { ok: true, code: 0, stdout: "linux|29.6.2\n", stderr: "" };
    },
  });

  const result = await runtime.probe();
  assert.equal(result.available, false);
  assert.match(result.reason, /원격 Docker context/);
  assert.deepEqual(calls, [[
    "context",
    "inspect",
    "remote-builder",
    "--format",
    "{{json .Endpoints.docker.Host}}",
  ]]);
});

test("검증하지 않은 macOS Docker 경로는 workspace 권한으로 승격하지 않는다", async () => {
  const runtime = new GrokDockerRuntime({
    platform: "darwin",
    dockerPath: "/usr/local/bin/docker",
    fsApi: { existsSync: () => true },
    runCommand: async () => ({
      ok: true,
      code: 0,
      stdout: "linux|29.6.2\n",
      stderr: "",
    }),
  });

  const result = await runtime.probe();
  assert.equal(result.available, false);
  assert.match(result.reason, /Windows와 Linux/);
});

test("Linux 실행 준비는 별도 로그인 스크립트 없이 호스트 인증을 동기화한다", async () => {
  const runtime = new GrokDockerRuntime({ platform: "linux" });
  const steps = [];
  runtime.ensureSetup = async () => steps.push("setup");
  runtime.syncAuth = async () => {
    steps.push("sync-host-auth");
    return { seeded: true, auth: parseAuthDocument(auth("alpha", "host-token")) };
  };
  runtime.probeContainerAuthWithHostRecovery = async () => {
    steps.push("probe-container-auth");
    return { ok: true, status: "authenticated", result: { ok: true } };
  };

  assert.equal(await runtime.ensureReady(), true);
  assert.deepEqual(steps, ["setup", "sync-host-auth", "probe-container-auth"]);
});

test("읽기 컨테이너 argv는 프로젝트 하나와 인증 볼륨만 마운트하고 위험 옵션을 배제한다", () => {
  const containerName = createContainerName("run-1", () => "12345678-1234-1234-1234-123456789abc");
  const args = buildReadContainerArgs({
    workspace: WORKSPACE,
    grokArgv: ["--allow", "Read", "--deny", "Edit"],
    containerName,
    home: HOME,
  });
  const volumes = args
    .map((arg, index) => (arg === "--volume" ? args[index + 1] : null))
    .filter(Boolean);
  assert.deepEqual(volumes, [
    `${path.resolve(WORKSPACE)}:/workspace:ro`,
    `${GROK_DOCKER_AUTH_VOLUME}:/home/node/.grok:rw`,
  ]);
  for (const required of ["--rm", "--init", "--interactive", "--read-only", "--cap-drop", "ALL", "no-new-privileges", "seccomp=unconfined", "--pids-limit", "1000:1000", "bridge"] ) {
    assert.ok(args.includes(required), required);
  }
  assert.equal(args[args.indexOf("--entrypoint") + 1], "/usr/local/bin/codepet-grok-stdin");
  assert.ok(args.includes(GROK_DOCKER_IMAGE));
  assert.ok(!args.includes("--privileged"));
  assert.doesNotMatch(args.join(" "), /docker\.sock|\/mnt\/host|C:\\Users\\u/i);
});

test("드라이브 루트와 사용자 홈 전체는 프로젝트 마운트로 거부한다", () => {
  assert.throws(() => validateWorkspaceMount(path.parse(WORKSPACE).root, HOME), /드라이브 전체/);
  assert.throws(() => validateWorkspaceMount(HOME, HOME), /사용자 홈 전체/);
});

test("같은 계정의 컨테이너 토큰은 보존하고 계정이 바뀔 때만 stdin으로 동기화한다", async () => {
  const runtime = new GrokDockerRuntime({ platform: "win32" });
  const hostA = parseAuthDocument(auth("alpha", "host-new"));
  const volumeA = parseAuthDocument(auth("alpha", "container-refreshed"));
  let seeded = null;
  runtime.readHostAuth = () => hostA;
  runtime.readVolumeAuth = async () => volumeA;
  runtime.seedVolumeAuth = async (raw) => {
    seeded = raw;
    return parseAuthDocument(raw);
  };
  const preserved = await runtime.syncAuth();
  assert.equal(preserved.seeded, false);
  assert.equal(seeded, null);

  runtime.readVolumeAuth = async () => parseAuthDocument(auth("beta", "other"));
  const replaced = await runtime.syncAuth();
  assert.equal(replaced.seeded, true);
  assert.equal(seeded, hostA.raw);
});

test("같은 계정의 오래된 컨테이너 인증은 미인증 응답 뒤 호스트 인증으로 한 번 복구한다", async () => {
  const runtime = new GrokDockerRuntime({ platform: "win32" });
  const host = parseAuthDocument(auth("alpha", "host-current"));
  const probes = [
    { ok: false, status: "unauthenticated", result: { ok: true, code: 0, stdout: "", stderr: "" } },
    { ok: true, status: "authenticated", result: { ok: true, code: 0, stdout: "", stderr: "" } },
  ];
  let seeded = null;
  runtime.probeContainerAuth = async () => probes.shift();
  runtime.readHostAuth = () => host;
  runtime.seedVolumeAuth = async (raw) => {
    seeded = raw;
    return parseAuthDocument(raw);
  };

  const recovered = await runtime.probeContainerAuthWithHostRecovery();
  assert.equal(recovered.ok, true);
  assert.equal(seeded, host.raw);
  assert.equal(probes.length, 0);
});

test("네트워크 등 알 수 없는 인증 프로브 실패에는 호스트 토큰을 덮어쓰지 않는다", async () => {
  const runtime = new GrokDockerRuntime({ platform: "win32" });
  let seeded = false;
  runtime.probeContainerAuth = async () => ({
    ok: false,
    status: "unknown",
    result: { ok: false, code: 1, stdout: "", stderr: "network unavailable" },
  });
  runtime.readHostAuth = () => parseAuthDocument(auth("alpha", "host-current"));
  runtime.seedVolumeAuth = async () => {
    seeded = true;
  };

  const failed = await runtime.probeContainerAuthWithHostRecovery();
  assert.equal(failed.ok, false);
  assert.equal(failed.status, "unknown");
  assert.equal(seeded, false);
});

test("인증 시크릿은 Docker argv가 아니라 network-none 준비 컨테이너 stdin에만 실린다", async () => {
  const dockerPath = path.join(HOME, "docker.exe");
  const calls = [];
  const raw = auth("alpha", "TOP_SECRET_REFRESH_TOKEN");
  const runtime = new GrokDockerRuntime({
    platform: "win32",
    dockerPath,
    fsApi: { existsSync: (file) => file === dockerPath },
    runCommand: async (file, args, options) => {
      calls.push({ file, args, options });
      return { ok: true, code: 0, stdout: "", stderr: "" };
    },
  });
  await runtime.seedVolumeAuth(raw);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes("--interactive"));
  assert.ok(calls[0].args.includes("none"));
  for (const capability of ["CHOWN", "FOWNER", "DAC_OVERRIDE"]) assert.ok(calls[0].args.includes(capability));
  assert.equal(calls[0].options.input, raw);
  assert.doesNotMatch(JSON.stringify(calls[0].args), /TOP_SECRET_REFRESH_TOKEN|refresh_token/);
});

test("실행 취소는 생성한 정확한 컨테이너 이름만 rm -f 한다", async () => {
  const dockerPath = path.join(HOME, "docker.exe");
  const calls = [];
  const runtime = new GrokDockerRuntime({
    platform: "win32",
    home: HOME,
    dockerPath,
    randomUUID: () => "12345678-1234-1234-1234-123456789abc",
    fsApi: { existsSync: (file) => file === dockerPath },
    runCommand: async (_file, args) => {
      calls.push(args);
      return { ok: true, code: 0, stdout: "", stderr: "" };
    },
  });
  const execution = runtime.buildReadExecution({
    workspace: WORKSPACE,
    grokArgv: ["--allow", "Read"],
    runId: "r1",
    cwd: os.tmpdir(),
  });
  await execution.onCancel();
  assert.deepEqual(calls.at(-1), ["rm", "-f", execution.containerName]);
});

test("배포 이미지 자산은 공식 Grok 버전과 base digest를 고정하고 프롬프트를 stdin으로 받는다", () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, "..", "src", "docker", "grok", "Dockerfile"), "utf8");
  const entrypoint = fs.readFileSync(path.join(__dirname, "..", "src", "docker", "grok", "codepet-grok-stdin"), "utf8");
  const writeEntrypoint = fs.readFileSync(path.join(__dirname, "..", "src", "docker", "grok", "codepet-grok-write"), "utf8");
  assert.match(dockerfile, /node:22-bookworm-slim@sha256:d649c27d/);
  assert.match(dockerfile, /@xai-official\/grok@\$\{GROK_VERSION\}/);
  assert.match(dockerfile, /ARG GROK_VERSION=1\.0\.0/);
  assert.match(dockerfile, /apt-get install -y --no-install-recommends bubblewrap/);
  assert.match(GROK_DOCKER_IMAGE, /isolated-write-v5$/);
  assert.match(entrypoint, /cat > "\$prompt_file"/);
  assert.match(dockerfile, /install -m 0555 .*\/usr\/local\/bin\/grok-build/);
  assert.match(entrypoint, /grok-build --prompt-file/);
  assert.match(writeEntrypoint, /CODEPET_GROK_CHANGESET_V1/);
  assert.match(writeEntrypoint, /rejectLinks: true/);
  assert.match(writeEntrypoint, /writeFileSync\(target, record\.content, \{ mode: 0o600/);
  assert.doesNotMatch(writeEntrypoint, /before\.mode !== after\.mode/);
  assert.doesNotMatch(writeEntrypoint, /\/stage|docker\.sock|\/mnt\/host/);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

test("펫과 채팅은 하나의 code-pet 패키지로 배포된다", () => {
  assert.equal(packageJson.name, "code-pet");
  assert.equal(packageJson.main, "src/main.js");
  assert.equal(packageJson.build.productName, "CodePet");
});

test("MIT 라이선스 파일과 license 필드가 있다", () => {
  assert.equal(packageJson.license, "MIT");
  const license = fs.readFileSync(path.join(ROOT, "LICENSE"), "utf8");
  assert.match(license, /MIT License/);
});

test("전역 실행 도우미(bin)가 선언되어 있고 존재한다", () => {
  assert.equal(packageJson.private, false);
  assert.equal(packageJson.bin["code-pet"], "bin/code-pet.js");
  assert.ok(packageJson.optionalDependencies.electron, "npm 전역 설치본에도 Electron 런타임이 필요합니다");
  const launcher = fs.readFileSync(path.join(ROOT, "bin", "code-pet.js"), "utf8");
  assert.match(launcher, /doctor/);
  // doctor는 자격 증명을 출력하지 않는다: 상태/버전/안내만 출력하는 구조인지 확인
  assert.doesNotMatch(launcher, /auth|token|credential/i);
});

test("npm 팩 대상은 실행 파일 형식과 CLI 진입점만 허용한다", () => {
  assert.deepEqual(packageJson.files, [
    "src/**/*.js",
    "src/**/*.html",
    "src/**/*.css",
    "src/**/*.json",
    "src/**/*.png",
    "src/**/*.webp",
    "src/docker/grok/Dockerfile",
    "src/docker/grok/codepet-grok-*",
    "bin/code-pet.js",
    "build/icon.ico",
    "build/icon.png",
  ]);
  assert.doesNotMatch(packageJson.files.join("\n"), /test|README|\.github|scripts/);
});

test("electron-builder 설정이 유지된다 (portable/dmg/AppImage)", () => {
  assert.deepEqual(packageJson.build.win.target, ["portable"]);
  assert.deepEqual(packageJson.build.mac.target, [
    { target: "dmg", arch: ["universal"] },
  ]);
  assert.deepEqual(packageJson.build.linux.target, ["AppImage"]);
  assert.ok(packageJson.build.files.includes("src/**/*.js"));
  assert.ok(packageJson.build.files.includes("src/**/*.png"));
  assert.ok(packageJson.build.files.includes("!node_modules{,/**/*}"));
  assert.doesNotMatch(packageJson.build.files.join("\n"), /test|README|\.github|scripts/);
});

test("참조되지 않는 구형 미리보기 자산은 저장소에 없다", () => {
  for (const relativePath of [
    "build/icon-preview.png",
    "src/chat-icon/gpt_01.png",
    "src/chat-icon/claude_01.png",
    "src/chat-icon/gemini_01.png",
    "src/chat-icon/grok_01.png",
    "src/chat-icon/emoticons/README.md",
  ]) {
    assert.equal(fs.existsSync(path.join(ROOT, relativePath)), false, relativePath);
  }
});

test("README가 .code-pet 저장소·권한·첨부·AGY 구분을 문서화한다", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  assert.match(readme, /\.code-pet/);
  assert.match(readme, /CODE_PET_HOME/);
  assert.match(readme, /워크스페이스와 권한/);
  assert.match(readme, /첨부 파일/);
  assert.match(readme, /IDE와 `agy` CLI는 별개/);
  assert.match(readme, /채팅 저장소에는 CLI 로그인 토큰\/자격 증명을 기록하지 않습니다/);
  assert.match(readme, /~\/\.codepet\/\*-switch/);
});

test("위험 우회 플래그는 명시적 자동 승인 경로에만 있다", () => {
  const targets = [
    "src/chat/chat-argv.js",
    "src/chat/chat-ipc.js",
    "src/chat/chat-agent-runner.js",
    "src/providers/provider-capabilities.js",
  ];
  for (const target of targets) {
    const source = fs.readFileSync(path.join(ROOT, target), "utf8");
    if (target === "src/chat/chat-argv.js") {
      assert.match(source, /autoApprove/);
      assert.match(source, /permissionMode !== "workspace-write"/);
    } else {
      assert.ok(!source.includes('"--dangerously') && !source.includes("'--dangerously"));
    }
  }
});

test("닫힌 팝오버는 CSS 우선순위와 무관하게 숨고 모델 직접 입력 UI가 없다", () => {
  const css = fs.readFileSync(path.join(ROOT, "src", "chat.css"), "utf8");
  const renderer = fs.readFileSync(path.join(ROOT, "src", "chat.js"), "utf8");
  assert.match(css, /\.popover\[hidden\]\s*\{\s*display:\s*none/);
  assert.doesNotMatch(renderer, /직접 입력|customModelInput|__custom__/);
  assert.match(renderer, /provider\.modelOptions/);
});

test("채팅 사이드바는 접기와 드래그 너비 조절을 지원하고 입력창은 그림자 표면이다", () => {
  const html = fs.readFileSync(path.join(ROOT, "src", "chat.html"), "utf8");
  const css = fs.readFileSync(path.join(ROOT, "src", "chat.css"), "utf8");
  const renderer = fs.readFileSync(path.join(ROOT, "src", "chat.js"), "utf8");
  assert.match(html, /id="sidebar-resizer"/);
  assert.match(html, /id="sidebar-toggle"/);
  assert.match(renderer, /setPointerCapture/);
  assert.match(renderer, /SIDEBAR_WIDTH_KEY/);
  assert.match(css, /\.app\.is-sidebar-collapsed \.sidebar/);
  const composerRule = css.match(/\.composer-box\s*\{([\s\S]*?)\}/)?.[1] || "";
  const composerAreaRule = css.match(/\.composer\s*\{([\s\S]*?)\}/)?.[1] || "";
  assert.match(composerAreaRule, /border-top:\s*none/);
  assert.match(composerRule, /border:\s*none/);
  assert.match(composerRule, /box-shadow:/);
  assert.doesNotMatch(composerRule, /0\s+0\s+0\s+[12]px/);
});

test("에이전트 프로필 사진은 배경색과 합성하지 않고 앞 레이어에 표시한다", () => {
  const css = fs.readFileSync(path.join(ROOT, "src", "chat.css"), "utf8");
  assert.doesNotMatch(css, /mix-blend-mode:\s*multiply/);
  assert.match(css, /\.message \.avatar::before[\s\S]*?z-index:\s*0/);
  assert.match(css, /\.message \.avatar img[\s\S]*?z-index:\s*1/);
});

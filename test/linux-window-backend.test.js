const test = require("node:test");
const assert = require("node:assert/strict");

const {
  hasExplicitOzonePlatform,
  prepareX11Relaunch,
  shouldForceX11WindowBackend,
} = require("../src/linux-window-backend");

test("Linux Wayland에서 XWayland DISPLAY가 있으면 펫 창을 X11로 실행한다", () => {
  assert.equal(shouldForceX11WindowBackend({
    platform: "linux",
    env: { XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" },
    argv: ["electron", "."],
  }), true);
});

test("X11 세션·XWayland 없음·다른 OS에서는 백엔드를 강제하지 않는다", () => {
  assert.equal(shouldForceX11WindowBackend({
    platform: "linux",
    env: { XDG_SESSION_TYPE: "x11", DISPLAY: ":0" },
    argv: [],
  }), false);
  assert.equal(shouldForceX11WindowBackend({
    platform: "linux",
    env: { XDG_SESSION_TYPE: "wayland" },
    argv: [],
  }), false);
  assert.equal(shouldForceX11WindowBackend({
    platform: "win32",
    env: { XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" },
    argv: [],
  }), false);
});

test("사용자가 명시한 Ozone 백엔드는 덮어쓰지 않는다", () => {
  assert.equal(hasExplicitOzonePlatform(["electron", ".", "--ozone-platform=wayland"], {}), true);
  assert.equal(hasExplicitOzonePlatform(["electron", ".", "--ozone-platform", "wayland"], {}), true);
  assert.equal(hasExplicitOzonePlatform(["electron", "."], {
    ELECTRON_OZONE_PLATFORM_HINT: "wayland",
  }), true);
  assert.equal(shouldForceX11WindowBackend({
    platform: "linux",
    env: { XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" },
    argv: ["electron", ".", "--ozone-platform=wayland"],
  }), false);
});

test("Wayland 프로세스는 X11 스위치를 실행 파일 앞에 붙여 한 번만 재실행한다", () => {
  const calls = [];
  const app = {
    relaunch: (options) => calls.push(["relaunch", options]),
    exit: (code) => calls.push(["exit", code]),
  };
  const env = { XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" };
  const argv = ["/app/electron", ".", "--chat"];

  assert.equal(prepareX11Relaunch(app, { platform: "linux", env, argv }), true);
  assert.deepEqual(calls, [
    ["relaunch", { args: ["--ozone-platform=x11", ".", "--chat"] }],
    ["exit", 0],
  ]);
  assert.equal(env.CODEPET_X11_RELAUNCHED, "1");
  assert.equal(prepareX11Relaunch(app, { platform: "linux", env, argv }), false);
  assert.equal(calls.length, 2);
});

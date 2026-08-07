const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { getInstalledFonts } = require("../src/installed-fonts");
const {
  getAutostartFile,
  isLinuxAutoLaunchEnabled,
  quoteDesktopExec,
  setLinuxAutoLaunchEnabled,
} = require("../src/linux-auto-launch");
const { secretToolArgs } = require("../src/linux-credential");
const { linuxTerminalInvocation, writeUnixLoginScript } = require("../src/unix-login");

test("Linux fonts are read from fontconfig family names", async () => {
  let invocation = null;
  const run = (command, args, options, callback) => {
    invocation = { command, args, options };
    callback(null, "DejaVu Sans,DejaVu Sans Condensed\nNoto Sans CJK KR\n");
  };

  const fonts = await getInstalledFonts({ run, platform: "linux" });
  assert.deepEqual(fonts, ["DejaVu Sans", "DejaVu Sans Condensed", "Noto Sans CJK KR"]);
  assert.equal(invocation.command, "fc-list");
  assert.deepEqual(invocation.args, ["--format=%{family}\\n"]);
});

test("Linux auto launch writes and removes one XDG desktop entry", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-linux-autostart-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const executable = "/home/person/Code Pet.AppImage";

  setLinuxAutoLaunchEnabled(true, { home, executable, args: ["--settings"] });

  const file = getAutostartFile({ home });
  assert.equal(isLinuxAutoLaunchEnabled({ home }), true);
  const contents = fs.readFileSync(file, "utf8");
  assert.match(contents, /^\[Desktop Entry\]$/m);
  assert.match(contents, new RegExp(`Exec=${quoteDesktopExec(executable)} ${quoteDesktopExec("--settings")}`));

  setLinuxAutoLaunchEnabled(false, { home });
  assert.equal(fs.existsSync(file), false);
});

test("Linux login scripts are executable and terminals receive the script path", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-linux-login-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const script = writeUnixLoginScript(directory, "codepet-login.sh", ["codex login"]);

  assert.match(fs.readFileSync(script, "utf8"), /^#!\/bin\/bash/);
  if (process.platform !== "win32") assert.ok((fs.statSync(script).mode & 0o111) !== 0);
  assert.deepEqual(linuxTerminalInvocation("/usr/bin/gnome-terminal", script), {
    command: "/usr/bin/gnome-terminal",
    args: ["--", script],
  });
  assert.deepEqual(linuxTerminalInvocation("/usr/bin/xterm", script), {
    command: "/usr/bin/xterm",
    args: ["-e", script],
  });
});

test("Linux credentials use fixed secret-tool attributes", () => {
  assert.deepEqual(secretToolArgs("lookup", "gemini:antigravity"), [
    "lookup", "application", "codepet", "target", "gemini:antigravity",
  ]);
  assert.deepEqual(secretToolArgs("store", "gemini:antigravity"), [
    "store", "--label=CodePet", "application", "codepet", "target", "gemini:antigravity",
  ]);
});

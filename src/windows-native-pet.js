const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { execFile, spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const { promisify } = require("node:util");
const { defaultRoot } = require("./chat/chat-store");
const { listPetAssets } = require("./pet-assets");
const { detectSpriteRows } = require("./sprite-layout");
const { normalizeWindowSize } = require("./window-geometry");
const { CodexWatcher } = require("./codex-watcher");
const { ClaudeWatcher } = require("./claude-watcher");
const { GrokWatcher } = require("./grok-watcher");
const { AntigravityWatcher } = require("./antigravity-watcher");

const run = promisify(execFile);
const UI_FLAGS = new Map([["chat", "--chat"], ["settings", "--settings"], ["live", "--live"], ["usage", "--usage"]]);
const PET_SIZE = { minWidth: 64, maxWidth: 512, aspectRatio: 208 / 192 };
const BUILTIN_PET = { filePath: path.join(__dirname, "default-pet", "spritesheet.webp"), spriteVersionNumber: 2 };
const hash = (data) => createHash("sha256").update(data).digest("hex").slice(0, 32);

async function cachedFile(target, create) {
  if (fs.existsSync(target)) return target;
  const partial = `${target}.${randomUUID()}${path.extname(target)}`;
  try {
    await create(partial);
    try { fs.renameSync(partial, target); }
    catch (error) { if (!fs.existsSync(target)) throw error; }
  } finally {
    fs.rmSync(partial, { force: true });
  }
  return target;
}

function compileHost(cache) {
  const framework = path.join(process.env.SystemRoot || "C:\\Windows", "Microsoft.NET", process.arch === "ia32" ? "Framework" : "Framework64", "v4.0.30319");
  const compiler = path.join(framework, "csc.exe");
  const source = path.join(__dirname, "windows-native-pet-host.cs");
  const wpf = ["WindowsBase", "PresentationCore", "PresentationFramework"]
    .map((name) => `/reference:${path.join(framework, "WPF", `${name}.dll`)}`);
  const target = path.join(cache, `CodePetNative-${hash(fs.readFileSync(source))}.exe`);
  return cachedFile(target, (output) => run(compiler, ["/nologo", "/target:winexe", "/optimize+", "/codepage:65001",
    "/reference:System.Xaml.dll", "/reference:System.Windows.Forms.dll", "/reference:System.Drawing.dll",
    ...wpf, `/out:${output}`, source], { windowsHide: true, timeout: 30000 }));
}

async function loadPetSprite({ pet, cache, electronPath, electronEnv }) {
  const stamp = fs.statSync(pet.spritePath);
  const target = path.join(cache, `sprite-${hash(`${pet.spritePath}:${stamp.size}:${stamp.mtimeMs}`)}.png`);
  const png = await cachedFile(target, (output) => run(electronPath,
    [path.join(__dirname, "windows-native-pet-sprite.js"), pet.spritePath, output],
    { env: electronEnv, windowsHide: true, timeout: 20000 }));
  const fd = fs.openSync(png, "r");
  const header = Buffer.alloc(24);
  try {
    if (fs.readSync(fd, header, 0, header.length) !== header.length || header.toString("ascii", 12, 16) !== "IHDR") {
      throw new Error("변환된 펫 스프라이트를 읽을 수 없습니다.");
    }
  }
  finally { fs.closeSync(fd); }
  const rows = detectSpriteRows({ width: header.readUInt32BE(16), height: header.readUInt32BE(20), spriteVersionNumber: pet.spriteVersionNumber });
  return { png, rows };
}

async function launchNativePet({ electronPath, appRoot }) {
  if (process.platform !== "win32") throw new Error("네이티브 펫은 Windows에서만 실행할 수 있습니다.");
  const root = defaultRoot();
  const cache = path.join(root, "runtime", "native-pet");
  fs.mkdirSync(cache, { recursive: true });
  const canonical = fs.realpathSync(root).toLowerCase();
  const homeRoot = defaultRoot({});
  const usingDefaultRoot = fs.existsSync(homeRoot) && fs.realpathSync(homeRoot).toLowerCase() === canonical;
  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const settingsDir = usingDefaultRoot ? path.join(appData, require("../package.json").name) : path.join(canonical, "runtime", "electron");
  const settingsFile = path.join(settingsDir, "settings.json");
  fs.mkdirSync(settingsDir, { recursive: true });

  const electronEnv = { ...process.env };
  delete electronEnv.ELECTRON_RUN_AS_NODE;
  const host = await compileHost(cache);
  const child = spawn(host, [path.join(appRoot, "build", "icon.ico"), hash(canonical)], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const completed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(code === 2 ? "네이티브 펫이 이미 실행 중입니다." : `네이티브 펫이 종료되었습니다 (${code}).`));
    });
  });
  child.stdin.on("error", () => {});
  const send = (line) => { if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.write(`${line}\n`); };
  const active = new Set();
  const watchers = [new CodexWatcher(), new ClaudeWatcher(), new GrokWatcher(), new AntigravityWatcher()];
  let chatState = "idle";
  let reportingUi;
  let displayedState;
  function publishState() {
    const state = chatState !== "idle" ? chatState : active.size ? "running" : "idle";
    if (state !== displayedState) send(`state\t${state}`);
    displayedState = state;
  }

  const output = createInterface({ input: child.stdout });
  const ready = new Promise((resolve) => output.on("line", (line) => {
    if (line === "ready:visible" || line === "ready:hidden") resolve();
  }));
  output.on("line", (raw) => {
    const flag = UI_FLAGS.get(raw.trim());
    if (!flag) return;
    const ui = spawn(electronPath, [appRoot, "--native-pet-ui", flag], {
      env: electronEnv, detached: true, stdio: ["ignore", "pipe", "ignore"],
    });
    const states = createInterface({ input: ui.stdout });
    states.on("line", (line) => {
      const match = /^codepet-native-state:(idle|review|running|failed)$/.exec(line);
      if (!match) return;
      reportingUi = ui;
      chatState = match[1];
      publishState();
    });
    ui.on("error", (error) => console.error(`CodePet UI 실행 실패: ${error.message}`));
    ui.once("close", () => {
      states.close();
      if (reportingUi === ui) {
        reportingUi = null;
        chatState = "idle";
        publishState();
      }
    });
    ui.unref();
    ui.stdout.unref();
  });

  const updateSettings = async () => {
    let settings;
    try { settings = JSON.parse(fs.readFileSync(settingsFile, "utf8")) || {}; }
    catch (error) { if (error.code !== "ENOENT") throw error; settings = {}; }
    const pets = listPetAssets({ baseDir: appRoot, codexPetsDir: path.join(os.homedir(), ".codex", "pets"),
      builtin: BUILTIN_PET });
    const pet = pets.find(({ key }) => key === settings.petKey) || pets[0];
    if (!pet) throw new Error("펫 스프라이트를 찾을 수 없습니다.");
    const { png, rows } = await loadPetSprite({ pet, cache, electronPath, electronEnv });
    const width = normalizeWindowSize(settings.windowBounds?.width, PET_SIZE)?.width || 192;
    send(["settings", settings.workMode ? 1 : 0, width, rows, png].join("\t"));
  };
  let changes;
  let reload;
  let startup;
  let refreshPromise = Promise.resolve();
  const shutdown = () => child.stdin.end();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    refreshPromise = updateSettings();
    await Promise.race([refreshPromise, completed]);
    const deadline = new Promise((_resolve, reject) => {
      startup = setTimeout(() => reject(new Error("네이티브 펫 창이 준비되지 않았습니다.")), 10000);
    });
    await Promise.race([ready, completed, deadline]);
    clearTimeout(startup);
    changes = fs.watch(settingsDir, { persistent: false }, (_type, name) => {
      if (name && name.toLowerCase() !== "settings.json") return;
      clearTimeout(reload);
      reload = setTimeout(() => {
        refreshPromise = refreshPromise.then(updateSettings).catch((error) => console.error(`펫 설정을 읽지 못했습니다: ${error.message}`));
      }, 150);
    });
    for (const watcher of watchers) {
      watcher.on("working-changed", (working) => {
        if (working) active.add(watcher);
        else active.delete(watcher);
        publishState();
      });
      watcher.start();
    }
    publishState();
    await completed;
  } finally {
    clearTimeout(reload);
    clearTimeout(startup);
    changes?.close();
    for (const watcher of watchers) watcher.stop();
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
    shutdown();
    output.close();
  }
}

module.exports = { launchNativePet };

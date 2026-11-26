const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createUsageWindows } = require("../src/usage-windows");

function setup(initialSettings) {
  let settings = { ...initialSettings };
  const monitor = new EventEmitter();
  monitor.snapshot = () => ({ providers: [] });
  monitor.start = monitor.stop = monitor.invalidate = () => {};
  const ipcMain = new EventEmitter();
  ipcMain.handle = ipcMain.removeHandler = () => {};
  const native = { visible: null, setVisible(value) { this.visible = value; }, update() {}, resetPosition() {}, dispose() {} };
  const feature = createUsageWindows({
    electron: { BrowserWindow: class { constructor() { throw new Error("Startup must never create an overlay"); } },
      ipcMain, screen: new EventEmitter(), powerMonitor: new EventEmitter() },
    monitor, readSettings: () => settings, writeSettings: (patch) => { settings = { ...settings, ...patch }; },
    taskbarFactory: () => native,
  });
  return { feature, native, readSettings: () => settings };
}

test("the exact old-overlay hidden state does not hide the native taskbar", () => {
  const app = setup({ usageBarVisible: false, usageBarPosition: { x: 1559, y: 985 } });
  assert.equal(app.native.visible, true);
  app.feature.toggleBar();
  assert.equal(app.native.visible, false);
  assert.deepEqual(app.readSettings(), { usageBarVisible: false, usageBarPosition: { x: 1559, y: 985 }, taskbarUsageVisible: false });
  app.feature.toggleBar(); assert.equal(app.native.visible, true);
  app.feature.dispose();
});
test("an explicit native-taskbar preference is preserved independently", () => {
  for (const visible of [true, false]) {
    const app = setup({ taskbarUsageVisible: visible, usageBarVisible: !visible });
    assert.equal(app.native.visible, visible);
    app.feature.dispose();
  }
});

test("a native taskbar click opens one quota popup, releases it after hiding, and can reopen it", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const windows = [];
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.visible = false; windows.push(this);
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.send = (channel, snapshot) => { this.lastUpdate = { channel, snapshot }; };
    }
    loadFile() {}
    isDestroyed() { return Boolean(this.destroyed); }
    isVisible() { return this.visible; }
    show() { this.visible = true; this.emit("show"); }
    hide() { this.visible = false; this.emit("hide"); }
    focus() {}
    setBounds(bounds) { this.bounds = bounds; }
    destroy() { this.destroyed = true; this.emit("closed"); }
  }
  const snapshot = { providers: ["Codex", "AGY", "Claude"].map((label) => ({ label, connected: true, gauges: [{ usedPercent: 23 }] })) };
  const monitor = new EventEmitter();
  monitor.snapshot = () => snapshot;
  monitor.start = monitor.stop = monitor.invalidate = monitor.refresh = () => {};
  const ipcMain = new EventEmitter(); ipcMain.handle = ipcMain.removeHandler = () => {};
  const screen = new EventEmitter();
  screen.screenToDipRect = (_, bounds) => bounds;
  screen.getDisplayMatching = screen.getPrimaryDisplay = () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1032 } });
  let click;
  const feature = createUsageWindows({
    electron: { BrowserWindow: FakeWindow, ipcMain, screen, powerMonitor: new EventEmitter() },
    monitor, readSettings: () => ({}), writeSettings() {},
    taskbarFactory: ({ onClick }) => {
      click = onClick;
      return { setVisible() {}, update() {}, dispose() {} };
    },
  });
  const authFailure = { providers: [{ label: "AGY", connected: false, error: "조회 실패", gauges: [] }] };
  monitor.emit("update", authFailure);
  assert.equal(windows.length, 0);
  click({ x: 1447, y: 1032, width: 227, height: 48 });
  assert.equal(windows.length, 1);
  assert.equal(windows[0].options.show, false);
  assert.equal(windows[0].options.webPreferences.sandbox, true);
  windows[0].emit("ready-to-show");
  windows[0].webContents.emit("did-finish-load");
  assert.equal(windows[0].visible, true);
  assert.deepEqual(windows[0].lastUpdate.snapshot, snapshot);
  assert.ok(windows[0].options.y + windows[0].options.height <= 1032);
  click({ x: 1447, y: 1032, width: 227, height: 48 });
  assert.equal(windows[0].visible, false);
  monitor.emit("update", authFailure);
  assert.equal(windows[0].visible, false);
  assert.deepEqual(windows[0].lastUpdate.snapshot, authFailure);
  assert.equal(windows.length, 1);
  t.mock.timers.tick(30000);
  assert.equal(windows[0].destroyed, true);
  click({ x: 1447, y: 1032, width: 227, height: 48 });
  assert.equal(windows.length, 2);
  windows[1].emit("ready-to-show");
  assert.equal(windows[1].visible, true);
  feature.dispose();
});

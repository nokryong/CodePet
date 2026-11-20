const path = require("node:path");
const fs = require("node:fs");
const { avoidWindows } = require("./usage-monitor");
const { createTaskbar } = require("./windows-taskbar");
const { releaseHiddenWindow } = require("./idle-window-release");

function createUsageWindows({ electron, monitor, readSettings, writeSettings, openSettings, onVisibilityChange, getObstacles = () => [], taskbarFactory = createTaskbar, taskbarEnabled = true }) {
  const { BrowserWindow, ipcMain, screen, powerMonitor } = electron;
  let popup = null;
  const alive = (win) => win && !win.isDestroyed();
  const trusted = (event) => alive(popup) && event.sender === popup.webContents;
  const publish = (value) => {
    taskbar?.update(value);
    if (alive(popup)) popup.webContents.send("usage-monitor:update", value);
  };

  function makeWindow(mode, bounds) {
    const win = new BrowserWindow({ ...bounds, frame: false, thickFrame: false, show: false,
      title: "CodePet 남은 한도",
      resizable: false, minimizable: false, maximizable: false, skipTaskbar: true,
      alwaysOnTop: true, backgroundColor: "#fafafa", autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, "usage-preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    win.loadFile(path.join(__dirname, "usage.html"), { query: { mode } });
    win.webContents.on("did-finish-load", () => win.webContents.send("usage-monitor:update", monitor.snapshot()));
    return win;
  }

  function toggleBar() {
    if (!taskbar) return;
    const visible = readSettings().taskbarUsageVisible === false;
    writeSettings({ taskbarUsageVisible: visible });
    taskbar.setVisible(visible);
    onVisibilityChange?.();
  }

  function togglePopup(anchor) {
    if (alive(popup) && popup.isVisible()) { popup.hide(); return; }
    const target = anchor?.width > 0 ? anchor : null;
    const display = target ? screen.getDisplayMatching(target) : screen.getPrimaryDisplay();
    const area = display.workArea;
    const bounds = avoidWindows({ width: 380, height: 560,
      x: target ? target.x + target.width - 380 : area.x + area.width - 390,
      y: target ? target.y - 568 : area.y + area.height - 570 }, getObstacles(), area);
    if (!alive(popup)) {
      popup = makeWindow("popup", bounds);
      releaseHiddenWindow(popup);
      popup.once("ready-to-show", () => { if (alive(popup)) { popup.show(); popup.focus(); } });
      popup.on("blur", () => { if (alive(popup)) popup.hide(); });
      popup.on("closed", () => { popup = null; });
    } else { popup.setBounds(bounds); popup.show(); popup.focus(); }
    void monitor.refresh();
  }

  const reposition = () => {
    if (alive(popup)) popup.hide();
  };
  let taskbar;
  if (taskbarEnabled) {
    let icon;
    try { icon = fs.readFileSync(path.join(__dirname, "..", "build", "icon.png")); } catch { }
    const visible = readSettings().taskbarUsageVisible !== false;
    taskbar = taskbarFactory({ icon, visible, onClick: (physicalBounds) => {
      const bounds = process.platform === "win32" ? screen.screenToDipRect(null, physicalBounds) : physicalBounds;
      togglePopup(bounds);
    } });
    taskbar.setVisible(visible);
    taskbar.update(monitor.snapshot());
  }
  const resume = () => void monitor.invalidate();
  monitor.on("update", publish);
  ipcMain.handle("usage-monitor:get", (event) => trusted(event) ? monitor.snapshot() : null);
  ipcMain.handle("usage-monitor:refresh", async (event) => {
    if (!trusted(event)) return null;
    await monitor.refresh(true);
    return monitor.snapshot();
  });
  ipcMain.on("usage-monitor:action", (event, action) => {
    if (!trusted(event)) return;
    if (action === "open") togglePopup();
    if (action === "close" && alive(popup)) popup.hide();
    if (action === "settings") { if (alive(popup)) popup.hide(); openSettings("accounts"); }
    if (action === "hide-bar") toggleBar();
  });
  screen.on("display-metrics-changed", reposition);
  screen.on("display-removed", reposition);
  powerMonitor.on("resume", resume);
  monitor.start();

  return { toggleBar, togglePopup,
    bringToFront() { if (alive(popup) && popup.isVisible()) popup.moveTop(); },
    resetPosition() { taskbar?.resetPosition(); },
    dispose() {
      monitor.stop(); monitor.off("update", publish); taskbar?.dispose();
      screen.off("display-metrics-changed", reposition); screen.off("display-removed", reposition); powerMonitor.off("resume", resume);
      ipcMain.removeHandler("usage-monitor:get"); ipcMain.removeHandler("usage-monitor:refresh");
      if (alive(popup)) popup.destroy();
    },
  };
}

module.exports = { createUsageWindows };

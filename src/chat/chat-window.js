const path = require("node:path");

// 채팅 창 생성. 설정창과 같은 프레임리스 패턴을 따릅니다.
function createChatWindow({ BrowserWindow, onReady, onClosed }) {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 560,
    minHeight: 480,
    show: false,
    frame: false,
    title: "CodePet 채팅",
    backgroundColor: "#fafafa",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "..", "chat-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.on("maximize", () => {
    win.webContents.send("chat:maximized-state", true);
  });
  win.on("unmaximize", () => {
    win.webContents.send("chat:maximized-state", false);
  });

  win.setMenuBarVisibility(false);
  win.once("ready-to-show", () => {
    win.show();
    win.focus();
    if (typeof onReady === "function") onReady(win);
  });
  win.on("closed", () => {
    if (typeof onClosed === "function") onClosed();
  });
  win.loadFile(path.join(__dirname, "..", "chat.html"));
  return win;
}

module.exports = { createChatWindow };

const fs = require("node:fs");
const path = require("node:path");
function claimInstance(app, root, dispatch) {
  fs.mkdirSync(root, { recursive: true });
  let canonical = fs.realpathSync(root);
  if (process.platform === "win32") canonical = canonical.toLowerCase();
  let defaultHome = require("./chat/chat-store").defaultRoot({});
  if (fs.existsSync(defaultHome)) defaultHome = fs.realpathSync(defaultHome);
  if (process.platform === "win32") defaultHome = defaultHome.toLowerCase();
  if (canonical !== defaultHome) {
    const userData = path.join(canonical, "runtime", "electron");
    fs.mkdirSync(userData, {recursive:true});
    app.setPath("userData", userData);
  }
  const pending = [];
  let ready = false;
  app.on("second-instance", (_event, argv) => {
    if (ready) dispatch(argv); else pending.push(argv);
  });
  if (!app.requestSingleInstanceLock()) { app.quit(); return null; }
  return () => { ready = true; for (const argv of pending) dispatch(argv); pending.length = 0; };
}
module.exports = { claimInstance };

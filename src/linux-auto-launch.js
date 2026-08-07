const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function quoteDesktopExec(value) {
  return `"${String(value).replace(/([\\"`$])/g, "\\$1")}"`;
}

function getAutostartFile({ home = os.homedir(), configHome = process.env.XDG_CONFIG_HOME } = {}) {
  return path.join(configHome || path.join(home, ".config"), "autostart", "codepet.desktop");
}

function isLinuxAutoLaunchEnabled(options = {}) {
  return fs.existsSync(getAutostartFile(options));
}

function setLinuxAutoLaunchEnabled(enabled, {
  executable,
  args = [],
  home = os.homedir(),
  configHome = process.env.XDG_CONFIG_HOME,
} = {}) {
  const file = getAutostartFile({ home, configHome });
  if (!enabled) {
    fs.rmSync(file, { force: true });
    return;
  }

  if (!executable) throw new Error("Linux auto launch requires an executable path.");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const exec = [executable, ...args].map(quoteDesktopExec).join(" ");
  const contents = [
    "[Desktop Entry]",
    "Type=Application",
    "Name=CodePet",
    `Exec=${exec}`,
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
}

module.exports = {
  getAutostartFile,
  isLinuxAutoLaunchEnabled,
  quoteDesktopExec,
  setLinuxAutoLaunchEnabled,
};

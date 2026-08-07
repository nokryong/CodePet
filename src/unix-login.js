const fs = require("node:fs");
const path = require("node:path");

function quoteShellArgument(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function writeUnixLoginScript(directory, fileName, lines) {
  const scriptPath = path.join(directory, fileName);
  fs.writeFileSync(
    scriptPath,
    [
      "#!/bin/bash",
      'export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"',
      ...lines,
      'read -r -p "Press Enter to close..." _',
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o755 }
  );
  return scriptPath;
}

function linuxTerminalInvocation(command, scriptPath) {
  const name = path.basename(command);
  if (name === "gnome-terminal") return { command, args: ["--", scriptPath] };
  if (name === "xfce4-terminal") return { command, args: ["--execute", scriptPath] };
  return { command, args: ["-e", scriptPath] };
}

module.exports = { linuxTerminalInvocation, quoteShellArgument, writeUnixLoginScript };

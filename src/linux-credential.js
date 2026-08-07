const { spawn } = require("node:child_process");

const APP_ATTRIBUTE = "codepet";

function secretToolArgs(operation, target) {
  const attributes = ["application", APP_ATTRIBUTE, "target", String(target)];
  if (operation === "lookup") return ["lookup", ...attributes];
  if (operation === "store") return ["store", "--label=CodePet", ...attributes];
  if (operation === "clear") return ["clear", ...attributes];
  throw new Error(`Unknown secret-tool operation: ${operation}`);
}

function runSecretTool(args, { stdin = "", timeoutMs = 10000, spawnImpl = spawn } = {}) {
  if (process.platform !== "linux") {
    return Promise.reject(new Error("Linux credential storage is only available on Linux."));
  }

  return new Promise((resolve, reject) => {
    const child = spawnImpl("secret-tool", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("Linux credential storage operation timed out."));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", (error) => {
      const message = error?.code === "ENOENT"
        ? "secret-tool is required for secure credential storage on Linux."
        : "Linux credential storage could not be started.";
      finish(new Error(message));
    });
    child.once("close", (code) => {
      finish(
        code === 0 ? null : new Error(stderr.trim() || "Linux credential storage operation failed."),
        stdout.trim()
      );
    });
    child.stdin.end(stdin);
  });
}

async function readCredential(target) {
  const encoded = await runSecretTool(secretToolArgs("lookup", target));
  if (!encoded) throw new Error("No saved credential was found.");
  return Buffer.from(encoded, "base64").toString("utf8");
}

function writeCredential(target, value) {
  const encoded = Buffer.from(JSON.stringify(value), "utf8").toString("base64");
  return runSecretTool(secretToolArgs("store", target), { stdin: encoded }).then(() => undefined);
}

function deleteCredential(target) {
  return runSecretTool(secretToolArgs("clear", target)).then(
    () => undefined,
    (error) => {
      if (/not found|no matching/i.test(error.message || "")) return undefined;
      throw error;
    }
  );
}

module.exports = {
  deleteCredential,
  readCredential,
  runSecretTool,
  secretToolArgs,
  writeCredential,
};

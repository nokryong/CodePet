const test = require("node:test");
const assert = require("node:assert/strict");
const { providerCliEnv } = require("../src/providers/cli-env");

test("only Windows AGY children disable updates and retain the supplied environment", () => {
  const parent = Object.freeze({ PATH: "isolated-path", AGY_CLI_DISABLE_AUTO_UPDATE: "false" });
  assert.deepEqual(providerCliEnv("agy", parent, "win32"), {
    PATH: "isolated-path", AGY_CLI_DISABLE_AUTO_UPDATE: "true",
  });
  assert.equal(providerCliEnv("claude", parent, "win32"), parent);
  assert.equal(providerCliEnv("agy", parent, "linux"), parent);
});

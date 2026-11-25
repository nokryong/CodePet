// AGY's updater can open its own console even when the parent starts hidden.
function providerCliEnv(provider, env, platform = process.platform) {
  if (provider !== "agy" || platform !== "win32") return env;
  return { ...(env || process.env), AGY_CLI_DISABLE_AUTO_UPDATE: "true" };
}

module.exports = { providerCliEnv };

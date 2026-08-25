function hasExplicitOzonePlatform(argv = process.argv, env = process.env) {
  if (String(env.ELECTRON_OZONE_PLATFORM_HINT || "").trim()) return true;
  return argv.some((arg, index) => (
    arg === "--ozone-platform" && Boolean(argv[index + 1])
  ) || String(arg).startsWith("--ozone-platform="));
}

function shouldForceX11WindowBackend({
  platform = process.platform,
  env = process.env,
  argv = process.argv,
} = {}) {
  if (platform !== "linux") return false;
  if (String(env.XDG_SESSION_TYPE || "").toLocaleLowerCase("en") !== "wayland") return false;
  if (!String(env.DISPLAY || "").trim()) return false;
  return !hasExplicitOzonePlatform(argv, env);
}

function prepareX11Relaunch(app, {
  platform = process.platform,
  env = process.env,
  argv = process.argv,
} = {}) {
  if (env.CODEPET_X11_RELAUNCHED === "1") return false;
  if (!shouldForceX11WindowBackend({ platform, env, argv })) return false;
  env.CODEPET_X11_RELAUNCHED = "1";
  app.relaunch({ args: ["--ozone-platform=x11", ...argv.slice(1)] });
  app.exit(0);
  return true;
}

module.exports = {
  hasExplicitOzonePlatform,
  prepareX11Relaunch,
  shouldForceX11WindowBackend,
};

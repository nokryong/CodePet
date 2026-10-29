const path = require("node:path");
const { build, Platform } = require("electron-builder");
const { buildReleaseArtifacts } = require("./build-artifacts");

const projectDir = path.resolve(__dirname, "..");
const outputDir = path.join(projectDir, "artifacts");

// 기본은 현재 OS용 빌드입니다. `npm run dist -- --win` / `--mac`으로 명시할 수 있습니다.
function resolveTargetPlatform() {
  if (process.argv.includes("--win")) return Platform.WINDOWS;
  if (process.argv.includes("--mac")) return Platform.MAC;
  if (process.argv.includes("--linux")) return Platform.LINUX;
  if (process.platform === "darwin") return Platform.MAC;
  if (process.platform === "linux") return Platform.LINUX;
  return Platform.WINDOWS;
}

async function main() {
  await buildReleaseArtifacts({
    projectDir,
    outputDir,
    build,
    targets: resolveTargetPlatform().createTarget(),
    keepLinuxUnpacked: process.env.CODEPET_LINUX_SMOKE_TEST === "1",
    validatePackage: ["win32", "darwin"].includes(process.platform) ? require("./smoke-package").smokePackage : null,
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

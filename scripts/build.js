const fs = require("node:fs");
const path = require("node:path");
const { build, Platform } = require("electron-builder");

const projectDir = path.resolve(__dirname, "..");
const outputDir = path.join(projectDir, "artifacts");
const privateBuildMetadata = [
  "builder-debug.yml",
  "builder-effective-config.yaml",
];

function cleanPrivateBuildMetadata() {
  for (const fileName of privateBuildMetadata) {
    fs.rmSync(path.join(outputDir, fileName), { force: true });
  }

  if (!fs.existsSync(outputDir)) return;
  for (const fileName of fs.readdirSync(outputDir)) {
    if (/\.nsis\.7z$/i.test(fileName)) {
      fs.rmSync(path.join(outputDir, fileName), { force: true });
    }
  }
}

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
  try {
    await build({
      projectDir,
      publish: "never",
      targets: resolveTargetPlatform().createTarget(),
    });
  } finally {
    cleanPrivateBuildMetadata();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

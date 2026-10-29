const fs = require("node:fs");
const path = require("node:path");

const RELEASE_FILE = /^CodePet-.+\.(?:exe|dmg|AppImage(?:\.zsync)?)$/;

function assertInside(parent, target) {
  const relative = path.relative(fs.realpathSync(parent), fs.realpathSync(target));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Build path is outside its output directory: ${target}`);
  }
}

function removeBuildDirectory(outputDir, directory) {
  if (!fs.existsSync(directory)) return;
  assertInside(outputDir, directory);
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("Refusing to remove a linked build directory.");
  fs.rmSync(directory, { recursive: true, force: true });
}

async function buildReleaseArtifacts({ projectDir, outputDir, build, targets, keepLinuxUnpacked = false, validatePackage = null }) {
  fs.mkdirSync(outputDir, { recursive: true });
  const stage = fs.mkdtempSync(path.join(outputDir, ".build-"));
  try {
    await build({ projectDir, publish: "never", targets, config: { directories: { output: stage } } });
    const files = fs.readdirSync(stage, { withFileTypes: true })
      .filter((entry) => entry.isFile() && RELEASE_FILE.test(entry.name))
      .map((entry) => entry.name);
    if (!files.length) throw new Error("The build did not produce a release package.");
    if (validatePackage) for (const name of files) await validatePackage(path.join(stage, name));

    const unpacked = path.join(stage, "linux-unpacked");
    const smokeDir = path.join(outputDir, "linux-unpacked");
    if (keepLinuxUnpacked) {
      assertInside(stage, unpacked);
      if (!fs.lstatSync(unpacked).isDirectory() || fs.existsSync(smokeDir)) {
        throw new Error("Cannot reserve the Linux smoke-test directory.");
      }
    }
    for (const name of files) {
      const source = path.join(stage, name);
      assertInside(stage, source);
      fs.renameSync(source, path.join(outputDir, name));
    }
    if (keepLinuxUnpacked) fs.renameSync(unpacked, smokeDir);
    return files.map((name) => path.join(outputDir, name));
  } finally {
    removeBuildDirectory(outputDir, stage);
  }
}

if (require.main === module) {
  if (process.argv[2] !== "--clean-linux") throw new Error("Expected --clean-linux.");
  const outputDir = path.resolve(__dirname, "..", "artifacts");
  removeBuildDirectory(outputDir, path.join(outputDir, "linux-unpacked"));
}

module.exports = { buildReleaseArtifacts, removeBuildDirectory };

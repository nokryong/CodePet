const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const projectDir = path.resolve(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf8"));
const buildScript = fs.readFileSync(path.join(projectDir, "scripts", "build.js"), "utf8");
const releaseWorkflow = fs.readFileSync(
  path.join(projectDir, ".github", "workflows", "release.yml"),
  "utf8"
);
const ciWorkflow = fs.readFileSync(
  path.join(projectDir, ".github", "workflows", "ci.yml"),
  "utf8"
);

test("release packaging defines one native package for Windows, Linux, and macOS", () => {
  assert.deepEqual(packageJson.build.win.target, ["portable"]);
  assert.deepEqual(packageJson.build.linux.target, ["AppImage"]);
  assert.deepEqual(packageJson.build.mac.target, ["dmg"]);
  assert.equal(packageJson.build.portable.artifactName, "CodePet-${version}.exe");
  assert.equal(packageJson.build.linux.artifactName, "CodePet-${version}-linux-${arch}.${ext}");
  assert.equal(packageJson.build.mac.artifactName, "CodePet-${version}-mac.${ext}");
  assert.equal(packageJson.desktopName, "CodePet.desktop");
  assert.equal(packageJson.build.linux.syncDesktopName, true);
});

test("build script selects Linux on Linux and accepts an explicit Linux target", () => {
  assert.match(buildScript, /process\.argv\.includes\("--linux"\).*Platform\.LINUX/);
  assert.match(buildScript, /process\.platform === "linux".*Platform\.LINUX/);
  assert.match(buildScript, /publish:\s*"never"/);
});

test("release workflow builds three native runners and uploads all three packages", () => {
  assert.match(releaseWorkflow, /windows-latest[\s\S]*artifacts\/\*\.exe/);
  assert.match(releaseWorkflow, /ubuntu-latest[\s\S]*artifacts\/\*\.AppImage/);
  assert.match(releaseWorkflow, /macos-latest[\s\S]*artifacts\/\*\.dmg/);
  assert.match(releaseWorkflow, /gh release upload/);
  assert.match(releaseWorkflow, /gh release create[^\n]+--draft/);
  assert.match(releaseWorkflow, /gh release edit[^\n]+--draft=false/);
  assert.doesNotMatch(releaseWorkflow, /actions\/(?:upload|download)-artifact/);
  assert.match(releaseWorkflow, /xvfb-run -a artifacts\/linux-unpacked\/code-pet/);
});

test("CI는 모든 push와 pull request에서 세 OS 테스트를 실행한다", () => {
  assert.match(ciWorkflow, /push:/);
  assert.match(ciWorkflow, /pull_request:/);
  assert.match(ciWorkflow, /windows-latest/);
  assert.match(ciWorkflow, /ubuntu-latest/);
  assert.match(ciWorkflow, /macos-latest/);
  assert.match(ciWorkflow, /npm ci/);
  assert.match(ciWorkflow, /npm test/);
});

const { execFileSync } = require("node:child_process");
function assertReleaseIdentity({ candidate, head, version, tag, tagCommit, draftCommit, published }) {
  if (!/^[0-9a-f]{40}$/.test(candidate) || head !== candidate || tag !== `v${version}`) throw new Error("Candidate, checkout and package version disagree");
  if (tagCommit && tagCommit !== candidate) throw new Error("Existing tag points to another commit");
  if (draftCommit && draftCommit !== candidate) throw new Error("Release target points to another commit");
  if (published) throw new Error("Published releases cannot be overwritten");
}
if (require.main === module) {
  const run = (command, args) => execFileSync(command, args, { encoding: "utf8" }).trim();
  const resolve = ref => run("git", ["rev-parse", "--verify", `${ref}^{commit}`]);
  const tag = process.env.RELEASE_TAG;
  const release = JSON.parse(run("gh", ["release", "view", tag, "--repo", process.env.GITHUB_REPOSITORY, "--json", "isDraft,targetCommitish"]));
  const tags = run("git", ["tag", "--list", tag]).split("\n");
  assertReleaseIdentity({candidate:process.env.GITHUB_SHA, head:resolve("HEAD"), version:require("../package.json").version,
    tag, tagCommit:tags.includes(tag) ? resolve(tag) : null, draftCommit:release.targetCommitish, published:!release.isDraft});
}
module.exports = { assertReleaseIdentity };

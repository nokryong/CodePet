const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  GrokWorkspaceChangeStore,
  normalizeChangePath,
  validateManifest,
  MAX_CHANGE_BYTES,
  CHANGE_TTL_MS,
} = require("../src/grok-workspace-changes");

const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");

function entry(file, before, after, { originalExists = before !== null } = {}) {
  const beforeBuffer = before === null ? Buffer.alloc(0) : Buffer.from(before);
  if (after === null) {
    return {
      path: file,
      op: "delete",
      originalExists,
      originalSha256: hash(beforeBuffer),
    };
  }
  const afterBuffer = Buffer.from(after);
  return {
    path: file,
    op: "write",
    originalExists,
    originalSha256: hash(beforeBuffer),
    content: afterBuffer.toString("base64"),
    sha256: hash(afterBuffer),
  };
}

function manifest(...changes) {
  return { version: 1, changes, diff: "--- a/file\n+++ b/file" };
}

function makeWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-change-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("승인 적용은 수정·생성·삭제를 한 번만 반영하고 기존 모드를 보존한다", (t) => {
  const root = makeWorkspace(t);
  fs.writeFileSync(path.join(root, "modify.txt"), "old", { mode: 0o640 });
  fs.writeFileSync(path.join(root, "delete.txt"), "gone");
  const store = new GrokWorkspaceChangeStore();
  const staged = store.stage({
    sessionId: "session-a",
    workspace: root,
    manifest: manifest(
      entry("modify.txt", "old", "new"),
      entry("nested/new.txt", null, "created"),
      entry("delete.txt", "gone", null)
    ),
  });

  assert.equal(staged.changes.length, 3);
  assert.equal(store.apply(staged.id, "session-a").applied, 3);
  assert.equal(fs.readFileSync(path.join(root, "modify.txt"), "utf8"), "new");
  assert.equal(fs.readFileSync(path.join(root, "nested", "new.txt"), "utf8"), "created");
  assert.equal(fs.existsSync(path.join(root, "delete.txt")), false);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.join(root, "modify.txt")).mode & 0o777, 0o640);
  }
  assert.throws(() => store.apply(staged.id, "session-a"), /만료|처리/);
});

test("취소와 만료는 멱등적으로 폐기하고 다른 세션의 승인을 거부한다", (t) => {
  const root = makeWorkspace(t);
  let now = 1_000;
  const store = new GrokWorkspaceChangeStore({ now: () => now });
  const first = store.stage({
    sessionId: "session-a",
    workspace: root,
    manifest: manifest(entry("a.txt", null, "x")),
  });
  assert.throws(() => store.apply(first.id, "session-b"), /만료|처리/);
  assert.deepEqual(store.cancel(first.id, "session-a"), { canceled: true, alreadyHandled: false });
  assert.deepEqual(store.cancel(first.id, "session-a"), { canceled: true, alreadyHandled: true });

  const expired = store.stage({
    sessionId: "session-a",
    workspace: root,
    manifest: manifest(entry("b.txt", null, "y")),
  });
  now += CHANGE_TTL_MS + 1;
  assert.throws(() => store.apply(expired.id, "session-a"), /만료|처리/);
});

test("경로 탈출·Windows 특수 경로·보호 디렉터리·중복 및 형식 변경을 거부한다", () => {
  for (const unsafe of [
    "../escape.txt",
    "/absolute.txt",
    "C:/absolute.txt",
    "dir\\file.txt",
    "file.txt:stream",
    "CON.txt",
    "trailing. ",
    ".git/config",
    "node_modules/pkg/index.js",
  ]) {
    assert.throws(() => normalizeChangePath(unsafe));
  }
  assert.throws(() => validateManifest(manifest(
    entry("A.txt", null, "a"),
    entry("a.txt", null, "b")
  )), /중복/);
  assert.throws(() => validateManifest(manifest(
    entry("file", null, "a"),
    entry("file/child", null, "b")
  )), /하위 경로/);
  assert.throws(() => validateManifest(manifest({
    ...entry("mode.sh", null, "x"),
    mode: 0o755,
  })), /실행 권한|형식/);
});

test("빈 새 파일도 적용하지만 기존 빈 파일을 새 파일로 위장하면 충돌한다", (t) => {
  const root = makeWorkspace(t);
  const store = new GrokWorkspaceChangeStore();
  const empty = store.stage({
    sessionId: "session-a",
    workspace: root,
    manifest: manifest(entry("empty.txt", null, Buffer.alloc(0))),
  });
  store.apply(empty.id, "session-a");
  assert.equal(fs.statSync(path.join(root, "empty.txt")).size, 0);

  assert.throws(() => store.stage({
    sessionId: "session-a",
    workspace: root,
    manifest: manifest(entry("empty.txt", null, "replacement")),
  }), /충돌/);
});

test("변경 내용 합계 상한을 넘으면 스테이징 전에 거부한다", () => {
  const tooLarge = Buffer.alloc(MAX_CHANGE_BYTES + 1, 1);
  assert.throws(() => validateManifest(manifest(entry("large.bin", null, tooLarge))), /크기 제한/);
});

test("워크스페이스 내부 정션을 통한 외부 파일 적용을 거부한다", (t) => {
  const root = makeWorkspace(t);
  const outside = makeWorkspace(t);
  fs.writeFileSync(path.join(outside, "secret.txt"), "outside");
  const link = path.join(root, "junction");
  fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  const store = new GrokWorkspaceChangeStore();
  assert.throws(() => store.stage({
    sessionId: "session-a",
    workspace: root,
    manifest: manifest(entry("junction/secret.txt", "outside", "changed")),
  }), /링크|정션|재분석/);
  assert.equal(fs.readFileSync(path.join(outside, "secret.txt"), "utf8"), "outside");
});

test("두 번째 파일 적용이 실패하면 첫 번째 파일과 이동된 원본을 모두 롤백한다", (t) => {
  const root = makeWorkspace(t);
  fs.writeFileSync(path.join(root, "a.txt"), "a-old");
  fs.writeFileSync(path.join(root, "b.txt"), "b-old");
  const fsApi = new Proxy(fs, {
    get(target, property) {
      if (property !== "renameSync") return target[property];
      return (source, destination) => {
        if (path.basename(source) === "new-1") throw new Error("injected rename failure");
        return target.renameSync(source, destination);
      };
    },
  });
  const store = new GrokWorkspaceChangeStore({ fsApi });
  const staged = store.stage({
    sessionId: "session-a",
    workspace: root,
    manifest: manifest(
      entry("a.txt", "a-old", "a-new"),
      entry("b.txt", "b-old", "b-new")
    ),
  });
  assert.throws(() => store.apply(staged.id, "session-a"), /injected rename failure/);
  assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "a-old");
  assert.equal(fs.readFileSync(path.join(root, "b.txt"), "utf8"), "b-old");
});

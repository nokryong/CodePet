const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { atomicWrite } = require("../src/provider-profile-store");
const { GrokAccountSwitcher, grokCredential } = require("../src/grok-account-switcher");

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codepet-grok-account-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function auth(refreshToken, email) {
  return {
    "https://auth.x.ai::client": {
      auth_mode: "oauth",
      user_id: `user-${refreshToken}`,
      email,
      refresh_token: refreshToken,
      expires_at: "2099-01-01T00:00:00Z",
    },
  };
}

test("Grok 동적 auth.json 키에서 자격 증명 메타데이터를 찾는다", () => {
  const credential = grokCredential(auth("alpha", "alpha@example.com"));
  assert.equal(credential.email, "alpha@example.com");
  assert.equal(credential.refresh_token, "alpha");
  assert.equal(grokCredential({ unrelated: true }), null);
});

test("Grok 현재 계정을 비밀 값 없이 저장·표시한다", (t) => {
  const home = tempHome(t);
  atomicWrite(path.join(home, ".grok", "auth.json"), auth("alpha", "Alpha@Example.com"));
  const switcher = new GrokAccountSwitcher({ home });

  const saved = switcher.snapshotCurrent({ plan: "SuperGrok Plus" });
  const listed = switcher.listProfiles();
  assert.equal(saved.email, "alpha@example.com");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].active, true);
  assert.equal(listed[0].plan, "SuperGrok Plus");
  assert.equal(Object.hasOwn(listed[0], "secret"), false);
});

test("Grok 계정 전환은 auth.json을 원자 교체하고 hot reload용 활성 계정을 바꾼다", (t) => {
  const home = tempHome(t);
  const authPath = path.join(home, ".grok", "auth.json");
  atomicWrite(authPath, auth("alpha", "alpha@example.com"));
  const switcher = new GrokAccountSwitcher({ home });
  switcher.snapshotCurrent();
  const beta = switcher.store.save({
    secret: auth("beta", "beta@example.com"),
    email: "beta@example.com",
  });

  const result = switcher.switchToProfile(beta.key);
  assert.equal(grokCredential(JSON.parse(fs.readFileSync(authPath, "utf8"))).refresh_token, "beta");
  assert.equal(result.active, true);
  assert.equal(Object.hasOwn(result, "secret"), false);
  assert.equal(switcher.listProfiles().find((profile) => profile.key === beta.key).active, true);
});

test("Grok 새 로그인 준비는 현재 계정을 보존하고 활성 계정 삭제는 거부한다", (t) => {
  const home = tempHome(t);
  atomicWrite(path.join(home, ".grok", "auth.json"), auth("alpha", "alpha@example.com"));
  const switcher = new GrokAccountSwitcher({ home });
  switcher.prepareLogin({ plan: "SuperGrok Plus" });
  const active = switcher.listProfiles().find((profile) => profile.active);

  assert.equal(active.email, "alpha@example.com");
  assert.throws(() => switcher.deleteProfile(active.key), /현재 사용 중/);
});

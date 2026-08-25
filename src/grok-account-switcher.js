const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  ProviderProfileStore,
  atomicWrite,
  normalizeEmail,
  safeProfile,
} = require("./provider-profile-store");

function grokCredential(secret) {
  if (!secret || typeof secret !== "object" || Array.isArray(secret)) return null;
  return Object.values(secret).find(
    (value) =>
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (typeof value.refresh_token === "string" || typeof value.user_id === "string")
  ) || null;
}

class GrokAccountSwitcher {
  constructor({ home = os.homedir(), store } = {}) {
    this.home = home;
    this.authPath = path.join(home, ".grok", "auth.json");
    this.store = store || new ProviderProfileStore("grok", home);
  }

  current() {
    try {
      const value = JSON.parse(fs.readFileSync(this.authPath, "utf8"));
      return grokCredential(value) ? value : null;
    } catch {
      return null;
    }
  }

  listProfiles() {
    const live = this.current();
    const credential = grokCredential(live);
    const liveEmail = normalizeEmail(credential?.email);
    const stored = this.store.list();
    const liveKey = this.store.findKeyBySecret(live) ||
      stored.find((profile) => liveEmail && normalizeEmail(profile.email) === liveEmail)?.key ||
      null;
    return stored.map((profile) => ({
      ...profile,
      active: Boolean(liveKey && profile.key === liveKey),
    }));
  }

  snapshotCurrent(meta = {}) {
    const live = this.current();
    const credential = grokCredential(live);
    if (!credential?.refresh_token) {
      throw new Error("Grok 로그인 정보를 찾지 못했습니다.");
    }
    return this.store.save({
      secret: live,
      email: meta.email || credential.email,
      plan: meta.plan || credential.auth_mode || null,
      active: true,
    });
  }

  deleteProfile(key) {
    const profile = this.listProfiles().find((item) => item.key === key);
    if (!profile) throw new Error("저장된 Grok 계정을 찾지 못했습니다.");
    if (profile.active) throw new Error("현재 사용 중인 계정은 삭제할 수 없습니다.");
    return this.store.delete(key);
  }

  switchToProfile(key) {
    const profile = this.store.get(key);
    if (!grokCredential(profile?.secret)?.refresh_token) {
      throw new Error("저장된 Grok 계정을 찾지 못했습니다.");
    }
    try {
      this.snapshotCurrent();
    } catch {
      // 현재 로그인이 없어도 저장 프로필로 복구할 수 있습니다.
    }
    atomicWrite(this.authPath, profile.secret);
    this.store.setActive(key);
    // Grok 1.0.0은 auth.json 변경을 다음 API 호출에서 hot reload하므로 프로세스 재시작이 필요 없습니다.
    return safeProfile(profile, true);
  }

  prepareLogin(meta = {}) {
    try {
      this.snapshotCurrent(meta);
    } catch {
      // 첫 로그인처럼 현재 자격 증명이 없으면 저장 단계만 건너뜁니다.
    }
    return true;
  }
}

module.exports = { GrokAccountSwitcher, grokCredential };

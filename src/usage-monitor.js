const { EventEmitter } = require("node:events");

class UsageMonitor extends EventEmitter {
  constructor(loaders, { intervalMs = 60000, now = Date.now } = {}) {
    super();
    this.loaders = loaders;
    this.intervalMs = intervalMs;
    this.now = now;
    this.rows = new Map(loaders.map(({ id, label }) => [id, { id, label, loading: true, gauges: [] }]));
    this.pending = new Map();
    this.lastAttempt = new Map();
    this.epoch = 0;
  }

  snapshot() { return { providers: [...this.rows.values()], intervalMs: this.intervalMs }; }
  publish() { this.emit("update", this.snapshot()); }

  async refresh(force = false) {
    return Promise.all(this.loaders.map(({ id, label, load }) => {
      if (this.pending.has(id)) return this.pending.get(id);
      const last = this.lastAttempt.get(id);
      if (last != null && this.now() - last < (force ? 15000 : this.intervalMs)) return;
      this.lastAttempt.set(id, this.now());
      this.rows.set(id, { ...this.rows.get(id), loading: true });
      this.publish();
      const epoch = this.epoch;
      const job = Promise.resolve().then(() => load(force)).then(({ accounts = [], usage }) => {
        if (epoch !== this.epoch) return;
        const account = accounts.find((row) => row.active && row.hasAuth !== false);
        const old = this.rows.get(id);
        const connected = Boolean(account) && !usage.authRequired && usage.error !== "로그인 필요";
        const gauges = (usage.gauges || []).filter((g) => typeof g.usedPercent === "number" && Number.isFinite(g.usedPercent));
        const failed = Boolean(usage.error) || gauges.length === 0;
        const canKeep = connected && account.key === old.accountKey && old.gauges.length > 0;
        this.rows.set(id, {
          id, label, connected, loading: false,
          accountKey: connected ? account.key : null,
          account: connected ? account.email || account.label : null,
          plan: connected ? account.plan || account.planType || "" : "",
          gauges: !failed ? gauges : canKeep ? old.gauges : [],
          stale: failed && canKeep,
          error: failed ? usage.error || "한도 정보 없음" : null,
          updatedAt: !failed ? this.now() : canKeep ? old.updatedAt : null,
        });
      }).catch(() => {
        if (epoch !== this.epoch) return;
        // Without a fresh account identity, do not reuse another account's data.
        this.rows.set(id, { id, label, loading: false, connected: false, gauges: [], error: "로그인 상태 확인 불가" });
      }).finally(() => { if (this.pending.get(id) === job) this.pending.delete(id); this.publish(); });
      this.pending.set(id, job);
      return job;
    }));
  }

  start() {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.intervalMs);
    this.timer.unref?.();
  }
  stop() { clearInterval(this.timer); this.timer = null; }
  invalidate() {
    this.epoch += 1;
    this.lastAttempt.clear(); this.pending.clear();
    for (const { id, label } of this.loaders) this.rows.set(id, { id, label, loading: true, gauges: [] });
    this.publish();
    return this.refresh();
  }
}

function clampWindow(bounds, area) {
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  return { width, height,
    x: Math.round(Math.max(area.x, Math.min(bounds.x, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(bounds.y, area.y + area.height - height))) };
}

function avoidWindows(bounds, obstacles, area) {
  const overlaps = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  const base = clampWindow(bounds, area);
  const blocked = (candidate) => obstacles.some((item) => overlaps(candidate, item));
  if (!blocked(base)) return base;
  for (const obstacle of obstacles) {
    for (const position of [
      { x: obstacle.x - base.width - 12, y: base.y },
      { x: obstacle.x + obstacle.width + 12, y: base.y },
      { x: base.x, y: obstacle.y - base.height - 12 },
    ]) {
      const candidate = clampWindow({ ...base, ...position }, area);
      if (!blocked(candidate)) return candidate;
    }
  }
  return base;
}

module.exports = { UsageMonitor, clampWindow, avoidWindows };

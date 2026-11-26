const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Exercise the renderer without opening a browser or taking desktop focus.
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.textContent = ""; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener() {}
}
function descendants(node) { return [node, ...node.children.flatMap(descendants)]; }
function render(gauges, row = { label: "Codex", connected: true, account: "test@example.com" }) {
  const elements = new Map();
  const document = {
    createElement: (tag) => new Element(tag),
    getElementById(id) { if (!elements.has(id)) elements.set(id, new Element("div")); return elements.get(id); },
    addEventListener() {},
  };
  const context = vm.createContext({ document, window: {}, data: { providers: [
    { ...row, gauges },
  ] } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "usage-renderer.js"), "utf8"), context);
  vm.runInContext("render(data)", context);
  return descendants(document.getElementById("providers"));
}
test("quota popup shows remaining percentages and remaining-sized progress bars", () => {
  const nodes = render([0, 23, 90, 100, 120, -10, 87.6].map((usedPercent) => ({ label: "limit", usedPercent })));
  assert.deepEqual(nodes.filter((n) => n.tag === "strong").map((n) => n.textContent), ["100% 남음", "77% 남음", "10% 남음", "0% 남음", "0% 남음", "100% 남음", "12% 남음"]);
  assert.deepEqual(nodes.filter((n) => n.tag === "progress").map((n) => n.value), [100, 77, 10, 0, 0, 100, 12]);
  assert.deepEqual(nodes.filter((n) => n.className?.startsWith("gauge ")).map((n) => n.className.trim()), ["gauge", "gauge", "gauge critical", "gauge critical", "gauge critical", "gauge", "gauge warning"]);
  assert.ok(nodes.filter((n) => n.tag === "progress").every((n) => n.attributes["aria-label"].includes("남은 한도")));
});
test("AGY 조회 실패는 기존 한도 영역의 텍스트로 표시한다", () => {
  const nodes = render([], { label: "AGY", connected: false, error: "조회 실패" });
  assert.ok(nodes.some(node => node.tag === "p" && node.textContent === "AGY: 조회 실패"));
  assert.ok(!nodes.some(node => node.tag === "a" || node.tag === "dialog"));
});

test("unknown quota is not converted to a full balance", () => {
  const nodes = render([null, undefined, NaN, Infinity, "23"].map((usedPercent) => ({ label: "unknown", usedPercent })));
  assert.deepEqual(nodes.filter((n) => n.tag === "strong").map((n) => n.textContent), ["—", "—", "—", "—", "—"]);
  assert.equal(nodes.filter((n) => n.tag === "progress").length, 0);
});

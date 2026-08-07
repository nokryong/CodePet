const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeFontFamily,
  normalizeFontSize,
  quoteFontFamily,
} = require("../src/appearance-settings");

test("글꼴은 실제 설치 목록의 안전한 패밀리명만 허용한다", () => {
  const installed = ["Malgun Gothic", "Arial"];
  assert.equal(normalizeFontFamily(" Malgun Gothic ", installed), "Malgun Gothic");
  assert.equal(normalizeFontFamily("Missing Font", installed), null);
  assert.equal(normalizeFontFamily("x; color:red", ["x; color:red"]), null);
  assert.equal(normalizeFontFamily("line\nbreak", ["line\nbreak"]), null);
});

test("CSS에 전달할 글꼴명은 따옴표와 역슬래시를 이스케이프한다", () => {
  assert.equal(quoteFontFamily('A"B'), '"A\\"B"');
  assert.equal(quoteFontFamily("A\\B"), '"A\\\\B"');
  assert.equal(quoteFontFamily(null), null);
});

test("font size accepts integer pixels from 10 through 20", () => {
  assert.equal(normalizeFontSize(10), 10);
  assert.equal(normalizeFontSize("16"), 16);
  assert.equal(normalizeFontSize(14.7), 15);
  assert.equal(normalizeFontSize(9), 12);
  assert.equal(normalizeFontSize(21), 12);
  assert.equal(normalizeFontSize("invalid", 13), 13);
});

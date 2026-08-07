function normalizeFontFamily(value, installedFonts = []) {
  if (typeof value !== "string") return null;
  const font = value.trim();
  if (!font || font.length > 120 || /[{};<>\n\r]/.test(font)) return null;
  return installedFonts.includes(font) ? font : null;
}

function quoteFontFamily(font) {
  return font ? `"${font.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : null;
}

function normalizeFontSize(value, fallback = 12) {
  const size = Number(value);
  return Number.isFinite(size) && size >= 10 && size <= 20
    ? Math.round(size)
    : fallback;
}

module.exports = { normalizeFontFamily, normalizeFontSize, quoteFontFamily };

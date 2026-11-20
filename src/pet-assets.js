const fs = require("node:fs");
const path = require("node:path");

function readMetadata(directory) {
  try { return JSON.parse(fs.readFileSync(path.join(directory, "pet.json"), "utf8")) || {}; }
  catch { return {}; }
}

function listPetAssets({ baseDir, codexPetsDir, builtin }) {
  const pets = [];
  const add = (directory, key, label) => {
    const spritePath = path.join(directory, "spritesheet.webp");
    if (!fs.existsSync(spritePath)) return;
    const meta = readMetadata(directory);
    pets.push({ key, label: key === "custom" ? label : meta.displayName || label,
      spritePath, spriteVersionNumber: Number(meta.spriteVersionNumber) || null });
  };
  add(path.join(baseDir, "pet"), "custom", "커스텀 (pet 폴더)");

  let names = [];
  try { names = fs.readdirSync(codexPetsDir); } catch { }
  for (const name of names) add(path.join(codexPetsDir, name), `codex:${name}`, name);

  if (fs.existsSync(builtin.filePath)) pets.push({
    key: "builtin", label: "기본 펫 (내장)", spritePath: builtin.filePath, spriteVersionNumber: builtin.spriteVersionNumber,
  });
  return pets;
}

module.exports = { listPetAssets };

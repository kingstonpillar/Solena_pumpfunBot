import fs from "fs";

export function saveMapToFile(map, file) {
  try {
    const obj = Object.fromEntries(map);
    const tmp = `${file}.tmp`;

    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) {
    console.log("[MAP_SAVE_ERROR]", e?.message || e);
  }
}

export function loadMapFromFile(file) {
  try {
    if (!fs.existsSync(file)) return new Map();

    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return new Map(Object.entries(raw));
  } catch (e) {
    console.log("[MAP_LOAD_ERROR]", e?.message || e);
    return new Map();
  }
}
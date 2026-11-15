// Copies the version from package.json (the single source of truth) into
// src-tauri/Cargo.toml and Cargo.lock. Runs from `npm version`, which then
// commits and tags (`v1.2.3`). tauri.conf.json reads package.json directly.
import { readFileSync, writeFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));

function replaceOnce(path, pattern, replacement) {
  const text = readFileSync(path, "utf8");
  if (!pattern.test(text)) throw new Error(`${path}: version line not found`);
  writeFileSync(path, text.replace(pattern, replacement));
}

replaceOnce("src-tauri/Cargo.toml", /^(\[package\][^[]*?\nversion = )"[^"]*"/m, `$1"${version}"`);
replaceOnce("src-tauri/Cargo.lock", /(\nname = "paperdock"\nversion = )"[^"]*"/, `$1"${version}"`);
console.log(`version ${version}`);

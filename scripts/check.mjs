import { readdirSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots = ["src", "test"];
const files = [];

function walk(directory) {
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    if (full.endsWith(".js") || full.endsWith(".mjs")) files.push(full);
  }
}

for (const name of roots) walk(path.join(root, name));

const banned = /from\s+["']three["']|from\s+["'][^"']*(?:gravacrest|garbage-can-race|vr-halo)[^"']*["']|from\s+["'](?:\.\.\/){2,}/;
let failed = false;

for (const file of files) {
  const relative = path.relative(root, file);
  const checked = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (checked.status !== 0) {
    failed = true;
    process.stderr.write(`arcade/check: syntax ${relative}\n${checked.stderr}`);
  }
  if (relative.startsWith(`src${path.sep}`) && banned.test(readFileSync(file, "utf8"))) {
    failed = true;
    process.stderr.write(`arcade/check: forbidden import in ${relative}\n`);
  }
}

if (failed) process.exit(1);
process.stdout.write(`arcade/check: ${files.length} files\n`);

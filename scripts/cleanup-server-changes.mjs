import { readdirSync, unlinkSync } from "node:fs";

const DIR = ".server-changes";
const KEEP = new Set(["README.md"]);

const removed = [];
for (const file of readdirSync(DIR)) {
  if (!file.endsWith(".md") || KEEP.has(file)) continue;
  unlinkSync(`${DIR}/${file}`);
  removed.push(file);
}

if (removed.length === 0) {
  console.log(`${DIR} already clean, no changes`);
} else {
  console.log(`${DIR} cleaned, removed ${removed.length} consumed file(s):`);
  removed.forEach((f) => console.log(`  - ${f}`));
}

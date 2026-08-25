// Proves the Frozen rule: the comparator's VALUE-import set is empty. Every import it has is
// `import type`, erased at runtime, so the compiled module pulls in no Redis or Prisma client and
// cannot read. Goes red the instant any value import is added — a client, the barrel, or a dynamic
// import(). The detector is pinned against redisSnapshotStore.ts (which value-imports a client) so
// this cannot pass as a tautology.
import { expect, it, describe } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// Returns the module specifiers a file imports FOR VALUE (i.e. that survive to runtime). `import type`
// declarations and named blocks whose specifiers are all inline `type` are erased and excluded.
function valueImports(sourcePath: string): string[] {
  const raw = readFileSync(sourcePath, "utf8");
  const out: string[] = [];

  // Statements are scanned on RAW source, anchored to line start (`^\s*import`), so a `//` comment
  // line never matches and no stripping can hide a real import. Only the mid-line dynamic `import(`
  // check runs on comment-stripped source. The pin test below guarantees the scan catches a real import.
  const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  if (/(^|[^.\w])import\s*\(/.test(stripped)) out.push("<dynamic import()>");

  const importRe = /^\s*import\b([\s\S]*?)\bfrom\s*["']([^"']+)["']/gm;
  for (let m = importRe.exec(raw); m !== null; m = importRe.exec(raw)) {
    const clause = m[1];
    const spec = m[2];
    if (/^\s*type\b/.test(clause)) continue; // `import type ... from`
    const named = clause.match(/\{([\s\S]*?)\}/);
    if (named && !/(^|,)\s*[A-Za-z_$]/.test(named[1].replace(/\btype\s+[A-Za-z_$][\w$]*/g, ""))) {
      continue; // every named specifier is an inline `type` — nothing left for value
    }
    out.push(spec);
  }

  // Bare side-effect imports (`import "x"`) run the module.
  const bareRe = /^\s*import\s*["']([^"']+)["']/gm;
  for (let m = bareRe.exec(raw); m !== null; m = bareRe.exec(raw)) out.push(m[1]);

  return out;
}

describe("comparator read-isolation", () => {
  it("the detector flags a real value import (pin against the store)", () => {
    // redisSnapshotStore.ts value-imports @internal/redis, so a working detector MUST see it.
    const storeImports = valueImports(resolve(here, "redisSnapshotStore.ts"));
    expect(storeImports).toContain("@internal/redis");
  });

  it("the comparator has no value imports — it is import-type-only and cannot read", () => {
    expect(valueImports(resolve(here, "snapshotComparator.ts"))).toEqual([]);
  });
});

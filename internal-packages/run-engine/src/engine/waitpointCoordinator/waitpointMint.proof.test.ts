import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WAITPOINT_MINT_SITES } from "./waitpointMintCatalog";

function repoRoot(): string {
  let dir = process.cwd();
  while (!existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("repo root (pnpm-workspace.yaml) not found");
    dir = parent;
  }
  return dir;
}

function read(relative: string): string {
  return readFileSync(path.join(repoRoot(), relative), "utf8");
}

function count(source: string, pattern: RegExp): number {
  return (source.match(pattern) ?? []).length;
}

// Every production `.ts` under a root, walked rather than listed: a mint added in a new
// file, or moved back into `systems/` where these all lived until the coordinator seam was
// extracted, has to be visible here or the census is decorative.
//
// Test-support trees are excluded deliberately. A helper that writes a row through raw
// Prisma never reaches the routing store, so it cannot misroute; requiring it to be
// catalogued would fill the census with sites that carry no risk.
const TEST_SUPPORT_DIRS = new Set(["tests", "__tests__", "fixtures"]);

function walk(relativeRoot: string): string[] {
  const absolute = path.join(repoRoot(), relativeRoot);
  return readdirSync(absolute).flatMap((name) => {
    const child = `${relativeRoot}/${name}`;
    if (statSync(path.join(absolute, name)).isDirectory()) {
      return TEST_SUPPORT_DIRS.has(name) ? [] : walk(child);
    }
    return name.endsWith(".ts") && !name.includes(".test.") ? [child] : [];
  });
}

// The mint helpers are the only sanctioned way to produce a Postgres waitpoint id.
const MINT_CALL = /mintWaitpointIdFor(?:Shard)?\(/g;
const UNSTAMPED_MINT = /WaitpointId\.generate\(/g;
const WAITPOINT_WRITE = /waitpoint\.create\(|upsertWaitpoint\(|createWaitpoint\(/g;

// The catalog holds the mint expressions as string data, so scanning it would count them.
const CATALOG_ITSELF =
  "internal-packages/run-engine/src/engine/waitpointCoordinator/waitpointMintCatalog.ts";

const ENGINE_SOURCES = walk("internal-packages/run-engine/src/engine").filter(
  (f) => f !== CATALOG_ITSELF
);
const SCANNED = [...ENGINE_SOURCES, "internal-packages/run-store/src/PostgresRunStore.ts"];

// expression -> how many times the catalog says it appears in this file
function expectedMints(file: string): Map<string, number> {
  const expected = new Map<string, number>();
  for (const site of WAITPOINT_MINT_SITES.filter((s) => s.site === file)) {
    for (const expr of site.mints) {
      expected.set(expr, (expected.get(expr) ?? 0) + 1);
    }
  }
  return expected;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("waitpoint mint census — the catalog matches the source", () => {
  it("scans the engine tree and the run-store writer, and finds files to scan", () => {
    expect(ENGINE_SOURCES.length).toBeGreaterThan(10);
    expect(SCANNED).toContain("internal-packages/run-engine/src/engine/systems/waitpointSystem.ts");
  });

  // Per EXPRESSION, not per file: this fails for a fifth mint added inside an
  // already-catalogued file, AND for a swapped anchor — mintWaitpointIdFor(undefined) in
  // place of the run id — which a bare call-count would wave through.
  it.each(SCANNED)("%s has exactly the mint expressions the catalog claims", (file) => {
    const source = read(file);
    const expected = expectedMints(file);

    for (const [expr, n] of expected) {
      expect({ expr, found: count(source, new RegExp(escapeRegExp(expr), "g")) }).toEqual({
        expr,
        found: n,
      });
    }

    // No mint in the file beyond the ones the catalog accounts for.
    const accounted = [...expected.values()].reduce((a, b) => a + b, 0);
    expect(count(source, MINT_CALL)).toBe(accounted);
  });

  it.each(SCANNED)("%s mints no waitpoint id with the un-stamped helper", (file) => {
    // The regex matches tokens inside comments too — deliberate. Any textual addition
    // forces the census to be reconciled, so a new site cannot land unnoticed.
    expect(count(read(file), UNSTAMPED_MINT)).toBe(0);
  });

  it.each(SCANNED)("%s writes a waitpoint row only if it is catalogued", (file) => {
    // A create with NO id is the worst case: Prisma's @default(cuid()) then mints a cuid on
    // a gen-2 shard after the write, which no stamp check can see.
    const writes = count(read(file), WAITPOINT_WRITE);
    const catalogued = WAITPOINT_MINT_SITES.some((s) => s.site === file);
    expect(writes === 0 || catalogued).toBe(true);
  });

  it("every catalogued site names a file that exists", () => {
    for (const site of WAITPOINT_MINT_SITES) {
      expect({ site: site.site, exists: existsSync(path.join(repoRoot(), site.site)) }).toEqual({
        site: site.site,
        exists: true,
      });
    }
  });

  it("every catalogued site names its enclosing symbol in that file", () => {
    for (const site of WAITPOINT_MINT_SITES) {
      const symbol = site.symbol.split(" ")[0]!.replace("#", "");
      expect({ site: site.id, present: read(site.site).includes(symbol) }).toEqual({
        site: site.id,
        present: true,
      });
    }
  });

  it("no catalogued symbol is a line number", () => {
    for (const site of WAITPOINT_MINT_SITES) {
      expect(site.symbol).not.toMatch(/:\d+/);
    }
  });
});

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

// Walked, not listed, so a mint in a new file is visible. Test trees excluded: a raw-Prisma
// helper never reaches the routing store.
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

const MINT_CALL = /mintWaitpointIdFor(?:Shard)?\(/g;
const UNSTAMPED_MINT = /WaitpointId\.generate\(/g;
const WAITPOINT_WRITE = /waitpoint\.create\(|upsertWaitpoint\(|createWaitpoint\(/g;

// Scanning the catalog would count its own string data.
const CATALOG_ITSELF =
  "internal-packages/run-engine/src/engine/waitpointCoordinator/waitpointMintCatalog.ts";

const ENGINE_SOURCES = walk("internal-packages/run-engine/src/engine").filter(
  (f) => f !== CATALOG_ITSELF
);
const SCANNED = [...ENGINE_SOURCES, "internal-packages/run-store/src/PostgresRunStore.ts"];

function expectedMints(file: string): Map<string, number> {
  const expected = new Map<string, number>();
  for (const site of WAITPOINT_MINT_SITES.filter((s) => s.site === file)) {
    for (const expr of site.mints) {
      expected.set(expr, (expected.get(expr) ?? 0) + 1);
    }
  }
  return expected;
}

// The declaration in errors.ts is not a call.
const REFUSAL_CALL = /(?<!function )refusePostgresWaitpointOnMemoryDbAnchor\(/g;

function expectedRefusals(file: string): Map<string, number> {
  const expected = new Map<string, number>();
  for (const site of WAITPOINT_MINT_SITES.filter((s) => s.site === file)) {
    if ("call" in site.refusal) {
      expected.set(site.refusal.call, (expected.get(site.refusal.call) ?? 0) + 1);
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

  // Per expression, so a swapped anchor fails too.
  it.each(SCANNED)("%s has exactly the mint expressions the catalog claims", (file) => {
    const source = read(file);
    const expected = expectedMints(file);

    for (const [expr, n] of expected) {
      expect({ expr, found: count(source, new RegExp(escapeRegExp(expr), "g")) }).toEqual({
        expr,
        found: n,
      });
    }

    const accounted = [...expected.values()].reduce((a, b) => a + b, 0);
    expect(count(source, MINT_CALL)).toBe(accounted);
  });

  it.each(SCANNED)("%s mints no waitpoint id with the un-stamped helper", (file) => {
    // Matches inside comments too: any textual addition forces a reconcile.
    expect(count(read(file), UNSTAMPED_MINT)).toBe(0);
  });

  it.each(SCANNED)("%s writes a waitpoint row only if it is catalogued", (file) => {
    // Worst case is a create with no id: @default(cuid()) mints one after the write.
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

describe("waitpoint mint census — every Postgres waitpoint mint refuses a MemoryDB anchor", () => {
  // Catches: a Postgres waitpoint create site added or removed without its refusal being decided.
  it("lists exactly the eight Postgres waitpoint create sites", () => {
    expect(WAITPOINT_MINT_SITES.map((s) => s.id).sort()).toEqual(
      [
        "coordinator.datetime",
        "coordinator.manual",
        "coordinator.associated.mint",
        "coordinator.associated.create",
        "coordinator.batch",
        "engine.batch",
        "runStore.createRun.nested",
        "runStore.createRun.dedicated",
      ].sort()
    );
  });

  // Catches: an anchored mint catalogued with no refusal of its own.
  it("every anchored mint has a refusal call, and every via names one", () => {
    const byId = new Map(WAITPOINT_MINT_SITES.map((s) => [s.id, s]));
    for (const site of WAITPOINT_MINT_SITES) {
      if (site.mints.some((m) => m.startsWith("mintWaitpointIdFor("))) {
        expect({ site: site.id, call: "call" in site.refusal }).toEqual({
          site: site.id,
          call: true,
        });
      }
      if ("via" in site.refusal) {
        const target = byId.get(site.refusal.via);
        expect({ site: site.id, viaHasCall: !!target && "call" in target.refusal }).toEqual({
          site: site.id,
          viaHasCall: true,
        });
      }
    }
  });

  // Catches: a refusal dropped from a site, given the wrong anchor, or added without a catalogue entry.
  it.each(SCANNED)("%s has exactly the refusal calls the catalog claims", (file) => {
    const source = read(file);
    const expected = expectedRefusals(file);

    for (const [expr, n] of expected) {
      expect({ expr, found: count(source, new RegExp(escapeRegExp(expr), "g")) }).toEqual({
        expr,
        found: n,
      });
    }

    const accounted = [...expected.values()].reduce((a, b) => a + b, 0);
    expect(count(source, REFUSAL_CALL)).toBe(accounted);
  });
});

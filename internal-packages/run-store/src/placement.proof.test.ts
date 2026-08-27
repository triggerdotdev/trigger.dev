import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  GIVEN_RUN_ID_ROUTE,
  PLACEMENT_SITES,
  READ_ONLY_METHODS,
  ROUTES_BY_GIVEN_RUN_ID,
} from "./placementCatalog.js";

function repoRoot(): string {
  let dir = process.cwd();
  while (!existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("repo root (pnpm-workspace.yaml) not found");
    dir = parent;
  }
  return dir;
}

const read = (relative: string) => readFileSync(path.join(repoRoot(), relative), "utf8");

const TYPES = "internal-packages/run-store/src/types.ts";
const STORE = "internal-packages/run-store/src/runOpsStore.ts";

/**
 * Method names declared on the `RunStore` interface, overloads collapsed. Parsed from the
 * source rather than imported as a type, because a type-level check cannot fail a build with
 * a message naming the method somebody forgot to classify.
 */
function interfaceMethods(): string[] {
  const source = read(TYPES);
  const start = source.indexOf("export interface RunStore {");
  expect(start).toBeGreaterThan(-1);

  // Declarations sit at exactly two-space indent inside the interface. Trailing members of
  // later declarations in the file are harmless: the union check below is what matters, and a
  // stray name would show up as uncatalogued rather than being quietly dropped.
  const body = source.slice(start);
  const names = new Set<string>();
  for (const match of body.matchAll(/^ {2}([a-zA-Z][A-Za-z0-9]*)(<[^\n]*?>)?\(/gm)) {
    names.add(match[1]!);
  }
  return [...names];
}

/**
 * The source of one method implementation: from its declaration to the next member at the same
 * indent. Deliberately not brace-matching — a signature carrying an inline object type makes
 * that fiddly, and getting it subtly wrong is how a census ends up reporting that a method has
 * no routing call when it has one on the next line.
 */
function methodBody(source: string, method: string): string | undefined {
  // The LAST declaration, not the first: an overloaded method leads with bodiless signatures,
  // and picking one of those reports the implementation as having no routing call at all.
  const declaration = new RegExp(`^ {2}(?:async )?${method}(?:<[^\\n]*?>)?\\(`, "gm");
  const matches = [...source.matchAll(declaration)];
  const start = matches.at(-1)?.index;
  if (start === undefined) return undefined;

  const rest = source.slice(start + 3);
  const next = rest.search(/^ {2}(?:async )?[a-zA-Z#][A-Za-z0-9]*(?:<[^\n]*?>)?\(/m);
  return next === -1 ? rest : rest.slice(0, next);
}

function catalogued(): { writes: string[]; all: string[] } {
  const writes = [...ROUTES_BY_GIVEN_RUN_ID, ...PLACEMENT_SITES.map((s) => s.method)];
  return { writes, all: [...writes, ...READ_ONLY_METHODS] };
}

describe("run-store placement census — every write states what it routes by", () => {
  it("parses a plausible interface, so a silent parse failure cannot pass the suite", () => {
    const methods = interfaceMethods();
    expect(methods.length).toBeGreaterThan(50);
    expect(methods).toContain("upsertWaitpointTag");
    expect(methods).toContain("findRun");
  });

  // The whole point of the census. A method added to `RunStore` is uncatalogued, and
  // uncatalogued fails: nobody gets to add a write without saying how it is placed.
  it("classifies every interface method as exactly one of read or write", () => {
    const methods = interfaceMethods();
    const { all } = catalogued();

    const uncatalogued = methods.filter((m) => !all.includes(m)).sort();
    expect({ uncatalogued }).toEqual({ uncatalogued: [] });

    const stale = all.filter((m) => !methods.includes(m)).sort();
    expect({ staleCatalogEntries: stale }).toEqual({ staleCatalogEntries: [] });
  });

  it("never classifies a method as both a read and a write", () => {
    const { writes } = catalogued();
    const both = writes.filter((m) => READ_ONLY_METHODS.includes(m)).sort();
    expect({ classifiedAsBoth: both }).toEqual({ classifiedAsBoth: [] });
  });

  it("lists no method twice", () => {
    const { all } = catalogued();
    const seen = new Set<string>();
    const duplicates = all.filter((m) => (seen.has(m) ? true : (seen.add(m), false))).sort();
    expect({ duplicates }).toEqual({ duplicates: [] });
  });

  // The forbidden cell. A write that can only name NEW or LEGACY, whose miss produces no
  // error, is a row placed on a database its owner does not live on with nothing to detect
  // it. `upsertWaitpointTag` sat here and every functional test passed.
  it("has no write that routes on residency alone and misses silently", () => {
    const forbidden = PLACEMENT_SITES.filter(
      (s) => s.basis === "residency" && s.missMode === "silent"
    ).map((s) => s.method);

    expect({ residencyOnlySilentWrites: forbidden }).toEqual({ residencyOnlySilentWrites: [] });
  });

  // `residency` and `fan-out` are both claims about safety rather than mechanisms that
  // enforce it, so each one has to be argued in the catalog. Writing that sentence honestly
  // for a tag is what would have caught the defect this census exists for.
  it("requires a written justification wherever safety is a claim, not a mechanism", () => {
    const unjustified = PLACEMENT_SITES.filter(
      (s) => (s.basis === "residency" || s.basis === "fan-out") && (s.why ?? "").trim().length < 40
    ).map((s) => s.method);

    expect({ unjustified }).toEqual({ unjustified: [] });
  });

  it("gives every catalogued write at least one routing expression", () => {
    const empty = PLACEMENT_SITES.filter((s) => s.routes.length === 0).map((s) => s.method);
    expect({ withoutRoutes: empty }).toEqual({ withoutRoutes: [] });
  });

  // Anchors the catalog to the source. Weakening a route — dropping the shard hint, swapping
  // an id for a residency fallback, renaming a helper — fails here rather than in production.
  it.each(PLACEMENT_SITES)("$method still contains the routes the catalog claims", (site) => {
    const source = read(STORE);
    for (const route of site.routes) {
      expect({ method: site.method, route, present: source.includes(route) }).toEqual({
        method: site.method,
        route,
        present: true,
      });
    }
  });

  it.each(ROUTES_BY_GIVEN_RUN_ID)("%s routes on the run id it is given", (method) => {
    const body = methodBody(read(STORE), method);

    expect({ method, found: body !== undefined }).toEqual({ method, found: true });
    expect({ method, routedOnGivenRunId: body!.includes(GIVEN_RUN_ID_ROUTE) }).toEqual({
      method,
      routedOnGivenRunId: true,
    });
  });
});

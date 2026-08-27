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
 * Method names on the `RunStore` interface, overloads collapsed. Parsed from source rather than
 * imported as a type, so a failure can name the method somebody forgot to classify.
 */
function interfaceMethods(): string[] {
  const source = read(TYPES);
  const start = source.indexOf("export interface RunStore {");
  expect(start).toBeGreaterThan(-1);

  // Declarations sit at two-space indent. A stray name from later in the file shows up as
  // uncatalogued rather than being dropped.
  const body = source.slice(start);
  const names = new Set<string>();
  for (const match of body.matchAll(/^ {2}([a-zA-Z][A-Za-z0-9]*)(<[^\n]*?>)?\(/gm)) {
    names.add(match[1]!);
  }
  return [...names];
}

/**
 * One method implementation: its declaration to the next member at the same indent. Not
 * brace-matching, which a signature carrying an inline object type makes fiddly to get right.
 */
function methodBody(source: string, method: string): string | undefined {
  // The last declaration: an overloaded method leads with bodiless signatures.
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

  // The point of the census: nobody adds a write without saying how it is placed.
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

  // The forbidden cell: a row on a database its owner does not live on, with nothing to detect
  // it. `upsertWaitpointTag` sat here and every functional test passed.
  it("has no write that routes on residency alone and misses silently", () => {
    const forbidden = PLACEMENT_SITES.filter(
      (s) => s.basis === "residency" && s.missMode === "silent"
    ).map((s) => s.method);

    expect({ residencyOnlySilentWrites: forbidden }).toEqual({ residencyOnlySilentWrites: [] });
  });

  // Both are claims about safety rather than mechanisms, so each has to be argued in the catalog.
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

  // Scoped to the method's own body, not the whole file: three creates share
  // `#routeOrNew(params.data.id)`, so a file-wide search passes when one loses its route.
  it.each(PLACEMENT_SITES)("$method still contains the routes the catalog claims", (site) => {
    const body = methodBody(read(STORE), site.method);

    expect({ method: site.method, found: body !== undefined }).toEqual({
      method: site.method,
      found: true,
    });

    for (const route of site.routes) {
      expect({ method: site.method, route, present: body!.includes(route) }).toEqual({
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

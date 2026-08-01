import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { scanDirectory, scanFile } from "../src/scan.js";
import { buildReport } from "../src/score.js";
import { SCORED_CHECK_IDS } from "../src/checks/index.js";

/**
 * The one deliberate coupling to `apps/webapp/app/routes` in the suite. Everything else, including
 * the CLI tests, runs against a fixture tree of this package's own making.
 *
 * The coupling is acceptable because nothing here names a route or a count: the scan must not
 * crash, the entry point count must sit inside a wide band, and parse failures must be zero. Those
 * survive routes being added, renamed and deleted, and they are the only things a fixture tree
 * cannot tell us, since a fixture only contains shapes somebody thought to write down.
 *
 * What runs this for a webapp pull request is the `unit-tests` job in
 * `.github/workflows/observability-map.yml`, which already triggers on `apps/webapp/app/routes/**`
 * and runs this package alone. Widening `pr_checks.yml`'s `internal` filter to those paths was
 * tried and reverted: it ran all eighteen internal packages, twelve shards with postgres,
 * clickhouse, redis and electric, to protect this one test.
 */
const ROUTES = resolve(__dirname, "../../../apps/webapp/app/routes");

/**
 * Every `.ts`/`.tsx` file under the tree, at any depth. Deliberately not the scanner's walk, which
 * looks at flat files and at one `route.ts`/`route.tsx` per directory: this used to be a verbatim
 * copy of that walk, which made `entryPoints.length < countCandidates()` a tautology that could
 * not fail for any route shape both of them missed.
 */
function countRouteModuleFiles(dir: string): number {
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      count += countRouteModuleFiles(join(dir, entry.name));
      continue;
    }
    if (entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) count++;
  }
  return count;
}

beforeAll(() => {
  // A hard failure rather than the `if (!existsSync(ROUTES)) return;` these tests opened with: if
  // this package moves relative to apps/webapp, the real-tree coverage must disappear loudly.
  if (!existsSync(ROUTES)) {
    throw new Error(`the webapp routes directory is missing: ${ROUTES}`);
  }
});

// B7. The build emits ESM (`module: ESNext`, and `cli.ts` uses `import.meta`) while `main` and
// `types` advertised it to a package.json with no module type. On node 24 that loads with a
// MODULE_TYPELESS_PACKAGE_JSON warning and a reparse rather than the throw older nodes give, which
// is a warning about an artifact this package tells other packages to import.
describe("the package it advertises", () => {
  const manifest = JSON.parse(
    readFileSync(resolve(__dirname, "../package.json"), "utf8")
  ) as Record<string, string>;

  // Asserted flat rather than behind an `if (!advertised) return`, which is the silent skip this
  // round removed from the tests below: the decision was to keep the entry point and declare the
  // module type, so dropping the entry point later should have to edit this, not slip past it.
  it("declares the module type its build emits alongside the entry point it advertises", () => {
    expect(manifest.main).toBe("./dist/src/index.js");
    expect(manifest.types).toBe("./dist/src/index.d.ts");
    expect(manifest.type).toBe("module");
  });
});

/**
 * The one thing the docstring checker cannot reach. It walks `src/` only, so workflow prose is
 * unpoliced, and the C1 defect was exactly that: two steps disagreeing about what a missing
 * `/tmp/existing-comment-id` meant, under a comment claiming they agreed. The render step read it
 * as "a comment exists" and emitted the resolved state, the upsert step read it as "no id" and
 * POSTed, so a transient lookup failure either added a second marker comment beside the stale one
 * or announced that findings were gone on a pull request that never had any.
 *
 * This is a text check over the workflow, not a parse of its semantics, so it catches one shape of
 * that class and no other. Named as such rather than sold as coverage of the file.
 */
describe("the report workflow's two readers of the comment lookup", () => {
  const WORKFLOW = resolve(__dirname, "../../../.github/workflows/observability-map.yml");

  /** Step bodies, split on the `- name:` lines, which is all the structure this needs. */
  function steps(): string[] {
    if (!existsSync(WORKFLOW)) throw new Error(`the report workflow is missing: ${WORKFLOW}`);
    const text = readFileSync(WORKFLOW, "utf8");
    return text.split(/^ {6}- name: /m).slice(1);
  }

  it("both honour the same sentinel, so a failed lookup cannot mean two things", () => {
    const readers = steps().filter((step) => step.includes("/tmp/existing-comment-id"));
    expect(readers.length).toBeGreaterThanOrEqual(2);
    expect(readers.filter((step) => !step.includes("/tmp/comment-lookup-failed"))).toEqual([]);
  });

  it("takes one id from a lookup that paginates rather than passing every line on", () => {
    const lookup = steps().find((step) => step.includes('startswith("<!-- observability-map'))!;
    expect(lookup).toBeDefined();
    expect(lookup).toContain("exit }'");
  });
});

describe("counting candidates independently of the scanner", () => {
  // The counter is only worth having if it disagrees with the scanner somewhere. It does: the
  // scanner attributes nothing to a nested file that is not `route.ts`/`route.tsx`, and the
  // counter counts every module file at every depth.
  it("counts a nested non-route file the scanner does not attribute to any route", () => {
    const dir = mkdtempSync(join(tmpdir(), "obs-map-count-"));
    mkdirSync(join(dir, "components"));
    writeFileSync(
      join(dir, "components", "helper.ts"),
      `export const loader = () => new Response("ok");`
    );

    expect(countRouteModuleFiles(dir)).toBe(1);
    expect(scanDirectory(dir).entryPoints).toHaveLength(0);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("scanning the real webapp routes", () => {
  it("parses every route file and produces a report inside a wide band", () => {
    const { entryPoints, parseFailures } = scanDirectory(ROUTES);

    expect(parseFailures).toEqual([]);
    expect(entryPoints.length).toBeGreaterThan(100);
    expect(entryPoints.length).toBeLessThan(countRouteModuleFiles(ROUTES));

    const report = buildReport(entryPoints, parseFailures);
    expect(report.global).toBeGreaterThanOrEqual(0);
    expect(report.global).toBeLessThanOrEqual(100);
    expect(Object.keys(report.byFamily).length).toBeGreaterThan(1);
  });

  // A1, exhaustive: every scored check suppressed on every real route, zero behavioural change.
  // The old measured-from-visible logic took this global from 17 to 33 and measured from 412 to
  // 176, because every entry whose only applicable checks were suppressed dropped out of the
  // mean. Measured must not move: every entry point that had something applicable still does.
  it("suppressing every scored check on every real route does not raise the global", () => {
    const { entryPoints, parseFailures } = scanDirectory(ROUTES);
    const before = buildReport(entryPoints, parseFailures);

    const directive = SCORED_CHECK_IDS.map(
      (id) => `// obs-map-disable ${id} -- exhaustive sweep\n`
    ).join("");
    const suppressed = entryPoints.map((ep) => scanFile(ep.fileName, directive + ep.source)!);
    const after = buildReport(suppressed, parseFailures);

    expect(after.measured).toBe(before.measured);
    expect(after.unmeasured).toBe(before.unmeasured);
    expect(after.global).not.toBeGreaterThan(before.global!);
    // Two full tree scans plus a re-scan of every source, which does not fit the suite default.
  }, 60_000);
});

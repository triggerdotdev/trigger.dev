import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { scanDirectory, scanFile } from "../src/scan.js";
import { buildReport } from "../src/score.js";
import { SCORED_CHECK_IDS } from "../src/checks/index.js";

const ROUTES = resolve(__dirname, "../../../apps/webapp/app/routes");

/**
 * Counts route module candidates the same way `scanDirectory` walks the tree, without scanning
 * their contents: a flat `.ts`/`.tsx` file, or one `route.ts`/`route.tsx` per directory. This is a
 * structural upper bound, not a golden number - not every candidate exports a loader or action, so
 * `entryPoints.length` must stay below it, and the route set is free to grow or shrink over time
 * without breaking this test.
 */
function countCandidates(dir: string): number {
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const child of readdirSync(join(dir, entry.name), { withFileTypes: true })) {
        if (child.isFile() && (child.name === "route.ts" || child.name === "route.tsx")) count++;
      }
      continue;
    }
    if (entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) count++;
  }
  return count;
}

describe("scanning the real webapp routes", () => {
  it("parses every route file without crashing", () => {
    if (!existsSync(ROUTES)) return;
    const { entryPoints, parseFailures } = scanDirectory(ROUTES);
    // Invariants, not exact numbers: the route set changes constantly.
    expect(entryPoints.length).toBeGreaterThan(200);
    expect(entryPoints.length).toBeLessThan(countCandidates(ROUTES));
    expect(parseFailures).toEqual([]);
  });

  it("produces a report with a score in range", () => {
    if (!existsSync(ROUTES)) return;
    const { entryPoints, parseFailures } = scanDirectory(ROUTES);
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
    if (!existsSync(ROUTES)) return;
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

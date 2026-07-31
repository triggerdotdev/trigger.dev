import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { scanDirectory } from "../src/scan.js";
import { buildReport } from "../src/score.js";

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
});

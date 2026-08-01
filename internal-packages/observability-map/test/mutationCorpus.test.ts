import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { scanDirectory } from "../src/scan.js";
import { buildReport } from "../src/score.js";
import { MUTATIONS, type Mutation } from "./mutations.js";

/**
 * The tree-scale mutation corpus.
 *
 * The tool's central claim is that no semantics-preserving edit to a route raises its score. Three
 * rounds argued that claim shape by shape and lost each time. This file turns it into evidence
 * instead: every laundering shape anyone has found is a corpus entry, and each entry rewrites the
 * whole real route tree in a temp copy and is held to three assertions.
 *
 * - the published global does not rise. That is the figure the claim is about.
 * - the mean over the routes measured in BOTH runs does not rise. Same comparison at full
 *   precision, with the population held fixed so it measures scores rather than denominators.
 * - for a semantics-preserving rewrite, no individual route's score rises and no measured route
 *   drops out of the measured set. The tree mean can hide a route going up by taking another down;
 *   `[0].map(...)` is exactly that shape.
 *
 * Tree scale, not per-fixture, because that is where laundering pays. A shape that moves one
 * hand-written fixture by 50 points may move the tree by nothing; a shape that moves the tree is the
 * one worth defending.
 *
 * The honest statement this file supports is "these N mutations are defended, and here they are",
 * never "unpaddable".
 *
 * Runtime is roughly six seconds per entry, which is why the whole file is gated behind
 * `OBS_MAP_MUTATION_CORPUS=1`. The `observability-map` workflow sets it, so the gate keeps the
 * default suite fast without making this the thing nobody runs.
 */

const ROUTES = resolve(__dirname, "../../../apps/webapp/app/routes");
const ENABLED = process.env.OBS_MAP_MUTATION_CORPUS === "1";

/**
 * Where a corpus entry goes when the tool does not defend it. Empty as of round A fix 2: all 30
 * entries hold. When a reviewer finds a shape that cannot be defended, add it to the corpus and
 * name it here rather than leaving it out, and write down why in the round's report. `it.fails`
 * keeps such an entry running, so closing the hole later turns this file red until the entry is
 * moved back out deliberately.
 */
const KNOWN_GAPS = new Set<string>([]);

type SourceFile = { relativeName: string; source: string };

/** Route modules exactly as `scanDirectory` enumerates them: flat files, plus one `route.ts(x)` per
 * directory. Read once; every mutation rewrites this list rather than the tree on disk. */
function readTree(dir: string): SourceFile[] {
  const files: SourceFile[] = [];
  const take = (absolutePath: string, relativeName: string) => {
    files.push({ relativeName, source: readFileSync(absolutePath, "utf8") });
  };
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const child of readdirSync(join(dir, entry.name), { withFileTypes: true })) {
        if (!child.isFile() || (child.name !== "route.ts" && child.name !== "route.tsx")) continue;
        take(join(dir, entry.name, child.name), `${entry.name}/${child.name}`);
      }
      continue;
    }
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name) || entry.name.endsWith(".d.ts")) continue;
    take(join(dir, entry.name), entry.name);
  }
  return files;
}

function materialize(files: SourceFile[]): string {
  const root = join(
    tmpdir(),
    `obs-map-corpus-${process.pid}-${Math.random().toString(36).slice(2)}`
  );
  for (const file of files) {
    const target = join(root, file.relativeName);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.source);
  }
  return root;
}

type Measurement = {
  global: number | null;
  /** The unrounded mean the global is a rounding of. A rise of less than half a point is invisible
   * in `global` and is still a rise, so the assertions read this. */
  exactMean: number;
  measured: number;
  entryPoints: number;
  parseFailures: number;
  /** Per route file, so a mutation that raises one route while lowering the tree is still caught.
   * `[0].map(...)` is exactly that shape: it deletes a route's catches, which takes a failing route
   * to 100 and a passing one to nothing, and the two cancel in the global. */
  perEntry: Map<string, { score: number; measured: boolean; checks: string }>;
};

function measure(files: SourceFile[]): Measurement {
  const root = materialize(files);
  try {
    const { entryPoints, parseFailures } = scanDirectory(root);
    const report = buildReport(entryPoints, parseFailures);
    const scores = report.entries.filter((e) => e.measured).map((e) => e.score);
    const perEntry = new Map<string, { score: number; measured: boolean; checks: string }>();
    for (const entry of report.entries) {
      perEntry.set(entry.fileName, {
        score: entry.score,
        measured: entry.measured,
        checks: entry.rawChecks.map((c) => `${c.id}=${c.status}`).join(" "),
      });
    }
    return {
      global: report.global,
      exactMean: scores.length === 0 ? 0 : scores.reduce((a, b) => a + b, 0) / scores.length,
      measured: report.measured,
      entryPoints: entryPoints.length,
      parseFailures: parseFailures.length,
      perEntry,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

type Rise = { fileName: string; from: number; to: number; before: string; after: string };

/**
 * Route files the mutation made look better, worst first. Two ways to qualify, both counted: the
 * score went up, or a route that was being measured stopped being measured. The second is a rise
 * too. An unmeasured route's score is the vacuous 100 and it leaves every mean, so dropping out of
 * the measured set is the most complete form of the thing the property forbids.
 *
 * A route the mutation removed from the report entirely is not counted here; the entry-point guard
 * catches that instead.
 */
function risesIn(baseline: Measurement, after: Measurement): Rise[] {
  const rises: Rise[] = [];
  for (const [fileName, before] of baseline.perEntry) {
    const now = after.perEntry.get(fileName);
    if (!now) continue;
    const droppedOut = before.measured && !now.measured;
    if (!droppedOut && now.score <= before.score) continue;
    rises.push({
      fileName,
      from: before.score,
      to: now.score,
      before: before.checks,
      after: now.checks,
    });
  }
  return rises.sort((a, b) => b.to - b.from - (a.to - a.from));
}

/** Mean score over the routes measured in BOTH runs. The plain mean moves when the measured
 * population moves, which a mutation can do without making any route look better: an inert
 * try/catch takes 15 trivial routes off the exemption list and into the report, and a route joining
 * at 50 raises a tree averaging 15 while itself having gone from an unmeasured 100 to a measured 50.
 * Holding the population fixed is what makes the comparison about the scores. */
function commonMean(baseline: Measurement, after: Measurement): { before: number; after: number } {
  let sumBefore = 0;
  let sumAfter = 0;
  let n = 0;
  for (const [fileName, before] of baseline.perEntry) {
    const now = after.perEntry.get(fileName);
    if (!before.measured || !now || !now.measured) continue;
    sumBefore += before.score;
    sumAfter += now.score;
    n++;
  }
  return n === 0 ? { before: 0, after: 0 } : { before: sumBefore / n, after: sumAfter / n };
}

function mutate(files: SourceFile[], mutation: Mutation): { files: SourceFile[]; changed: number } {
  let changed = 0;
  const out = files.map((file) => {
    const source = mutation.apply(file.relativeName, file.source);
    if (source === null || source === file.source) return file;
    changed++;
    return { relativeName: file.relativeName, source };
  });
  return { files: out, changed };
}

const describeCorpus = ENABLED && existsSync(ROUTES) ? describe : describe.skip;

describeCorpus("mutation corpus over the real route tree", () => {
  const files = ENABLED && existsSync(ROUTES) ? readTree(ROUTES) : [];
  const baseline = ENABLED && existsSync(ROUTES) ? measure(files) : null;

  it("has a baseline worth mutating", () => {
    expect(baseline).not.toBeNull();
    expect(baseline!.entryPoints).toBeGreaterThan(300);
    expect(baseline!.global).not.toBeNull();
    console.log(
      `[corpus] baseline global=${baseline!.global} mean=${baseline!.exactMean.toFixed(3)} ` +
        `measured=${baseline!.measured} eps=${baseline!.entryPoints} files=${files.length}`
    );
  });

  /**
   * The number of files a mutation must touch before its result means anything. A mutation that
   * silently matched nothing would otherwise "pass" by leaving the tree alone, which is the exact
   * failure mode that let earlier rounds believe a shape was defended.
   */
  const MINIMUM_FILES_TOUCHED = 20;

  for (const mutation of MUTATIONS) {
    const run = KNOWN_GAPS.has(mutation.id) ? it.fails : it;

    run(`${mutation.kind}: ${mutation.what} (${mutation.id})`, () => {
      const { files: mutated, changed } = mutate(files, mutation);
      expect(changed).toBeGreaterThanOrEqual(MINIMUM_FILES_TOUCHED);

      const after = measure(mutated);

      // A mutation that stops the tree parsing, or that hides most of the routes from the scanner,
      // has not tested the property: whatever the score does afterwards is measuring a different
      // tree. Both guards fail loudly rather than letting such a mutation report a pass.
      expect(after.parseFailures).toBe(baseline!.parseFailures);
      expect(after.entryPoints).toBeGreaterThanOrEqual(baseline!.entryPoints - 5);

      const rises = risesIn(baseline!, after);
      const common = commonMean(baseline!, after);
      console.log(
        `[corpus] ${mutation.id}: global ${baseline!.global} -> ${after.global} ` +
          `(mean ${baseline!.exactMean.toFixed(3)} -> ${after.exactMean.toFixed(3)}, ` +
          `common mean ${common.before.toFixed(3)} -> ${common.after.toFixed(3)}, ` +
          `measured ${baseline!.measured} -> ${after.measured}, files ${changed}, ` +
          `routes raised ${rises.length})` +
          rises
            .slice(0, 3)
            .map(
              (r) =>
                `\n    ${r.fileName} ${r.from}->${r.to}\n      was: ${r.before}\n      now: ${r.after}`
            )
            .join("")
      );

      // The published figure, which is what the claim is about.
      expect(after.global!).toBeLessThanOrEqual(baseline!.global!);
      // The same comparison at full precision, over a fixed population so it measures the scores
      // and not who is in the denominator.
      expect(common.after).toBeLessThanOrEqual(common.before + 1e-9);

      // Per route, for the preserving half of the corpus. This is the property as stated: an edit
      // that does not change what a route does must not make that route look better, whatever it
      // does to the tree's mean. The deleting half is exempt on purpose: a route whose only failing
      // check was error-classification really does leave the denominator when its catch goes, which
      // the design chose over crediting a route for deleting its error handling, and the global
      // figure above is where that trade is held to account.
      if (mutation.kind === "preserving") {
        expect(rises.map((r) => `${r.fileName} ${r.from}->${r.to}`)).toEqual([]);
      }
    });
  }
});

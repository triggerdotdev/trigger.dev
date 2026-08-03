import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { routeModuleFiles, scanDirectory } from "./scan.js";
import { buildReport } from "./score.js";
import { ADDITIVE_IDS, MUTATIONS, type Mutation } from "./mutations.js";
import { CHECKS } from "./checks/index.js";

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
 * - the mirror of that, for a semantics-preserving rewrite: no individual route's score FALLS on
 *   the routes measured in both runs. A fall is a false accusation, which is the direction that
 *   gets the tool switched off, and it went unasserted for three rounds while 19 entries regressed
 *   104 routes (see `fallsIn`). Exactly two entries carry a permanent `lowers` exemption, with the
 *   reason on the entry and the residual shape asserted instead of waived.
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
 * Where a corpus entry goes when the tool does not defend it. `it.fails` keeps the entry running,
 * so closing the hole later turns this file red until the entry is moved back out deliberately.
 *
 * `dead-classifying-try-with-call` is the shape `dead-classifying-try` only looked like it closed.
 * `canRaise` accepts any call at all, so `try { String(0); }` reads as a clause guarding real work
 * and takes the tree from 19 to 44, raising 224 routes, exactly as `try { 0; }` did before it was
 * refused. Telling an inert call from one that can throw needs types the scanner does not have.
 * The docstrings in `scan.ts`, `types.ts` and `errorClassification.ts` say the rule refuses
 * `try { 0; }` and is defeated by one call, rather than claiming the family is closed.
 *
 * `dead-branch-after-if-true` used to be listed here on a measurement that was wrong. See the round
 * A fix 3 report; the short version is that the rejected alternative was implemented with the exit
 * flag raised before each statement's own branch check, which makes every deciding statement refuse
 * itself. Raising it after is byte-identical on the real tree and closes the shape, so the entry is
 * defended now and the `if (true)` family needed no condition folding after all.
 */
const KNOWN_GAPS = new Set<string>(["dead-classifying-try-with-call"]);

type SourceFile = { relativeName: string; source: string };

/**
 * Route modules exactly as `scanDirectory` enumerates them, because it is the same enumeration and
 * no longer a copy of it. `isScannableFile` had already replaced the file half of the copy; the
 * directory half survived, so "one `route.ts(x)` per immediate subdirectory" was still written
 * twice. A harness that reads a different tree from the scanner reports files and sites the scan
 * never saw, and those counts are what the thresholds below rest on.
 *
 * Read once; every mutation rewrites this list rather than the tree on disk.
 */
function readTree(dir: string): SourceFile[] {
  return routeModuleFiles(dir).map((file) => ({
    relativeName: file.relativeName,
    source: readFileSync(file.absolutePath, "utf8"),
  }));
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

type Fall = { fileName: string; from: number; to: number; before: string; after: string };

/**
 * The mirror of `risesIn`: route files the mutation made look WORSE, worst first. A preserving
 * edit lowering a route's score is a false accusation, the direction that gets the tool switched
 * off, and for three rounds it was structurally invisible here because only rises were asserted.
 * 19 of 43 preserving entries were regressing 104 routes when it was first measured.
 *
 * Only routes measured in BOTH runs are compared. A route ENTERING the measured set is not a fall:
 * unmeasured routes score the vacuous 100, so a mutation that brings one in at 50 registers a
 * 100 -> 50 "fall" that is nothing of the kind. A route LEAVING the measured set is already
 * counted by `risesIn`, not double-counted here. `compared` is the size of the both-measured
 * population, asserted against `baseline.measured` in every preserving entry so a silently
 * shrunken comparison cannot pass.
 */
function fallsIn(baseline: Measurement, after: Measurement): { falls: Fall[]; compared: number } {
  const falls: Fall[] = [];
  let compared = 0;
  for (const [fileName, before] of baseline.perEntry) {
    const now = after.perEntry.get(fileName);
    if (!now || !before.measured || !now.measured) continue;
    compared++;
    if (now.score >= before.score) continue;
    falls.push({
      fileName,
      from: before.score,
      to: now.score,
      before: before.checks,
      after: now.checks,
    });
  }
  return { falls: falls.sort((a, b) => a.to - a.from - (b.to - b.from)), compared };
}

/** The `id=status` pairs of a `perEntry.checks` string, for the exemption shape assertion. */
function checkStatuses(checks: string): Map<string, string> {
  return new Map(checks.split(" ").map((pair) => pair.split("=") as [string, string]));
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

function mutate(
  files: SourceFile[],
  mutation: Mutation
): { files: SourceFile[]; changed: number; sites: number } {
  let changed = 0;
  let sites = 0;
  const out = files.map((file) => {
    const result = mutation.apply(file.relativeName, file.source);
    if (result === null || result.source === file.source) return file;
    changed++;
    sites += result.sites;
    return { relativeName: file.relativeName, source: result.source };
  });
  return { files: out, changed, sites };
}

/**
 * Deliberately NOT gated behind `OBS_MAP_MUTATION_CORPUS`, unlike everything below it.
 *
 * This is the guard for the way the corpus actually failed. `auth-scope` was added a round after
 * `suppress-every-check` was written and never added to its directive list, so the "a suppression
 * cannot raise a score" invariant went untested at tree scale for the 19 routes that check applies
 * to, while the entry's own description said "every check". Nothing noticed, because the entry
 * still passed: omitting a check from the sweep leaves its failures in place, which lowers the
 * score rather than raising it, so the corpus cannot catch its own omission by failing.
 *
 * A registry assertion can, and it belongs in the default suite so that adding a check without
 * extending the corpus turns `pnpm test` red rather than a job nobody runs locally.
 */
describe("the corpus keeps up with the check registry", () => {
  it("suppresses every registered check in the exhaustive sweep", () => {
    const sweep = MUTATIONS.find((m) => m.id === "suppress-every-check")!;
    const mutated = sweep.apply("api.v1.a.ts", "export const loader = () => null;")!.source;
    const missing = CHECKS.map((c) => c.id).filter(
      (id) => !mutated.includes(`obs-map-disable ${id} `)
    );
    expect(missing).toEqual([]);
  });

  // Ungated for the same reason as the sweep assertion above: it reads no route tree and costs
  // nothing, so gating it would only hide a stale list from the run people actually do.
  it("covers the additive direction, not only the subtractive one", () => {
    // Every corpus entry once removed or restructured real signal, and none added fake signal. The
    // two largest holes ever found here lived in that blind spot, so the class is asserted rather
    // than left to whoever edits the list next.
    const ids = new Set(MUTATIONS.map((m) => m.id));
    expect(ADDITIVE_IDS.filter((id) => !ids.has(id))).toEqual([]);
    expect(ADDITIVE_IDS.length).toBeGreaterThanOrEqual(8);
  });
});

/**
 * Ungated, because a `preserving` entry that changes behaviour is a false negative in the property
 * the whole file exists to argue, and the shape is cheaper to state on a two-line fixture than to
 * wait for a route to grow it.
 */
describe("a preserving mutation preserves what the route does", () => {
  it("leaves a directive prologue alone when merging comma expressions", () => {
    const merge = MUTATIONS.find((m) => m.id === "merge-comma-expressions")!;
    const result = merge.apply("api.v1.a.tsx", '"use client";\nfoo();\nbar();\n');
    // The first two assertions carry the test. Without them `?? ""` let it pass when the mutation
    // did not apply at all, and it would still have passed had the mutation deleted the directive.
    expect(result).toBeDefined();
    expect(result?.source).toContain('"use client";');
    expect(result?.source).not.toContain('"use client",');
    expect(result?.source).toContain("foo(), bar()");
  });
});

const describeCorpus = ENABLED && existsSync(ROUTES) ? describe : describe.skip;

/**
 * Each entry rescans the whole tree, so the suite's default per-test timeout is far too short. Set
 * here rather than left to a `--testTimeout` flag: the flag only helps someone who already knows to
 * pass it, and without it the corpus fails as a timeout, which reads as a broken harness rather
 * than a slow one.
 */
const ENTRY_TIMEOUT_MS = 120_000;

describeCorpus("mutation corpus over the real route tree", { timeout: ENTRY_TIMEOUT_MS }, () => {
  let files: SourceFile[] = [];
  let baseline: Measurement | null = null;

  // In a hook rather than the suite body, which Vitest runs during collection where no test timeout
  // applies and a throw has no test name to attach to. The baseline is the single most expensive
  // step in the file, so it is the one that must be inside something that can be timed out and
  // reported. `beforeAll` takes its own timeout.
  beforeAll(() => {
    files = readTree(ROUTES);
    baseline = measure(files);
  }, ENTRY_TIMEOUT_MS);

  /**
   * The corpus's own population, against the scanner's.
   *
   * The whole-body entries wrap what `entryBodies` finds, and that helper read two of the four
   * export forms `scan.ts` reads. It missed `export const { action, loader } = builder(...)`,
   * `const { action } = builder(...); export { action };` and `export const action = route.action`,
   * which is 36 of the tree's entry points: the corpus was testing less than its entry count
   * implied, and no assertion could notice, because a mutation that reaches fewer routes lowers the
   * score rather than raising it. Same failure mode as the `suppress-every-check` omission above,
   * so the answer is the same: assert the population rather than wait for a verdict to move.
   *
   * `admin.tsx` is the one documented exclusion. Its handler is a concise arrow
   * (`async ({ user }) => typedjson({ user })`) with no block for a block wrapper to wrap, which is
   * a limit of the rewrite rather than a gap in the enumeration. It is named rather than counted so
   * a second one cannot appear silently.
   */
  const CONCISE_ARROW_BODIES = new Set(["admin.tsx"]);

  it("wraps a body in every non-delegating entry point the scanner finds", () => {
    const wrap = MUTATIONS.find((m) => m.id === "wrap-body-in-rethrow")!;
    const root = materialize(files);
    let entryPoints;
    try {
      ({ entryPoints } = scanDirectory(root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    const byName = new Map(files.map((f) => [f.relativeName, f.source]));
    const untouched = entryPoints
      .filter((ep) => !ep.delegating && !CONCISE_ARROW_BODIES.has(ep.fileName))
      .filter((ep) => wrap.apply(ep.fileName, byName.get(ep.fileName)!) === null)
      .map((ep) => ep.fileName);

    expect(untouched).toEqual([]);
  });

  it("has a baseline worth mutating", () => {
    expect(baseline).not.toBeNull();
    expect(baseline!.entryPoints).toBeGreaterThan(300);
    // The falls assertions compare over the routes measured in both runs and pin that population
    // to `baseline.measured`, so the baseline itself has to be big enough that a broken scan
    // cannot produce a tiny population the mirror trivially holds over.
    expect(baseline!.measured).toBeGreaterThan(300);
    expect(baseline!.global).not.toBeNull();
    console.log(
      `[corpus] baseline global=${baseline!.global} mean=${baseline!.exactMean.toFixed(3)} ` +
        `measured=${baseline!.measured} eps=${baseline!.entryPoints} files=${files.length}`
    );
  });

  /**
   * How much a mutation must reach before its result means anything. A mutation that silently
   * matched nothing would otherwise "pass" by leaving the tree alone, which is the exact failure
   * mode that let earlier rounds believe a shape was defended.
   *
   * Sites, not only files, and sites are what the threshold is really on. A file count says a
   * rewrite touched a file, not that it reached anything inside it: eleven entries reported 172
   * files while landing in a position that mattered for 26 of the tree's 260 catch clauses, because
   * the splice went after statements that had already returned. `prependToEveryCatch` now splices
   * at the head of the clause, so all 260 count, and this threshold is what would notice if a later
   * change quietly took that back.
   *
   * The guard the design asked for, verdict movement, cannot be used, though not for the reason an
   * earlier version of this comment gave. Plenty of defended entries move verdicts hard:
   * `delete-every-catch` takes the tree from 19 to 8 and `dead-throw-after-switch` to 10. The
   * narrower true reason is that the IDEAL defended shape is one the scanner is blind to, and those
   * move nothing at all: `dead-if-false` and the ten entries beside it are defended precisely
   * because the tree comes out identical. Requiring movement would fail exactly the entries that
   * work best. Site count is the reachable version of the same intent.
   */
  const MINIMUM_FILES_TOUCHED = 20;
  const MINIMUM_SITES_TOUCHED = 40;

  for (const mutation of MUTATIONS) {
    const run = KNOWN_GAPS.has(mutation.id) ? it.fails : it;

    run(`${mutation.kind}: ${mutation.what} (${mutation.id})`, () => {
      const { files: mutated, changed, sites } = mutate(files, mutation);
      expect(changed).toBeGreaterThanOrEqual(MINIMUM_FILES_TOUCHED);
      expect(sites).toBeGreaterThanOrEqual(MINIMUM_SITES_TOUCHED);

      const after = measure(mutated);

      // A mutation that stops the tree parsing, or that hides a route from the scanner, has not
      // tested the property: whatever the score does afterwards is measuring a different tree. The
      // route guard is exact rather than tolerant, because a route the mutated scan cannot see is
      // one `risesIn` and `commonMean` both skip, and a rewrite that makes a route unscannable is
      // itself a finding.
      expect(after.parseFailures).toBe(baseline!.parseFailures);
      expect(after.entryPoints).toBe(baseline!.entryPoints);
      expect([...baseline!.perEntry.keys()].filter((f) => !after.perEntry.has(f))).toEqual([]);

      const rises = risesIn(baseline!, after);
      const { falls, compared } = fallsIn(baseline!, after);
      const common = commonMean(baseline!, after);
      console.log(
        `[corpus] ${mutation.id}: global ${baseline!.global} -> ${after.global} ` +
          `(mean ${baseline!.exactMean.toFixed(3)} -> ${after.exactMean.toFixed(3)}, ` +
          `common mean ${common.before.toFixed(3)} -> ${common.after.toFixed(3)}, ` +
          `measured ${baseline!.measured} -> ${after.measured}, files ${changed}, sites ${sites}, ` +
          `routes raised ${rises.length}, routes lowered ${falls.length})` +
          rises
            .slice(0, 3)
            .map(
              (r) =>
                `\n    ${r.fileName} ${r.from}->${r.to}\n      was: ${r.before}\n      now: ${r.after}`
            )
            .join("") +
          falls
            .slice(0, 3)
            .map(
              (f) =>
                `\n    ${f.fileName} ${f.from}->${f.to}\n      was: ${f.before}\n      now: ${f.after}`
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

        // The mirror direction. A preserving edit must not make any route look WORSE either: a
        // fall here is a false accusation, the direction that gets the tool switched off, and it
        // went unasserted for three rounds while 19 entries regressed 104 routes. Together with
        // the rises assertion and the entry-point guards above, this pins per-route score
        // EQUALITY for a preserving entry. The comparison population is pinned to the whole
        // measured baseline first, so a silently shrunken population cannot pass vacuously.
        expect(compared).toBe(baseline!.measured);
        if (mutation.lowers === undefined) {
          expect(falls.map((f) => `${f.fileName} ${f.from}->${f.to}`)).toEqual([]);
        } else {
          // An exempted entry must still be falling, or the exemption is stale and has to be
          // removed deliberately rather than sitting as cover for the next defect.
          expect(falls.length).toBeGreaterThan(0);
          // And the falls must have exactly the measured residual shape the exemption was
          // granted for: `error-classification` moving pass -> not-applicable, every other
          // check's status unchanged, nothing anywhere moving to fail. Anything else is a new
          // defect hiding under the exemption.
          for (const fall of falls) {
            const before = checkStatuses(fall.before);
            const now = checkStatuses(fall.after);
            expect([...now.keys()].sort()).toEqual([...before.keys()].sort());
            for (const [id, was] of before) {
              const is = now.get(id);
              if (is === was) continue;
              expect(`${fall.fileName}: ${id} ${was}->${is}`).toBe(
                `${fall.fileName}: error-classification pass->not-applicable`
              );
            }
          }
        }
      }
    });
  }
});

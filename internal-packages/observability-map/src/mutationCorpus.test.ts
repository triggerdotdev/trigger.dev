import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { routeModuleFiles, scanDirectory } from "./scan.js";
import { buildReport } from "./score.js";
import { ADDITIVE_IDS, MUTATIONS, type Mutation } from "./mutations.js";
import { CHECKS } from "./checks/index.js";

/**
 * The tree-scale mutation corpus. Every laundering shape anyone has found is an entry, each rewrites
 * the whole real route tree in a temp copy, and each is held to four assertions: the published global
 * does not rise, the mean over the routes measured in both runs does not rise, no individual route
 * rises or drops out of the measured set, and the mirror of that, no individual route falls.
 *
 * Tree scale rather than per fixture, because that is where laundering pays. The honest statement this
 * file supports is "these N mutations are defended, and here they are", never "unpaddable". Roughly
 * six seconds an entry, which is why the file is gated behind `OBS_MAP_MUTATION_CORPUS=1`.
 */

const ROUTES = resolve(__dirname, "../../../apps/webapp/app/routes");
const ENABLED = process.env.OBS_MAP_MUTATION_CORPUS === "1";

/**
 * Where a corpus entry goes when the tool does not defend it. `it.fails` keeps the entry running, so
 * closing the hole later turns this file red until the entry is moved back out deliberately. Both
 * gaps are described at length in INTERNALS.md, "The mutation harness".
 */
const KNOWN_GAPS = new Set<string>([
  // `canRaise` accepts any call at all, so `try { String(0); }` reads as a clause guarding real work
  // and takes the tree from 19 to 44, exactly as `try { 0; }` did before it was refused. Telling an
  // inert call from one that can throw needs types the scanner does not have.
  "dead-classifying-try-with-call",
  // `selectsADistinctPath` folds a dead ARM but not a dead CONDITION, and `literalTruth` treats `&&`
  // as always null on purpose so a live guard can never be read as dead. Widening that fold is a
  // different rule and needs its own measurement.
  "dead-conjunction-instanceof-if",
]);

type SourceFile = { relativeName: string; source: string };

/**
 * Route modules exactly as `scanDirectory` enumerates them, because it is the same enumeration and no
 * longer a copy of it: a harness reading a different tree reports files and sites the scan never saw,
 * and those counts are what the thresholds below rest on. Read once; every mutation rewrites this list
 * rather than the tree on disk.
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
  /** The unrounded mean `global` rounds. A rise of less than half a point is invisible in `global`
   * and is still a rise. */
  exactMean: number;
  measured: number;
  entryPoints: number;
  parseFailures: number;
  /** Per route file, so a mutation that raises one route while lowering the tree is still caught.
   * `[0].map(...)` is that shape, and the two movements cancel in the global. */
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
 * Route files the mutation made look better, worst first. Two ways to qualify: the score went up, or a
 * measured route stopped being measured, which is the most complete form of the thing the property
 * forbids. A route removed from the report entirely is the entry-point guard's business instead.
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
 * The mirror of `risesIn`: route files the mutation made look WORSE. A preserving edit lowering a
 * score is a false accusation, and for three rounds it was structurally invisible here, with 19 of 43
 * preserving entries regressing 104 routes when it was first measured.
 *
 * Only routes measured in BOTH runs are compared: one ENTERING the measured set would register a
 * 100 to 50 fall that is nothing of the kind, and one LEAVING it is already `risesIn`'s business.
 * `compared` is asserted against `baseline.measured` so a silently shrunken comparison cannot pass.
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
 * population moves, which a mutation can do without making any route look better, so holding the
 * population fixed is what makes the comparison about the scores. */
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
 * Deliberately NOT gated behind `OBS_MAP_MUTATION_CORPUS`, unlike everything below it: the corpus
 * cannot catch its own omission by failing, since omitting a check from the sweep lowers the score
 * rather than raising it. Belongs in the default suite so adding a check without extending the corpus
 * turns `pnpm test` red rather than a job nobody runs locally. See INTERNALS.md, "The mutation
 * harness".
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

  // Ungated for the same reason as the sweep assertion above: it reads no route tree, so gating it
  // would only hide a stale list from the run people actually do. Every corpus entry once removed or
  // restructured real signal and none added fake signal, which is where the two largest holes lived.
  it("covers the additive direction, not only the subtractive one", () => {
    const ids = new Set(MUTATIONS.map((m) => m.id));
    expect(ADDITIVE_IDS.filter((id) => !ids.has(id))).toEqual([]);
    expect(ADDITIVE_IDS.length).toBeGreaterThanOrEqual(8);
  });
});

/**
 * Ungated, because a `preserving` entry that changes behaviour is a false negative in the property the
 * whole file exists to argue.
 */
describe("a preserving mutation preserves what the route does", () => {
  it("leaves a directive prologue alone when merging comma expressions", () => {
    const merge = MUTATIONS.find((m) => m.id === "merge-comma-expressions")!;
    const result = merge.apply("api.v1.a.tsx", '"use client";\nfoo();\nbar();\n');
    // The first two assertions carry the test: without them it passed when the mutation did not apply
    // at all, and would have passed had the mutation deleted the directive.
    expect(result).toBeDefined();
    expect(result?.source).toContain('"use client";');
    expect(result?.source).not.toContain('"use client",');
    expect(result?.source).toContain("foo(), bar()");
  });
});

const describeCorpus = ENABLED && existsSync(ROUTES) ? describe : describe.skip;

/**
 * Each entry rescans the whole tree. Set here rather than left to a `--testTimeout` flag, which only
 * helps someone who already knows to pass it, and without which the corpus fails as a timeout and
 * reads as a broken harness rather than a slow one.
 */
const ENTRY_TIMEOUT_MS = 120_000;

describeCorpus("mutation corpus over the real route tree", { timeout: ENTRY_TIMEOUT_MS }, () => {
  let files: SourceFile[] = [];
  let baseline: Measurement | null = null;

  // In a hook rather than the suite body, which Vitest runs during collection where no test timeout
  // applies and a throw has no test name to attach to. The baseline is the most expensive step here.
  beforeAll(() => {
    files = readTree(ROUTES);
    baseline = measure(files);
  }, ENTRY_TIMEOUT_MS);

  /**
   * The one documented exclusion from the population assertion below. `admin.tsx`'s handler is a
   * concise arrow with no block for a block wrapper to wrap, which is a limit of the rewrite rather
   * than a gap in the enumeration. Named rather than counted so a second one cannot appear silently.
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
    // The falls assertions pin their population to `baseline.measured`, so the baseline itself has to
    // be big enough that a broken scan cannot produce a tiny population the mirror trivially holds
    // over.
    expect(baseline!.measured).toBeGreaterThan(300);
    expect(baseline!.global).not.toBeNull();
    console.log(
      `[corpus] baseline global=${baseline!.global} mean=${baseline!.exactMean.toFixed(3)} ` +
        `measured=${baseline!.measured} eps=${baseline!.entryPoints} files=${files.length}`
    );
  });

  /**
   * How much a mutation must reach before its result means anything, since one that silently matched
   * nothing would otherwise pass by leaving the tree alone. On sites and not only files, and why
   * verdict movement cannot be the guard instead: INTERNALS.md, "The mutation harness".
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

      // A mutation that stops the tree parsing, or hides a route from the scanner, has not tested the
      // property. Exact rather than tolerant, because a route the mutated scan cannot see is one both
      // `risesIn` and `commonMean` skip.
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

      // Per route, for the preserving half. The deleting half is exempt on purpose: a route whose only
      // failing check was `error-classification` really does leave the denominator when its catch
      // goes, and the global figure above is where that trade is held to account.
      if (mutation.kind === "preserving") {
        expect(rises.map((r) => `${r.fileName} ${r.from}->${r.to}`)).toEqual([]);

        // The mirror direction, which with the rises assertion and the entry-point guards above pins
        // per-route score EQUALITY for a preserving entry. Population pinned first, so a silently
        // shrunken one cannot pass vacuously.
        expect(compared).toBe(baseline!.measured);
        if (mutation.lowers === undefined) {
          expect(falls.map((f) => `${f.fileName} ${f.from}->${f.to}`)).toEqual([]);
        } else {
          // An exempted entry must still be falling, or the exemption is stale cover for the next
          // defect.
          expect(falls.length).toBeGreaterThan(0);
          // And each fall must have exactly the residual shape the exemption was granted for.
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

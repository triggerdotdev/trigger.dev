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
import { isScannableFile, scanDirectory, scanFile } from "./scan.js";
import { buildReport } from "./score.js";
import { SCORED_CHECK_IDS } from "./checks/index.js";

/**
 * This file's deliberate coupling to `apps/webapp/app/routes`, and not the suite's only one:
 * `webappSymbols.test.ts` walks all of `apps/webapp/app` and two more trees, and
 * `mutationCorpus.test.ts` scans the route tree behind an env gate.
 *
 * The coupling is acceptable because nothing here names a route or a count: the scan must not crash,
 * the entry point count must sit inside a wide band, and parse failures must be zero. Those are the
 * only things a fixture tree cannot tell us, since a fixture only contains shapes somebody thought to
 * write down. How the whole suite is gated in CI: INTERNALS.md, "Tests, timeouts and CI".
 */
const ROUTES = resolve(__dirname, "../../../apps/webapp/app/routes");

/**
 * Every `.ts`/`.tsx` file under the tree, at any depth. Deliberately not the scanner's walk: as a copy
 * of it, `entryPoints.length < countCandidates()` was a tautology that could not fail for any route
 * shape both of them missed.
 */
function countRouteModuleFiles(dir: string): number {
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      count += countRouteModuleFiles(join(dir, entry.name));
      continue;
    }
    if (entry.isFile() && isScannableFile(entry.name)) count++;
  }
  return count;
}

beforeAll(() => {
  // A hard failure rather than a silent skip: if this package moves relative to apps/webapp, the
  // real-tree coverage must disappear loudly.
  if (!existsSync(ROUTES)) {
    throw new Error(`the webapp routes directory is missing: ${ROUTES}`);
  }
});

// The build emits ESM while `main` and `types` advertised it to a package.json with no module type,
// which on node 24 loads with a MODULE_TYPELESS_PACKAGE_JSON warning and a reparse.
describe("the package it advertises", () => {
  const manifest = JSON.parse(
    readFileSync(resolve(__dirname, "../package.json"), "utf8")
  ) as Record<string, string>;

  // Asserted flat rather than behind a skip, so dropping the entry point later has to edit this
  // rather than slip past it.
  it("declares the module type its build emits alongside the entry point it advertises", () => {
    expect(manifest.main).toBe("./dist/src/index.js");
    expect(manifest.types).toBe("./dist/src/index.d.ts");
    expect(manifest.type).toBe("module");
  });
});

const CHONK_WORKFLOWS = resolve(__dirname, "../../../../.github/workflows");
const MONO_WORKFLOWS = resolve(__dirname, "../../../.github/workflows");
const USE_CHONK = existsSync(resolve(CHONK_WORKFLOWS, "pr_checks.yml"));
const WORKFLOWS = USE_CHONK ? CHONK_WORKFLOWS : MONO_WORKFLOWS;
const PATH_PREFIX = USE_CHONK ? "trigger.dev/" : "";
const REPORT = resolve(WORKFLOWS, "observability-map.yml");
const REPORT_PRESENT = existsSync(REPORT);

function read(path: string): string {
  if (!existsSync(path)) throw new Error(`workflow is missing: ${path}`);
  return readFileSync(path, "utf8");
}

/** Comment lines dropped, so an assertion is about what the YAML says rather than what its prose
 * mentions. */
const withoutComments = (text: string) => text.replace(/^\s*#.*$/gm, "");

/** One job's block, from its key to the next key at job indent. */
function job(name: string): string {
  const parts = read(REPORT).split(new RegExp(`^ {2}${name}:$`, "m"));
  expect(parts).toHaveLength(2);
  return parts[1]!.split(/^ {2}[a-z][a-z-]*:$/m)[0]!;
}

/** A job's condition and everything else it declares before its steps. */
const gate = (name: string) => job(name).split("    steps:")[0]!;

/** Step bodies, split on the `- name:` lines, which is all the structure this needs. */
const steps = (block: string) => block.split(/^ {6}- name: /m).slice(1);

/**
 * The one thing the docstring checker cannot reach, since it walks `src/` only. What the C1 defect was
 * and what replaced it: INTERNALS.md, "Tests, timeouts and CI". These are text checks over the
 * workflow
 * rather than a parse of its semantics, so they catch the wiring coming apart and nothing about
 * whether GitHub agrees.
 */
describe.skipIf(!REPORT_PRESENT)("the report workflow's one source of the comment id", () => {
  it("does not start the report job at all unless the lookup finished cleanly", () => {
    expect(gate("report")).toContain("needs.changes.outputs.lookup == 'ok'");
  });

  it("gives the render and the upsert step the same output to read", () => {
    const readers = steps(job("report")).filter((step) => step.includes("EXISTING_COMMENT"));
    expect(readers.length).toBeGreaterThanOrEqual(2);
    expect(
      readers.filter(
        (step) => !step.includes("EXISTING_COMMENT: ${{ needs.changes.outputs.comment }}")
      )
    ).toEqual([]);
  });

  // The lookup is what lets the report job be gated, so it happens in the cheap job an unrelated pull
  // request pays for anyway.
  it("looks the comment up in the cheap job and not again in the report job", () => {
    expect(job("changes")).toContain("issues/${PR_NUMBER}/comments");
    expect(job("changes")).toContain("pull-requests: read");
    expect(job("report")).not.toContain("--paginate");
  });

  it("takes one id from a lookup that paginates rather than passing every line on", () => {
    const lookup = steps(job("changes")).find((step) =>
      step.includes('startswith("<!-- observability-map')
    )!;
    expect(lookup).toBeDefined();
    expect(lookup).toContain("exit }'");
  });

  it("only reconciles a comment github-actions[bot] posted, not anyone quoting the marker", () => {
    const lookup = steps(job("changes")).find((step) =>
      step.includes('startswith("<!-- observability-map')
    )!;
    expect(lookup).toContain('.user.login == "github-actions[bot]"');
  });
});

/**
 * The workflow runs on every pull request with the gating internal, because GitHub evaluates one
 * `paths:` filter per workflow and a pull request whose diff stopped matching never started it at all,
 * leaving an earlier push's comment standing for ever. See README, "CI". What that has to preserve is
 * the cost, which is what these assert.
 */
describe.skipIf(!REPORT_PRESENT)(
  "the report workflow reconciles a comment the paths no longer reach",
  () => {
    it("runs on every pull request rather than only on the paths it watches", () => {
      const trigger = withoutComments(
        read(REPORT).split("\non:\n")[1]!.split("\nconcurrency:")[0]!
      );
      expect(trigger).toContain("pull_request:");
      expect(trigger).not.toContain("paths:");
    });

    it("starts the report job when the paths moved or when a comment already exists", () => {
      expect(gate("report")).toContain("needs.changes.outputs.report == 'true'");
      expect(gate("report")).toContain("needs.changes.outputs.comment != ''");
    });

    it("scans nothing on the run that only has a comment to reconcile", () => {
      const scans = steps(job("report")).filter((step) => step.startsWith("🔎 Scan"));
      expect(scans).toHaveLength(2);
      for (const scan of scans) {
        expect(scan.split("run:")[0]).toContain("if: needs.changes.outputs.report == 'true'");
      }
    });

    it("renders the resolved state on that run instead of a report it did not produce", () => {
      const render = steps(job("report")).find((step) => step.startsWith("📝 Render comment"))!;
      expect(render).toContain("SCANNED: ${{ needs.changes.outputs.report }}");
      expect(render).toMatch(/SCANNED" != "true" \]; then\s+emit --resolved/);
    });

    // The renderer takes the sha and the URL as data; building the URL is the workflow's job, because
    // the workflow is what has the two shas.
    it("forwards the head sha and a compare URL for the pull request's range", () => {
      const render = steps(job("report")).find((step) => step.startsWith("📝 Render comment"))!;
      expect(render).toContain("HEAD_SHA: ${{ github.event.pull_request.head.sha }}");
      expect(render).toContain(
        "/compare/${{ github.event.pull_request.base.sha }}...${{ github.event.pull_request.head.sha }}"
      );
      expect(render).toContain('--commit-sha="$HEAD_SHA"');
      expect(render).toContain('--commit-url="$COMPARE_URL"');
    });
  }
);

/**
 * Asserts the shape that cannot have the stdout-capture bug rather than the pnpm version that happens
 * not to. Why: INTERNALS.md, "Tests, timeouts and CI".
 */
describe.skipIf(!REPORT_PRESENT)("the report workflow's scan and render steps", () => {
  it("let the renderer write its own comment rather than capturing stdout", () => {
    const render = steps(read(REPORT)).find((step) => step.startsWith("📝 Render"))!;
    expect(render).toBeDefined();
    expect(render).toMatch(/--out=\S+\.md\S*/);
    // The marker has to be the comment's first line for the lookup to find it, so a redirect that
    // could put a package-manager banner ahead of the document costs the upsert, not just tidiness.
    expect(render).not.toMatch(/render[^\n]*>\s*\S*\.md/);
  });

  it("let the scanner write its own report rather than capturing stdout", () => {
    const scans = steps(read(REPORT)).filter((step) => step.startsWith("🔎 Scan"));
    expect(scans).toHaveLength(2);

    for (const step of scans) {
      // The `if ...; then` condition only, which is where the scanner runs. The else branch writes
      // `echo "-" > /tmp/base.json`, a redirect of the workflow's own making that has nothing to
      // do with capturing the scanner, and an earlier version of this test failed on it.
      const command = step.split("; then")[0]!;
      expect(command).toMatch(/--out=\S+\.json/);
      expect(command).not.toMatch(/>\s*\S*\.json/);
    }
  });
});

/**
 * The gating half of the same problem: a test job that nothing waits for is decoration. Text checks
 * again, over two workflow files.
 */
describe("the package's tests are wired into the gate", () => {
  const PR_CHECKS = resolve(WORKFLOWS, "pr_checks.yml");
  const REUSABLE = resolve(WORKFLOWS, "unit-tests-observability-map.yml");

  it("calls the reusable workflow from pr_checks behind a filter of its own", () => {
    const text = read(PR_CHECKS);
    expect(text).toContain("uses: ./.github/workflows/unit-tests-observability-map.yml");
    expect(text).toContain("if: needs.changes.outputs.obsmap == 'true'");
    expect(read(REUSABLE)).toContain("workflow_call");
  });

  // Asserted as the whole set the suite reads and no other filter covers, rather than as the one path
  // that prompted the filter, because the routes entry looked complete right up until it wasn't.
  it("watches every webapp path the internal filter misses, not just the routes folder", () => {
    const filter = read(PR_CHECKS).split("            obsmap:")[1]!.split("            cli:")[0]!;
    // webappSymbols.test.ts walks all of apps/webapp/app, not just routes.
    expect(filter).toContain(`'${PATH_PREFIX}apps/webapp/app/**'`);
    // The report workflow, whose text the two describes above assert on. No other filter names it.
    expect(filter).toContain("'.github/workflows/observability-map.yml'");
  });

  // The other two trees `webappSymbols.test.ts` reads belong to `internal`, so this pins the reason
  // and the obvious-looking addition has to argue with a test first.
  it("leaves the two non-webapp roots it reads to the internal filter", () => {
    const text = read(PR_CHECKS);
    const obsmap = text.split("            obsmap:")[1]!.split("            cli:")[0]!;
    expect(obsmap).not.toContain("packages/plugins");
    expect(obsmap).not.toContain("internal-packages/rbac");

    const internal = text.split("            internal:")[1]!.split("            obsmap:")[0]!;
    expect(internal).toContain(`'${PATH_PREFIX}packages/**'`);
    expect(internal).toContain(`'${PATH_PREFIX}internal-packages/**'`);
  });

  // Naming this package here as well ran the suite twice on every pull request touching it. Asserted
  // rather than left to the next reader, because the duplicate looks like the right entry to add back.
  it("leaves the package's own paths to the internal filter, so the suite runs once", () => {
    const text = read(PR_CHECKS);
    const obsmap = text.split("            obsmap:")[1]!.split("            cli:")[0]!;
    expect(obsmap).not.toContain(`'${PATH_PREFIX}internal-packages/observability-map/**'`);

    const internal = text.split("            internal:")[1]!.split("            obsmap:")[0]!;
    expect(internal).toContain(`'${PATH_PREFIX}internal-packages/**'`);
    expect(internal).not.toContain(`!${PATH_PREFIX}internal-packages/observability-map`);
    expect(read(resolve(WORKFLOWS, "unit-tests-internal.yml"))).toContain('--filter "@internal/*"');
  });

  // The test above only checks the package's own source path, a different overlap that was already
  // fixed. It has no way to catch a shared *generic* path (package.json, a lockfile, this workflow
  // file itself) added to both filters, which is its own way to run the suite twice. Asserted as the
  // actual set intersection, not another hardcoded path, so any future shared path fails this too.
  it("shares no path with the internal filter, so the suite runs once", () => {
    const text = read(PR_CHECKS);
    // Comment lines are dropped before matching: an apostrophe in prose ("this filter's own doing")
    // otherwise pairs with a real path's quote and swallows it, which would be a silent false pass.
    const pathsOf = (name: string, next: string) =>
      new Set(
        [
          ...text
            .split(`            ${name}:`)[1]!
            .split(`            ${next}:`)[0]!
            .split("\n")
            .filter((line) => !line.trim().startsWith("#"))
            .join("\n")
            .matchAll(/'([^']+)'/g),
        ].map((m) => m[1])
      );
    const internal = pathsOf("internal", "obsmap");
    const obsmap = pathsOf("obsmap", "cli");
    const shared = [...obsmap].filter((p) => internal.has(p));
    expect(shared).toEqual([]);
  });

  it("is in the all-checks needs list, or it gates nothing", () => {
    const needs = read(PR_CHECKS).split("    needs:").pop()!.split("    if: always()")[0]!;
    expect(needs).toContain("- obsmap");
  });

  it.skipIf(!REPORT_PRESENT)("does not also run the same suite in the report workflow", () => {
    expect(read(REPORT)).not.toContain("run test");
  });

  // The nightly is the other half of the trade and is asserted with it: dropping the schedule would
  // leave tree drift uncovered rather than covered late.
  it.skipIf(!REPORT_PRESENT)(
    "runs the corpus on the package's own paths and on a schedule, not on every route PR",
    () => {
      const text = read(REPORT);
      const corpus = text.split("  mutation-corpus:")[1]!.split("    steps:")[0]!;
      expect(corpus).toContain("needs.changes.outputs.package == 'true'");

      // The corpus filter alone, a separate entry from the report's own gate beside it, and this one
      // has to stay off the route tree.
      const filter = text.split("            package:")[1]!.split("            routes:")[0]!;
      expect(filter).toContain(`'${PATH_PREFIX}internal-packages/observability-map/**'`);
      expect(filter).not.toContain("apps/webapp/app/routes");

      expect(text).toContain("schedule:");
      expect(text).toContain("cron:");
    }
  );

  // Two reviewers read the README's old "merge base" wording against the workflow's base.sha and
  // reported the workflow; the wording was the bug. Pinned so it cannot drift back without the
  // workflow moving with it.
  it.skipIf(!REPORT_PRESENT)(
    "describes the base the report workflow actually scans against",
    () => {
      expect(read(REPORT)).toContain("github.event.pull_request.base.sha");
      const readme = readFileSync(resolve(__dirname, "../README.md"), "utf8");
      const ci = readme.split("## CI")[1]!.split("\n## ")[0]!;
      expect(ci).toContain("against the tip of the base branch");
      expect(ci).not.toMatch(/scanning head\s+against the PR's merge base/);
    }
  );
});

/**
 * The third road into this suite, `turbo run test`. Asserts the task is uncacheable, because the
 * config is one line and reads like a performance oversight to anyone who does not know what the suite
 * reads. Measurement and the rejected `inputs` alternative: INTERNALS.md, "Tests, timeouts and CI".
 */
describe("the third road in, turbo", () => {
  it("keeps its test task out of the turbo cache", () => {
    const config = readFileSync(resolve(__dirname, "../turbo.json"), "utf8");
    // Comments are legal in turbo.json and this one carries the reasoning, so strip them to parse.
    const pipeline = JSON.parse(config.replace(/^\s*\/\/.*$/gm, "")) as {
      pipeline?: { test?: { cache?: boolean } };
    };
    expect(pipeline.pipeline?.test?.cache).toBe(false);
  });
});

describe("counting candidates independently of the scanner", () => {
  // The counter is only worth having if it disagrees with the scanner somewhere, and it does.
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

/**
 * Timeout for the two real-tree tests, which do not fit the suite's 10s default. A hang detector and
 * nothing else: neither test asserts anything about how long a scan takes, so a number tight enough to
 * be a performance budget would only be a way to fail on a busy runner. The contention measurements
 * behind 120s, and why 60s is not enough: INTERNALS.md, "Tests, timeouts and CI".
 */
const TREE_SCAN_TIMEOUT = 120_000;

describe("scanning the real webapp routes", () => {
  it(
    "parses every route file and produces a report inside a wide band",
    () => {
      const { entryPoints, parseFailures } = scanDirectory(ROUTES);

      expect(parseFailures).toEqual([]);
      expect(entryPoints.length).toBeGreaterThan(100);
      expect(entryPoints.length).toBeLessThan(countRouteModuleFiles(ROUTES));

      const report = buildReport(entryPoints, parseFailures);
      expect(report.global).toBeGreaterThanOrEqual(0);
      expect(report.global).toBeLessThanOrEqual(100);
      expect(Object.keys(report.byFamily).length).toBeGreaterThan(1);
    },
    TREE_SCAN_TIMEOUT
  );

  /** The per-export split against the union it came from, on every real route. `scan.test.ts` pins the
   * same property on fixtures; this is the version that sees the shapes nobody wrote down. */
  it(
    "every callee name is attributed to an export that exists",
    () => {
      const { entryPoints } = scanDirectory(ROUTES);
      const orphaned: string[] = [];
      const unattributed: string[] = [];

      for (const ep of entryPoints) {
        const attributed = new Set([...ep.loaderCalleeNames, ...ep.actionCalleeNames]);
        for (const name of new Set(ep.calleeNames)) {
          if (!attributed.has(name)) unattributed.push(`${ep.fileName}: ${name}`);
        }
        const union = new Set(ep.calleeNames);
        for (const name of attributed) {
          if (!union.has(name)) orphaned.push(`${ep.fileName}: ${name}`);
        }
        if (!ep.hasLoader) expect(ep.loaderCalleeNames).toEqual([]);
        if (!ep.hasAction) expect(ep.actionCalleeNames).toEqual([]);
      }

      expect(unattributed).toEqual([]);
      expect(orphaned).toEqual([]);
    },
    TREE_SCAN_TIMEOUT
  );

  // Every scored check suppressed on every real route. The old measured-from-visible logic took the
  // global from 17 to 33 and measured from 412 to 176, so `measured` must not move either.
  it(
    "suppressing every scored check on every real route does not raise the global",
    () => {
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
    },
    TREE_SCAN_TIMEOUT
  );
});

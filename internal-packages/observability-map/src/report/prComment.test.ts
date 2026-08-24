import {
  hasDelta,
  renderPrComment,
  renderResolvedComment,
  renderScanFailedComment,
} from "./prComment.js";
import { renderTerminal } from "./terminal.js";
import { buildReport } from "../score.js";
import { scanFile } from "../scan.js";

const cleanSource = `
  import { requireUserId } from "~/services/session.server";
  import { logger } from "~/services/logger.server";
  import { prisma } from "~/db.server";
  export async function action({ request }) {
    const userId = await requireUserId(request);
    try { return await prisma.token.create({ data: { userId } }); }
    catch (error) { logger.error("token create failed", { userId, error }); throw error; }
  }`;

const brokenSource = `
  import { prisma } from "~/db.server";
  export async function action() {
    try { return await prisma.token.create({ data: {} }); } catch (e) { return null; }
  }`;

describe("renderPrComment", () => {
  it("puts the upsert marker on the first line, always", () => {
    const head = buildReport([scanFile("api.v1.a.ts", brokenSource)!], []);
    expect(renderPrComment(head, null).split("\n")[0]).toBe("<!-- observability-map-report -->");
    expect(renderPrComment(head, head).split("\n")[0]).toBe("<!-- observability-map-report -->");
  });

  it("says the comparison is unavailable when base is null", () => {
    const head = buildReport([scanFile("api.v1.a.ts", brokenSource)!], []);
    const out = renderPrComment(head, null);
    expect(out).toContain("Base comparison unavailable.");
    expect(out).not.toContain("no change");
  });

  it("reports a score drop and the newly failing checks", () => {
    const head = buildReport([scanFile("api.v1.auth.tokens.ts", brokenSource)!], []);
    const base = buildReport([scanFile("api.v1.auth.tokens.ts", cleanSource)!], []);
    const out = renderPrComment(head, base);

    expect(out).toMatch(/\(base \d+, down \d+\)/);
    expect(out).toContain("| /api/v1/auth/tokens |");
    // request-context and error-classification regress; auth-boundary is not applicable here
    // (no sensitivity signal on this route), so it must not show up as newly failing.
    expect(out).toMatch(/\| \/api\/v1\/auth\/tokens \| \d+ \| \d+ \|[^|]*error-classification/);
  });

  it("reports a score improvement the other way round", () => {
    const head = buildReport([scanFile("api.v1.auth.tokens.ts", cleanSource)!], []);
    const base = buildReport([scanFile("api.v1.auth.tokens.ts", brokenSource)!], []);
    const out = renderPrComment(head, base);
    expect(out).toMatch(/\(base \d+, up \d+\)/);
  });

  it("says nothing changed when every score matches", () => {
    const head = buildReport([scanFile("api.v1.auth.tokens.ts", cleanSource)!], []);
    const base = buildReport([scanFile("api.v1.auth.tokens.ts", cleanSource)!], []);
    const out = renderPrComment(head, base);
    expect(out).toContain("No entry point this PR touches changed its score.");
    expect(out).toContain("(base 100, no change)");
  });

  it("shows a new entry with its base column as 'new' and lists its failing checks", () => {
    const head = buildReport(
      [scanFile("api.v1.auth.tokens.ts", cleanSource)!, scanFile("api.v1.new.ts", brokenSource)!],
      []
    );
    const base = buildReport([scanFile("api.v1.auth.tokens.ts", cleanSource)!], []);
    const out = renderPrComment(head, base);

    expect(out).toMatch(/\| \/api\/v1\/new \| new \| \d+ \|/);
  });

  // Mirrors the guard report.test.ts has for the terminal renderer: audit-trail fails almost
  // every sensitive mutation today (no audit helper exists), so it is a headline figure, not a
  // per-route nag. A regression here previously let it leak into the "now failing" column.
  it("does not list audit-trail among a new sensitive entry's failing checks", () => {
    const sensitiveMutation = scanFile(
      "api.v1.envvars.ts",
      `import { prisma } from "~/db.server";
       export async function action() {
         try {
           return await prisma.envVar.update({ where: {}, data: {} });
         } catch (e) {
           return null;
         }
       }`
    )!;
    const head = buildReport([sensitiveMutation], []);
    const base = buildReport([], []);
    const out = renderPrComment(head, base);

    const row = out.split("\n").find((l) => l.startsWith("| /api/v1/envvars |"))!;
    expect(row).toBeDefined();
    expect(row).toContain("new");
    expect(row).not.toContain("audit-trail");
    expect(row).toMatch(/error-classification|auth-boundary|request-context/);
  });

  it("skips a new entry that passes every check it was measured against", () => {
    const head = buildReport(
      [scanFile("api.v1.auth.tokens.ts", cleanSource)!, scanFile("api.v1.new.ts", cleanSource)!],
      []
    );
    const base = buildReport([scanFile("api.v1.auth.tokens.ts", cleanSource)!], []);
    const out = renderPrComment(head, base);

    expect(out).not.toContain("/api/v1/new");
    expect(out).toContain("No entry point this PR touches changed its score.");
  });

  // B3. `score` is 100 for an entry no scored check applied to, and the table read that placeholder
  // as a figure: a route refactored down to a trivial body rendered as a 67-point improvement.
  describe("an unmeasured entry", () => {
    const trivial = `export const loader = () => new Response("ok");`;

    it("renders as not measured rather than as 100 when the head stopped being measurable", () => {
      const head = buildReport([scanFile("api.v1.auth.tokens.ts", trivial)!], []);
      const base = buildReport([scanFile("api.v1.auth.tokens.ts", brokenSource)!], []);
      const out = renderPrComment(head, base);

      const row = out.split("\n").find((l) => l.startsWith("| /api/v1/auth/tokens |"))!;
      expect(row).toBeDefined();
      expect(row).toContain("not measured");
      expect(row).not.toMatch(/\|\s*100\s*\|/);
    });

    it("names the base score when it is the head that has none, not the base", () => {
      const head = buildReport([scanFile("api.v1.auth.tokens.ts", trivial)!], []);
      const base = buildReport([scanFile("api.v1.auth.tokens.ts", brokenSource)!], []);
      expect(head.global).toBeNull();
      expect(base.global).not.toBeNull();

      const out = renderPrComment(head, base);
      expect(out).toContain(`(base ${base.global})`);
      expect(out).not.toContain("(base not measured)");
    });

    it("still says the base is the missing one when it really is", () => {
      const head = buildReport([scanFile("api.v1.auth.tokens.ts", brokenSource)!], []);
      const base = buildReport([scanFile("api.v1.auth.tokens.ts", trivial)!], []);
      expect(base.global).toBeNull();

      expect(renderPrComment(head, base)).toContain("(base not measured)");
    });

    it("renders as not measured in the base column when the head gained real work", () => {
      const head = buildReport([scanFile("api.v1.auth.tokens.ts", brokenSource)!], []);
      const base = buildReport([scanFile("api.v1.auth.tokens.ts", trivial)!], []);
      const out = renderPrComment(head, base);

      const row = out.split("\n").find((l) => l.startsWith("| /api/v1/auth/tokens |"))!;
      expect(row).toBeDefined();
      expect(row).toMatch(/\| not measured \| \d+ \|/);
    });

    // The early-out compared scores only, so a measured 100 turning into an unmeasured placeholder
    // 100 produced no row at all: the table said nothing happened.
    it("still produces a row when a measured 100 becomes an unmeasured placeholder 100", () => {
      const head = buildReport([scanFile("api.v1.auth.tokens.ts", trivial)!], []);
      const base = buildReport([scanFile("api.v1.auth.tokens.ts", cleanSource)!], []);
      expect(base.entries[0]!.score).toBe(100);
      expect(head.entries[0]!.score).toBe(100);

      const out = renderPrComment(head, base);
      const row = out.split("\n").find((l) => l.startsWith("| /api/v1/auth/tokens |"))!;
      expect(row).toBeDefined();
      expect(row).toMatch(/\| 100 \| not measured \|/);
    });

    // Not the same statement as a new entry that passes everything, which is skipped above.
    it("still gets a row when it is new, since its 100 is a placeholder and not a pass", () => {
      const head = buildReport(
        [
          scanFile("api.v1.auth.tokens.ts", cleanSource)!,
          scanFile("resources.health.ts", trivial)!,
        ],
        []
      );
      const base = buildReport([scanFile("api.v1.auth.tokens.ts", cleanSource)!], []);
      const out = renderPrComment(head, base);

      const row = out.split("\n").find((l) => l.startsWith("| /resources/health |"))!;
      expect(row).toBeDefined();
      expect(row).toMatch(/\| new \| not measured \|/);
    });

    it("does not sort an unmeasured transition above a real regression", () => {
      const head = buildReport(
        [scanFile("resources.gone.ts", trivial)!, scanFile("resources.busy.ts", brokenSource)!],
        []
      );
      const base = buildReport(
        [scanFile("resources.gone.ts", brokenSource)!, scanFile("resources.busy.ts", cleanSource)!],
        []
      );
      const out = renderPrComment(head, base);

      const busy = out.indexOf("/resources/busy");
      const gone = out.indexOf("/resources/gone");
      expect(busy).toBeGreaterThan(-1);
      expect(gone).toBeGreaterThan(-1);
      expect(busy).toBeLessThan(gone);
    });
  });

  // I4. A suppression added to a check that was PASSING drops the score by round A's cap and
  // produces a row with an empty "now failing" column, sorted among the real regressions. On the
  // real tree `_app.@.orgs.$organizationSlug.$.tsx` renders 67 to 50 exactly that way.
  describe("a row a suppression caused", () => {
    // Two of three applicable scored checks pass, so suppressing one of the passes takes the
    // visible ratio from 2/3 to 1/2, which is the 67 to 50 the real tree renders on
    // `_app.@.orgs.$organizationSlug.$.tsx`. The catch has to decide something for
    // error-classification to apply at all, and nothing may name a tenant, or the ratio is 3/3.
    const twoOfThree = `import { requireUserId } from "~/services/session.server";
       import { prisma } from "~/db.server";
       export async function action({ request }) {
         const userId = await requireUserId(request);
         try { return await prisma.token.create({ data: { userId } }); }
         catch (error) {
           if (error instanceof BadRequest) return json({ error: "bad" }, { status: 400 });
           throw error;
         }
       }`;
    const silence = (id: string, source: string) =>
      `// obs-map-disable ${id} -- silenced\n${source}`;

    it("says so on the route, so it is not read as a regression", () => {
      const base = buildReport([scanFile("api.v1.auth.tokens.ts", twoOfThree)!], []);
      const head = buildReport(
        [scanFile("api.v1.auth.tokens.ts", silence("error-classification", twoOfThree))!],
        []
      );
      expect(base.entries[0]!.score).toBe(67);
      expect(head.entries[0]!.score).toBe(50);

      const row = renderPrComment(head, base)
        .split("\n")
        .find((l) => l.startsWith("| /api/v1/auth/tokens"))!;
      expect(row).toBeDefined();
      expect(row).toContain("(suppressed: error-classification)");
      // The column that would otherwise explain the drop is empty, which is the whole problem.
      expect(row.split("|")[4]!.trim()).toBe("");
    });

    // I3. This one moves no score at all, so before the suppression set was compared it produced
    // no row and no comment: a pull request whose whole purpose is to silence findings was silent.
    it("appears even when suppressing an already-failing check moved no score", () => {
      const base = buildReport([scanFile("api.v1.t.ts", brokenSource)!], []);
      const head = buildReport(
        [scanFile("api.v1.t.ts", silence("error-classification", brokenSource))!],
        []
      );
      expect(head.entries[0]!.score).toBe(base.entries[0]!.score);
      expect(head.global).toBe(base.global);

      const out = renderPrComment(head, base);
      expect(out).not.toContain("No entry point this PR touches changed its score.");
      const row = out.split("\n").find((l) => l.startsWith("| /api/v1/t "))!;
      expect(row).toBeDefined();
      expect(row).toContain("(suppressed: error-classification)");
    });

    it("says nothing about suppression on a row that has none", () => {
      const head = buildReport([scanFile("api.v1.auth.tokens.ts", brokenSource)!], []);
      const base = buildReport([scanFile("api.v1.auth.tokens.ts", cleanSource)!], []);
      const row = renderPrComment(head, base)
        .split("\n")
        .find((l) => l.startsWith("| /api/v1/auth/tokens"))!;
      expect(row).not.toContain("suppressed:");
    });

    it("gives a new entry that lands at 100 only because of a suppression a row", () => {
      const base = buildReport([scanFile("api.v1.a.ts", cleanSource)!], []);
      const head = buildReport(
        [
          scanFile("api.v1.a.ts", cleanSource)!,
          scanFile("api.v1.new.ts", silence("request-context", cleanSource))!,
        ],
        []
      );
      const row = renderPrComment(head, base)
        .split("\n")
        .find((l) => l.startsWith("| /api/v1/new"))!;
      expect(row).toBeDefined();
      expect(row).toContain("(suppressed: request-context)");
    });
  });

  // M5. This section rendered one line per file, and a tree-wide typo took the comment past
  // GitHub's 65,536 character limit for a 422 nobody sees.
  it("caps the unknown-suppression lines instead of running past the comment size limit", () => {
    const entries = [];
    for (let i = 0; i < 40; i++) {
      entries.push(
        scanFile(
          `api.v1.route${i}.ts`,
          `// obs-map-disable eror-classification -- typo\n${brokenSource}`
        )!
      );
    }
    const head = buildReport(entries, []);
    const out = renderPrComment(head, null);

    expect(out.split("\n").filter((l) => l.startsWith("UNKNOWN SUPPRESSION"))).toHaveLength(10);
    expect(out).toContain("and 30 more files with unknown ids");
    expect(out.length).toBeLessThan(65536);
  });

  // Round E item 1. The same unbounded-section failure, in the one other section that grows with
  // the tree. A codemod moving route bodies into `.server.ts` modules is the refactor `delegating`
  // exists to notice, and it is what makes this list tree-sized.
  it("caps the delegated route list instead of running past the comment size limit", () => {
    const entries = [];
    for (let i = 0; i < 400; i++) {
      const padding = `route-with-a-realistically-long-name-${String(i).padStart(4, "0")}`;
      entries.push(
        scanFile(
          `_app.orgs.$organizationSlug.projects.$projectParam.${padding}/route.tsx`,
          `export { action } from "./handler.server";`
        )!
      );
    }
    const head = buildReport(entries, []);
    const line = renderPrComment(head, null)
      .split("\n")
      .find((l) => l.startsWith("DELEGATED"))!;

    expect(line).toContain("400 routes");
    expect(line).toContain(", and 385 more");
    expect(line.match(/\/route\.tsx/g)).toHaveLength(15);
    expect(renderPrComment(head, null).length).toBeLessThan(65536);
  });

  // The terminal has no size limit to respect, so the cap must not reach it.
  it("leaves the terminal report naming every delegating route", () => {
    const entries = [];
    for (let i = 0; i < 40; i++) {
      entries.push(scanFile(`webhooks.v1.hook${i}.ts`, `export { action } from "./h.server";`)!);
    }
    const line = renderTerminal(buildReport(entries, []))
      .split("\n")
      .find((l) => l.startsWith("DELEGATED"))!;
    expect(line).toContain("webhooks.v1.hook39.ts");
    expect(line).not.toContain("more");
  });

  it("sorts a sensitive entry with a small drop above a non-sensitive entry with a large drop", () => {
    const sensitiveSmallDropBase = scanFile("api.v1.auth.tokens.ts", cleanSource)!;
    const sensitiveSmallDropHead = scanFile(
      "api.v1.auth.tokens.ts",
      `import { requireUserId } from "~/services/session.server";
       import { logger } from "~/services/logger.server";
       import { prisma } from "~/db.server";
       export async function action({ request }) {
         const userId = await requireUserId(request);
         try { return await prisma.token.create({ data: { userId } }); }
         catch (error) { logger.error("token create failed", { error }); throw error; }
       }`
    )!;

    const notSensitiveLargeDropBase = scanFile(
      "resources.busy.ts",
      `import { logger } from "~/services/logger.server";
       import { prisma } from "~/db.server";
       export async function loader({ params }) {
         try { return await prisma.thing.findMany(); }
         catch (error) { logger.error("failed", { environmentId: params.envId, error }); throw error; }
       }`
    )!;
    const notSensitiveLargeDropHead = scanFile(
      "resources.busy.ts",
      `import { prisma } from "~/db.server";
       export async function loader() {
         try { return await prisma.thing.findMany(); } catch (e) { return null; }
       }`
    )!;

    const head = buildReport([sensitiveSmallDropHead, notSensitiveLargeDropHead], []);
    const base = buildReport([sensitiveSmallDropBase, notSensitiveLargeDropBase], []);
    const out = renderPrComment(head, base);

    const sensitiveIndex = out.indexOf("/api/v1/auth/tokens");
    const notSensitiveIndex = out.indexOf("/resources/busy");
    expect(sensitiveIndex).toBeGreaterThan(-1);
    expect(notSensitiveIndex).toBeGreaterThan(-1);
    expect(sensitiveIndex).toBeLessThan(notSensitiveIndex);
  });

  it("reports a removed entry as a count line, not a row", () => {
    const head = buildReport([scanFile("api.v1.auth.tokens.ts", cleanSource)!], []);
    const base = buildReport(
      [scanFile("api.v1.auth.tokens.ts", cleanSource)!, scanFile("api.v1.gone.ts", brokenSource)!],
      []
    );
    const out = renderPrComment(head, base);

    expect(out).toContain("1 entries removed");
    expect(out).not.toContain("/api/v1/gone");
  });

  it("caps the changed-entries table at 15 rows and says how many more", () => {
    const headEntries = [];
    const baseEntries = [];
    for (let i = 0; i < 20; i++) {
      headEntries.push(scanFile(`api.v1.route${i}.ts`, brokenSource)!);
      baseEntries.push(scanFile(`api.v1.route${i}.ts`, cleanSource)!);
    }
    const head = buildReport(headEntries, []);
    const base = buildReport(baseEntries, []);
    const out = renderPrComment(head, base);

    const rows = out.split("\n").filter((l) => l.startsWith("| /api/v1/route"));
    expect(rows).toHaveLength(15);
    expect(out).toContain("and 5 more");
  });

  it("warns about parse failures in either report, since they shrink the denominator", () => {
    const head = buildReport([scanFile("api.v1.a.ts", cleanSource)!], ["broken-head.ts"]);
    const base = buildReport([scanFile("api.v1.a.ts", cleanSource)!], ["broken-base.ts"]);
    const out = renderPrComment(head, base);
    expect(out).toMatch(/Warning: parse failures \(1 at head, 1 at base\)/);
  });

  it("does not warn about parse failures when there are none", () => {
    const head = buildReport([scanFile("api.v1.a.ts", cleanSource)!], []);
    expect(renderPrComment(head, null)).not.toContain("Warning: parse failures");
  });

  it("footer names the report-only rule, the required suite that is not it, and the readme", () => {
    const head = buildReport([scanFile("api.v1.a.ts", cleanSource)!], []);
    const out = renderPrComment(head, null);
    expect(out).toContain("report-only and never gate the merge");
    expect(out).toContain("a required test suite");
    // Both directions. A footer naming only the rename case sends the author who added the first
    // `secrets` route looking for a rename they never made.
    expect(out).toContain("renames or removes a symbol");
    expect(out).toContain("adds the first route with a segment");
    expect(out).toContain("internal-packages/observability-map/README.md");
  });
});

/**
 * The comment is edited in place across pushes, so every comment the job posts carries the head sha as
 * a link to the compare range. The commit arrives as data, so these renderers stay pure.
 */
describe("the commit stamp", () => {
  const COMMIT = {
    sha: "0123456789abcdef0123456789abcdef01234567",
    url: "https://github.com/triggerdotdev/trigger.dev/compare/1111111...2222222",
  };
  const STAMP =
    "As of [`0123456`](https://github.com/triggerdotdev/trigger.dev/compare/1111111...2222222).";
  const head = () => buildReport([scanFile("api.v1.a.ts", brokenSource)!], []);

  it("stamps the report comment under the heading, before anything the report says", () => {
    const lines = renderPrComment(head(), null, COMMIT).split("\n");
    expect(lines[2]).toBe("## Observability map");
    expect(lines[4]).toBe(STAMP);
  });

  it("stamps the resolved comment, which is the one a stale report gets replaced with", () => {
    const lines = renderResolvedComment(COMMIT).split("\n");
    expect(lines[4]).toBe(STAMP);
    expect(lines.join("\n")).toContain("Nothing in this pull request moves the report any more.");
  });

  it("stamps the stale-report comment", () => {
    expect(renderScanFailedComment(COMMIT).split("\n")[4]).toBe(STAMP);
  });

  it("shortens the sha to seven characters for the link text, not the target", () => {
    expect(renderPrComment(head(), null, COMMIT)).toContain("[`0123456`](");
    expect(renderPrComment(head(), null, COMMIT)).not.toContain("[`01234567`]");
  });

  // The optional half. Unit tests and a local CLI run have no commit context, and rendering has to
  // work without one rather than printing a link to nowhere.
  it("renders every comment without a stamp when there is no commit context", () => {
    for (const out of [
      renderPrComment(head(), null),
      renderResolvedComment(),
      renderScanFailedComment(),
    ]) {
      expect(out).not.toContain("As of [");
      expect(out.split("\n")[2]).toBe("## Observability map");
    }
  });
});

// B4. The job posts only when the pull request moves the report, so the decision has to be a
// tested function of the two reports rather than shell logic in the workflow.
/**
 * `hasDelta` compares no `sensitive` field, and does not need one. Sensitivity reaches the rendered
 * comment only through `fixFirstSection`, whose primary sort key it is, and a route can only appear
 * there with a scored failure. A scored failure needs a try/catch in the body, `isTrivialExport`
 * rejects any export that has one, and a sensitive non-trivial export is therefore either accused
 * (`fail`) or guarded (`pass`) on `auth-boundary`, never `not-applicable`. So a flip that could move
 * the fix list always moves `auth-boundary`, which moves `checkContributions`, which is compared.
 *
 * Both halves are pinned here because the argument rests on that coupling: make a trivial route
 * capable of a scored failure and the first case below starts rendering a difference `hasDelta` cannot
 * see.
 */
describe("a sensitivity flip", () => {
  const stub = `import { redirect } from "@remix-run/server-runtime";
    export const loader = () => redirect("/");`;
  const stubSensitive = `import { redirect } from "@remix-run/server-runtime";
    import { createPersonalAccessToken } from "~/services/personalAccessToken.server";
    export const loader = () => redirect("/");`;

  it("renders nothing different on a route too trivial to reach the fix list", () => {
    const base = buildReport([scanFile("resources.stub.ts", stub)!], []);
    const head = buildReport([scanFile("resources.stub.ts", stubSensitive)!], []);
    expect(base.entries[0]!.sensitive).toBe(false);
    expect(head.entries[0]!.sensitive).toBe(true);

    expect(renderPrComment(head, base)).toBe(renderPrComment(base, base));
    expect(hasDelta(head, base)).toBe(false);
  });

  it("moves auth-boundary, and so is caught, on a route that does real work", () => {
    const working = `export async function loader() {
      try { compute(); } catch (e) { return null; }
    }`;
    const workingSensitive = `import { createPersonalAccessToken } from "~/services/personalAccessToken.server";
      export async function loader() {
        try { compute(); } catch (e) { return null; }
      }`;
    const base = buildReport([scanFile("resources.work.ts", working)!], []);
    const head = buildReport([scanFile("resources.work.ts", workingSensitive)!], []);

    const status = (r: typeof base) =>
      r.entries[0]!.checks.find((c) => c.id === "auth-boundary")!.status;
    expect(status(base)).toBe("not-applicable");
    expect(status(head)).toBe("fail");
    expect(hasDelta(head, base)).toBe(true);
  });
});

describe("hasDelta", () => {
  const trivial = `export const loader = () => new Response("ok");`;
  const one = (name: string, source: string) => buildReport([scanFile(name, source)!], []);

  it("is true when there is no base to compare against", () => {
    expect(hasDelta(one("api.v1.a.ts", cleanSource), null)).toBe(true);
  });

  it("is false for two identical reports", () => {
    expect(hasDelta(one("api.v1.a.ts", cleanSource), one("api.v1.a.ts", cleanSource))).toBe(false);
  });

  it("is true when the global score moved", () => {
    expect(hasDelta(one("api.v1.a.ts", brokenSource), one("api.v1.a.ts", cleanSource))).toBe(true);
  });

  it("is true when an entry was added", () => {
    const head = buildReport(
      [scanFile("api.v1.a.ts", cleanSource)!, scanFile("api.v1.b.ts", cleanSource)!],
      []
    );
    expect(hasDelta(head, one("api.v1.a.ts", cleanSource))).toBe(true);
  });

  it("is true when an entry was removed", () => {
    const base = buildReport(
      [scanFile("api.v1.a.ts", cleanSource)!, scanFile("api.v1.b.ts", cleanSource)!],
      []
    );
    expect(hasDelta(one("api.v1.a.ts", cleanSource), base)).toBe(true);
  });

  // The global is a mean over measured entries, so two entries moving in opposite directions can
  // leave it where it was. The per-entry comparison is what catches that.
  it("is true when an entry's score moved but the global mean did not", () => {
    const head = buildReport(
      [scanFile("api.v1.a.ts", brokenSource)!, scanFile("api.v1.b.ts", cleanSource)!],
      []
    );
    const base = buildReport(
      [scanFile("api.v1.a.ts", cleanSource)!, scanFile("api.v1.b.ts", brokenSource)!],
      []
    );
    expect(head.global).toBe(base.global);
    expect(hasDelta(head, base)).toBe(true);
  });

  // audit-trail does not feed the score, so it can start failing without moving a single figure.
  it("is true when an unscored check started failing and no score moved", () => {
    const head = one("api.v1.envvars.ts", cleanSource);
    const base = one(
      "api.v1.envvars.ts",
      `// obs-map-disable audit-trail -- no helper exists yet\n${cleanSource}`
    );
    expect(head.global).toBe(base.global);
    expect(hasDelta(head, base)).toBe(true);
  });

  it("is true when an entry stopped being measured at the same placeholder score", () => {
    const head = one("api.v1.a.ts", trivial);
    const base = one("api.v1.a.ts", cleanSource);
    expect(head.entries[0]!.score).toBe(base.entries[0]!.score);
    expect(hasDelta(head, base)).toBe(true);
  });

  it("is true when a parse failure appeared, since the comment warns about it", () => {
    const head = buildReport([scanFile("api.v1.a.ts", cleanSource)!], ["broken.ts"]);
    expect(hasDelta(head, one("api.v1.a.ts", cleanSource))).toBe(true);
  });

  // I3. These three are the half that was missing, and it ran the dangerous way: a pull request
  // that only silences findings posted nothing, while a mistyped directive did post.
  it("is true when a suppression was added to a check that was already failing", () => {
    const base = one("api.v1.t.ts", brokenSource);
    const head = one(
      "api.v1.t.ts",
      `// obs-map-disable error-classification -- silenced\n${brokenSource}`
    );
    expect(head.global).toBe(base.global);
    expect(head.entries[0]!.score).toBe(base.entries[0]!.score);
    expect(head.measured).toBe(base.measured);
    expect(hasDelta(head, base)).toBe(true);
  });

  it("is true when the audit gap closed, which no score reports", () => {
    const audited = `import { clearImpersonation } from "~/models/admin.server";
       import { prisma } from "~/db.server";
       export async function action() {
         const token = await prisma.token.create({ data: {} });
         await clearImpersonation(request, "/admin");
         return json(token);
       }`;
    const unaudited = `import { prisma } from "~/db.server";
       export async function action() {
         const token = await prisma.token.create({ data: {} });
         return json(token);
       }`;
    const head = one("api.v1.auth.tokens.ts", audited);
    const base = one("api.v1.auth.tokens.ts", unaudited);
    expect(head.auditGap).not.toEqual(base.auditGap);
    expect(hasDelta(head, base)).toBe(true);
  });

  // The CONTEXT line reads pre-suppression data, so with request-context suppressed its figure can
  // move while the post-suppression checks, the score and the global all stay put. The comment
  // says "0 of 1" and then "1 of 1"; nothing else in the report moves at all.
  it("is true when the context figure moved behind a suppression", () => {
    const silence = "// obs-map-disable request-context -- reported as a figure\n";
    const namesNobody = `${silence}import { prisma } from "~/db.server";
       export async function action() {
         try { return await prisma.envVar.update({ where: {}, data: {} }); } catch (e) { return null; }
       }`;
    const namesTenant = `${silence}import { logger } from "~/services/logger.server";
       import { prisma } from "~/db.server";
       export async function action({ params }) {
         try { return await prisma.envVar.update({ where: {}, data: {} }); }
         catch (error) { logger.error("failed", { environmentId: params.envId, error }); return null; }
       }`;
    const head = one("api.v1.envvars.ts", namesTenant);
    const base = one("api.v1.envvars.ts", namesNobody);

    expect(head.global).toBe(base.global);
    expect(head.entries[0]!.score).toBe(base.entries[0]!.score);
    expect(head.entries[0]!.suppressed).toEqual(base.entries[0]!.suppressed);
    expect(head.contextGap).not.toEqual(base.contextGap);
    expect(hasDelta(head, base)).toBe(true);
  });

  // Suppressing a check that was not applicable anyway changes no status and no score, and moving
  // that suppression between two entries leaves the report-level totals identical too. The
  // per-entry suppression comparison is the only thing left that can see it.
  it("is true when a suppression of an inapplicable check moved between entries", () => {
    const silenced = `// obs-map-disable auth-boundary -- not a user-facing route\n${brokenSource}`;
    const head = buildReport(
      [scanFile("api.v1.a.ts", silenced)!, scanFile("api.v1.b.ts", brokenSource)!],
      []
    );
    const base = buildReport(
      [scanFile("api.v1.a.ts", brokenSource)!, scanFile("api.v1.b.ts", silenced)!],
      []
    );
    expect(head.suppressions).toEqual(base.suppressions);
    expect(head.global).toBe(base.global);
    expect(head.entries.map((e) => e.score)).toEqual(base.entries.map((e) => e.score));
    const statuses = (r: typeof head) =>
      r.entries.map((e) => e.checks.map((c) => `${c.id}=${c.status}`).join(" "));
    expect(statuses(head)).toEqual(statuses(base));
    expect(hasDelta(head, base)).toBe(true);
  });

  it("is true when a suppression names a check that does not exist", () => {
    const head = one(
      "api.v1.a.ts",
      `// obs-map-disable eror-classification -- typo\n${cleanSource}`
    );
    expect(hasDelta(head, one("api.v1.a.ts", cleanSource))).toBe(true);
  });
});

// C4b and C5. Both are rendered, so both have to move `hasDelta`, and neither is reachable through
// the per-entry score comparison the loop makes.
describe("hasDelta: the figures round C added", () => {
  const one = (name: string, source: string) => buildReport([scanFile(name, source)!], []);
  const delegated = `export { action } from "./handler.server";`;

  it("is true when a route started delegating its body", () => {
    const head = one("webhooks.v1.stripe.ts", delegated);
    const base = one("webhooks.v1.stripe.ts", brokenSource);
    expect(head.delegating).toEqual(["webhooks.v1.stripe.ts"]);
    expect(hasDelta(head, base)).toBe(true);
  });

  // The shape the per-entry loop cannot see: the score stays where it was and what the score is
  // made of changed underneath it.
  it("is true when a check stopped applying without moving any entry's score", () => {
    const head = one("api.v1.auth.tokens.ts", cleanSource);
    const base = one("api.v1.auth.tokens.ts", cleanSource);
    const contribution = base.checkContributions.find((c) => c.id === "auth-boundary")!;
    contribution.applicable = contribution.applicable + 1;
    expect(head.entries[0]!.score).toBe(base.entries[0]!.score);
    expect(hasDelta(head, base)).toBe(true);
  });

  it("says the comment renders the delegated line it is comparing", () => {
    const head = one("webhooks.v1.stripe.ts", delegated);
    expect(renderPrComment(head, null)).toContain("DELEGATED");
  });

  it("says the comment renders the check contributions it is comparing", () => {
    const head = one("api.v1.auth.tokens.ts", cleanSource);
    expect(renderPrComment(head, null)).toContain("What the score is made of");
  });
});

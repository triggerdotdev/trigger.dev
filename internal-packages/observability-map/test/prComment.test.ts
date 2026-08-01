import { hasDelta, renderPrComment } from "../src/report/prComment.js";
import { buildReport } from "../src/score.js";
import { scanFile } from "../src/scan.js";

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

  it("footer names the report-only rule and the readme", () => {
    const head = buildReport([scanFile("api.v1.a.ts", cleanSource)!], []);
    const out = renderPrComment(head, null);
    expect(out).toContain("Report only, nothing here gates the merge.");
    expect(out).toContain("internal-packages/observability-map/README.md");
  });
});

// B4. The job posts only when the pull request moves the report, so the decision has to be a
// tested function of the two reports rather than shell logic in the workflow.
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

  it("is true when a suppression names a check that does not exist", () => {
    const head = one(
      "api.v1.a.ts",
      `// obs-map-disable eror-classification -- typo\n${cleanSource}`
    );
    expect(hasDelta(head, one("api.v1.a.ts", cleanSource))).toBe(true);
  });
});

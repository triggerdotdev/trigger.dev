import { renderPrComment } from "../src/report/prComment.js";
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

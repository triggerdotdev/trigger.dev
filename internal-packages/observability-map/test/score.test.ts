import { scoreEntry, buildReport } from "../src/score.js";
import { scanFile } from "../src/scan.js";

const BUILDER = `import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";
export const loader = createLoaderApiRoute({}, async () => new Response("ok"));`;

const RAW = `import { prisma } from "~/db.server";
export async function loader() { return prisma.thing.findMany(); }`;

/** Trivial and not sensitive: every scored check reports not-applicable. */
const TRIVIAL = `export const loader = () => new Response("ok");`;

/** Not trivial (touches prisma, has a try/catch) and not sensitive: swallows every error and
 * records nothing about whose failure it was, so both applicable scored checks fail. */
const BUSY_AND_FAILING = `import { prisma } from "~/db.server";
export async function loader() {
  try { return await prisma.thing.findMany(); } catch (e) { return null; }
}`;

/** Guarded, classifies what it catches, and names the tenant on the failure path. */
const CLEAN = `import { requireUserId } from "~/services/session.server";
import { logger } from "~/services/logger.server";
import { prisma } from "~/db.server";
export async function action({ request, params }) {
  const userId = await requireUserId(request);
  try {
    return await prisma.token.create({ data: { userId } });
  } catch (error) {
    logger.error("token create failed", { userId, environmentId: params.envId, error });
    throw error;
  }
}`;

describe("scoreEntry", () => {
  it("scores an entry that passes every applicable check 100", () => {
    expect(scoreEntry(scanFile("api.v1.auth.tokens.ts", CLEAN)!).score).toBe(100);
  });

  // A builder wrapper classifies errors for the route, but the route itself catches nothing and
  // names nobody on its failure path, so there is one applicable check and it fails.
  it("does not credit a builder route for the error handling it does not do", () => {
    const scored = scoreEntry(scanFile("api.v1.a.ts", BUILDER)!);
    expect(scored.checks.find((c) => c.id === "error-classification")!.status).toBe(
      "not-applicable"
    );
    expect(scored.checks.find((c) => c.id === "request-context")!.status).toBe("fail");
    expect(scored.score).toBe(0);
  });

  it("excludes audit-trail from the per-entry score", () => {
    const scored = scoreEntry(scanFile("api.v1.auth.jwt.ts", CLEAN)!);
    expect(scored.checks.find((c) => c.id === "audit-trail")!.status).toBe("fail");
    expect(scored.score).toBe(100);
  });

  it("counts a suppressed check as not-applicable", () => {
    const suppressed = `// obs-map-disable-next-line error-classification -- health probe
${RAW}`;
    const scored = scoreEntry(scanFile("api.v1.b.ts", suppressed)!);
    const ec = scored.checks.find((c) => c.id === "error-classification")!;
    expect(ec.status).toBe("not-applicable");
  });

  it("a suppressed-to-passing entry point does not read as unmeasured", () => {
    // error-classification would fail here; auth-boundary is not-applicable (not sensitive).
    // Suppressing the only applicable scored check must not be indistinguishable from an entry
    // point nothing applies to: it is still reported, just not scored on that axis.
    const suppressed = `// obs-map-disable-next-line error-classification -- health probe
${BUSY_AND_FAILING}`;
    const scored = scoreEntry(scanFile("api.v1.c.ts", suppressed)!);
    expect(scored.checks.find((c) => c.id === "error-classification")!.status).toBe(
      "not-applicable"
    );
  });

  it("marks an entry point with nothing applicable as unmeasured, scored 100", () => {
    const scored = scoreEntry(scanFile("resources.health.ts", TRIVIAL)!);
    expect(scored.checks.every((c) => c.status === "not-applicable")).toBe(true);
    expect(scored.measured).toBe(false);
    expect(scored.score).toBe(100);
  });

  it("marks an entry point with at least one applicable scored check as measured", () => {
    const scored = scoreEntry(scanFile("api.v1.busy.ts", BUSY_AND_FAILING)!);
    expect(scored.measured).toBe(true);
  });
});

describe("buildReport", () => {
  it("reports the audit gap separately from the score", () => {
    // A sensitive mutation with no audit record, but nothing else wrong: the audit gap is reported
    // as its own figure and must not pull the score down with it.
    const report = buildReport([scanFile("api.v1.auth.tokens.ts", CLEAN)!], []);
    expect(report.auditGap.sensitiveMutations).toBe(1);
    expect(report.auditGap.withAudit).toBe(0);
    expect(report.global).toBe(100);
  });

  it("records parse failures", () => {
    const report = buildReport([scanFile("api.v1.a.ts", BUILDER)!], ["broken.ts"]);
    expect(report.parseFailures).toEqual(["broken.ts"]);
  });

  it("excludes an unmeasured entry point from the global mean", () => {
    const trivial = scanFile("resources.health.ts", TRIVIAL)!;
    const busy = scanFile("api.v1.busy.ts", BUSY_AND_FAILING)!;

    const report = buildReport([trivial, busy], []);

    expect(report.measured).toBe(1);
    expect(report.unmeasured).toBe(1);
    // If the trivial entry's vacuous 100 counted toward the mean, the global score would be 50
    // instead of matching the one entry that was actually measured.
    expect(report.global).toBe(scoreEntry(busy).score);
  });

  it("excludes an unmeasured entry point from its family mean too", () => {
    const trivial = scanFile("resources.health.ts", TRIVIAL)!;
    const busy = scanFile("resources.busy.ts", BUSY_AND_FAILING)!;

    const report = buildReport([trivial, busy], []);

    const family = report.byFamily["resources"]!;
    expect(family.n).toBe(2);
    expect(family.measured).toBe(1);
    expect(family.mean).toBe(scoreEntry(busy).score);
  });
});

import { renderTerminal } from "../src/report/terminal.js";
import { renderJson } from "../src/report/json.js";
import { buildReport } from "../src/score.js";
import { scanFile } from "../src/scan.js";

const report = () =>
  buildReport(
    [
      scanFile(
        "api.v1.a.ts",
        `import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";
         export const loader = createLoaderApiRoute({}, async () => new Response("ok"));`
      )!,
      scanFile(
        "api.v1.auth.tokens.ts",
        `import { prisma } from "~/db.server";
         export async function action() { return prisma.token.create({ data: {} }); }`
      )!,
    ],
    ["broken.ts"]
  );

describe("renderTerminal", () => {
  it("shows the global score, the audit gap and the fix list", () => {
    const out = renderTerminal(report());
    expect(out).toContain("COVERAGE");
    expect(out).toContain("FIX FIRST");
    expect(out).toContain("audit");
    expect(out).toContain("/api/v1/auth/tokens");
  });

  it("surfaces parse failures so the denominator is not silently wrong", () => {
    expect(renderTerminal(report())).toContain("broken.ts");
  });

  it("shows the unmeasured count so 415 vs 427 is not silently confusing", () => {
    const trivial = scanFile(
      "resources.health.ts",
      `export const loader = () => new Response("ok");`
    )!;
    const out = renderTerminal(buildReport([trivial], []));
    expect(out).toContain("1 unmeasured");
  });

  it("orders FIX FIRST by sensitivity first, then ascending score, and excludes audit-only gaps", () => {
    // Sensitive, score 0: both applicable scored checks fail (auth-boundary, error-classification,
    // request-context all fail because the catch swallows without naming who it happened to).
    const sensitiveZero = scanFile(
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

    // Sensitive, score 67: guarded and classifies what it catches, but its failure log names
    // nobody, so only request-context fails.
    const sensitiveSixtySeven = scanFile(
      "api.v1.auth.tokens.ts",
      `import { requireUserId } from "~/services/session.server";
       import { logger } from "~/services/logger.server";
       import { prisma } from "~/db.server";
       export async function action({ request }) {
         const userId = await requireUserId(request);
         try { return await prisma.token.create({ data: { userId } }); }
         catch (error) { logger.error("failed", { error }); throw error; }
       }`
    )!;

    // Not sensitive, score 0: worse score than sensitiveSixtySeven, but must still sort after both
    // sensitive entries because sensitivity outranks raw score.
    const notSensitiveZero = scanFile(
      "resources.busy.ts",
      `import { prisma } from "~/db.server";
       export async function loader() {
         try { return await prisma.thing.findMany(); } catch (e) { return null; }
       }`
    )!;

    // Sensitive mutation, scored checks all pass (guarded, no try/catch): the only gap is
    // audit-trail, which is a headline figure, not a per-route fix-list item. Must not appear.
    const sensitiveAuditOnly = scanFile(
      "api.v1.billing.ts",
      `import { prisma } from "~/db.server";
       import { logger } from "~/services/logger.server";
       import { requireUserId } from "~/services/session.server";
       export async function action({ request }) {
         const userId = await requireUserId(request);
         try { return await prisma.billing.update({ where: { userId }, data: {} }); }
         catch (error) { logger.error("billing update failed", { userId, error }); throw error; }
       }`
    )!;

    const out = renderTerminal(
      buildReport([sensitiveSixtySeven, sensitiveZero, notSensitiveZero, sensitiveAuditOnly], [])
    );

    const fixFirst = out.slice(out.indexOf("FIX FIRST"), out.indexOf("already solid"));
    const idxZero = fixFirst.indexOf("api.v1.envvars.ts");
    const idxSixtySeven = fixFirst.indexOf("api.v1.auth.tokens.ts");
    const idxNotSensitive = fixFirst.indexOf("resources.busy.ts");

    expect(idxZero).toBeGreaterThan(-1);
    expect(idxSixtySeven).toBeGreaterThan(idxZero);
    expect(idxNotSensitive).toBeGreaterThan(idxSixtySeven);
    expect(fixFirst).not.toContain("api.v1.billing.ts");
  });
});

describe("renderJson", () => {
  it("round-trips to an object carrying the score and entries", () => {
    const parsed = JSON.parse(renderJson(report()));
    expect(typeof parsed.global).toBe("number");
    expect(Array.isArray(parsed.entries)).toBe(true);
  });
});

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

  it("surfaces suppressions so laundering is visible rather than silent", () => {
    const suppressed = scanFile(
      "api.v1.d.ts",
      `// obs-map-disable-next-line error-classification -- deliberate, see ticket
       import { prisma } from "~/db.server";
       export async function loader() {
         try { return await prisma.thing.findMany(); } catch (e) { return null; }
       }`
    )!;
    const out = renderTerminal(buildReport([suppressed], []));
    expect(out).toMatch(/suppress/i);
    expect(out).toContain("1");
  });

  it("does not mention suppressions when there are none", () => {
    expect(renderTerminal(report())).not.toMatch(/suppress/i);
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

describe("rendering honestly when there is nothing to say", () => {
  // I4. mean([]) returned 100, so a family with nothing measured rendered a full green bar.
  it("renders a family with nothing measured as not measured, not as 100", () => {
    const trivial = scanFile(
      "resources.health.ts",
      `export const loader = () => new Response("ok");`
    )!;
    const out = renderTerminal(buildReport([trivial], []));
    const line = out.split("\n").find((l) => l.includes("resources"))!;
    expect(line).not.toMatch(/100/);
    expect(line).toMatch(/not measured/i);
  });

  it("renders the global score as not measured when nothing was measured", () => {
    const trivial = scanFile(
      "resources.health.ts",
      `export const loader = () => new Response("ok");`
    )!;
    expect(renderTerminal(buildReport([trivial], []))).toMatch(/score not measured/i);
  });

  // I11. The audit sentence was printed unconditionally, including when the figure said otherwise.
  it("does not claim no audit helper exists when one is in use", () => {
    const audited = scanFile(
      "api.v1.auth.tokens.ts",
      `import { auditLog } from "~/services/audit.server";
       import { prisma } from "~/db.server";
       export async function action() {
         const token = await prisma.token.create({ data: {} });
         await auditLog("token.created", { tokenId: token.id });
         return json(token);
       }`
    )!;
    const out = renderTerminal(buildReport([audited], []));
    expect(out).toContain("1 of 1");
    expect(out).not.toContain("No audit helper exists");
  });

  it("says nothing about audit when no sensitive mutation was found", () => {
    const plain = scanFile(
      "resources.things.ts",
      `import { prisma } from "~/db.server";
       export async function loader() { return prisma.thing.findMany(); }`
    )!;
    expect(renderTerminal(buildReport([plain], []))).not.toMatch(/AUDIT/);
  });

  // I5. "already solid" counted entries that are clean because they do nothing, alongside entries
  // nothing applied to, in one flattering number.
  it("separates entries that passed from entries nothing applied to", () => {
    const clean = scanFile(
      "api.v1.clean.ts",
      `import { logger } from "~/services/logger.server";
       import { prisma } from "~/db.server";
       export async function loader({ params }) {
         try { return await prisma.thing.findMany(); }
         catch (error) { logger.error("failed", { environmentId: params.envId, error }); throw error; }
       }`
    )!;
    const trivial = scanFile(
      "resources.health.ts",
      `export const loader = () => new Response("ok");`
    )!;
    const out = renderTerminal(buildReport([clean, trivial], []));
    expect(out).not.toMatch(/already solid/i);
    expect(out).toMatch(/1 passed every applicable check/i);
    expect(out).toMatch(/1 had none to apply/i);
  });
});

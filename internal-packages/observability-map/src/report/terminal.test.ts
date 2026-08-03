import { renderTerminal } from "./terminal.js";
import { renderJson } from "./json.js";
import { buildReport } from "../score.js";
import { scanFile } from "../scan.js";

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

/** The FIX FIRST section, with the index asserted rather than assumed. `indexOf` returns -1 for a
 * section that is not there, and `slice(-1)` is the last character of the report, which every
 * `not.toContain` below would pass against. */
function sliceFixFirst(out: string): string {
  const start = out.indexOf("FIX FIRST");
  expect(start).toBeGreaterThan(-1);
  const end = out.indexOf("no findings:");
  expect(end).toBeGreaterThan(start);
  return out.slice(start, end);
}

describe("renderTerminal", () => {
  // The guard has to be able to fail, or it is decoration in a file whose own comment warns about
  // exactly this trap.
  it("refuses to slice a report with no fix list rather than returning its last character", () => {
    expect(() => sliceFixFirst("a report with neither section in it")).toThrow();
  });

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
      `// obs-map-disable error-classification -- deliberate, see ticket
       import { prisma } from "~/db.server";
       export async function loader() {
         try { return await prisma.thing.findMany(); } catch (e) { return null; }
       }`
    )!;
    const out = renderTerminal(buildReport([suppressed], []));
    expect(out).toMatch(/SUPPRESSED\s+1 check across 1 entry point/);
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

    // Sensitive, score 33: its catch decides something, telling a bad request apart from the rest,
    // but it has no guard and names nobody. Fails more than request-context, so it stays in the
    // list rather than collapsing into the figure.
    const sensitiveThirtyThree = scanFile(
      "api.v1.auth.tokens.ts",
      `import { prisma } from "~/db.server";
       export async function action() {
         try { return await prisma.token.create({ data: {} }); }
         catch (error) {
           if (error instanceof BadRequest) return json({ error: "bad" }, { status: 400 });
           throw error;
         }
       }`
    )!;

    // Not sensitive, score 0: worse score than sensitiveThirtyThree, but must still sort after both
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
      buildReport([sensitiveThirtyThree, sensitiveZero, notSensitiveZero, sensitiveAuditOnly], [])
    );

    // Slice to the end of the list, not to a string the I5 fix deleted: `indexOf` returned -1 for
    // "already solid" and the assertions were quietly running against the whole tail.
    const fixFirst = sliceFixFirst(out);
    const idxZero = fixFirst.indexOf("api.v1.envvars.ts");
    const idxThirtyThree = fixFirst.indexOf("api.v1.auth.tokens.ts");
    const idxNotSensitive = fixFirst.indexOf("resources.busy.ts");

    expect(idxZero).toBeGreaterThan(-1);
    expect(idxThirtyThree).toBeGreaterThan(idxZero);
    expect(idxNotSensitive).toBeGreaterThan(idxThirtyThree);
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
      `import { clearImpersonation } from "~/models/admin.server";
       import { prisma } from "~/db.server";
       export async function action() {
         const token = await prisma.token.create({ data: {} });
         await clearImpersonation(request, "/admin");
         return json(token);
       }`
    )!;
    const out = renderTerminal(buildReport([audited], []));
    expect(out).toContain("1 of 1");
    expect(out).not.toContain("No audit helper exists");
  });

  // The other half of the branch. A zero used to print "No audit helper exists in the webapp", which
  // is false, and a scan of any subset with no impersonation route in it brings it straight back.
  it("does not claim the webapp has no audit helper when nothing reached one", () => {
    const unaudited = scanFile(
      "api.v1.auth.tokens.ts",
      `import { prisma } from "~/db.server";
       export async function action() {
         return json(await prisma.token.create({ data: {} }));
       }`
    )!;
    const out = renderTerminal(buildReport([unaudited], []));
    expect(out).toContain("AUDIT   0 of 1 sensitive mutations record an actor. 1 without one.");
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

describe("collapsing the house-style finding", () => {
  const namesNobody = () =>
    scanFile(
      "api.v1.silent.ts",
      `import { prisma } from "~/db.server";
       export async function loader() { return prisma.thing.findMany(); }`
    )!;

  const namesNobodyAndSwallows = () =>
    scanFile(
      "api.v1.auth.tokens.ts",
      `import { prisma } from "~/db.server";
       export async function action() {
         try { return await prisma.token.create({ data: {} }); } catch (e) { return null; }
       }`
    )!;

  // request-context fails 401 of 412 entry points, so listing each one turns the fix list into a
  // single finding repeated. Same reasoning that keeps audit-trail out of the list.
  it("keeps an entry whose only finding is request-context out of the fix list", () => {
    const out = renderTerminal(buildReport([namesNobody()], []));
    // Guarded for the same reason as the slice above: an absent section makes `indexOf` return -1,
    // `slice(-1)` yields the last character, and the negative assertion passes for the wrong reason.
    const fixFirst = sliceFixFirst(out);
    expect(fixFirst).not.toContain("api.v1.silent.ts");
  });

  it("reports the gap as a headline figure instead", () => {
    const out = renderTerminal(buildReport([namesNobody()], []));
    expect(out).toMatch(/CONTEXT\s+0 of 1 entry points name a tenant on a failure path/);
  });

  // NEW-3. 18 of the collapsed entries are sensitive, including /admin/impersonate and the envvars
  // routes, so the line has to say a reader should go and look at them.
  it("says how many of the collapsed entries are sensitive", () => {
    const sensitiveAndSilent = scanFile(
      "api.v1.auth.jwt.ts",
      `import { requireUserId } from "~/services/session.server";
       import { prisma } from "~/db.server";
       export async function loader({ request }) {
         const userId = await requireUserId(request);
         return prisma.token.findMany({ where: { userId } });
       }`
    )!;
    const out = renderTerminal(buildReport([sensitiveAndSilent], []));
    expect(out).toMatch(/1 appears? only here[^\n]*1 of them sensitive/i);
  });

  it("says how many entries the collapse took out of the list", () => {
    const out = renderTerminal(buildReport([namesNobody(), namesNobodyAndSwallows()], []));
    expect(out).toMatch(/1 appears? only here/i);
  });

  it("still lists request-context when the entry fails something else too", () => {
    const out = renderTerminal(buildReport([namesNobodyAndSwallows()], []));
    const fixFirst = sliceFixFirst(out);
    expect(fixFirst).toContain("api.v1.auth.tokens.ts");
    expect(fixFirst).toContain("request-context");
    expect(fixFirst).toContain("error-classification");
  });
});

// B6. A stderr warning is the minimum; the terminal report is where someone would notice.
describe("reporting a suppression that names no check", () => {
  const typo = (fileName: string) =>
    scanFile(
      fileName,
      `// obs-map-disable eror-classification -- typo
       import { prisma } from "~/db.server";
       export async function loader() {
         try { return await prisma.thing.findMany(); } catch (e) { return null; }
       }`
    )!;

  it("names the file and the bad id", () => {
    const out = renderTerminal(buildReport([typo("api.v1.a.ts")], []));
    expect(out).toContain("UNKNOWN SUPPRESSION");
    expect(out).toContain("api.v1.a.ts");
    expect(out).toContain("eror-classification");
  });

  it("lists the ids that would have worked", () => {
    const out = renderTerminal(buildReport([typo("api.v1.a.ts")], []));
    expect(out).toContain(
      "error-classification, auth-boundary, auth-scope, request-context, audit-trail"
    );
  });

  it("does not report the finding as suppressed", () => {
    const out = renderTerminal(buildReport([typo("api.v1.a.ts")], []));
    expect(out).not.toMatch(/SUPPRESSED\s+\d/);
  });

  it("reports one line per file rather than one for the run", () => {
    const out = renderTerminal(buildReport([typo("api.v1.a.ts"), typo("api.v1.b.ts")], []));
    expect(out.split("\n").filter((l) => l.startsWith("UNKNOWN SUPPRESSION"))).toHaveLength(2);
  });

  it("says nothing when every directive named a real check", () => {
    expect(renderTerminal(report())).not.toContain("UNKNOWN SUPPRESSION");
  });
});

// C4b. A delegating route must not read as a clean bill of health. It is surfaced the way a parse
// failure is, because it shrinks the denominator the same way.
describe("reporting a route whose body is in another module", () => {
  const delegated = () =>
    buildReport(
      [
        scanFile("webhooks.v1.stripe.ts", `export { action } from "./handler.server";`)!,
        scanFile(
          "api.v1.a.ts",
          `import { prisma } from "~/db.server";
           export async function loader() { return prisma.thing.findMany(); }`
        )!,
      ],
      []
    );

  it("names the route and says nothing was checked", () => {
    const out = renderTerminal(delegated());
    expect(out).toContain("DELEGATED");
    expect(out).toContain("webhooks.v1.stripe.ts");
    expect(out).toContain("nothing here was checked");
  });

  it("separates it from the entries nothing applied to, in the headline", () => {
    expect(renderTerminal(delegated())).toContain("1 measured, 0 unmeasured, 1 delegated of 2");
  });

  it("carries the file names into the JSON", () => {
    expect(JSON.parse(renderJson(delegated())).delegating).toEqual(["webhooks.v1.stripe.ts"]);
  });

  it("says nothing when every route keeps its body", () => {
    expect(renderTerminal(report())).not.toContain("DELEGATED");
  });
});

// C5. What the composite is made of, disclosed on screen rather than folded into a weight.
describe("reporting what the score is made of", () => {
  it("gives a line per check with applicability, passes and worth", () => {
    const out = renderTerminal(report());
    expect(out).toContain("CHECKS");
    expect(out).toMatch(
      /request-context\s+\d+ applicable,\s+\d+ pass,\s+\d+ sole, global without it/
    );
  });

  it("marks the check that does not feed the score", () => {
    expect(renderTerminal(report())).toMatch(/audit-trail\s+.*not in the score/);
  });

  it("carries the same figures into the JSON", () => {
    const parsed = JSON.parse(renderJson(report()));
    expect(parsed.checkContributions.map((c: { id: string }) => c.id)).toContain("auth-scope");
  });
});

import { scoreEntry, buildReport } from "./score.js";
import { scanFile } from "./scan.js";

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
    const suppressed = `// obs-map-disable error-classification -- health probe
${RAW}`;
    const scored = scoreEntry(scanFile("api.v1.b.ts", suppressed)!);
    const ec = scored.checks.find((c) => c.id === "error-classification")!;
    expect(ec.status).toBe("not-applicable");
  });

  it("a suppressed-to-passing entry point does not read as unmeasured", () => {
    // error-classification would fail here; auth-boundary is not-applicable (not sensitive).
    // Suppressing the only applicable scored check must not be indistinguishable from an entry
    // point nothing applies to: it is still reported, just not scored on that axis.
    const suppressed = `// obs-map-disable error-classification -- health probe
${BUSY_AND_FAILING}`;
    const scored = scoreEntry(scanFile("api.v1.c.ts", suppressed)!);
    expect(scored.checks.find((c) => c.id === "error-classification")!.status).toBe(
      "not-applicable"
    );
    // The point of the test, which it did not previously assert: request-context still applies, so
    // the entry is still measured and still counted in the mean.
    expect(scored.checks.find((c) => c.id === "request-context")!.status).toBe("fail");
    expect(scored.measured).toBe(true);
  });

  // I1. `score = passed / applicable` meant removing a failing check from the denominator raised
  // the entry's score, so suppression laundered findings into points. A suppression buys removal
  // from the worklist, never a better number.
  it("does not raise the score when a failing check is suppressed", () => {
    const source = `import { requireUserId } from "~/services/session.server";
import { prisma } from "~/db.server";
export async function action({ request }) {
  const userId = await requireUserId(request);
  try { return await prisma.token.create({ data: { userId } }); }
  catch (error) { return null; }
}`;
    const plain = scoreEntry(scanFile("api.v1.auth.tokens.ts", source)!);
    const suppressed = scoreEntry(
      scanFile(
        "api.v1.auth.tokens.ts",
        `// obs-map-disable error-classification -- deliberate, see ticket
${source}`
      )!
    );

    expect(plain.checks.find((c) => c.id === "error-classification")!.status).toBe("fail");
    expect(suppressed.checks.find((c) => c.id === "error-classification")!.status).toBe(
      "not-applicable"
    );
    expect(suppressed.score).toBeLessThanOrEqual(plain.score);
  });

  it("records which scored checks were suppressed", () => {
    const suppressed = scoreEntry(
      scanFile(
        "api.v1.b.ts",
        `// obs-map-disable error-classification -- health probe
// obs-map-disable request-context -- nothing to name here
${BUSY_AND_FAILING}`
      )!
    );
    expect(suppressed.suppressed).toEqual(["error-classification", "request-context"]);
  });

  // A1. `measured` reads pre-suppression applicability. Before the fix it read `visible`
  // (post-suppression) applicability, so suppressing an entry's only applicable checks flipped
  // `measured` to false and dropped the entry, still failing, out of the global mean, every family
  // mean and the sensitive cohort. `unmeasured` stays for entries nothing was ever applicable to.
  it("still reads as measured when every applicable scored check is suppressed", () => {
    const suppressed = scoreEntry(
      scanFile(
        "api.v1.b.ts",
        `// obs-map-disable error-classification -- health probe
// obs-map-disable request-context -- nothing to name here
${BUSY_AND_FAILING}`
      )!
    );
    expect(suppressed.measured).toBe(true);
    expect(suppressed.score).toBe(0);
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
  it("reports the request-context gap as a figure, like the audit gap", () => {
    const naming = scanFile(
      "api.v1.named.ts",
      `import { logger } from "~/services/logger.server";
       import { prisma } from "~/db.server";
       export async function loader({ params }) {
         try { return await prisma.thing.findMany(); }
         catch (error) { logger.error("failed", { environmentId: params.envId, error }); throw error; }
       }`
    )!;
    const silent = scanFile(
      "api.v1.silent.ts",
      `import { prisma } from "~/db.server";
       export async function loader() { return prisma.thing.findMany(); }`
    )!;
    const trivial = scanFile(
      "resources.health.ts",
      `export const loader = () => new Response("ok");`
    )!;

    const report = buildReport([naming, silent, trivial], []);
    expect(report.contextGap).toEqual({ applicable: 2, naming: 1 });
  });

  it("counts suppressions so laundering is visible in the report", () => {
    const report = buildReport(
      [
        scanFile(
          "api.v1.b.ts",
          `// obs-map-disable error-classification -- health probe
${BUSY_AND_FAILING}`
        )!,
        scanFile("api.v1.c.ts", BUSY_AND_FAILING)!,
      ],
      []
    );
    expect(report.suppressions).toEqual({ entries: 1, checks: 1 });
  });

  // I4. contextGap and auditGap read `checks` (post-suppression), so suppressing the one failing
  // request-context on an entry removed it from the denominator too, moving CONTEXT from 1 of 2
  // (50%) to 1 of 1 (100%) printed on the same screen as "a suppression does not raise a score".
  // Both gaps now read `rawChecks`, pre-suppression, exactly like `measured`.
  it("does not let a suppressed request-context finding shrink the context gap's denominator", () => {
    const failing = `import { prisma } from "~/db.server";
export async function loader() {
  try { return await prisma.thing.findMany(); } catch (e) { return null; }
}`;
    const passing = `import { logger } from "~/services/logger.server";
import { prisma } from "~/db.server";
export async function loader({ params }) {
  try { return await prisma.thing.findMany(); }
  catch (error) { logger.error("failed", { environmentId: params.envId, error }); throw error; }
}`;

    const before = buildReport([scanFile("a.ts", failing)!, scanFile("b.ts", passing)!], []);
    expect(before.contextGap).toEqual({ applicable: 2, naming: 1 });

    const after = buildReport(
      [
        scanFile(
          "a.ts",
          `// obs-map-disable request-context -- silence
${failing}`
        )!,
        scanFile("b.ts", passing)!,
      ],
      []
    );
    expect(after.contextGap).toEqual({ applicable: 2, naming: 1 });
  });

  // I4, second half. A suppressed audit-trail directive never showed up in `suppressed` because
  // audit-trail is not in SCORED_CHECK_IDS, so the SUPPRESSED line undercounted while the audit
  // denominator silently shrank underneath it. Every suppression is now counted, scored or not.
  it("counts an audit-trail suppression and does not let it shrink the audit gap's denominator", () => {
    const missingAudit = `import { prisma } from "~/db.server";
export async function action() { return prisma.token.create({ data: {} }); }`;
    const withAudit = `import { clearImpersonation } from "~/models/admin.server";
import { prisma } from "~/db.server";
export async function action({ request }) {
  const token = await prisma.token.create({ data: {} });
  await clearImpersonation(request, "/admin");
  return json(token);
}`;

    const before = buildReport(
      [
        scanFile("api.v1.auth.tokens.ts", missingAudit)!,
        scanFile("api.v1.auth.jwt.ts", withAudit)!,
      ],
      []
    );
    expect(before.auditGap).toEqual({ sensitiveMutations: 2, withAudit: 1 });

    const after = buildReport(
      [
        scanFile(
          "api.v1.auth.tokens.ts",
          `// obs-map-disable audit-trail -- accepted risk
${missingAudit}`
        )!,
        scanFile("api.v1.auth.jwt.ts", withAudit)!,
      ],
      []
    );
    expect(after.auditGap).toEqual({ sensitiveMutations: 2, withAudit: 1 });
    expect(after.suppressions).toEqual({ entries: 1, checks: 1 });
  });

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

// A1. `measured` used to read post-suppression (`visible`) applicability, so suppressing an
// entry's only applicable checks removed it from the global mean, every family mean and the
// sensitive cohort, rather than keeping it at its capped score. That is how a suppression with no
// behavioural change moved the global from 17 to 33 tree-wide.
describe("A1: a suppression cannot raise the global", () => {
  it("scoring 100 and 0, suppressing every check on the failing entry leaves the global at 50", () => {
    const passing = scanFile("api.v1.auth.tokens.ts", CLEAN)!;
    const failing = scanFile("api.v1.busy.ts", BUSY_AND_FAILING)!;

    const before = buildReport([passing, failing], []);
    expect(before.global).toBe(50);

    const failingSuppressed = scanFile(
      "api.v1.busy.ts",
      `// obs-map-disable error-classification -- silence
// obs-map-disable request-context -- silence
${BUSY_AND_FAILING}`
    )!;
    const after = buildReport([passing, failingSuppressed], []);

    expect(after.global).toBe(50);
    expect(after.measured).toBe(2);
  });

  // A test suppressing a PASSING check used to sit here and was deleted rather than kept as
  // decoration: the per-entry cap guarantees it on its own, so it passed against the pre-fix code.
});

/**
 * The invariant both ways round. Removing error handling must lower the score, and that direction
 * alone could not see the free-points path: adding a catch that only rethrows used to move a route
 * from not-applicable to pass, worth 27 points across the tree.
 */
describe("no-op error handling must not pay", () => {
  const BODY = `const rows = await prisma.thing.findMany();
    return json({ rows });`;

  const plain = `import { prisma } from "~/db.server";
export async function loader() {
  ${BODY}
}`;

  const wrappedInARethrow = `import { prisma } from "~/db.server";
export async function loader() {
  try {
    ${BODY}
  } catch (e) {
    throw e;
  }
}`;

  const handled = `import { logger } from "~/services/logger.server";
import { prisma } from "~/db.server";
export async function loader({ params }) {
  try {
    ${BODY}
  } catch (error) {
    if (error instanceof NotFoundError) return json({ error: "not found" }, { status: 404 });
    logger.error("thing lookup failed", { environmentId: params.envId, error });
    throw error;
  }
}`;

  it("does not pay for wrapping a body in a catch that only rethrows", () => {
    const before = scoreEntry(scanFile("api.v1.x.ts", plain)!);
    const after = scoreEntry(scanFile("api.v1.x.ts", wrappedInARethrow)!);
    expect(after.score).toBeLessThanOrEqual(before.score);
  });

  // A4. rethrows used to be set by any ThrowStatement anywhere in the clause, dead code included,
  // so appending `throw e;` after a `return` in a swallowing catch flipped error-classification
  // from fail to not-applicable: a mutation with no behavioural effect that hid the swallow.
  it("does not improve the verdict when a dead throw follows a return in a swallowing catch", () => {
    const swallows = `import { prisma } from "~/db.server";
export async function loader() {
  try {
    ${BODY}
  } catch (e) {
    return null;
  }
}`;
    const swallowsWithDeadThrow = `import { prisma } from "~/db.server";
export async function loader() {
  try {
    ${BODY}
  } catch (e) {
    return null;
    throw e;
  }
}`;

    const before = scoreEntry(scanFile("api.v1.x.ts", swallows)!);
    const after = scoreEntry(scanFile("api.v1.x.ts", swallowsWithDeadThrow)!);

    expect(before.checks.find((c) => c.id === "error-classification")!.status).toBe("fail");
    expect(after.checks.find((c) => c.id === "error-classification")!.status).toBe("fail");
    expect(after.score).toBeLessThanOrEqual(before.score);
  });

  it("does not pay for wrapping a whole tree in catches that only rethrow", () => {
    const before = buildReport(
      [scanFile("api.v1.x.ts", plain)!, scanFile("api.v1.y.ts", plain)!],
      []
    );
    const after = buildReport(
      [scanFile("api.v1.x.ts", wrappedInARethrow)!, scanFile("api.v1.y.ts", wrappedInARethrow)!],
      []
    );
    expect(after.global!).toBeLessThanOrEqual(before.global!);
  });

  it("does not pay for deleting error handling either", () => {
    const before = scoreEntry(scanFile("api.v1.x.ts", handled)!);
    const after = scoreEntry(scanFile("api.v1.x.ts", plain)!);
    expect(after.score).toBeLessThanOrEqual(before.score);
    // And the handled version is genuinely better, so the invariant is not holding by both being 0.
    expect(before.score).toBeGreaterThan(after.score);
  });

  it("still credits a catch that decides something on its way through", () => {
    const scored = scoreEntry(scanFile("api.v1.x.ts", handled)!);
    expect(scored.checks.find((c) => c.id === "error-classification")!.status).toBe("pass");
  });
});

// C4b. A route whose body is in another module used to be scored as if it were a redirect stub:
// zero statements, zero callees, `isTrivial` true, every check not-applicable, and a placeholder
// 100 that no mean ever used. The tool said nothing about it at all, so moving a body into a
// `.server.ts` file silently deleted the route from the metric.
describe("a route that delegates its body to another module", () => {
  const DELEGATED = `export { action } from "./handler.server";`;
  const entry = () => scoreEntry(scanFile("webhooks.v1.stripe.ts", DELEGATED)!);

  it("reports every check as not-applicable for the reason that is true", () => {
    const e = entry();
    expect(e.rawChecks.every((c) => c.status === "not-applicable")).toBe(true);
    expect(new Set(e.rawChecks.map((c) => c.detail))).toEqual(
      new Set(["delegates its body to another module"])
    );
  });

  it("is not measured, and says so on the entry", () => {
    const e = entry();
    expect(e.delegating).toBe(true);
    expect(e.measured).toBe(false);
  });

  // request-context would otherwise fail it for leaving its failures to the central handler, which
  // is an accusation about a body this file does not contain.
  it("is not accused of anything the scanner cannot see", () => {
    expect(entry().rawChecks.find((c) => c.id === "request-context")!.status).toBe(
      "not-applicable"
    );
  });

  it("is counted apart from the entries nothing happened to apply to", () => {
    const r = buildReport(
      [scanFile("webhooks.v1.stripe.ts", DELEGATED)!, scanFile("@.ts", TRIVIAL)!],
      []
    );
    expect(r.delegating).toEqual(["webhooks.v1.stripe.ts"]);
    expect(r.unmeasured).toBe(1);
    expect(r.measured).toBe(0);
  });

  it("cannot raise the global, since it is in no mean", () => {
    const withDelegate = buildReport(
      [scanFile("api.v1.b.ts", BUSY_AND_FAILING)!, scanFile("webhooks.v1.stripe.ts", DELEGATED)!],
      []
    );
    const without = buildReport([scanFile("api.v1.b.ts", BUSY_AND_FAILING)!], []);
    expect(withDelegate.global).toBe(without.global);
  });
});

// C5. The composite is disclosed rather than weighted: the reader gets applicability, pass rate,
// how many entries rest on one check alone, and what the global would be without each check.
describe("per-check contribution", () => {
  const r = () =>
    buildReport(
      [
        scanFile("api.v1.a.ts", BUSY_AND_FAILING)!,
        scanFile("api.v1.b.ts", RAW)!,
        scanFile("@.ts", TRIVIAL)!,
      ],
      []
    );

  it("has one row per check, in registry order", () => {
    expect(r().checkContributions.map((c) => c.id)).toEqual([
      "error-classification",
      "auth-boundary",
      "auth-scope",
      "request-context",
      "audit-trail",
    ]);
  });

  it("counts applicability and passes off the pre-suppression results", () => {
    const context = r().checkContributions.find((c) => c.id === "request-context")!;
    expect(context.applicable).toBe(2);
    expect(context.passed).toBe(0);
  });

  // `RAW` has no catch, so request-context is the only scored check that applies to it.
  it("counts the entries that rest on one check alone", () => {
    const rows = r().checkContributions;
    expect(rows.find((c) => c.id === "request-context")!.sole).toBe(1);
    expect(rows.find((c) => c.id === "error-classification")!.sole).toBe(0);
  });

  it("says what the global would be without each scored check", () => {
    const report = r();
    expect(report.global).toBe(0);
    const errors = report.checkContributions.find((c) => c.id === "error-classification")!;
    expect(errors.scored).toBe(true);
    expect(errors.globalWithout).toBe(0);
  });

  it("gives no without-figure for a check that is not in the score", () => {
    const audit = r().checkContributions.find((c) => c.id === "audit-trail")!;
    expect(audit.scored).toBe(false);
    expect(audit.globalWithout).toBeNull();
  });

  // Taking the only applicable check away leaves nothing measured, which is an absence and not a
  // perfect score.
  it("gives a null without-figure when nothing would be left measured", () => {
    const only = buildReport([scanFile("api.v1.b.ts", RAW)!], []);
    expect(
      only.checkContributions.find((c) => c.id === "request-context")!.globalWithout
    ).toBeNull();
  });
});

// C4b, stated as the property rather than as a shape. Moving a body into a `.server.ts` file is an
// ordinary refactor: it must not delete the route from the metric silently. The corpus cannot hold
// this one, because its per-route assertion reads "dropped out of the measured set" as a rise, and
// dropping out is the correct outcome here. What is forbidden is dropping out QUIETLY.
describe("refactoring a body out of the route file", () => {
  const BEFORE = `import { prisma } from "~/db.server";
export async function action() {
  try { return await prisma.thing.create({ data: {} }); } catch (e) { return null; }
}`;
  const AFTER = `export { action } from "./handler.server";`;

  it("leaves the mean, and is reported instead of being dropped", () => {
    const before = buildReport([scanFile("webhooks.v1.stripe.ts", BEFORE)!], []);
    const after = buildReport([scanFile("webhooks.v1.stripe.ts", AFTER)!], []);

    expect(before.measured).toBe(1);
    expect(before.global).toBe(0);
    expect(after.measured).toBe(0);
    expect(after.global).toBeNull();
    expect(after.delegating).toEqual(["webhooks.v1.stripe.ts"]);
    expect(after.unmeasured).toBe(0);
  });
});

/**
 * `contextGap` and `auditGap` are the arithmetic `checkContributions` already does, written out again
 * by hand for two named ids, on the two figures the report puts in front of a reader as headlines.
 * Pinned rather than shared: what matters is that three spellings of "applicable, and how many
 * passed" cannot disagree, and an assertion says that without moving code the renderers read.
 */
describe("the hand-rolled gap figures agree with the per-check contributions", () => {
  const SOURCE = `import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
export async function action({ params }) {
  try {
    return await prisma.apiKey.create({ data: { orgId: params.orgId } });
  } catch (e) {
    logger.error("failed", { orgId: params.orgId });
    return null;
  }
}`;

  // A sensitive mutation that DOES record an audit event, so `withAudit` is not simply
  // `sensitiveMutations`. Without it the audit assertion held whatever the numerator counted.
  const AUDITED = `import { prisma } from "~/db.server";
import { startImpersonation } from "~/models/admin.server";
export async function action({ request, params }) {
  const session = await startImpersonation(request, params.userId);
  await prisma.apiKey.create({ data: { orgId: params.orgId } });
  return redirect("/", { headers: session });
}`;

  const report = buildReport(
    [
      scanFile("api.v1.orgs.$orgId.apikeys.ts", SOURCE)!,
      scanFile("api.v1.tokens.ts", SOURCE)!,
      scanFile("resources.impersonation.ts", AUDITED)!,
      scanFile("healthcheck.ts", `export const loader = () => new Response("ok");`)!,
    ],
    []
  );

  const contribution = (id: string) => report.checkContributions.find((c) => c.id === id)!;

  it("reports the same request-context denominator and numerator", () => {
    expect(report.contextGap.applicable).toBe(contribution("request-context").applicable);
    expect(report.contextGap.naming).toBe(contribution("request-context").passed);
  });

  it("reports the same audit-trail denominator and numerator", () => {
    expect(report.auditGap.sensitiveMutations).toBe(contribution("audit-trail").applicable);
    expect(report.auditGap.withAudit).toBe(contribution("audit-trail").passed);
  });

  // A denominator of zero would make both assertions above hold vacuously.
  // Both assertions above hold vacuously on a zero denominator, and the audit one holds vacuously
  // whenever every applicable route fails, since the two counts coincide.
  it("measured something for both of them, with the audit numerator strictly between", () => {
    expect(report.contextGap.applicable).toBeGreaterThan(0);
    expect(report.auditGap.withAudit).toBeGreaterThan(0);
    expect(report.auditGap.withAudit).toBeLessThan(report.auditGap.sensitiveMutations);
  });
});

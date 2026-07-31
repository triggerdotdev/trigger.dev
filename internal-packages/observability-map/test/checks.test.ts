import { CHECKS, SCORED_CHECK_IDS } from "../src/checks/index.js";
import { scanFile } from "../src/scan.js";

const run = (id: string, fileName: string, source: string) => {
  const ep = scanFile(fileName, source)!;
  return CHECKS.find((c) => c.id === id)!.run(ep);
};

/**
 * The React component that lives alongside the loader in a `.tsx` route. Every check reads
 * body-scoped evidence, so nothing in here may change a verdict: it try/catches, it logs, it names
 * every request identifier the checks look for, and it calls an auth helper.
 */
const COMPONENT = `
  export default function Page() {
    const { environmentId, organizationId, projectId, runId } = useTypedLoaderData<typeof loader>();
    useEffect(() => {
      try {
        requireUserId(environmentId);
        logger.error("render failed", { environmentId, organizationId, projectId, runId });
      } catch (e) {
        if (e instanceof Error) return;
        throw e;
      }
    }, [environmentId]);
    return <div>{runId}</div>;
  }
`;

describe("registry", () => {
  it("holds the four checks, with audit-trail left out of the score", () => {
    expect(CHECKS.map((c) => c.id)).toEqual([
      "error-classification",
      "auth-boundary",
      "request-context",
      "audit-trail",
    ]);
    expect(SCORED_CHECK_IDS).toEqual(["error-classification", "auth-boundary", "request-context"]);
  });
});

describe("error-classification", () => {
  // C1. A route with no catch makes no classification decision, so there is nothing here to judge
  // and nothing to credit. Crediting it made deleting error handling raise the score.
  it("is not applicable to a builder-wrapped route with no local try/catch", () => {
    const r = run(
      "error-classification",
      "api.v1.x.ts",
      `import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";
       export const loader = createLoaderApiRoute({}, async () => new Response("ok"));`
    );
    expect(r.status).toBe("not-applicable");
  });

  it("fails a raw route whose catch swallows every error identically", () => {
    const r = run(
      "error-classification",
      "api.v1.y.ts",
      `import { prisma } from "~/db.server";
       export async function loader() {
         try { return await prisma.thing.findMany(); } catch (e) { return null; }
       }`
    );
    expect(r.status).toBe("fail");
  });

  // Restored from the brief: `catchBranches` sees the `instanceof` and the `if`.
  it("passes a raw route whose catch branches on the error", () => {
    const r = run(
      "error-classification",
      "api.v1.z.ts",
      `import { prisma } from "~/db.server";
       export async function loader() {
         try { return await prisma.thing.findMany(); }
         catch (e) { if (e instanceof NotFound) return null; throw e; }
       }`
    );
    expect(r.status).toBe("pass");
  });

  it("passes a raw route whose catch rethrows without branching", () => {
    const r = run(
      "error-classification",
      "api.v1.v.ts",
      `import { logger } from "~/services/logger.server";
       import { prisma } from "~/db.server";
       export async function loader() {
         try { return await prisma.thing.findMany(); }
         catch (e) { logger.error("thing lookup failed", { error: e }); throw e; }
       }`
    );
    expect(r.status).toBe("pass");
  });

  // The builder only classifies what reaches it. A swallow inside the handler never does, so the
  // swallow is read before the builder is credited.
  it("fails a builder-wrapped route whose handler swallows", () => {
    const r = run(
      "error-classification",
      "api.v2.runs.$runParam.cancel.ts",
      `import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
       import { CancelTaskRunService } from "~/services/cancelTaskRun.server";
       const { action } = createActionApiRoute({}, async ({ params }) => {
         const service = new CancelTaskRunService();
         try { await service.call(params.runParam); }
         catch { return json({ error: "Internal Server Error" }, { status: 500 }); }
         return json({ ok: true });
       });
       export { action };`
    );
    expect(r.status).toBe("fail");
  });

  it("is not applicable to a raw route that lets its errors propagate", () => {
    const r = run(
      "error-classification",
      "api.v1.w.ts",
      `import { prisma } from "~/db.server";
       export async function loader() {
         const rows = await prisma.thing.findMany();
         return json({ rows });
       }`
    );
    expect(r.status).toBe("not-applicable");
  });

  it("is not applicable to a trivial redirect", () => {
    const r = run(
      "error-classification",
      "@.ts",
      `import { redirect } from "@remix-run/server-runtime";
       export async function loader() { return redirect("/admin"); }`
    );
    expect(r.status).toBe("not-applicable");
  });

  // A narrow guard around one operation classifies an expected failure without needing to branch
  // or rethrow. `catchesNarrowly` is what tells it apart from a handler-wide catch.
  it("passes a narrow guard around a single parse", () => {
    const r = run(
      "error-classification",
      "resources.timezone.ts",
      `import { prisma } from "~/db.server";
       export async function action({ request }) {
         let data;
         try { data = await request.json(); }
         catch { return json({ error: "Invalid JSON" }, { status: 400 }); }
         const saved = await prisma.preference.create({ data });
         return json({ saved });
       }`
    );
    expect(r.status).toBe("pass");
  });

  // False positive fixture for the narrow rule: a narrow parse guard must not launder the broad
  // handler catch sitting next to it. `catchesNarrowly` is false when any guarded try is broad.
  it("still fails when a narrow guard sits beside a handler-wide swallow", () => {
    const r = run(
      "error-classification",
      "api.v1.thing.ts",
      `import { prisma } from "~/db.server";
       export async function action({ request }) {
         let data;
         try { data = await request.json(); }
         catch { return json({ error: "Invalid JSON" }, { status: 400 }); }
         try {
           const thing = await prisma.thing.create({ data });
           const audit = await prisma.audit.create({ data: { thing: thing.id } });
           return json({ thing, audit });
         } catch (error) {
           return json({ error: "Something went wrong" }, { status: 500 });
         }
       }`
    );
    expect(r.status).toBe("fail");
  });

  // try/finally with no catch clause. `hasTryCatch` is true here and `catches` is empty, and it is
  // `catches` that answers "does this route catch anything". Nothing is swallowed: the error
  // propagates once the connection is closed.
  it("is not applicable to a try/finally that catches nothing", () => {
    const r = run(
      "error-classification",
      "admin.api.v1.runs-replication.status.ts",
      `import Redis from "ioredis";
       export async function loader() {
         const redis = new Redis({ host: "localhost" });
         try {
           const exists = await redis.exists("some-key");
           const other = await redis.exists("other-key");
           return json({ exists, other });
         } finally {
           await redis.quit();
         }
       }`
    );
    expect(r.status).toBe("not-applicable");
  });

  // Multi-catch, the case the aggregate booleans could not describe. Judged per clause: the parse
  // guard is a guard, the handler catch rethrows, so both are accounted for.
  it("passes a parse guard sitting beside a handler catch that rethrows", () => {
    const r = run(
      "error-classification",
      "api.v1.thing.ts",
      `import { logger } from "~/services/logger.server";
       import { prisma } from "~/db.server";
       export async function action({ request }) {
         let data;
         try { data = await request.json(); }
         catch { return json({ error: "Invalid JSON" }, { status: 400 }); }
         try {
           const thing = await prisma.thing.create({ data });
           const audit = await prisma.audit.create({ data: { thing: thing.id } });
           const count = await prisma.thing.count();
           return json({ thing, audit, count });
         } catch (error) {
           logger.error("create failed", { error });
           throw error;
         }
       }`
    );
    expect(r.status).toBe("pass");
  });

  // A parse guard that has grown to cover the handler is not a guard any more. `otel.v1.logs.ts`
  // catches 15 of its 18 statements around a `request.json()` and answers 500 for all of them.
  it("fails a parse guard that covers most of the body", () => {
    const r = run(
      "error-classification",
      "otel.v1.logs.ts",
      `import { otlpExporter } from "~/v3/otlpExporter.server";
       export async function action({ request }) {
         try {
           const exporter = await otlpExporter;
           const contentType = request.headers.get("content-type");
           const body = await request.json();
           const result = await exporter.exportLogs(body);
           const encoded = encodeResponse(result);
           const headers = buildHeaders(contentType);
           return new Response(encoded, { status: 200, headers });
         } catch (error) {
           console.error(error);
           return new Response("Internal Server Error", { status: 500 });
         }
       }`
    );
    expect(r.status).toBe("fail");
  });

  // False positive fixture: the only try/catch in the file belongs to the component.
  it("does not judge a route whose try/catch is in the React component", () => {
    const r = run(
      "error-classification",
      "_app.orgs.$organizationSlug.things/route.tsx",
      `import { prisma } from "~/db.server";
       export async function loader() {
         const rows = await prisma.thing.findMany();
         return typedjson({ rows });
       }
       ${COMPONENT}`
    );
    expect(r.status).toBe("not-applicable");
  });
});

describe("auth-boundary", () => {
  it("passes a sensitive route guarded by a require helper", () => {
    const r = run(
      "auth-boundary",
      "admin.api.v1.gc.ts",
      `import { requireAdminApiRequest } from "~/services/personalAccessToken.server";
       import { prisma } from "~/db.server";
       export async function loader({ request }) {
         await requireAdminApiRequest(request);
         return prisma.thing.findMany();
       }`
    );
    expect(r.status).toBe("pass");
  });

  it("passes a sensitive route guarded by an authenticate helper", () => {
    const r = run(
      "auth-boundary",
      "api.v1.tokens.ts",
      `import { authenticateApiRequest } from "~/services/apiAuth.server";
       import { prisma } from "~/db.server";
       export async function loader({ request }) {
         const auth = await authenticateApiRequest(request);
         if (!auth) throw new Response(null, { status: 401 });
         return prisma.token.findMany();
       }`
    );
    expect(r.status).toBe("pass");
  });

  it("fails a sensitive route with no guard", () => {
    const r = run(
      "auth-boundary",
      "api.v1.tokens.ts",
      `import { prisma } from "~/db.server";
       export async function loader() {
         const tokens = await prisma.token.findMany();
         return json({ tokens });
       }`
    );
    expect(r.status).toBe("fail");
  });

  it("is not applicable to a non-sensitive route", () => {
    const r = run(
      "auth-boundary",
      "api.v1.timezones.ts",
      `import { prisma } from "~/db.server";
       export async function loader() { return prisma.tz.findMany(); }`
    );
    expect(r.status).toBe("not-applicable");
  });

  // False positive fixture for the delegated guard. `clearImpersonation` authenticates and writes
  // an audit row, in `app/models/admin.server.ts`, which the scanner cannot open. The body shows no
  // privileged work either, so there is nothing here to accuse: absence of evidence, not evidence
  // of absence.
  it("does not flag a sensitive route that hands its work to an imported helper", () => {
    const r = run(
      "auth-boundary",
      "resources.impersonation.ts",
      `import { clearImpersonation } from "~/models/admin.server";
       export async function action({ request }) {
         return clearImpersonation(request, "/admin");
       }`
    );
    expect(r.status).toBe("not-applicable");
    expect(r.detail).toMatch(/verif/i);
  });

  it("does not flag a sensitive redirect stub", () => {
    const r = run(
      "auth-boundary",
      "orgs.$organizationSlug.billing.ts",
      `import { redirect } from "@remix-run/server-runtime";
       import { OrganizationParamsSchema, v3BillingPath } from "~/utils/pathBuilder";
       export const loader = async ({ params }) => {
         const { organizationSlug } = OrganizationParamsSchema.parse(params);
         return redirect(v3BillingPath({ slug: organizationSlug }));
       };`
    );
    expect(r.status).toBe("not-applicable");
  });

  // The gate must not swallow the real thing: a body doing its own privileged work, unguarded.
  it("still fails a sensitive route whose visible body does the work unguarded", () => {
    const r = run(
      "auth-boundary",
      "api.v1.token.ts",
      `import { prisma } from "~/db.server";
       import { createPersonalAccessToken } from "~/services/personalAccessToken.server";
       export async function action({ request }) {
         const body = await request.json();
         const code = await prisma.authorizationCode.findFirst({ where: { code: body.code } });
         if (!code) return json({ error: "Not found" }, { status: 404 });
         const token = await createPersonalAccessToken(code.userId);
         return json({ token });
       }`
    );
    expect(r.status).toBe("fail");
  });

  // Possession of a valid signature is the auth boundary for a callback URL.
  it("passes a sensitive callback guarded by a signature check", () => {
    const r = run(
      "auth-boundary",
      "api.v1.waitpoints.tokens.$waitpointFriendlyId.callback.$hash.ts",
      `import { verifyHttpCallbackHash } from "~/services/httpCallback.server";
       import { prisma } from "~/db.server";
       export async function action({ request, params }) {
         const waitpoint = await prisma.waitpoint.findFirst({ where: { id: params.id } });
         if (!verifyHttpCallbackHash(params.hash, waitpoint)) {
           return json({ error: "Invalid" }, { status: 401 });
         }
         return json({ ok: true });
       }`
    );
    expect(r.status).toBe("pass");
  });

  // False positive fixture: the guard sits one hop away, in a same-file helper.
  it("does not flag a sensitive route whose guard is in a same-file helper", () => {
    const r = run(
      "auth-boundary",
      "api.v1.tokens.ts",
      `import { requireUserId } from "~/services/session.server";
       import { prisma } from "~/db.server";
       async function loadTokens(request) {
         const userId = await requireUserId(request);
         return prisma.token.findMany({ where: { userId } });
       }
       export async function loader({ request }) { return json(await loadTokens(request)); }`
    );
    expect(r.status).toBe("pass");
  });

  // The guard has to be called, not merely imported: importedNames is file-wide.
  it("fails a sensitive route that imports a guard it never calls", () => {
    const r = run(
      "auth-boundary",
      "api.v1.tokens.ts",
      `import { requireUserId } from "~/services/session.server";
       import { prisma } from "~/db.server";
       export async function loader() {
         const tokens = await prisma.token.findMany();
         return json({ tokens });
       }
       export function meta() { return requireUserId; }`
    );
    expect(r.status).toBe("fail");
  });
});

describe("request-context", () => {
  it("passes a route whose failure log names an identifier", () => {
    const r = run(
      "request-context",
      "engine.v1.dev.config.ts",
      `import { logger } from "~/services/logger.server";
       import { prisma } from "~/db.server";
       export async function loader({ params }) {
         try { return await prisma.thing.findMany(); }
         catch (error) {
           logger.error("dev config failed", { environmentId: params.envId, error });
           throw error;
         }
       }`
    );
    expect(r.status).toBe("pass");
  });

  it("passes on a route param, which names the tenant just as well", () => {
    const r = run(
      "request-context",
      "resources.things.ts",
      `import { logger } from "~/services/logger.server";
       import { prisma } from "~/db.server";
       export async function loader({ params }) {
         try { return await prisma.thing.findMany(); }
         catch (error) {
           logger.error("lookup failed", { organizationSlug: params.organizationSlug, error });
           throw error;
         }
       }`
    );
    expect(r.status).toBe("pass");
  });

  it("fails a failure log that carries only the error", () => {
    const r = run(
      "request-context",
      "api.v1.r.ts",
      `import { logger } from "~/services/logger.server";
       import { prisma } from "~/db.server";
       export async function loader() {
         try { return await prisma.thing.findMany(); }
         catch (error) { logger.error("failed", { error }); throw error; }
       }`
    );
    expect(r.status).toBe("fail");
  });

  it("fails a bare failure log with no object argument at all", () => {
    const r = run(
      "request-context",
      "api.v1.r.ts",
      `import { logger } from "~/services/logger.server";
       import { prisma } from "~/db.server";
       export async function loader() {
         try { return await prisma.thing.findMany(); } catch (e) { logger.error("failed"); throw e; }
       }`
    );
    expect(r.status).toBe("fail");
  });

  // The builder logs `{ error, url }` at its boundary and nothing that names a tenant, so being
  // wrapped in one earns no pass here. This is what stops the check echoing `auth-boundary`.
  it("fails a builder-wrapped route whose own failure log names nobody", () => {
    const r = run(
      "request-context",
      "api.v1.q.ts",
      `import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";
       import { logger } from "~/services/logger.server";
       import { prisma } from "~/db.server";
       export const loader = createLoaderApiRoute({}, async () => {
         try { return json(await prisma.thing.findMany()); }
         catch (error) { logger.error("failed", { error }); throw error; }
       });`
    );
    expect(r.status).toBe("fail");
  });

  // C1. The global handler carries requestId, path, host and method, and no tenant. A route that
  // never catches cannot name one, so it fails rather than being credited or excused.
  it("fails a route that leaves everything to the central handler", () => {
    const r = run(
      "request-context",
      "api.v1.q.ts",
      `import { authenticateApiRequest } from "~/services/apiAuth.server";
       import { prisma } from "~/db.server";
       export async function loader({ request }) {
         const auth = await authenticateApiRequest(request);
         return json(await prisma.thing.findMany({ where: { environmentId: auth.environment.id } }));
       }`
    );
    expect(r.status).toBe("fail");
  });

  it("fails a route that catches but only names an identifier outside the catch", () => {
    const r = run(
      "request-context",
      "api.v1.q.ts",
      `import { logger } from "~/services/logger.server";
       import { prisma } from "~/db.server";
       export async function loader() {
         logger.info("starting", { environmentId: "env_1" });
         try { return await prisma.thing.findMany(); } catch (e) { throw e; }
       }`
    );
    expect(r.status).toBe("fail");
  });

  // A route that catches and reports nothing at all is the case the log-based applicability gate
  // used to excuse. It is a finding, not an exemption.
  it("fails a route that catches and reports nothing", () => {
    const r = run(
      "request-context",
      "api.v1.q.ts",
      `import { prisma } from "~/db.server";
       export async function loader() {
         try { return await prisma.thing.findMany(); }
         catch (error) { return json({ error: "Internal Server Error" }, { status: 500 }); }
       }`
    );
    expect(r.status).toBe("fail");
  });

  // A guard around a parse is not the route taking over its failure path: whatever its real work
  // throws still reaches the central handler. Same reading error-classification gives the field.
  it("fails a route whose only catch guards a parse", () => {
    const r = run(
      "request-context",
      "api.v1.q.ts",
      `import { prisma } from "~/db.server";
       export async function loader({ request }) {
         let body;
         try { body = await request.json(); }
         catch { return json({ error: "Invalid JSON" }, { status: 400 }); }
         return json(await prisma.thing.findMany({ where: body }));
       }`
    );
    expect(r.status).toBe("fail");
  });

  // Was a known false positive: `new URL()` is a constructor, so the parse was invisible while the
  // evidence came from `calleeTexts`. `CatchEvidence.guardsParse` covers constructors, so the guard
  // is legible now and the route is no longer judged as though it kept its failures.
  it("fails a route whose only catch guards a constructor parse", () => {
    const r = run(
      "request-context",
      "_app.@.orgs.$organizationSlug.$.tsx",
      `import { prisma } from "~/db.server";
       function refererOrigin(request) {
         const referer = request.headers.get("referer");
         try { return new URL(referer).origin; }
         catch { return undefined; }
       }
       export async function loader({ request }) {
         const origin = refererOrigin(request);
         return typedjson({ origin, things: await prisma.thing.findMany() });
       }`
    );
    expect(r.status).toBe("fail");
  });

  it("fails a try/finally that catches nothing", () => {
    const r = run(
      "request-context",
      "admin.api.v1.runs-replication.status.ts",
      `import Redis from "ioredis";
       export async function loader() {
         const redis = new Redis({ host: "localhost" });
         try {
           const exists = await redis.exists("some-key");
           return json({ exists });
         } finally {
           await redis.quit();
         }
       }`
    );
    expect(r.status).toBe("fail");
  });

  it("still judges a route with a handler-wide catch beside a narrow guard", () => {
    const r = run(
      "request-context",
      "api.v1.q.ts",
      `import { logger } from "~/services/logger.server";
       import { prisma } from "~/db.server";
       export async function loader({ request }) {
         let body;
         try { body = await request.json(); }
         catch { return json({ error: "Invalid JSON" }, { status: 400 }); }
         try {
           const rows = await prisma.thing.findMany({ where: body });
           const count = await prisma.thing.count();
           return json({ rows, count });
         } catch (error) {
           logger.error("failed", { error });
           return json({ error: "Internal Server Error" }, { status: 500 });
         }
       }`
    );
    expect(r.status).toBe("fail");
  });

  // The incentive fixture pair. The two routes differ by one line, the log call, and nothing else.
  // Deleting that line must never improve the verdict or drop the route out of the report.
  it("never improves a verdict when the log call is deleted", () => {
    const body = (log: string) =>
      `import { logger } from "~/services/logger.server";
       import { prisma } from "~/db.server";
       export async function loader({ params }) {
         try { return await prisma.thing.findMany(); }
         catch (error) { ${log} throw error; }
       }`;

    const withLog = run(
      "request-context",
      "api.v1.q.ts",
      body(`logger.error("failed", { environmentId: params.envId, error });`)
    );
    const withoutLog = run("request-context", "api.v1.q.ts", body(""));

    expect(withLog.status).toBe("pass");
    expect(withoutLog.status).toBe("fail");
    expect(withoutLog.status).not.toBe("not-applicable");
  });

  // False positive fixture: the component logs every identifier there is, inside its own catch.
  // Only the loader's own failure log may decide this.
  it("does not read the React component's log calls", () => {
    const bare = run(
      "request-context",
      "_app.orgs.$organizationSlug.things/route.tsx",
      `import { logger } from "~/services/logger.server";
       import { prisma } from "~/db.server";
       export async function loader() {
         try { return typedjson(await prisma.thing.findMany()); }
         catch (error) { logger.error("failed", { error }); throw error; }
       }
       ${COMPONENT}`
    );
    expect(bare.status).toBe("fail");

    const attributed = run(
      "request-context",
      "_app.orgs.$organizationSlug.things/route.tsx",
      `import { logger } from "~/services/logger.server";
       import { prisma } from "~/db.server";
       export async function loader({ params }) {
         try { return typedjson(await prisma.thing.findMany()); }
         catch (error) { logger.error("failed", { projectParam: params.projectParam, error }); throw error; }
       }
       ${COMPONENT}`
    );
    expect(attributed.status).toBe("pass");
  });

  it("is not applicable to a trivial redirect", () => {
    const r = run(
      "request-context",
      "@.ts",
      `import { redirect } from "@remix-run/server-runtime";
       export async function loader() { return redirect("/admin"); }`
    );
    expect(r.status).toBe("not-applicable");
  });
});

describe("audit-trail", () => {
  it("is applicable only to sensitive mutations", () => {
    const readOnly = run(
      "audit-trail",
      "api.v1.auth.jwt.ts",
      `export async function loader() { return 1; }`
    );
    expect(readOnly.status).toBe("not-applicable");

    const mutation = run(
      "audit-trail",
      "api.v1.auth.jwt.ts",
      `import { prisma } from "~/db.server";
       export async function action() { return prisma.token.create({ data: {} }); }`
    );
    expect(mutation.status).toBe("fail");
  });

  // False positive fixture: an ordinary mutation is not an audit target.
  it("is not applicable to a non-sensitive mutation", () => {
    const r = run(
      "audit-trail",
      "resources.things.ts",
      `import { prisma } from "~/db.server";
       export async function action() { return prisma.thing.create({ data: {} }); }`
    );
    expect(r.status).toBe("not-applicable");
  });

  it("passes a sensitive mutation that records an audit event", () => {
    const r = run(
      "audit-trail",
      "api.v1.auth.jwt.ts",
      `import { auditLog } from "~/services/audit.server";
       import { prisma } from "~/db.server";
       export async function action({ request }) {
         const token = await prisma.token.create({ data: {} });
         await auditLog("token.created", { tokenId: token.id });
         return json(token);
       }`
    );
    expect(r.status).toBe("pass");
  });
});

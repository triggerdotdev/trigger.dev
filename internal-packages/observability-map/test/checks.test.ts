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
  it("passes a builder-wrapped route with no local try/catch", () => {
    const r = run(
      "error-classification",
      "api.v1.x.ts",
      `import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";
       export const loader = createLoaderApiRoute({}, async () => new Response("ok"));`
    );
    expect(r.status).toBe("pass");
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

  it("passes a raw route that lets its errors propagate", () => {
    const r = run(
      "error-classification",
      "api.v1.w.ts",
      `import { prisma } from "~/db.server";
       export async function loader() {
         const rows = await prisma.thing.findMany();
         return json({ rows });
       }`
    );
    expect(r.status).toBe("pass");
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

  // False positive fixture: the only try/catch in the file belongs to the component.
  it("does not flag a route whose try/catch is in the React component", () => {
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
    expect(r.status).toBe("pass");
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

  it("is not applicable to a route that logs nothing on its failure path", () => {
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
    expect(r.status).toBe("not-applicable");
  });

  it("is not applicable when the only log sits outside the catch", () => {
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
    expect(r.status).toBe("not-applicable");
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

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

  // Restored from the brief: the clause branches, on the `instanceof` and the `if`.
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

  // A clause that only rethrows makes no classification decision: the error propagates exactly as
  // it would with no catch at all, so it is read as no catch at all. Scoring the two differently
  // paid 50 points a route for wrapping a body in `try { ... } catch (e) { throw e }`.
  it("is not applicable to a raw route whose catch only rethrows", () => {
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
    expect(r.status).toBe("not-applicable");
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
  // or rethrow. Guarding a parse over a small part of the body is what tells it apart from a
  // handler-wide catch.
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

  // I6. NARROW_TRY_STATEMENTS is an absolute count over the try block alone (guardsParse still
  // required), not a ratio against the enclosing body, so it holds the exact boundary regardless of
  // how big or small the rest of the function is: two statements binds the parsed result and still
  // passes, a third means the try has started to cover the handler and fails, even though both
  // guard the same parse.
  it("passes a parse guard that binds its result in exactly two statements", () => {
    const r = run(
      "error-classification",
      "resources.pattern.ts",
      `export async function action({ request }) {
         let parsed;
         try {
           const raw = await request.text();
           parsed = new RegExp(raw);
         } catch {
           return json({ error: "Invalid pattern" }, { status: 400 });
         }
         return json({ parsed: parsed.source });
       }`
    );
    expect(r.status).toBe("pass");
  });

  // C5. The count is not the only condition any more, and this is the shape that showed why: two
  // statements, one of them a parse, and the whole handler inside the try. Before `awaitsOnlyParse`
  // the count read it as a narrow guard and passed it, which is the `otel.v1.logs.ts` swallow
  // written compactly. Three spellings of the same thing, all of which the count reads as narrow.
  const COMPACT_SWALLOWS: Array<[string, string]> = [
    [
      "two statements",
      `try { const body = await request.json(); return await handleEverything(body); }
       catch (error) { return new Response("Internal Server Error", { status: 500 }); }`,
    ],
    [
      "one statement, the parse nested inside the call",
      `try { return await handleEverything(await request.json()); }
       catch (error) { return new Response("Internal Server Error", { status: 500 }); }`,
    ],
    [
      "one statement, merged into a declaration list",
      `try { const body = await request.json(), out = await handleEverything(body); return out; }
       catch (error) { return new Response("Internal Server Error", { status: 500 }); }`,
    ],
  ];

  for (const [label, body] of COMPACT_SWALLOWS) {
    it(`fails a whole handler wrapped in a parse-guard-shaped try (${label})`, () => {
      const r = run(
        "error-classification",
        "otel.v1.logs.ts",
        `export async function action({ request }) {\n${body}\n}`
      );
      expect(r.status).toBe("fail");
    });
  }

  // The counterpart: the same route with the handler moved out of the try is a real guard and
  // still passes, so the rule above is not just "any try containing an await fails".
  it("passes the same route once the handler moves out of the try", () => {
    const r = run(
      "error-classification",
      "otel.v1.logs.ts",
      `export async function action({ request }) {
         let body;
         try { body = await request.json(); }
         catch { return json({ error: "bad json" }, { status: 400 }); }
         return await handleEverything(body);
       }`
    );
    expect(r.status).toBe("pass");
  });

  // Synchronous string work preparing a parse's input is not what `awaitsOnlyParse` refuses. Four
  // real routes are this shape, `admin.llm-models.new.tsx` among them.
  it("passes a guard that prepares its input synchronously before parsing", () => {
    const r = run(
      "error-classification",
      "admin.llm-models.new.tsx",
      `export async function action({ request }) {
         const matchPattern = String(await request.text());
         try {
           const testPattern = matchPattern.startsWith("(?i)") ? matchPattern.slice(4) : matchPattern;
           new RegExp(testPattern);
         } catch {
           return json({ error: "Invalid regex" }, { status: 400 });
         }
         return await save(matchPattern);
       }`
    );
    expect(r.status).toBe("pass");
  });

  it("fails a parse guard that takes a third statement beyond binding the result", () => {
    const r = run(
      "error-classification",
      "resources.pattern.ts",
      `export async function action({ request }) {
         let parsed;
         try {
           const raw = await request.text();
           const trimmed = raw.trim();
           parsed = new RegExp(trimmed);
         } catch {
           return json({ error: "Invalid pattern" }, { status: 400 });
         }
         return json({ parsed: parsed.source });
       }`
    );
    expect(r.status).toBe("fail");
  });

  // False positive fixture for the narrow rule: a narrow parse guard must not launder the broad
  // handler catch sitting next to it. Clauses are judged one at a time, so the broad one still
  // counts against the entry point.
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

  // A6. isParseGuard compared the clause against ep.statementCount, the loader and the action and
  // every one-hop helper summed together, rather than the statements of the body the clause is
  // actually in. So an unrelated sibling handler or a fat helper in the same file diluted the
  // denominator and relabelled the same broad swallow as a narrow parse guard. Byte-identical
  // action, verdict must not move.
  it("gives the same verdict to a byte-identical swallow whether or not an unrelated sibling and helper share the file", () => {
    const action = `import { otlpExporter } from "~/v3/otlpExporter.server";
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
       }`;

    const withUnrelatedSiblingAndHelper = `${action}
       function unrelatedHelper() {
         let total = 0;
         total += 1;
         total += 2;
         total += 3;
         total += 4;
         total += 5;
         total += 6;
         total += 7;
         total += 8;
         total += 9;
         total += 10;
         total += 11;
         return total;
       }
       export async function loader() {
         const helperTotal = unrelatedHelper();
         return new Response(String(helperTotal));
       }`;

    const alone = run("error-classification", "otel.v1.logs.ts", action);
    const withSiblingAndHelper = run(
      "error-classification",
      "otel.v1.logs.ts",
      withUnrelatedSiblingAndHelper
    );

    expect(alone.status).toBe("fail");
    expect(withSiblingAndHelper.status).toBe("fail");
  });

  // I6. Moving the denominator from the entry point to the enclosing body (A6) closed
  // cross-body dilution but not same-body dilution: the rule was still a ratio, "unrelated
  // statements dilute", wherever the unrelated statements live. Padding the SAME action with 11
  // inert statements after the try relabelled the identical broad swallow from fail to pass.
  // isParseGuard is now an absolute count over the try block alone (NARROW_TRY_STATEMENTS),
  // which nothing outside the try can dilute, in the same body or another.
  it("gives the same verdict to a byte-identical swallow whether or not it is padded with inert statements in the same body", () => {
    const action = `import { otlpExporter } from "~/v3/otlpExporter.server";
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
       }`;

    const padding = Array.from({ length: 11 }, (_, i) => `const pad${i} = ${i};`).join("\n");
    const paddedInSameBody = `import { otlpExporter } from "~/v3/otlpExporter.server";
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
         ${padding}
         return new Response("unreachable", { status: 200 });
       }`;

    const alone = run("error-classification", "otel.v1.logs.ts", action);
    const padded = run("error-classification", "otel.v1.logs.ts", paddedInSameBody);

    expect(alone.status).toBe("fail");
    expect(padded.status).toBe("fail");
  });

  // A3. `referencesBinding` used to match any identifier with the binding's text, including a
  // property name in a member expression. A catch whose only `if` tests `fallback.error`, never the
  // caught binding itself, was credited with classifying an error it never inspected.
  it("fails a catch whose only if tests a same-named property, not the caught error", () => {
    const r = run(
      "error-classification",
      "api.v1.y.ts",
      `import { prisma } from "~/db.server";
       export async function loader() {
         try { return await prisma.thing.findMany(); }
         catch (error) {
           if (fallback.error) return json({}, { status: 500 });
           return json({}, { status: 500 });
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

  // A7 as revised. A per-item error boundary inside a `.map()` callback is still not judged as the
  // route's own catch, so it never sets `catches` and never speaks for the route's `tryStatementCount`.
  // It is no longer excused either. Reading "no catch of its own" as not-applicable was worth 50
  // points to anything that could get the boundary rule to refuse the route's real catch, which
  // `[0].map(...)` did, so a refused catch now fails instead of sitting out.
  it("fails a route whose only catch is inside a Promise.all(items.map(...)) callback", () => {
    const source = `import { prisma } from "~/db.server";
       export async function action({ request }) {
         const items = await prisma.item.findMany();
         await Promise.all(
           items.map(async (item) => {
             try {
               await processItem(item);
             } catch {
               return null;
             }
           })
         );
         return json({ ok: true });
       }`;
    const ep = scanFile("batch.process.ts", source)!;
    expect(ep.catches).toEqual([]);
    expect(ep.callbackCatches).toBe(1);
    const r = run("error-classification", "batch.process.ts", source);
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("callback the route does not own");
  });

  // The same route with nothing caught anywhere stays not-applicable, so the fail above is
  // attributable to the refused catch and not to the check having stopped excusing anything.
  it("is not applicable to a route that catches nothing at all", () => {
    const r = run(
      "error-classification",
      "batch.process.ts",
      `import { prisma } from "~/db.server";
       export async function action({ request }) {
         const items = await prisma.item.findMany();
         await Promise.all(items.map(async (item) => processItem(item)));
         return json({ ok: true });
       }`
    );
    expect(r.status).toBe("not-applicable");
    expect(r.detail).toContain("catches nothing");
  });

  // C2. A single-element array cannot iterate, so `[0].map(async () => { whole body })` is not a
  // per-item boundary and the route's own catch is found where it always was. Before this, the
  // wrapper deleted the route's catches and took a swallow from fail to not-applicable.
  it("still fails a swallow wrapped in Promise.all([0].map(...))", () => {
    const r = run(
      "error-classification",
      "wrapped.ts",
      `import { prisma } from "~/db.server";
       export async function action({ request }) {
         const [result] = await Promise.all([0].map(async () => {
           try {
             const body = await request.json();
             const a = await stepOne(body);
             const b = await stepTwo(a);
             return json({ b });
           } catch (e) {
             return new Response("nope", { status: 500 });
           }
         }));
         return result;
       }`
    );
    expect(r.status).toBe("fail");
  });

  // A second receiver exercising the same mechanism: an empty array literal, which no name list
  // would treat differently from a populated one.
  it("still fails a swallow wrapped in [].flatMap(...)", () => {
    const r = run(
      "error-classification",
      "wrapped-empty.ts",
      `import { prisma } from "~/db.server";
       export async function action({ request }) {
         return [].flatMap(async () => {
           try {
             const body = await request.json();
             const a = await stepOne(body);
             const b = await stepTwo(a);
             return json({ b });
           } catch (e) {
             return new Response("nope", { status: 500 });
           }
         });
       }`
    );
    expect(r.status).toBe("fail");
  });

  // A third, where the name list cannot help at all: a non-array receiver whose method is called
  // `map`. The boundary rule still refuses the callback, so the route has no catch of its own, and
  // the refusal now fails rather than excusing. This is the shape the name list cannot tell from
  // `users.map(...)`, and it is why the refusal had to stop paying.
  it("still fails a swallow wrapped in a non-array receiver's .map(...)", () => {
    const r = run(
      "error-classification",
      "wrapped-result.ts",
      `import { prisma } from "~/db.server";
       export async function action({ request }) {
         return await Result.map(async () => {
           try {
             const body = await request.json();
             const a = await stepOne(body);
             const b = await stepTwo(a);
             return json({ b });
           } catch (e) {
             return new Response("nope", { status: 500 });
           }
         });
       }`
    );
    expect(r.status).toBe("fail");
  });
});

describe("auth-boundary", () => {
  it("passes a sensitive route guarded by a require helper", () => {
    // Sensitive on the impersonation call, not on the guard: calling a guard is not what makes a
    // route sensitive, see sensitivity.test.ts.
    const r = run(
      "auth-boundary",
      "admin.api.v1.impersonate.ts",
      `import { requireAdminApiRequest } from "~/services/personalAccessToken.server";
       import { setImpersonation } from "~/models/admin.server";
       export async function action({ request }) {
         await requireAdminApiRequest(request);
         return setImpersonation(request, "user_1");
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
      "webhooks.v1.billing.$hash.ts",
      `import { verifyWebhookSignature } from "~/services/webhooks.server";
       import { prisma } from "~/db.server";
       export async function action({ request, params }) {
         const invoice = await prisma.invoice.findFirst({ where: { id: params.id } });
         if (!verifyWebhookSignature(params.hash, invoice)) {
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

  // Was a known false positive: `new URL()` is a constructor, so the parse was invisible to the
  // call-callee scan the evidence used to come from. `CatchEvidence.guardsParse` covers
  // constructors, so the guard is legible now and the route is no longer judged as though it kept
  // its failures.
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

  // A5. IDENTIFIER_FIELD matched any suffix, so a resource id (a run, a batch, a notification, a
  // chat, a span) that shares the same `Id`/`Param` shape as a tenant field passed, and a bare `id`
  // passed too. TENANT_FIELD requires the root word itself to be environment, organization, project
  // or user.
  it("does not pass a failure log that only names a resource, not a tenant", () => {
    const r = run(
      "request-context",
      "api.v3.batches.$batchId.ts",
      `import { logger } from "~/services/logger.server";
       import { prisma } from "~/db.server";
       export async function loader({ params }) {
         try { return await prisma.thing.findMany(); }
         catch (error) {
           logger.error("batch lookup failed", { batchId: params.batchId, error });
           throw error;
         }
       }`
    );
    expect(r.status).toBe("fail");
  });

  it("does not pass a failure log that only names a bare id", () => {
    const r = run(
      "request-context",
      "api.v1.q.ts",
      `import { logger } from "~/services/logger.server";
       import { prisma } from "~/db.server";
       export async function loader() {
         try { return await prisma.thing.findMany(); }
         catch (error) {
           logger.debug("cache miss", { id: 1 });
           logger.error("lookup failed", { id: 1, error });
           throw error;
         }
       }`
    );
    expect(r.status).toBe("fail");
  });

  it("passes on the abbreviated envId/orgId forms the webapp also writes", () => {
    const r = run(
      "request-context",
      "api.v1.q.ts",
      `import { logger } from "~/services/logger.server";
       import { prisma } from "~/db.server";
       export async function loader({ params }) {
         try { return await prisma.thing.findMany(); }
         catch (error) {
           logger.error("lookup failed", { envId: params.envId, orgId: params.orgId, error });
           throw error;
         }
       }`
    );
    expect(r.status).toBe("pass");
  });

  // A5. request-context filtered failure-path logs on inCatch only, not on level, so a debug log
  // naming a tenant field passed the check even though debug lines are routinely dropped or
  // sampled out before an incident is read.
  it("does not pass a debug-level failure log, even one that names a tenant", () => {
    const r = run(
      "request-context",
      "api.v1.q.ts",
      `import { logger } from "~/services/logger.server";
       import { prisma } from "~/db.server";
       export async function loader({ params }) {
         try { return await prisma.thing.findMany(); }
         catch (error) {
           logger.debug("lookup failed", { environmentId: params.envId, error });
           throw error;
         }
       }`
    );
    expect(r.status).toBe("fail");
  });

  it("does not pass an info-level failure log either", () => {
    const r = run(
      "request-context",
      "api.v1.q.ts",
      `import { logger } from "~/services/logger.server";
       import { prisma } from "~/db.server";
       export async function loader({ params }) {
         try { return await prisma.thing.findMany(); }
         catch (error) {
           logger.info("lookup failed", { environmentId: params.envId, error });
           throw error;
         }
       }`
    );
    expect(r.status).toBe("fail");
  });

  it("still passes a warn-level failure log that names a tenant", () => {
    const r = run(
      "request-context",
      "api.v1.q.ts",
      `import { logger } from "~/services/logger.server";
       import { prisma } from "~/db.server";
       export async function loader({ params }) {
         try { return await prisma.thing.findMany(); }
         catch (error) {
           logger.warn("lookup failed", { environmentId: params.envId, error });
           throw error;
         }
       }`
    );
    expect(r.status).toBe("pass");
  });

  // M7. The real logger (packages/core/src/logger.ts) has log/error/warn/info/debug/verbose, no
  // fatal and no trace, and log is level 0, never filtered by TRIGGER_LOG_LEVEL, so it must
  // qualify. verbose is the actual noisiest level this codebase has, not trace.
  it("passes a log-level failure log, which the real logger never filters", () => {
    const r = run(
      "request-context",
      "api.v1.q.ts",
      `import { logger } from "~/services/logger.server";
       import { prisma } from "~/db.server";
       export async function loader({ params }) {
         try { return await prisma.thing.findMany(); }
         catch (error) {
           logger.log("lookup failed", { environmentId: params.envId, error });
           throw error;
         }
       }`
    );
    expect(r.status).toBe("pass");
  });

  it("does not pass a verbose-level failure log", () => {
    const r = run(
      "request-context",
      "api.v1.q.ts",
      `import { logger } from "~/services/logger.server";
       import { prisma } from "~/db.server";
       export async function loader({ params }) {
         try { return await prisma.thing.findMany(); }
         catch (error) {
           logger.verbose("lookup failed", { environmentId: params.envId, error });
           throw error;
         }
       }`
    );
    expect(r.status).toBe("fail");
  });

  // M8. A bare `env` field is ambiguous with a deployment environment name
  // (`{ env: process.env.NODE_ENV }`), not a tenant, so it must not qualify on its own; the
  // abbreviated root still works with a real suffix.
  it("does not pass a failure log that only names a bare env field", () => {
    const r = run(
      "request-context",
      "api.v1.q.ts",
      `import { logger } from "~/services/logger.server";
       import { prisma } from "~/db.server";
       export async function loader() {
         try { return await prisma.thing.findMany(); }
         catch (error) {
           logger.error("lookup failed", { env: process.env.NODE_ENV, error });
           throw error;
         }
       }`
    );
    expect(r.status).toBe("fail");
  });

  it("still passes envId, the abbreviated root with a real suffix", () => {
    const r = run(
      "request-context",
      "api.v1.q.ts",
      `import { logger } from "~/services/logger.server";
       import { prisma } from "~/db.server";
       export async function loader({ params }) {
         try { return await prisma.thing.findMany(); }
         catch (error) {
           logger.error("lookup failed", { envId: params.envId, error });
           throw error;
         }
       }`
    );
    expect(r.status).toBe("pass");
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

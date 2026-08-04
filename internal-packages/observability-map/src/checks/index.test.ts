import { CHECKS, SCORED_CHECK_IDS } from "./index.js";
import { scanFile } from "../scan.js";

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
  it("holds the five checks, with audit-trail left out of the score", () => {
    expect(CHECKS.map((c) => c.id)).toEqual([
      "error-classification",
      "auth-boundary",
      "auth-scope",
      "request-context",
      "audit-trail",
    ]);
    expect(SCORED_CHECK_IDS).toEqual([
      "error-classification",
      "auth-boundary",
      "auth-scope",
      "request-context",
    ]);
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

  // The exact boundary, held regardless of how big the rest of the function is: two statements binds
  // the parsed result and passes, a third means the try has started to cover the handler.
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

  // Against the entry-point statement count, a sibling handler or a fat helper in the same file
  // diluted the denominator and relabelled the same broad swallow as a narrow parse guard.
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

  // Same-body dilution, which moving the denominator to the enclosing body did not close: as a
  // ratio, padding the SAME action with 11 inert statements took the identical swallow to pass.
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

  // The anti-laundering half of the boundary rule: judging refused catches on their evidence must
  // not stop failing a swallow relocated behind one.
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
    expect(ep.callbackCatches).toHaveLength(1);
    const r = run("error-classification", "batch.process.ts", source);
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("a catch inside an iteration callback swallows");
  });

  // The evidence half of the mechanism-C rule: a refused catch that DECIDES caps at not-applicable
  // rather than failing (the old placement rule) or passing (the crediting rule `dead-deciding-map`
  // exists to refuse). The route's error handling is real and per item; the route itself decides
  // nothing, so out of the denominator is the honest place for it.
  it("sits out a route whose only catch is a deciding per-item boundary", () => {
    const r = run(
      "error-classification",
      "batch.decide.ts",
      `import { prisma } from "~/db.server";
       export async function action({ request }) {
         const results = await stream.map(async (item) => {
           try {
             await service.call(item);
           } catch (e) {
             if (e instanceof KnownError) { return new Response(e.code, { status: 400 }); }
             throw e;
           }
         });
         return json({ results });
       }`
    );
    expect(r.status).toBe("not-applicable");
    expect(r.detail).toContain("its only catches sit in iteration callbacks");
  });

  // Same shape with an inert per-item rethrow: not a swallow, so it sits out too.
  it("sits out a route whose only catch is an inert per-item rethrow", () => {
    const r = run(
      "error-classification",
      "batch.rethrow.ts",
      `import { prisma } from "~/db.server";
       export async function action({ request }) {
         const results = await stream.map(async (item) => {
           try {
             await service.call(item);
           } catch (e) {
             throw e;
           }
         });
         return json({ results });
       }`
    );
    expect(r.status).toBe("not-applicable");
    expect(r.detail).toContain("its only catches sit in iteration callbacks");
  });

  // Why the refused-swallow arm is not conditioned on the route owning no catches: an own inert catch
  // is exactly what `wrap-body-in-rethrow` adds to every route, and the gate would lift this fail to
  // not-applicable.
  it("fails a per-item swallow even when the route owns an inert rethrow catch", () => {
    const r = run(
      "error-classification",
      "batch.wrapped.ts",
      `import { prisma } from "~/db.server";
       export async function action({ request }) {
         try {
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
         } catch (e) {
           throw e;
         }
       }`
    );
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("a catch inside an iteration callback swallows");
  });

  // The no-pass ceiling at the fixture scale: a catchless route with a prepended dead deciding
  // map sits out. A crediting rule would read pass here, which is 50 free points on the tree's
  // 261 catchless routes; the old placement rule read fail, a false accusation on a preserving
  // prepend. `dead-deciding-map` in the mutation corpus is the tree-scale version.
  it("sits out a catchless route with a prepended dead deciding map", () => {
    const r = run(
      "error-classification",
      "prepended-map.ts",
      `import { prisma } from "~/db.server";
       export async function action({ request }) {
         [0, 1].map((v) => { try { JSON.parse("0"); } catch (e) { if (e instanceof SyntaxError) { return null; } throw e; } return v; });
         const rows = await prisma.thing.findMany();
         return json({ rows });
       }`
    );
    expect(r.status).toBe("not-applicable");
    expect(r.detail).toContain("its only catches sit in iteration callbacks");
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

  // S2 at the check level. The evidence tests in `scan.test.ts` pin `guardCanRaise` itself; these
  // pin the check reading it, which is where the 50 points were. Prepending this to a route that
  // catches nothing took it from not-applicable to pass, and 224 routes were in exactly that state.
  it("is not applicable to a route whose only catch guards a try that cannot throw", () => {
    const r = run(
      "error-classification",
      "prepended.ts",
      `import { prisma } from "~/db.server";
       export async function action({ request }) {
         try { 0; } catch (e) {
           if (e instanceof Error) { return new Response(null, { status: 400 }); }
           throw e;
         }
         const rows = await prisma.thing.findMany();
         return json({ rows });
       }`
    );
    expect(r.status).toBe("not-applicable");
    expect(r.detail).toContain("guards nothing that can throw");
  });

  it("still fails a swallow that a dead classifying catch was prepended to", () => {
    const r = run(
      "error-classification",
      "prepended-swallow.ts",
      `import { prisma } from "~/db.server";
       export async function action({ request }) {
         try { 0; } catch (e) {
           if (e instanceof Error) { return new Response(null, { status: 400 }); }
           throw e;
         }
         try {
           return json(await prisma.thing.findMany());
         } catch (error) {
           return new Response(null, { status: 500 });
         }
       }`
    );
    expect(r.status).toBe("fail");
  });

  it("still passes the same classifying catch once its try does real work", () => {
    const r = run(
      "error-classification",
      "live.ts",
      `import { prisma } from "~/db.server";
       export async function action({ request }) {
         try { await prisma.thing.findMany(); } catch (e) {
           if (e instanceof Error) { return new Response(null, { status: 400 }); }
           throw e;
         }
         return json({ ok: true });
       }`
    );
    expect(r.status).toBe("pass");
  });

  // "Takes one way out regardless of what was thrown" is false of a clause that throws for some
  // errors, and 16 clauses in the tree were eligible for the wording. Whether `fail` is the right
  // verdict for them at all is a separate question, parked.
  it("does not accuse a clause that throws of taking one way out", () => {
    const r = run(
      "error-classification",
      "mixed.ts",
      `import { prisma } from "~/db.server";
       export async function loader() {
         try { return json(await prisma.thing.findMany()); }
         catch (e) { if (rare) { return null; } throw e; }
       }`
    );
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("without looking at what was thrown");
    expect(r.detail).not.toContain("one way out");
  });

  it("still says one way out for a clause that never throws", () => {
    const r = run(
      "error-classification",
      "swallow.ts",
      `import { prisma } from "~/db.server";
       export async function loader() {
         try { return json(await prisma.thing.findMany()); }
         catch (e) { logger.error(e); return null; }
       }`
    );
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("one way out");
  });

  // `canRaise` does not list destructuring, and `const { a } = undefined` throws, so an owned
  // classifying catch drops out of `reachable`; the refused-swallow arm reads `guardMayRaise` instead.
  // Asserted on `status`, since an earlier version asserted the absence of a detail string no arm
  // emits, which could not fail.
  it("does not accuse a route that owns a catch of owning none", () => {
    const r = run(
      "error-classification",
      "owned.ts",
      `import { prisma } from "~/db.server";
       export async function action({ request }) {
         const items = await prisma.item.findMany();
         await Promise.all(
           items.map(async (item) => {
             try { await processItem(item); } catch { return null; }
           })
         );
         try { const { a } = undefined; } catch (e) {
           if (e instanceof TypeError) { return new Response(null, { status: 400 }); }
           throw e;
         }
         return json({ ok: true });
       }`
    );
    expect(r.status).toBe("not-applicable");
    expect(r.detail).toContain("guards nothing that can throw");
  });

  // I4 sibling: the same shape through `.filter` and a different `canRaise` miss (a plain
  // declaration is not on the whitelist either), so the fix is the rule and not the fixture.
  it("does not accuse a route whose deciding catch guards a declaration beside a filter swallow", () => {
    const r = run(
      "error-classification",
      "owned-filter.ts",
      `import { prisma } from "~/db.server";
       export async function action({ request }) {
         const items = await prisma.item.findMany();
         const kept = items.filter((item) => {
           try { return check(item); } catch { return false; }
         });
         try { const parsed = { ...raw }; } catch (e) {
           if (e instanceof TypeError) { return new Response(null, { status: 400 }); }
           throw e;
         }
         return json({ kept });
       }`
    );
    expect(r.status).toBe("not-applicable");
  });

  // The blocking catch has to DECIDE: an own inert rethrow catch over the same invisible guard
  // still leaves the refused swallow in the verdict, or `wrap-body-in-rethrow` spelled with a
  // destructuring guard would lift every per-item swallow out of it.
  it("still fails a per-item swallow beside an inert catch over an invisible guard", () => {
    const r = run(
      "error-classification",
      "owned-inert.ts",
      `import { prisma } from "~/db.server";
       export async function action({ request }) {
         const items = await prisma.item.findMany();
         await Promise.all(
           items.map(async (item) => {
             try { await processItem(item); } catch { return null; }
           })
         );
         try { const { a } = undefined; } catch (e) { throw e; }
         return json({ ok: true });
       }`
    );
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("nothing the route owns decides");
  });

  // And the blocking catch has to guard something that MAY raise: the provably-inert `try { 0; }`
  // clause `dead-classifying-try` prepends decides and must still block nothing, or the prepend
  // would lift a refused-swallow fail to not-applicable at tree scale.
  it("still fails a per-item swallow beside a deciding catch over a dead guard", () => {
    const r = run(
      "error-classification",
      "owned-dead.ts",
      `import { prisma } from "~/db.server";
       export async function action({ request }) {
         const items = await prisma.item.findMany();
         await Promise.all(
           items.map(async (item) => {
             try { await processItem(item); } catch { return null; }
           })
         );
         try { 0; } catch (e) {
           if (e instanceof Error) { return new Response(null, { status: 400 }); }
           throw e;
         }
         return json({ ok: true });
       }`
    );
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("nothing the route owns decides");
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

  // The verdict end of the `break and continue inside the construct they target` finding. A clause
  // that sorts the error by code and then rethrows was failed, with a detail line asserting it
  // takes one way out regardless of what was thrown, which is the opposite of what it does. Both
  // spellings are here because the pair is the evidence: the switch must not change the verdict.
  const SORTED_RETHROW = (sorter: string) => `import { prisma } from "~/db.server";
     export async function action({ request, params }) {
       try {
         return json(await prisma.thing.update({ where: { id: params.id }, data: {} }));
       } catch (e) {
         ${sorter}
         throw e;
       }
     }`;

  it("does not accuse a clause that sorts the error by code and rethrows", () => {
    const r = run(
      "error-classification",
      "api.v1.sorted.ts",
      SORTED_RETHROW(
        'switch (e.code) { case "P2025": handleNotFound(e); break; default: handleOther(e); break; }'
      )
    );
    expect(r.status).toBe("not-applicable");
    expect(r.detail).not.toContain("one way out");
  });

  it("reads the same clause written without the switch identically", () => {
    const withSwitch = run(
      "error-classification",
      "api.v1.sorted.ts",
      SORTED_RETHROW(
        'switch (e.code) { case "P2025": handleNotFound(e); break; default: handleOther(e); break; }'
      )
    );
    const without = run(
      "error-classification",
      "api.v1.sorted.ts",
      SORTED_RETHROW("handleOther(e);")
    );
    expect(withSwitch).toEqual(without);
  });

  // The other direction, so the rule above is not just "a switch is ignored": the same sorter with
  // a clause that answers the request is a decision, and still passes.
  it("still passes a clause whose switch on the error code answers the request", () => {
    const r = run(
      "error-classification",
      "api.v1.sorted.ts",
      SORTED_RETHROW(
        'switch (e.code) { case "P2025": return new Response(null, { status: 404 }); default: break; }'
      )
    );
    expect(r.status).toBe("pass");
  });

  // The verdict end of the walk's guaranteed-execution entries, one pair per entered construct. The
  // evidence end is `the walk enters exactly the positions guaranteed to execute` in scan.test.ts.
  const CLAUSE_WRAPPED = (clauseBody: string) => `import { prisma } from "~/db.server";
     export async function loader() {
       try {
         return json(await prisma.thing.findMany());
       } catch (e) {
         ${clauseBody}
       }
     }`;

  const DECIDING_CLAUSE =
    "if (e instanceof Error) { return new Response(null, { status: 400 }); }\n" +
    "return new Response(null, { status: 500 });";

  const GUARANTEED_WRAPPERS: Array<[string, (body: string) => string]> = [
    ["a catchless try/finally", (body) => `try {\n${body}\n} finally { }`],
    ["a single-default switch", (body) => `switch (pick()) { default: {\n${body}\n} }`],
    ["an if (true)", (body) => `if (true) {\n${body}\n}`],
    [
      "an if/else with the body in both arms",
      (body) => `if (pick()) {\n${body}\n} else {\n${body}\n}`,
    ],
  ];

  for (const [label, wrap] of GUARANTEED_WRAPPERS) {
    it(`reads a deciding clause relocated into ${label} with the same verdict`, () => {
      const wrapped = run(
        "error-classification",
        "api.v1.wrapped.ts",
        CLAUSE_WRAPPED(wrap(DECIDING_CLAUSE))
      );
      const bare = run(
        "error-classification",
        "api.v1.wrapped.ts",
        CLAUSE_WRAPPED(DECIDING_CLAUSE)
      );
      expect(bare.status).toBe("pass");
      expect(wrapped).toEqual(bare);
    });
  }
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
  const signatureRoute = (guard: string) =>
    run(
      "auth-boundary",
      "webhooks.v1.billing.$hash.ts",
      `import { ${guard} } from "~/services/webhooks.server";
       import { prisma } from "~/db.server";
       export async function action({ request, params }) {
         const invoice = await prisma.invoice.findFirst({ where: { id: params.id } });
         if (!${guard}(params.hash, invoice)) {
           return json({ error: "Invalid" }, { status: 401 });
         }
         return json({ ok: true });
       }`
    );

  it("passes a sensitive callback guarded by a signature check", () => {
    expect(signatureRoute("verifyWebhook").status).toBe("pass");
  });

  // C1a. The accept-list is derived from the helpers this webapp has. `verifyWebhookSignature` is
  // a plausible name that exists nowhere in it, and the pattern this list replaced passed it.
  it("does not pass a signature guard the webapp does not have", () => {
    expect(signatureRoute("verifyWebhookSignature").status).toBe("fail");
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

  // The pass branch had never been exercised against a real name: the fixture imported `auditLog`
  // from `~/services/audit.server`, a helper and a module that both exist nowhere. All three names
  // on the list now reach `prisma.impersonationAuditLog.create` in `models/admin.server.ts`.
  it.each(["redirectWithImpersonation", "clearImpersonation", "startImpersonation"])(
    "passes a sensitive mutation that records an audit event through %s",
    (writer) => {
      const r = run(
        "audit-trail",
        "admin.impersonate.tsx",
        `import { ${writer} } from "~/models/admin.server";
         import { prisma } from "~/db.server";
         export async function action({ request }) {
           const target = await prisma.user.findFirst({ where: { admin: false } });
           const session = await ${writer}(request, target.id, "/");
           return session;
         }`
      );
      expect(r.status).toBe("pass");
      expect(r.detail).toBe("records an audit event");
    }
  );

  it("still fails a sensitive mutation that writes no record", () => {
    const r = run(
      "audit-trail",
      "api.v1.auth.jwt.ts",
      `import { prisma } from "~/db.server";
       export async function action({ request }) {
         const token = await prisma.token.create({ data: { name: request.url } });
         return json(token);
       }`
    );
    expect(r.status).toBe("fail");
  });

  // The coherence fix. `auth-boundary` declines to judge a trivial body because a guard would be
  // behind the import; this check accused the same body over an audit write behind the same
  // import. Same rule now, and presence is still read before the exemption, so a trivial body that
  // does call a writer passes rather than sitting out.
  it("declines to judge a trivial sensitive mutation, as auth-boundary does", () => {
    const source = `import { doTheThing } from "~/models/admin.server";
       export async function action({ request }) { return doTheThing(request, "/admin"); }`;
    expect(run("audit-trail", "resources.impersonation.ts", source).status).toBe("not-applicable");
    expect(run("auth-boundary", "resources.impersonation.ts", source).status).toBe(
      "not-applicable"
    );
  });

  it("still passes a trivial sensitive mutation that calls a writer", () => {
    const r = run(
      "audit-trail",
      "resources.impersonation.ts",
      `import { clearImpersonation } from "~/models/admin.server";
       export async function action({ request }) { return clearImpersonation(request, "/admin"); }`
    );
    expect(r.status).toBe("pass");
  });
});

// C1a. The guard list is names now, not a five-character prefix. Both directions matter: a real
// helper must still clear a sensitive route, and a callee that merely starts the right way must
// not.
describe("auth-boundary: the guard accept-list", () => {
  const sensitiveRoute = (guard: string) =>
    run(
      "auth-boundary",
      "api.v1.orgs.$orgParam.members.ts",
      `import { prisma } from "~/db.server";
       export async function loader({ request, params }) {
         const caller = await ${guard}(request);
         const members = await prisma.orgMember.findMany({ where: { orgId: params.orgParam } });
         return json({ members, caller });
       }`
    );

  it.each(["requireUserId", "requireUser", "authenticateApiRequest", "authenticateSession"])(
    "passes a sensitive route guarded by %s",
    (guard) => {
      expect(sensitiveRoute(guard).status).toBe("pass");
    }
  );

  // The live case. `requireSsoEntitlement` is a plan check inside one route file, and the prefix
  // pattern cleared the org SSO settings route on it.
  it("does not pass a plan check that happens to start with require", () => {
    const r = sensitiveRoute("requireSsoEntitlement");
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("no auth guard in the body");
  });

  // `getUser` and `getUserId` answer with null instead of throwing, so being called is not evidence
  // of a boundary: they are credited only when the body reads the answer.
  it("does not pass a route that resolves the caller and ignores the answer", () => {
    const r = run(
      "auth-boundary",
      "invite-accept.tsx",
      `import { getUser } from "~/services/session.server";
       import { getInviteFromToken } from "~/models/member.server";
       export async function loader({ request }) {
         const user = await getUser(request);
         const token = new URL(request.url).searchParams.get("token");
         const invite = await getInviteFromToken({ token });
         return json({ invite, email: user.email });
       }`
    );
    expect(r.status).toBe("fail");
  });

  it("does not pass a route that drops the caller entirely", () => {
    const r = run(
      "auth-boundary",
      "invite-accept.tsx",
      `import { getUserId } from "~/services/session.server";
       import { getInviteFromToken } from "~/models/member.server";
       export async function loader({ request }) {
         await getUserId(request);
         const token = new URL(request.url).searchParams.get("token");
         return json(await getInviteFromToken({ token }));
       }`
    );
    expect(r.status).toBe("fail");
  });

  it("passes an invite acceptance that resolves the caller and refuses a mismatch", () => {
    const r = run(
      "auth-boundary",
      "invite-accept.tsx",
      `import { getUser } from "~/services/session.server";
       import { getInviteFromToken } from "~/models/member.server";
       export async function loader({ request }) {
         const user = await getUser(request);
         const token = new URL(request.url).searchParams.get("token");
         if (!user) return redirect("/login");
         const invite = await getInviteFromToken({ token });
         if (invite.email !== user.email) return redirect("/");
         return redirect("/");
       }`
    );
    expect(r.status).toBe("pass");
  });

  it("passes a login page that sends an already authenticated caller away", () => {
    const r = run(
      "auth-boundary",
      "login._index/route.tsx",
      `import { getUserId } from "~/services/session.server";
       import { prisma } from "~/db.server";
       export async function loader({ request }) {
         const userId = await getUserId(request);
         if (userId) return redirect("/");
         const flags = await prisma.featureFlag.findMany();
         return typedjson({ flags });
       }`
    );
    expect(r.status).toBe("pass");
  });

  it("does not pass an invented require helper", () => {
    expect(sensitiveRoute("requireValidParams").status).toBe("fail");
    expect(sensitiveRoute("requireQueryParam").status).toBe("fail");
  });

  // `resolveAuthenticatedEnv` hydrates an environment record from its id. Ten routes call it and
  // the /Authenticated/ pattern read every one of them as guarded.
  it("does not pass a lookup whose name merely contains Authenticated", () => {
    expect(sensitiveRoute("resolveAuthenticatedEnv").status).toBe("fail");
    expect(sensitiveRoute("commitAuthenticatedSession").status).toBe("fail");
  });
});

/**
 * Per-export attribution. Each `it` here goes green on the entry-point-wide version of exactly one of
 * the three inputs, which is why they are separate cases rather than one.
 */
describe("auth-boundary: a guard credits only the export that calls it", () => {
  const TOKENS = `import { requireUserId } from "~/services/session.server";
       import { prisma } from "~/db.server";`;

  it("fails an unguarded action beside a loader that calls a guard", () => {
    const r = run(
      "auth-boundary",
      "api.v1.tokens.ts",
      `${TOKENS}
       export async function loader({ request }) {
         const userId = await requireUserId(request);
         return json(await prisma.token.findMany({ where: { userId } }));
       }
       export async function action({ request }) {
         const body = await request.json();
         await prisma.token.deleteMany({ where: { id: body.id } });
         return json({ ok: true });
       }`
    );
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("action");
  });

  it("fails an unguarded loader beside an action that calls a guard", () => {
    const r = run(
      "auth-boundary",
      "api.v1.tokens.ts",
      `${TOKENS}
       export async function loader({ params }) {
         const tokens = await prisma.token.findMany({ where: { orgId: params.orgId } });
         return json({ tokens });
       }
       export async function action({ request }) {
         const userId = await requireUserId(request);
         await prisma.token.deleteMany({ where: { userId } });
         return json({ ok: true });
       }`
    );
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("loader");
  });

  // The soft-guard arm reads its own export's checked-callee list for the same reason.
  it("fails an unguarded action beside a loader that reads what getUserId returned", () => {
    const r = run(
      "auth-boundary",
      "api.v1.tokens.ts",
      `import { getUserId } from "~/services/session.server";
       import { prisma } from "~/db.server";
       export async function loader({ request }) {
         const userId = await getUserId(request);
         if (!userId) return redirect("/login");
         return json(await prisma.token.findMany({ where: { userId } }));
       }
       export async function action({ request }) {
         const body = await request.json();
         await prisma.token.deleteMany({ where: { id: body.id } });
         return json({ ok: true });
       }`
    );
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("action");
  });

  // The builder arm. `usesBuilder` was an OR over both initializer callees, so a builder on one
  // export authenticated a hand-written handler on the other.
  it("fails a hand-written action beside a builder-wrapped loader", () => {
    const r = run(
      "auth-boundary",
      "api.v1.tokens.ts",
      `import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";
       import { prisma } from "~/db.server";
       export const loader = createLoaderApiRoute({}, async ({ authentication }) => {
         return json(await prisma.token.findMany({ where: { userId: authentication.userId } }));
       });
       export async function action({ request }) {
         const body = await request.json();
         await prisma.token.deleteMany({ where: { id: body.id } });
         return json({ ok: true });
       }`
    );
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("action");
  });

  it("passes when both exports call a guard of their own", () => {
    const r = run(
      "auth-boundary",
      "api.v1.tokens.ts",
      `${TOKENS}
       export async function loader({ request }) {
         const userId = await requireUserId(request);
         return json(await prisma.token.findMany({ where: { userId } }));
       }
       export async function action({ request }) {
         const userId = await requireUserId(request);
         await prisma.token.deleteMany({ where: { userId } });
         return json({ ok: true });
       }`
    );
    expect(r.status).toBe("pass");
  });

  // One handler serving both exports guards both, which is the dominant API-route shape.
  it("passes a shared builder handler that both exports resolve to", () => {
    const r = run(
      "auth-boundary",
      "api.v1.tokens.ts",
      `import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
       export const { action, loader } = createActionApiRoute({}, async ({ authentication }) => {
         return json({ userId: authentication.userId });
       });`
    );
    expect(r.status).toBe("pass");
  });

  /** The damper on the attribution: `auth.github.ts` and `auth.google.ts` went pass to fail on the
   * real tree until `isTrivialExport` existed. */
  it("reports not-applicable for a redirect-stub loader beside a guarded action", () => {
    const r = run(
      "auth-boundary",
      "auth.github.ts",
      `import { authenticator } from "~/services/auth.server";
       export let loader = () => redirect("/login");
       export let action = async ({ request }) => {
         const url = new URL(request.url);
         const safeRedirect = sanitizeRedirectPath(url.searchParams.get("redirectTo"), "/");
         return await authenticator.authenticate("github", request, {
           successRedirect: safeRedirect,
           failureRedirect: "/login",
         });
       };`
    );
    expect(r.status).toBe("pass");
    expect(r.detail).toBe("guarded in the body");
  });

  /** The per-export excuse must read the export's own body and not the file's text, or
   * `log-caller-scope-userid` puts the word `logger` in this file and accuses the untouched loader. */
  it("does not un-excuse a redirect-stub loader because the file mentions a logger", () => {
    const r = run(
      "auth-boundary",
      "auth.github.ts",
      `import { authenticator } from "~/services/auth.server";
       import { logger } from "~/services/logger.server";
       export let loader = () => redirect("/login");
       export let action = async ({ request }) => {
         logger.error("obs-map", { userId: request.userId });
         return await authenticator.authenticate("github", request, {
           successRedirect: "/",
           failureRedirect: "/login",
         });
       };`
    );
    expect(r.status).toBe("pass");
  });

  it("fails an export whose own body does real work unguarded", () => {
    const r = run(
      "auth-boundary",
      "auth.github.ts",
      `import { authenticator } from "~/services/auth.server";
       import { prisma } from "~/db.server";
       export let loader = async ({ params }) => {
         const org = await prisma.organization.findFirst({ where: { slug: params.slug } });
         const members = await prisma.orgMember.findMany({ where: { orgId: org.id } });
         return json({ org, members });
       };
       export let action = async ({ request }) => {
         return await authenticator.authenticate("github", request, {
           successRedirect: "/",
           failureRedirect: "/login",
         });
       };`
    );
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("loader");
  });
});

// C1b. A builder authenticates the request; it does not necessarily scope it. `authorization` is
// optional on every one of them and the RBAC gate only runs when it is declared.
describe("auth-scope", () => {
  const patRoute = (options: string, body: string) =>
    run(
      "auth-scope",
      "api.v1.orgs.$orgParam.members.ts",
      `import { createActionPATApiRoute } from "~/services/routeBuilders/apiBuilder.server";
       import { prisma } from "~/db.server";
       export const action = createActionPATApiRoute(
         { method: "POST"${options}},
         async ({ authentication, params }) => {
           ${body}
           return json({ members });
         }
       );`
    );

  const UNSCOPED = `const members = await prisma.orgMember.findMany({
             where: { organization: { slug: params.orgParam } },
           });`;

  it("fails a sensitive PAT route that authenticates and scopes nothing", () => {
    const r = patRoute("", UNSCOPED);
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("authenticated but not scoped to the caller");
    expect(r.detail).toContain("createActionPATApiRoute");
  });

  it("passes when the builder declares the authorization gate", () => {
    const r = patRoute(
      `, authorization: { action: "read", resource: { type: "members" } }`,
      UNSCOPED
    );
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("authorization gate");
  });

  it("passes when the handler filters by the caller's membership instead", () => {
    const r = patRoute(
      "",
      `const members = await prisma.orgMember.findMany({
         where: { organization: { slug: params.orgParam, members: { some: { userId: authentication.userId } } } },
       });`
    );
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("caller's identity");
  });

  // Round C ruling 1. apps/webapp/CLAUDE.md: the OSS fallback ability is permissive, so
  // `ability.can(...)` enforces the role and the membership-scoped query is the tenant floor.
  // Crediting it made this check agree with `_app.orgs.$organizationSlug.settings.sso/route.tsx`,
  // which resolves its target org from the URL slug and puts nothing else in front of it.
  it("does not accept an ability gate in the handler as scoping", () => {
    const r = run(
      "auth-scope",
      "_app.orgs.$slug.settings.team/route.tsx",
      `import { dashboardAction } from "~/services/routeBuilders/dashboardBuilder";
       import { prisma } from "~/db.server";
       export const action = dashboardAction({ params: Params }, async ({ ability, params }) => {
         if (!ability.can("manage", { type: "members" })) throw new Response(null, { status: 403 });
         const members = await prisma.orgMember.findMany({ where: { slug: params.slug } });
         return json({ members });
       });`
    );
    expect(r.status).toBe("fail");
  });

  // The two shapes on the real tree, both hand-read for round C.
  it("fails when the loader is unscoped and only the action filters by the caller", () => {
    const r = run(
      "auth-scope",
      "_app.orgs.$slug.settings.sso/route.tsx",
      `import { dashboardAction, dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
       import { prisma } from "~/db.server";
       export const loader = dashboardLoader({ params: Params }, async ({ context, ability }) => {
         if (!ability.can("manage", { type: "sso" })) throwPermissionDenied();
         return json(await prisma.ssoConnection.findMany({ where: { organizationId: context.organizationId } }));
       });
       export const action = dashboardAction({ params: Params }, async ({ context, user }) =>
         json(await ssoController.generatePortalLink({ organizationId: context.organizationId, userId: user.id }))
       );`
    );
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("loader (dashboardLoader)");
    expect(r.detail).not.toContain("action");
  });

  it("fails when the action is unscoped and only the loader filters by the caller", () => {
    const r = run(
      "auth-scope",
      "_app.orgs.$slug.settings.team/route.tsx",
      `import { dashboardAction, dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
       import { prisma } from "~/db.server";
       export const loader = dashboardLoader({ params: Params }, async ({ user }) =>
         json(await new TeamPresenter().call({ userId: user.id }))
       );
       export const action = dashboardAction({ params: Params }, async ({ context, ability }) => {
         if (!ability.can("manage", { type: "members" })) throwPermissionDenied();
         return json(await prisma.orgMember.deleteMany({ where: { organizationId: context.organizationId } }));
       });`
    );
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("action (dashboardAction)");
  });

  // A file whose loader is gated and whose action is not is not a gated route.
  it("fails when only one of two builder exports declares the gate", () => {
    const r = run(
      "auth-scope",
      "api.v1.orgs.$orgParam.members.ts",
      `import { createActionPATApiRoute, createLoaderPATApiRoute } from "~/services/routeBuilders/apiBuilder.server";
       import { prisma } from "~/db.server";
       export const loader = createLoaderPATApiRoute(
         { authorization: { action: "read", resource: { type: "members" } } },
         async ({ params }) => json(await prisma.orgMember.findMany({ where: { slug: params.orgParam } }))
       );
       export const action = createActionPATApiRoute({ method: "POST" }, async ({ params }) =>
         json(await prisma.orgMember.deleteMany({ where: { slug: params.orgParam } }))
       );`
    );
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("action (createActionPATApiRoute)");
  });

  // Round D item 3, at the check level: the shape that cleared both real findings.
  it("is not cleared by a dead object holding the caller id", () => {
    const r = run(
      "auth-scope",
      "api.v1.orgs.$orgParam.members.ts",
      `import { createActionPATApiRoute } from "~/services/routeBuilders/apiBuilder.server";
       import { prisma } from "~/db.server";
       export const action = createActionPATApiRoute({ method: "POST" }, async ({ user, params }) => {
         const unused = { userId: user.id };
         return json(await prisma.orgMember.deleteMany({ where: { slug: params.orgParam } }));
       });`
    );
    expect(r.status).toBe("fail");
  });

  it("is not applicable to a route that is not sensitive", () => {
    const r = run(
      "auth-scope",
      "api.v1.runs.ts",
      `import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
       import { prisma } from "~/db.server";
       export const action = createActionApiRoute({ method: "POST" }, async ({ params }) =>
         json(await prisma.taskRun.findMany({ where: { id: params.id } }))
       );`
    );
    expect(r.status).toBe("not-applicable");
    expect(r.detail).toBe("not sensitive");
  });

  it("is not applicable to a sensitive route with no builder to read options from", () => {
    const r = run(
      "auth-scope",
      "api.v1.orgs.$orgParam.members.ts",
      `import { requireUserId } from "~/services/session.server";
       import { prisma } from "~/db.server";
       export async function action({ request, params }) {
         await requireUserId(request);
         return json(await prisma.orgMember.deleteMany({ where: { slug: params.orgParam } }));
       }`
    );
    expect(r.status).toBe("not-applicable");
    expect(r.detail).toContain("no route builder");
  });

  // A builder-wrapped route is never trivial, so the sensitive routes that sit out for having
  // nothing in the body sit out here for having no builder instead.
  it("is not applicable to a trivial sensitive route with no builder", () => {
    const r = run(
      "auth-scope",
      "orgs.$organizationSlug.team.ts",
      `import { redirect } from "@remix-run/server-runtime";
       export async function loader({ params }) { return redirect(teamPath(params.slug)); }`
    );
    expect(r.status).toBe("not-applicable");
    expect(r.detail).toContain("no route builder");
  });
});

// The cheapest way to launder auth-scope would be to write the option and give it nothing, which
// the builder's own `if (authorization)` treats as absent.
describe("auth-scope: an option declared as nothing is not declared", () => {
  const withValue = (value: string) =>
    run(
      "auth-scope",
      "api.v1.orgs.$orgParam.members.ts",
      `import { createActionPATApiRoute } from "~/services/routeBuilders/apiBuilder.server";
       import { prisma } from "~/db.server";
       export const action = createActionPATApiRoute(
         { method: "POST", authorization: ${value} },
         async ({ params }) => json(await prisma.orgMember.findMany({ where: { slug: params.orgParam } }))
       );`
    );

  it.each(["undefined", "null", "false"])("fails on authorization: %s", (value) => {
    expect(withValue(value).status).toBe("fail");
  });

  it("passes on a real one, so the rule is about the value and not the key", () => {
    expect(withValue(`{ action: "read", resource: { type: "members" } }`).status).toBe("pass");
  });
});

import { isTrivial } from "./triviality.js";
import { scanFile } from "./scan.js";

const ep = (fileName: string, source: string) => scanFile(fileName, source)!;

describe("isTrivial", () => {
  it("treats a redirect-only route as trivial", () => {
    const e = ep(
      "@.ts",
      `import { redirect } from "@remix-run/server-runtime";
       export async function loader() { return redirect("/admin"); }`
    );
    expect(isTrivial(e)).toBe(true);
  });

  it("does not treat a route that queries the database as trivial", () => {
    const e = ep(
      "api.v1.things.ts",
      `import { prisma } from "~/db.server";
       export async function loader() {
         const rows = await prisma.thing.findMany();
         return rows;
       }`
    );
    expect(isTrivial(e)).toBe(false);
  });

  // The motivating case from the design: four lines, one delegating call, nothing to instrument.
  it("treats the impersonation-clearing route as trivial", () => {
    const e = ep(
      "@.ts",
      `import { clearImpersonation } from "~/models/admin.server";
       export async function loader({ request }) { return clearImpersonation(request, "/admin"); }`
    );
    expect(isTrivial(e)).toBe(true);
  });

  it("treats a static-response route as trivial", () => {
    const e = ep(
      "internal.webhooks.slack.interactivity.ts",
      `export function action() { return new Response(null, { status: 200 }); }`
    );
    expect(isTrivial(e)).toBe(true);
  });

  it("treats a guard and two fixed responses as trivial", () => {
    const e = ep(
      "api.v1.mock.ts",
      `export async function action() {
         if (process.env.NODE_ENV === "production") {
           return new Response("Not found", { status: 404 });
         }
         return new Response(JSON.stringify({ id: "123" }), { status: 200 });
       }`
    );
    expect(isTrivial(e)).toBe(true);
  });

  it("treats a params-parse and redirect as trivial", () => {
    const e = ep(
      "orgs.$organizationSlug.billing.ts",
      `import { redirect } from "@remix-run/server-runtime";
       import { OrganizationParamsSchema, v3BillingPath } from "~/utils/pathBuilder";
       export const loader = async ({ params }) => {
         const { organizationSlug } = OrganizationParamsSchema.parse(params);
         return redirect(v3BillingPath({ slug: organizationSlug }));
       };`
    );
    expect(isTrivial(e)).toBe(true);
  });
});

// statementCount deliberately does not descend into inline callbacks, so a two-statement body can
// still hold a pile of work. calleeNames does descend, which is what catches these.
describe("isTrivial: work hidden from the statement count", () => {
  it("does not treat a short body holding a busy callback as trivial", () => {
    const e = ep(
      "api.v1.remote-build-provider-status.ts",
      `export async function loader() {
         const result = await fromPromise(
           (async () => {
             const response = await callProvider();
             const parsed = ProviderStatus.safeParse(await response.json());
             if (!parsed.success) return err("bad-payload");
             return ok(parsed.data);
           })()
         );
         return result.match(toJson, toError);
       }`
    );
    expect(isTrivial(e)).toBe(false);
  });

  it("does not treat a builder-wrapped route with a one-line handler as trivial", () => {
    const e = ep(
      "api.v1.deployments.current.ts",
      `import { json } from "@remix-run/server-runtime";
       import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";
       export const loader = createLoaderApiRoute(
         { findResource: async (_params, auth) => lookup(auth) },
         async ({ resource }) => { return json(resource); }
       );`
    );
    expect(isTrivial(e)).toBe(false);
  });

  it("does not treat a body that delegates to a same-file helper as trivial", () => {
    const e = ep(
      "api.v1.proxy.ts",
      `export async function loader({ request }) { return proxy(request); }
       async function proxy(request) {
         const url = buildUrl(request);
         const response = await send(url);
         const body = await response.text();
         return new Response(body);
       }`
    );
    expect(isTrivial(e)).toBe(false);
  });
});

// Calibrated against apps/webapp/app/routes: three statements is the widest window that holds only
// redirects, fixed responses and single hand-offs. The fourth statement is where routes start
// authenticating and then calling a presenter, which is work worth reporting on.
describe("isTrivial: the statement boundary", () => {
  it("treats a three-statement redirect as trivial", () => {
    const e = ep(
      "schedules._index/route.tsx",
      `import { redirect } from "@remix-run/server-runtime";
       import { EnvironmentParamSchema, v3EnvironmentPath } from "~/utils/pathBuilder";
       export async function loader({ params }) {
         const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);
         const tasksPath = v3EnvironmentPath({ slug: organizationSlug }, { slug: projectParam }, { slug: envParam });
         return redirect(\`\${tasksPath}?types=SCHEDULED\`);
       }`
    );
    expect(isTrivial(e)).toBe(true);
  });

  it("does not treat an authenticated hand-off to a presenter as trivial", () => {
    const e = ep(
      "tasks.stream/route.tsx",
      `import { TasksStreamPresenter } from "~/presenters/v3/TasksStreamPresenter.server";
       import { requireUserId } from "~/services/session.server";
       import { EnvironmentParamSchema } from "~/utils/pathBuilder";
       export async function loader({ request, params }) {
         const userId = await requireUserId(request);
         const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);
         const presenter = new TasksStreamPresenter();
         return presenter.call({ request, projectParam, envParam, organizationSlug, userId });
       }`
    );
    expect(isTrivial(e)).toBe(false);
  });
});

describe("isTrivial: an error path is something to instrument", () => {
  it("does not treat a short body with a try/catch as trivial", () => {
    const e = ep(
      "api.v1.ping.ts",
      `export async function loader() {
         try { return await ping(); } catch { return null; }
       }`
    );
    expect(isTrivial(e)).toBe(false);
  });
});

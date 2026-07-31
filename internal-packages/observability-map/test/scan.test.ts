import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ParseFailureError, scanDirectory, scanFile } from "../src/scan.js";

const LOADER = `
import { json } from "@remix-run/server-runtime";
export async function loader() { return json({}); }
`;

const COMPONENT_ONLY = `
export default function Page() { return null; }
`;

describe("scanFile", () => {
  it("detects an exported loader as a server entry point", () => {
    const ep = scanFile("api.v1.things.ts", LOADER);
    expect(ep).not.toBeNull();
    expect(ep!.hasLoader).toBe(true);
    expect(ep!.hasAction).toBe(false);
  });

  it("ignores a route that only exports a component", () => {
    expect(scanFile("_app.things.tsx", COMPONENT_ONLY)).toBeNull();
  });

  it("detects a loader assigned from a call expression", () => {
    const ep = scanFile("api.v1.x.ts", `export const loader = createLoaderApiRoute({});`);
    expect(ep!.hasLoader).toBe(true);
    expect(ep!.loaderInitializerCallee).toBe("createLoaderApiRoute");
  });
});

describe("scanFile: named export clauses", () => {
  it("detects `export { loader }` and resolves the builder callee from the local declaration", () => {
    const ep = scanFile(
      "api.v1.query.ts",
      `
      const { loader } = createLoaderApiRoute({ findResource: async () => 1 }, async () => {
        const a = 1;
        return json({ a });
      });
      export { loader };
      `
    );
    expect(ep).not.toBeNull();
    expect(ep!.hasLoader).toBe(true);
    expect(ep!.loaderInitializerCallee).toBe("createLoaderApiRoute");
    expect(ep!.statementCount).toBe(2);
  });

  it("detects an aliased named export `export { h as loader }`", () => {
    const ep = scanFile(
      "api.v1.aliased.ts",
      `
      async function h() { return json({}); }
      export { h as loader };
      `
    );
    expect(ep).not.toBeNull();
    expect(ep!.hasLoader).toBe(true);
    expect(ep!.statementCount).toBe(1);
  });

  it("reports both `export const loader` and a separate `export { action }`", () => {
    const ep = scanFile(
      "api.v1.both.ts",
      `
      export const loader = createLoaderApiRoute({}, async () => json({}));
      const { action } = createActionApiRoute({}, async ({ body }) => {
        const x = body.x;
        return json({ x });
      });
      export { action };
      `
    );
    expect(ep).not.toBeNull();
    expect(ep!.hasLoader).toBe(true);
    expect(ep!.hasAction).toBe(true);
    expect(ep!.actionInitializerCallee).toBe("createActionApiRoute");
  });

  it("resolves an export assigned from a property of a local builder result", () => {
    const ep = scanFile(
      "api.v1.errors.$errorId.ignore.ts",
      `
      const route = createActionApiRoute({ method: "POST" }, async ({ body }) => {
        const a = 1;
        const b = 2;
        return json({ a, b });
      });
      export const action = route.action;
      export const loader = route.loader;
      `
    );
    expect(ep!.hasAction).toBe(true);
    expect(ep!.actionInitializerCallee).toBe("createActionApiRoute");
    // Both exports share one handler, so its statements are counted once.
    expect(ep!.statementCount).toBe(3);
  });

  it("counts a `handler` property body but not the surrounding builder config lambdas", () => {
    const ep = scanFile(
      "engine.v1.dev.presence.ts",
      `
      export const loader = createSSELoader({
        timeout: 1000,
        findResource: async (params) => {
          const a = 1;
          const b = 2;
          const c = 3;
          return lookup(a, b, c);
        },
        handler: async ({ request }) => {
          const auth = await authenticate(request);
          return stream(auth);
        },
      });
      `
    );
    expect(ep!.statementCount).toBe(2);
    expect(ep!.calleeNames).not.toContain("lookup");
  });

  it("counts the per-method `methods.POST.handler` bodies", () => {
    const ep = scanFile(
      "api.v1.prompts.$slug.override.ts",
      `
      const { action, loader } = createMultiMethodApiRoute({
        params: ParamsSchema,
        methods: {
          POST: {
            body: CreateBody,
            handler: async ({ body }) => {
              const created = await create(body);
              return json(created);
            },
          },
          DELETE: {
            handler: async ({ params }) => {
              return json({ ok: true });
            },
          },
        },
      });
      export { action, loader };
      `
    );
    expect(ep!.statementCount).toBe(3);
    expect(ep!.calleeNames).toContain("create");
  });

  it("ignores a nested config callback that happens to be named `handler`", () => {
    const ep = scanFile(
      "api.v1.named-collision.ts",
      `
      export const loader = build({
        onError: {
          handler: async () => {
            const a = 1;
            const b = 2;
            const c = 3;
            return null;
          },
        },
        handler: async () => json({}),
      });
      `
    );
    expect(ep!.statementCount).toBe(1);
  });

  it("ignores a callback passed to a decorator further along the builder chain", () => {
    const ep = scanFile(
      "api.v1.chained.ts",
      `
      export const loader = createLoaderApiRoute({}, async () => json({})).withCors(async () => {
        const a = 1;
        const b = 2;
        return a + b;
      });
      `
    );
    expect(ep!.loaderInitializerCallee).toBe("createLoaderApiRoute");
    expect(ep!.statementCount).toBe(1);
  });

  it("detects an action-only route", () => {
    const ep = scanFile(
      "api.v1.action-only.ts",
      `export async function action() { return json({}); }`
    );
    expect(ep).not.toBeNull();
    expect(ep!.hasAction).toBe(true);
    expect(ep!.hasLoader).toBe(false);
  });

  it("does not crash on a re-export or a star export", () => {
    expect(() => scanFile("re-export.ts", `export { loader } from "./other";`)).not.toThrow();
    expect(() => scanFile("star.ts", `export * from "./other";`)).not.toThrow();
    const ep = scanFile("re-export.ts", `export { loader } from "./other";`);
    expect(ep!.hasLoader).toBe(true);
    expect(ep!.loaderInitializerCallee).toBeNull();
  });
});

describe("scanFile: statement counting", () => {
  it("counts only the loader's statements, not a fat exported component's", () => {
    const ep = scanFile(
      "route.tsx",
      `
      export async function loader() {
        return json({});
      }
      export default function Page() {
        const a = 1;
        const b = 2;
        const c = 3;
        const d = 4;
        return null;
      }
      export function ErrorBoundary() {
        const e = 1;
        return null;
      }
      `
    );
    expect(ep!.statementCount).toBe(1);
  });

  it("counts through a try/catch wrapper rather than reporting 1", () => {
    const ep = scanFile(
      "otel.v1.traces.ts",
      `
      export async function action({ request }) {
        try {
          const body = await request.arrayBuffer();
          const result = await process(body);
          return json(result);
        } catch (e) {
          logger.error(e);
          return json({ error: true }, { status: 500 });
        }
      }
      `
    );
    // try (1) + 3 in the try block + 2 in the catch block
    expect(ep!.statementCount).toBe(6);
  });

  it("counts a same-file helper the body delegates to", () => {
    const ep = scanFile(
      "ph.$.ts",
      `
      async function proxyToPostHog(request) {
        const url = new URL(request.url);
        try {
          const upstream = await fetch(url);
          return new Response(upstream.body);
        } catch (e) {
          logger.error(e);
          return new Response(null, { status: 502 });
        }
      }
      export async function loader({ request }) {
        return proxyToPostHog(request);
      }
      export async function action({ request }) {
        return proxyToPostHog(request);
      }
      `
    );
    // loader (1) + action (1) + helper: const url, try (1) + 2 + 2
    expect(ep!.statementCount).toBe(8);
    expect(ep!.hasTryCatch).toBe(true);
    expect(ep!.calleeNames).toContain("proxyToPostHog");
    expect(ep!.calleeNames).toContain("fetch");
  });

  it("counts a shared helper once when both the loader and the action delegate to it", () => {
    const ep = scanFile(
      "shared.ts",
      `
      function work() {
        const a = 1;
        const b = 2;
        return a + b;
      }
      export async function loader() { return work(); }
      export async function action() { return work(); }
      `
    );
    // loader (1) + action (1) + helper (3), the helper counted once
    expect(ep!.statementCount).toBe(5);
  });

  it("follows a delegating helper one hop only", () => {
    const ep = scanFile(
      "two-hop.ts",
      `
      function deep() {
        const a = 1;
        const b = 2;
        const c = 3;
        return a + b + c;
      }
      function shallow() {
        return deep();
      }
      export async function loader() { return shallow(); }
      `
    );
    // loader (1) + shallow (1). `deep` is a second hop and is not counted.
    expect(ep!.statementCount).toBe(2);
  });

  it("terminates on a recursive helper", () => {
    const ep = scanFile(
      "recursive.ts",
      `
      function recurse(n) {
        if (n <= 0) return 0;
        return recurse(n - 1);
      }
      export async function loader() { return recurse(3); }
      `
    );
    // loader (1) + recurse: if (1) + return (1) + return (1)
    expect(ep!.statementCount).toBe(4);
  });

  it("does not count an imported helper it cannot resolve", () => {
    const ep = scanFile(
      "imported.ts",
      `
      import { proxy } from "./proxy.server";
      export async function loader({ request }) {
        return proxy(request);
      }
      `
    );
    expect(ep!.statementCount).toBe(1);
    expect(ep!.hasTryCatch).toBe(false);
  });

  it("does not count a same-file function the body never calls", () => {
    const ep = scanFile(
      "unused-helper.ts",
      `
      function unrelated() {
        try {
          const a = 1;
          const b = 2;
          return a + b;
        } catch (e) {
          return null;
        }
      }
      export async function loader() {
        return json({});
      }
      `
    );
    expect(ep!.statementCount).toBe(1);
    expect(ep!.hasTryCatch).toBe(false);
  });

  it("counts statements nested in if/for/while/switch blocks", () => {
    const ep = scanFile(
      "nested.ts",
      `
      export async function loader() {
        if (a) {
          const x = 1;
          doThing(x);
        }
        for (const i of list) {
          use(i);
        }
        return json({});
      }
      `
    );
    // if (1) + 2 nested + for (1) + 1 nested + return (1)
    expect(ep!.statementCount).toBe(6);
  });
});

describe("scanFile: entry-point scoping", () => {
  it("reports hasTryCatch false when the only try is in a non-entry-point export", () => {
    const ep = scanFile(
      "route.tsx",
      `
      export async function loader() {
        return json({});
      }
      export default function Page() {
        try {
          render();
        } catch (e) {
          report(e);
        }
        return null;
      }
      `
    );
    expect(ep!.hasLoader).toBe(true);
    expect(ep!.hasTryCatch).toBe(false);
  });

  it("reports hasTryCatch true when the try is inside the loader", () => {
    const ep = scanFile(
      "route.tsx",
      `
      export async function loader() {
        try {
          return json(await load());
        } catch (e) {
          return json({}, { status: 500 });
        }
      }
      `
    );
    expect(ep!.hasTryCatch).toBe(true);
  });

  it("excludes callees invoked outside the loader/action body", () => {
    const ep = scanFile(
      "route.tsx",
      `
      const schema = z.object({});
      export async function loader() {
        const data = await fetchThings();
        return json(data);
      }
      export default function Page() {
        useFancyHook();
        return null;
      }
      `
    );
    expect(ep!.calleeNames).toContain("fetchThings");
    expect(ep!.calleeNames).toContain("json");
    expect(ep!.calleeNames).not.toContain("useFancyHook");
    expect(ep!.calleeNames).not.toContain("object");
  });
});

describe("scanFile: callee resolution", () => {
  it("records the root callee of a chained builder call", () => {
    const ep = scanFile(
      "api.v1.cors.ts",
      `export const loader = createLoaderApiRoute({}).withCors();`
    );
    expect(ep!.loaderInitializerCallee).toBe("createLoaderApiRoute");
  });

  it("leaves the callee null for a shape that cannot be named", () => {
    const ep = scanFile("api.v1.anon.ts", `export const loader = async () => json({});`);
    expect(ep!.hasLoader).toBe(true);
    expect(ep!.loaderInitializerCallee).toBeNull();
  });
});

describe("scanFile: parse failures", () => {
  it("throws on a malformed source rather than returning a clean entry point", () => {
    expect(() =>
      scanFile("broken.ts", `export async function loader() { const a = ; return json(`)
    ).toThrow(ParseFailureError);
  });

  it("does not throw on a well-formed tsx route", () => {
    expect(() =>
      scanFile(
        "route.tsx",
        `export async function loader() { return json({}); }
         export default function Page() { return <div className="x">hi</div>; }`
      )
    ).not.toThrow();
  });
});

describe("scanDirectory", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "obs-map-scan-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("recurses into route directories and keeps file names distinct", () => {
    writeFileSync(join(dir, "a.ts"), `export async function loader() { return json({}); }`);
    mkdirSync(join(dir, "nested.route"));
    writeFileSync(
      join(dir, "nested.route", "route.tsx"),
      `export async function loader() { return json({}); }`
    );
    mkdirSync(join(dir, "other.route"));
    writeFileSync(
      join(dir, "other.route", "route.tsx"),
      `export async function action() { return json({}); }`
    );

    const { entryPoints, parseFailures } = scanDirectory(dir);
    const names = entryPoints.map((ep) => ep.fileName).sort();

    expect(parseFailures).toEqual([]);
    expect(names).toEqual(["a.ts", "nested.route/route.tsx", "other.route/route.tsx"]);
  });

  it("records a malformed file as a parse failure instead of an entry point", () => {
    writeFileSync(
      join(dir, "broken.ts"),
      `export async function loader() { const a = ; return json(`
    );

    const { entryPoints, parseFailures } = scanDirectory(dir);

    expect(entryPoints).toEqual([]);
    expect(parseFailures).toHaveLength(1);
    // The file name, then the diagnostic that made it a failure.
    expect(parseFailures[0]).toMatch(/^broken\.ts: \S/);
  });

  // root ignores the mode bits, so the unreadable file would read fine.
  it.skipIf(process.getuid?.() === 0)(
    "rethrows an error that is not a parse failure instead of counting it as one",
    () => {
      const unreadable = join(dir, "unreadable.ts");
      writeFileSync(unreadable, `export async function loader() { return json({}); }`);
      chmodSync(unreadable, 0o000);

      try {
        expect(() => scanDirectory(dir)).toThrow(/EACCES|EPERM/);
      } finally {
        chmodSync(unreadable, 0o600);
      }
    }
  );

  it("skips a non-route file inside a route directory", () => {
    mkdirSync(join(dir, "nested.route"));
    writeFileSync(
      join(dir, "nested.route", "route.tsx"),
      `export async function loader() { return json({}); }`
    );
    writeFileSync(
      join(dir, "nested.route", "loaders.server.ts"),
      `export async function loader() { return json({}); }`
    );

    const { entryPoints } = scanDirectory(dir);

    expect(entryPoints.map((ep) => ep.fileName)).toEqual(["nested.route/route.tsx"]);
  });

  it("scans a route file whose name ends in .test.ts but skips .d.ts", () => {
    writeFileSync(
      join(dir, "projects.v3.$projectRef.test.ts"),
      `export async function loader() { return json({}); }`
    );
    writeFileSync(join(dir, "types.d.ts"), `export declare const x: number;`);

    const { entryPoints } = scanDirectory(dir);

    expect(entryPoints.map((ep) => ep.fileName)).toEqual(["projects.v3.$projectRef.test.ts"]);
  });
});

describe("scanFile: catch clause evidence", () => {
  it("sets catchRethrows when a catch rethrows", () => {
    const ep = scanFile(
      "rethrow.ts",
      `
      export async function loader({ request }) {
        try {
          return json(await load(request));
        } catch (e) {
          logger.error(e);
          throw e;
        }
      }
      `
    );
    expect(ep!.hasTryCatch).toBe(true);
    expect(ep!.catchRethrows).toBe(true);
    expect(ep!.catchBranches).toBe(false);
  });

  it("leaves both flags false when the catch only returns", () => {
    const ep = scanFile(
      "swallow.ts",
      `
      export async function loader({ request }) {
        try {
          return json(await load(request));
        } catch (e) {
          return null;
        }
      }
      `
    );
    expect(ep!.hasTryCatch).toBe(true);
    expect(ep!.catchRethrows).toBe(false);
    expect(ep!.catchBranches).toBe(false);
  });

  it("sets catchBranches for an `if` on the error", () => {
    const ep = scanFile(
      "branch-if.ts",
      `
      export async function loader({ request }) {
        try {
          return json(await request.json());
        } catch (e) {
          if (e instanceof SyntaxError) {
            return json({ error: "bad json" }, { status: 400 });
          }
          return json({ error: "failed" }, { status: 500 });
        }
      }
      `
    );
    expect(ep!.catchBranches).toBe(true);
    expect(ep!.catchRethrows).toBe(false);
  });

  it("sets catchBranches for an instanceof conditional that is the whole returned expression", () => {
    const ep = scanFile(
      "branch-instanceof.ts",
      `
      export async function loader({ request }) {
        try {
          return json(await load(request));
        } catch (e) {
          return e instanceof Response ? e : json({}, { status: 500 });
        }
      }
      `
    );
    expect(ep!.catchBranches).toBe(true);
  });

  it("sets catchBranches for a switch in the catch", () => {
    const ep = scanFile(
      "branch-switch.ts",
      `
      export async function loader({ request }) {
        try {
          return json(await load(request));
        } catch (e) {
          switch (e.code) {
            case "P2025":
              return json({}, { status: 404 });
            default:
              return json({}, { status: 500 });
          }
        }
      }
      `
    );
    expect(ep!.catchBranches).toBe(true);
  });

  it("ignores a catch that lives in the React component", () => {
    const ep = scanFile(
      "route.tsx",
      `
      export async function loader() {
        return json({});
      }
      export default function Page() {
        try {
          render();
        } catch (e) {
          if (e instanceof RenderError) throw e;
          return null;
        }
      }
      `
    );
    expect(ep!.hasTryCatch).toBe(false);
    expect(ep!.catchRethrows).toBe(false);
    expect(ep!.catchBranches).toBe(false);
  });

  it("reads a catch inside a same-file helper the body delegates to", () => {
    const ep = scanFile(
      "ph.$.ts",
      `
      async function proxy(request) {
        try {
          return await fetch(request.url);
        } catch (e) {
          if (e.name === "AbortError") throw e;
          return new Response(null, { status: 502 });
        }
      }
      export async function loader({ request }) {
        return proxy(request);
      }
      `
    );
    expect(ep!.hasTryCatch).toBe(true);
    expect(ep!.catchRethrows).toBe(true);
    expect(ep!.catchBranches).toBe(true);
  });

  it("leaves both flags false for a try with no catch", () => {
    const ep = scanFile(
      "finally-only.ts",
      `
      export async function loader() {
        try {
          return json(await load());
        } finally {
          release();
        }
      }
      `
    );
    expect(ep!.hasTryCatch).toBe(true);
    expect(ep!.catchRethrows).toBe(false);
    expect(ep!.catchBranches).toBe(false);
  });
});

describe("scanFile: callee texts", () => {
  it("keeps the full callee expression alongside the bare name", () => {
    const ep = scanFile(
      "api.v1.things.ts",
      `
      export async function loader({ request }) {
        const org = await prisma.organization.findFirst({ where: { id: 1 } });
        logger.error("nope", { organizationId: org.id });
        return json(org);
      }
      `
    );
    expect(ep!.calleeNames).toContain("findFirst");
    expect(ep!.calleeTexts).toContain("prisma.organization.findFirst");
    expect(ep!.calleeTexts).toContain("logger.error");
    expect(ep!.calleeTexts).toContain("json");
    // Index-aligned with calleeNames, so a consumer can read either.
    expect(ep!.calleeTexts).toHaveLength(ep!.calleeNames.length);
  });

  it("does not leak calls made in the React component", () => {
    const ep = scanFile(
      "route.tsx",
      `
      export async function loader() {
        return json(await prisma.run.findMany());
      }
      export default function Page() {
        useFancyHook();
        analytics.track("viewed");
        return null;
      }
      `
    );
    expect(ep!.calleeTexts).toContain("prisma.run.findMany");
    expect(ep!.calleeTexts).not.toContain("analytics.track");
    expect(ep!.calleeTexts).not.toContain("useFancyHook");
  });

  it("records callee texts from a same-file helper the body delegates to", () => {
    const ep = scanFile(
      "delegating.ts",
      `
      async function load(id) {
        return prisma.project.findUnique({ where: { id } });
      }
      export async function loader({ params }) {
        return json(await load(params.id));
      }
      `
    );
    expect(ep!.calleeTexts).toContain("prisma.project.findUnique");
  });

  it("falls back to the bare name for a callee it cannot render as a path", () => {
    const ep = scanFile(
      "new-expression.ts",
      `
      export async function action({ request }) {
        return json(await new PromptService().createOverride(request));
      }
      `
    );
    expect(ep!.calleeNames).toContain("createOverride");
    expect(ep!.calleeTexts).toContain("createOverride");
    expect(ep!.calleeTexts).toHaveLength(ep!.calleeNames.length);
  });
});

describe("scanFile: log calls", () => {
  it("records the fields of a log call's object argument", () => {
    const ep = scanFile(
      "logging.ts",
      `
      export async function loader({ request }) {
        try {
          return json(await load(request));
        } catch (e) {
          logger.error("load failed", { environmentId: env.id, error: e });
          return json({}, { status: 500 });
        }
      }
      `
    );
    expect(ep!.logCalls).toHaveLength(1);
    expect(ep!.logCalls[0]).toEqual({
      callee: "logger.error",
      hasObjectArgument: true,
      fields: ["environmentId", "error"],
      inCatch: true,
    });
  });

  it("records a log call with no object argument, outside a catch", () => {
    const ep = scanFile(
      "logging-plain.ts",
      `
      export async function loader() {
        log.info("starting");
        return json({});
      }
      `
    );
    expect(ep!.logCalls).toEqual([
      { callee: "log.info", hasObjectArgument: false, fields: [], inCatch: false },
    ]);
  });

  it("ignores a non-logger call and a log call in the React component", () => {
    const ep = scanFile(
      "route.tsx",
      `
      export async function loader() {
        return json(await load());
      }
      export default function Page() {
        logger.debug("rendered", { runId: 1 });
        return null;
      }
      `
    );
    expect(ep!.logCalls).toEqual([]);
  });
});

describe("scanFile: narrow catches", () => {
  it("flags a try that guards a single request.json()", () => {
    const ep = scanFile(
      "admin.api.v1.platform-notifications.ts",
      `
      export async function action({ request }) {
        const user = await requireUser(request);
        let body;
        try {
          body = await request.json();
        } catch {
          return json({ error: "Invalid JSON body" }, { status: 400 });
        }
        const result = await createPlatformNotification(body);
        return json(result);
      }
      `
    );
    expect(ep!.hasTryCatch).toBe(true);
    expect(ep!.catchRethrows).toBe(false);
    expect(ep!.catchBranches).toBe(false);
    expect(ep!.catchesNarrowly).toBe(true);
  });

  it("does not flag a catch wrapping the whole handler", () => {
    const ep = scanFile(
      "otel.v1.logs.ts",
      `
      export async function action({ request }) {
        try {
          const exporter = await otlpExporter;
          const contentType = request.headers.get("content-type") ?? "";
          const body = await request.json();
          await exporter.export(body);
          return json({ ok: true });
        } catch (e) {
          logger.error(e);
          return json({}, { status: 500 });
        }
      }
      `
    );
    expect(ep!.hasTryCatch).toBe(true);
    expect(ep!.catchesNarrowly).toBe(false);
  });

  it("does not flag a body that has both a narrow catch and a broad one", () => {
    const ep = scanFile(
      "mixed.ts",
      `
      export async function action({ request }) {
        let body;
        try {
          body = await request.json();
        } catch {
          return json({}, { status: 400 });
        }
        try {
          const run = await find(body.id);
          const updated = await update(run);
          await notify(updated);
          return json(updated);
        } catch (e) {
          return json({}, { status: 500 });
        }
      }
      `
    );
    expect(ep!.catchesNarrowly).toBe(false);
  });

  it("allows a guarded operation with its own local binding", () => {
    const ep = scanFile(
      "regex.ts",
      `
      export async function action({ request }) {
        const pattern = await patternFrom(request);
        try {
          const stripped = pattern.startsWith("(?i)") ? pattern.slice(4) : pattern;
          new RegExp(stripped);
        } catch {
          return json({ error: "Invalid regex" }, { status: 400 });
        }
        return json({ ok: true });
      }
      `
    );
    expect(ep!.catchesNarrowly).toBe(true);
  });

  it("does not flag a try of three statements", () => {
    const ep = scanFile(
      "three.ts",
      `
      export async function loader({ request }) {
        try {
          const raw = await request.json();
          const parsed = Schema.parse(raw);
          return json(parsed);
        } catch {
          return json({}, { status: 400 });
        }
      }
      `
    );
    expect(ep!.catchesNarrowly).toBe(false);
  });

  it("is false when there is no try at all", () => {
    const ep = scanFile("plain.ts", `export async function loader() { return json({}); }`);
    expect(ep!.hasTryCatch).toBe(false);
    expect(ep!.catchesNarrowly).toBe(false);
  });

  it("is false for a try with a finally and no catch", () => {
    const ep = scanFile(
      "finally-only.ts",
      `
      export async function loader() {
        try {
          return json(await load());
        } finally {
          release();
        }
      }
      `
    );
    expect(ep!.hasTryCatch).toBe(true);
    expect(ep!.catchesNarrowly).toBe(false);
  });

  it("reads a narrow catch inside a same-file helper the body delegates to", () => {
    const ep = scanFile(
      "helper-narrow.ts",
      `
      function parseTags(payload) {
        try {
          return JSON.parse(payload);
        } catch {
          return null;
        }
      }
      export async function loader({ params }) {
        return json(parseTags(params.payload));
      }
      `
    );
    expect(ep!.hasTryCatch).toBe(true);
    expect(ep!.catchesNarrowly).toBe(true);
  });

  it("ignores a narrow catch that lives in the React component", () => {
    const ep = scanFile(
      "route.tsx",
      `
      export async function loader() {
        return json({});
      }
      export default function Page() {
        try {
          JSON.parse(raw);
        } catch {
          return null;
        }
        return null;
      }
      `
    );
    expect(ep!.hasTryCatch).toBe(false);
    expect(ep!.catchesNarrowly).toBe(false);
  });
});

describe("scanFile: per-catch evidence", () => {
  it("records one entry per catch clause, keeping a narrow guard distinct from a broad catch", () => {
    const ep = scanFile(
      "two-catches.ts",
      `
      export async function action({ request }) {
        let body;
        try {
          body = await request.json();
        } catch {
          return json({}, { status: 400 });
        }
        try {
          const run = await find(body.id);
          const updated = await update(run);
          await notify(updated);
          return json(updated);
        } catch (e) {
          return json({}, { status: 500 });
        }
      }
      `
    );
    expect(ep!.catches).toHaveLength(2);
    expect(ep!.catches[0]).toEqual({
      narrow: true,
      rethrows: false,
      branches: false,
      guardsParse: true,
      tryStatementCount: 1,
    });
    expect(ep!.catches[1]).toMatchObject({
      narrow: false,
      guardsParse: false,
      tryStatementCount: 4,
    });
    // The aggregate still collapses, which is why the per-catch list exists.
    expect(ep!.catchesNarrowly).toBe(false);
  });

  it("leaves catches empty for a try/finally with no catch clause", () => {
    const ep = scanFile(
      "runs-replication.status.ts",
      `
      export async function loader() {
        const redis = createRedis();
        try {
          for (const source of sources) {
            const exists = await redis.exists(source.slotName);
            leaders.set(source.id, exists === 1);
          }
        } finally {
          await redis.quit();
        }
        return json({});
      }
      `
    );
    expect(ep!.catches).toEqual([]);
    // hasTryCatch keeps its meaning: a `try` appears. Nothing is caught here.
    expect(ep!.hasTryCatch).toBe(true);
    expect(ep!.catchRethrows).toBe(false);
    expect(ep!.catchBranches).toBe(false);
    expect(ep!.catchesNarrowly).toBe(false);
  });

  it("sees a URL constructor as a guarded parse", () => {
    const ep = scanFile(
      "_app.@.orgs.$organizationSlug.$.tsx",
      `
      function refererOrigin(request) {
        const referer = request.headers.get("referer");
        if (!referer) return undefined;
        try {
          return new URL(referer).origin;
        } catch {
          return undefined;
        }
      }
      export async function action({ request }) {
        const origin = refererOrigin(request);
        return json({ origin });
      }
      `
    );
    expect(ep!.catches).toHaveLength(1);
    expect(ep!.catches[0]!.guardsParse).toBe(true);
    expect(ep!.catches[0]!.narrow).toBe(true);
  });

  it("sees a parse in a try that grew past the narrowness threshold", () => {
    const ep = scanFile(
      "admin.api.v1.orgs.$organizationId.stream-basin.ts",
      `
      export async function action({ request }) {
        let parsed;
        try {
          const text = await request.text();
          const raw = text.length > 0 ? JSON.parse(text) : {};
          const result = BodySchema.safeParse(raw);
          if (!result.success) {
            return json({ ok: false }, { status: 400 });
          }
          parsed = result.data;
        } catch {
          return json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
        }
        return json(parsed);
      }
      `
    );
    expect(ep!.catches).toHaveLength(1);
    expect(ep!.catches[0]!.narrow).toBe(false);
    expect(ep!.catches[0]!.guardsParse).toBe(true);
    expect(ep!.catches[0]!.tryStatementCount).toBe(6);
  });

  it("does not call a broad catch over database work a parse guard", () => {
    const ep = scanFile(
      "broad.ts",
      `
      export async function loader({ params }) {
        try {
          const run = await prisma.run.findFirst({ where: { id: params.id } });
          const events = await prisma.event.findMany({ where: { runId: run.id } });
          await touch(run);
          return json({ run, events });
        } catch (e) {
          return json({}, { status: 500 });
        }
      }
      `
    );
    expect(ep!.catches).toHaveLength(1);
    expect(ep!.catches[0]).toEqual({
      narrow: false,
      rethrows: false,
      branches: false,
      guardsParse: false,
      tryStatementCount: 4,
    });
  });

  it("keeps rethrow and branch evidence per clause", () => {
    const ep = scanFile(
      "mixed-clauses.ts",
      `
      export async function loader({ request }) {
        try {
          return json(await load(request));
        } catch (e) {
          if (e instanceof Response) throw e;
          return json({}, { status: 500 });
        }
      }
      export async function action({ request }) {
        try {
          return json(await save(request));
        } catch (e) {
          return null;
        }
      }
      `
    );
    expect(ep!.catches).toHaveLength(2);
    expect(ep!.catches.filter((c) => c.rethrows && c.branches)).toHaveLength(1);
    expect(ep!.catches.filter((c) => !c.rethrows && !c.branches)).toHaveLength(1);
    // Aggregates stay as they are: any clause sets them.
    expect(ep!.catchRethrows).toBe(true);
    expect(ep!.catchBranches).toBe(true);
  });

  it("includes a catch from a same-file helper and excludes one from the React component", () => {
    const ep = scanFile(
      "route.tsx",
      `
      function parseTags(payload) {
        try {
          return JSON.parse(payload);
        } catch {
          return null;
        }
      }
      export async function loader({ params }) {
        return json(parseTags(params.payload));
      }
      export default function Page() {
        try {
          render();
        } catch (e) {
          throw e;
        }
        return null;
      }
      `
    );
    expect(ep!.catches).toHaveLength(1);
    expect(ep!.catches[0]!.guardsParse).toBe(true);
    expect(ep!.catchRethrows).toBe(false);
  });

  it("keeps the aggregates derivable from the per-catch list", () => {
    const ep = scanFile(
      "aggregate.ts",
      `
      export async function loader({ request }) {
        try {
          return json(await request.json());
        } catch (e) {
          if (e instanceof SyntaxError) return json({}, { status: 400 });
          return json({}, { status: 500 });
        }
      }
      `
    );
    expect(ep!.catchRethrows).toBe(ep!.catches.some((c) => c.rethrows));
    expect(ep!.catchBranches).toBe(ep!.catches.some((c) => c.branches));
    expect(ep!.catchesNarrowly).toBe(ep!.catches.length > 0 && ep!.catches.every((c) => c.narrow));
  });
});

describe("scanFile: guardsParse is limited to parsing constructors", () => {
  it("does not treat a presenter construction as a parse guard", () => {
    const ep = scanFile(
      "_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.branches/route.tsx",
      `
      export async function loader({ request, params }) {
        try {
          const presenter = new BranchesPresenter();
          const result = await presenter.call({ userId: 1, projectSlug: params.projectParam });
          return typedjson(result);
        } catch (error) {
          logger.error("Error loading preview branches page", { error });
          throw new Response(undefined, { status: 400 });
        }
      }
      `
    );
    expect(ep!.catches).toHaveLength(1);
    expect(ep!.catches[0]!.guardsParse).toBe(false);
  });

  it("does not treat a collection construction as a parse guard", () => {
    const ep = scanFile(
      "account.tokens/route.tsx",
      `
      export async function action({ request }) {
        try {
          const roles = await loadRoles(request);
          const names = new Set(roles.map((r) => r.name));
          return json({ names: [...names] });
        } catch (error) {
          return json({ error: "failed" }, { status: 400 });
        }
      }
      `
    );
    expect(ep!.catches[0]!.guardsParse).toBe(false);
  });

  it("treats RegExp and URLSearchParams construction as a parse guard", () => {
    const regexp = scanFile(
      "regexp.ts",
      `
      export async function action({ request }) {
        const pattern = await patternFrom(request);
        try {
          new RegExp(pattern);
        } catch {
          return json({ error: "Invalid regex" }, { status: 400 });
        }
        return json({ ok: true });
      }
      `
    );
    expect(regexp!.catches[0]!.guardsParse).toBe(true);

    const search = scanFile(
      "search-params.ts",
      `
      export async function loader({ request }) {
        try {
          return json(Object.fromEntries(new URLSearchParams(request.url)));
        } catch {
          return json({}, { status: 400 });
        }
      }
      `
    );
    expect(search!.catches[0]!.guardsParse).toBe(true);
  });

  it("still sees a parse call in a try that also constructs something ordinary", () => {
    const ep = scanFile(
      "parse-and-construct.ts",
      `
      export async function action({ request }) {
        try {
          const body = JSON.parse(await request.text());
          const service = new PromptService();
          return json(await service.create(body));
        } catch {
          return json({}, { status: 400 });
        }
      }
      `
    );
    expect(ep!.catches[0]!.guardsParse).toBe(true);
  });
});

describe("scanFile: branches ignores the error-stringifying ternary", () => {
  it("does not count an instanceof nested inside a returned call argument", () => {
    const ep = scanFile(
      "admin.api.v1.runs-replication.start.ts",
      `
      export async function action({ request }) {
        try {
          return json(await start(request));
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : error }, { status: 400 });
        }
      }
      `
    );
    expect(ep!.catches).toHaveLength(1);
    expect(ep!.catches[0]!.branches).toBe(false);
    expect(ep!.catchBranches).toBe(false);
  });

  it("does not count an instanceof used to build a logged message", () => {
    const ep = scanFile(
      "admin.api.v1.feature-flags.ts",
      `
      export async function action({ request }) {
        try {
          return json(await setFlag(request));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error("flag update failed", { message });
          return json({ error: message }, { status: 400 });
        }
      }
      `
    );
    expect(ep!.catches[0]!.branches).toBe(false);
  });

  it("still counts an instanceof in an `if`", () => {
    const ep = scanFile(
      "branch-if-instanceof.ts",
      `
      export async function loader({ request }) {
        try {
          return json(await load(request));
        } catch (e) {
          if (e instanceof Response) return e;
          return json({}, { status: 500 });
        }
      }
      `
    );
    expect(ep!.catches[0]!.branches).toBe(true);
  });
});

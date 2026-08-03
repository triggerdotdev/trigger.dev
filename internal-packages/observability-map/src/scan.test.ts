import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ParseFailureError, routeModuleFiles, scanDirectory, scanFile } from "./scan.js";

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

  it("resolves a multi-level call and falls back to the bare name past an unnameable one", () => {
    const ep = scanFile(
      "api.v1.things.ts",
      `
      export async function loader({ request }) {
        try {
          const org = await prisma.organization.findFirst({ where: { id: 1 } });
          return json(await new PromptService().createOverride(org));
        } catch (e) {
          logger.error("nope", { error: e });
          return json({}, { status: 500 });
        }
      }
      `
    );
    // A three-level property chain still lands on its bare method name.
    expect(ep!.calleeNames).toContain("findFirst");
    // A chain through a `new` expression has no name of its own, so this also falls back to the
    // bare name rather than losing the call.
    expect(ep!.calleeNames).toContain("createOverride");
    // The full path still builds where nothing unnameable sits in it, which is what `LogCall.callee`
    // depends on.
    expect(ep!.logCalls[0]!.callee).toBe("logger.error");
  });
});

describe("scanFile: parse failures", () => {
  it("throws on a malformed source rather than returning a clean entry point", () => {
    expect(() =>
      scanFile("broken.ts", `export async function loader() { const a = ; return json(`)
    ).toThrow(ParseFailureError);
  });

  // The shapes that prove the public route through `ts.Program` still sees a malformed file.
  it("throws on an unclosed jsx element in a tsx route", () => {
    expect(() =>
      scanFile(
        "broken.route.tsx",
        `export async function loader() { return json({}); }
         export default function Page() { return <div className="x">hi</span>; }`
      )
    ).toThrow(ParseFailureError);
  });

  it("throws on an unterminated template literal", () => {
    expect(() =>
      scanFile("broken.ts", `export async function loader() { return \`unterminated; }`)
    ).toThrow(ParseFailureError);
  });

  it("throws on a stray closing brace after a complete function", () => {
    expect(() =>
      scanFile("broken.ts", `export async function loader() { return json({}); } }`)
    ).toThrow(ParseFailureError);
  });

  it("names the diagnostic rather than reporting a bare failure", () => {
    try {
      scanFile("broken.ts", `export async function loader() { const a = ; }`);
      expect.unreachable("scanFile should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ParseFailureError);
      expect((error as ParseFailureError).diagnostic.length).toBeGreaterThan(0);
    }
  });

  // Both spellings find the same malformed files today, so the tests above cannot tell them apart.
  // What a compiler upgrade can break is the private one, and only a source-level guard fails for it.
  it("reads its diagnostics through public typescript api rather than a private field", () => {
    const source = readFileSync(resolve(__dirname, "./scan.ts"), "utf8");
    expect(source).not.toContain("parseDiagnostics");
    expect(source).toContain("getSyntacticDiagnostics");
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
  it("sets rethrows on the clause when a catch rethrows", () => {
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
    expect(ep!.catches[0]!.rethrows).toBe(true);
    expect(ep!.catches[0]!.branches).toBe(false);
  });

  // `rethrows` was once set by any `ThrowStatement` at all, so a `throw e;` appended after a `return`
  // flipped a swallowing catch to inert with no behavioural change.
  it("does not set rethrows for a throw that is dead code after a return", () => {
    const ep = scanFile(
      "dead-throw.ts",
      `
      export async function loader({ request }) {
        try {
          return json(await load(request));
        } catch (e) {
          return null;
          throw e;
        }
      }
      `
    );
    expect(ep!.catches[0]!.rethrows).toBe(false);
    expect(ep!.catches[0]!.branches).toBe(false);
  });

  // Dead code from a statically-false condition, and a throw merely REGISTERED in a callback the
  // clause constructs. All four must leave a plain swallow inert.
  describe("dead and deferred code inside a catch does not count as evidence", () => {
    const swallow = (mutation: string) => `
      export async function loader() {
        try {
          return await prisma.thing.findMany();
        } catch (e) {
          ${mutation}
          return null;
        }
      }
    `;

    it("is inert as a baseline with no mutation", () => {
      const ep = scanFile("x.ts", swallow(""));
      expect(ep!.catches[0]).toMatchObject({ rethrows: false, branches: false });
    });

    // Eleven shapes that put a `throw` somewhere it can never run, none of them named in the rule: a
    // throw counts when it is unconditional. No claim the list is complete, and a twelfth family
    // arrived the round after, see `dead throw written after something that already exited`.
    const DEAD_SHAPES: Array<[string, string]> = [
      ["if (false)", "if (false) { throw e; }"],
      ["while (false)", "while (false) { throw e; }"],
      ["for (;false;)", "for (;false;) { throw e; }"],
      ["if (true) else", "if (true) { doThing(); } else { throw e; }"],
      ["switch with no matching case", "switch (1) { case 2: throw e; }"],
      ["inner try/catch", "try { doThing(); } catch { throw e; }"],
      ["for...of an empty array", "for (const item of []) { throw e; }"],
      ["for...in an empty object", "for (const key in {}) { throw e; }"],
      ["if on an empty string", 'if ("") { throw e; }'],
      ["if on a negated literal", "if (!true) { throw e; }"],
      ["if on a constant comparison", "if (1 === 2) { throw e; }"],
    ];

    for (const [label, shape] of DEAD_SHAPES) {
      it(`does not set rethrows for a throw inside ${label}`, () => {
        const ep = scanFile("x.ts", swallow(shape));
        expect(ep!.catches[0]).toMatchObject({ rethrows: false, branches: false });
      });
    }

    it("does not set rethrows for a throw merely registered in a constructed callback", () => {
      const ep = scanFile("x.ts", swallow("queue.push(() => { throw e; });"));
      expect(ep!.catches[0]).toMatchObject({ rethrows: false, branches: false });
    });

    it("does not set branches for an error test merely registered in a constructed callback", () => {
      const ep = scanFile(
        "x.ts",
        swallow("queue.push(() => { if (e instanceof Error) { doThing(); } });")
      );
      expect(ep!.catches[0]).toMatchObject({ rethrows: false, branches: false });
    });

    // The same "merely registered" mechanism under a different callback-taking call, so the fix is
    // not scoped to `.push`.
    it("does not set rethrows for a throw registered in a setTimeout callback", () => {
      const ep = scanFile("x.ts", swallow("setTimeout(() => { throw e; }, 0);"));
      expect(ep!.catches[0]).toMatchObject({ rethrows: false, branches: false });
    });

    // Positive control: a do/while runs its body at least once, so a throw in one is genuinely
    // unconditional and the while(false) fix must not have swallowed it too.
    it("still sets rethrows for a throw in a do/while, which runs its body once regardless", () => {
      const ep = scanFile("x.ts", swallow("do { throw e; } while (false);"));
      expect(ep!.catches[0]!.rethrows).toBe(true);
    });
  });

  // The mirror of the family above: each dead spelling earns nothing and must also COST nothing,
  // since a containment read of the dead statement raised `exited` and blinded the walk to the real
  // classification below it, on 78 real routes. The spellings are the CORPUS ones from `dead-*`, not
  // the `DEAD_SHAPES` table's, whose inner-try twin is not provably dead and gets no twin here.
  describe("dead and deferred code prepended to a deciding catch does not blind it", () => {
    const deciding = (mutation: string) => `
      export async function loader() {
        try {
          return await prisma.thing.findMany();
        } catch (e) {
          ${mutation}
          if (e instanceof Error) { return new Response(null, { status: 400 }); }
          return new Response(null, { status: 500 });
        }
      }
    `;

    it("decides as a baseline with no mutation", () => {
      const ep = scanFile("x.ts", deciding(""));
      expect(ep!.catches[0]!.branches).toBe(true);
    });

    const DEAD_PREPENDS: Array<[string, string]> = [
      ["if (false)", "if (false) { throw e; }"],
      ["while (false)", "while (false) { throw e; }"],
      ["for (;false;)", "for (;false;) { throw e; }"],
      ["if (true) else", "if (true) { 0; } else { throw e; }"],
      ["switch with no matching case", "switch (1) { case 2: throw e; }"],
      ["an inner try over a literal", "try { 0; } catch { throw e; }"],
      ["for...of an empty array", "for (const obsMapItem of []) { throw e; }"],
      ["for...in an empty object", "for (const obsMapKey in {}) { throw e; }"],
      ["if on an empty string", 'if ("") { throw e; }'],
      ["if on a negated literal", "if (!true) { throw e; }"],
      ["if on a constant comparison", "if (1 === 2) { throw e; }"],
    ];

    for (const [label, shape] of DEAD_PREPENDS) {
      it(`keeps branches true past a dead throw inside ${label}`, () => {
        const ep = scanFile("x.ts", deciding(shape));
        expect(ep!.catches[0]!.branches).toBe(true);
      });
    }

    // The dead if wrapped in a bare block, which the walk enters: the block's own live-exit read has
    // to fold too, or entering it re-raises the flag the fold lowered.
    it("keeps branches true past a dead throw in a block around an if (false)", () => {
      const ep = scanFile("x.ts", deciding("{ if (false) { throw e; } }"));
      expect(ep!.catches[0]!.branches).toBe(true);
    });

    // The returns half: a dead `return null;` must not veto the rethrow, which regressed 11 real
    // routes from not-applicable to fail. `dead-if-false-return` is the tree-scale version.
    it("still sets rethrows past a dead return in an if (false) arm", () => {
      const ep = scanFile(
        "x.ts",
        `export async function loader() {
           try { return await prisma.thing.findMany(); }
           catch (e) {
             if (false) { return null; }
             throw e;
           }
         }`
      );
      expect(ep!.catches[0]!.rethrows).toBe(true);
    });

    // Negative controls: the fold withholds blindness and never refusal, so an always-true guard's
    // throw still kills the error test after it.
    it("still refuses an error test after an always-true spelling that throws", () => {
      const ep = scanFile(
        "x.ts",
        `export async function loader() {
           try { return await prisma.thing.findMany(); }
           catch (e) {
             if (!false) { throw e; }
             if (e instanceof Error) { return new Response(null, { status: 400 }); }
           }
         }`
      );
      expect(ep!.catches[0]!.branches).toBe(false);
    });

    // `case 1` matches and runs on into `case 2`, so the return is live and vetoes the rethrow.
    // Misreading the slice as dead blinds the veto, which is the direction that hands out credit.
    it("reads a switch fall-through onto a live return as live", () => {
      const ep = scanFile(
        "x.ts",
        `export async function loader() {
           try { return await prisma.thing.findMany(); }
           catch (e) {
             switch (1) { case 1: 0; case 2: return null; }
             throw e;
           }
         }`
      );
      expect(ep!.catches[0]!.rethrows).toBe(false);
    });
  });

  // The walk enters a construct exactly where the entered statements are guaranteed to execute.
  // Without these entries, relocating a clause's own statements inside a wrapper put the branch
  // evidence out of reach while the returns veto still saw the return: 83 real routes per corpus
  // entry. Each pair holds the wrapped and unwrapped spellings to the same evidence.
  describe("the walk enters exactly the positions guaranteed to execute", () => {
    const clauseEvidence = (body: string) => {
      const ep = scanFile(
        "x.ts",
        `export async function loader() {
           try { return await prisma.thing.findMany(); }
           catch (e) {
             ${body}
           }
         }`
      );
      return ep!.catches[0]!;
    };

    const DECIDING =
      "if (e instanceof KnownError) { return new Response(e.code, { status: 400 }); }\n" +
      "return new Response(null, { status: 500 });";
    const RETHROW = "logger.error(e);\nthrow e;";

    const WRAPPERS: Array<[string, (body: string) => string]> = [
      ["a catchless try/finally", (body) => `try {\n${body}\n} finally { }`],
      ["a single-default switch", (body) => `switch (pick()) { default: {\n${body}\n} }`],
      ["an if (true)", (body) => `if (true) {\n${body}\n}`],
      [
        "an if/else with the body in both arms",
        (body) => `if (pick()) {\n${body}\n} else {\n${body}\n}`,
      ],
    ];

    for (const [label, wrap] of WRAPPERS) {
      it(`reads a deciding clause wrapped in ${label} identically`, () => {
        expect(clauseEvidence(wrap(DECIDING))).toEqual(clauseEvidence(DECIDING));
      });

      it(`reads a rethrowing clause wrapped in ${label} identically`, () => {
        expect(clauseEvidence(wrap(RETHROW))).toEqual(clauseEvidence(RETHROW));
      });
    }

    // The switch entry is exact: one clause and it is a default. Anything else is not entered and
    // keeps its top-level treatment, which is what the identity pair below and the `break and
    // continue inside the construct they target` family already pin for the multi-clause shapes.
    it("reads a clause wrapped in a single-default switch as the bare clause", () => {
      expect(clauseEvidence(`switch (1) { default: {\n${DECIDING}\n} }`)).toEqual(
        clauseEvidence(DECIDING)
      );
    });

    // Intersection, not union. One arm running is a condition, not a guarantee, so evidence in a
    // single arm earns nothing; `dead-classifier-one-arm` in the mutation corpus is the tree-scale
    // twin with the arm provably dead.
    it("does not credit a classifier that sits in one arm only", () => {
      const evidence = clauseEvidence(
        "if (pick()) { if (e instanceof Error) { return new Response(null, { status: 400 }); } } else { 0; }\n" +
          "return null;"
      );
      expect(evidence.branches).toBe(false);
    });

    it("does not credit a classifier in a dead arm beside an inert arm", () => {
      const evidence = clauseEvidence(
        "if (false) { if (e instanceof Error) { return new Response(null, { status: 400 }); } } else { 0; }\n" +
          "return null;"
      );
      expect(evidence).toMatchObject({ branches: false, rethrows: false, throws: false });
    });

    // The else-arm under a literal-true guard can never run, so nothing in it is evidence: no
    // rethrow minted, and the deciding statements after the wrapper keep their credit.
    it("reads a dead else arm under if true as contributing nothing", () => {
      const evidence = clauseEvidence(`if (true) { 0; } else { throw e; }\n${DECIDING}`);
      expect(evidence).toMatchObject({ throws: false, branches: true });
    });

    // A throw in the tryBlock of a CAUGHT try never escapes the clause: the nested catch takes
    // it. Crediting it as a rethrow would launder a returnless swallow into not-applicable.
    it("does not read the tryBlock of a caught try as this clause's rethrow", () => {
      const evidence = clauseEvidence("try { throw e; } catch {}\nlogger.error(e);");
      expect(evidence).toMatchObject({ rethrows: false, throws: false });
    });

    // The walk does not enter a finally block, so the returns veto must still read it off the
    // whole statement: this clause's finally return eats the throw, and the error never leaves.
    it("reads a try whose finally returns as swallowing, not rethrowing", () => {
      const evidence = clauseEvidence("try { throw e; } finally { return null; }");
      expect(evidence.rethrows).toBe(false);
    });

    // A finally leaving itself by `break` cancels the try's completion the same way a finally return
    // does, so a throw in that tryBlock never escapes. Crediting it minted branches on 80 real
    // routes; `dead-throw-in-cancelled-try` is the tree-scale twin.
    it("reads a throw a finally break discards as no rethrow", () => {
      const evidence = clauseEvidence(
        "do { try { throw e; } finally { break; } } while (false);\nlogger.error(e);"
      );
      expect(evidence).toMatchObject({ rethrows: false, throws: false, branches: false });
    });

    it("reads a throw a finally continue discards as no rethrow", () => {
      const evidence = clauseEvidence(
        'do { try { throw e; } finally { continue; } } while (false);\nlogger.error("x", { e });'
      );
      expect(evidence).toMatchObject({ rethrows: false, throws: false, branches: false });
    });

    it("reads a throw a switch-hosted finally break discards as no rethrow", () => {
      const evidence = clauseEvidence(
        "switch (0) { default: try { throw e; } finally { break; } }\nlogger.error(e);"
      );
      expect(evidence).toMatchObject({ rethrows: false, throws: false, branches: false });
    });

    // The refusal is a containment read: a jump that only MAY run still cancels entry, because
    // entry grants credit and a wrong grant pays.
    it("refuses the tryBlock when the finally only may break", () => {
      const evidence = clauseEvidence(
        "do { try { throw e; } finally { if (pick()) { break; } } } while (false);\nlogger.error(e);"
      );
      expect(evidence).toMatchObject({ rethrows: false, throws: false });
    });

    // A loop inside the finally captures its own bare jumps, so nothing there leaves the finally
    // and the try's completion stands: the rethrow is genuine.
    it("does not refuse a finally whose loop captures its own break", () => {
      const evidence = clauseEvidence("try { throw e; } finally { while (pick()) { break; } }");
      expect(evidence).toMatchObject({ rethrows: true, throws: true });
    });

    // The cancelled statement contributes nothing, in either direction: no credit from inside it,
    // and no blinding of the real classification after it. Same evidence as the bare clause.
    it("keeps the classification after a finally-break no-op", () => {
      expect(
        clauseEvidence(
          `do { try { if (e instanceof Error) { throw e; } } finally { break; } } while (false);\n${DECIDING}`
        )
      ).toEqual(clauseEvidence(DECIDING));
    });

    // The `definitelyExits` fold: `if (true) { X }` definitely exits iff X does, so the trailing
    // throw is cut rather than read. Without the fold the throw still walks and mints `throws`.
    it("cuts a dead trailing statement after an if true that exits", () => {
      const evidence = clauseEvidence("if (true) { return null; }\nthrow e;");
      expect(evidence.throws).toBe(false);
    });
  });

  // The other end of the same problem: cutting the statement list only on a BARE `return`/`throw`
  // left a `throw e;` after a nested construct that had already returned reading as a rethrow, worth
  // 50 points a route. Two rules answer them together, `definitelyExits` seeing through the wrappers
  // and `rethrows` requiring no reachable `return`. `dead-throw-after-*` is the tree-scale family.
  describe("dead throw written after something that already exited", () => {
    const exiting = (wrapped: string) => `
      export async function loader() {
        try {
          return await prisma.thing.findMany();
        } catch (e) {
          ${wrapped}
          throw e;
        }
      }
    `;

    const EXITED: Array<[string, string]> = [
      ["a bare block", "{ logger.error(e); return null; }"],
      ["a do body", "do { return null; } while (false);"],
      ["an if (true)", "if (true) { return null; }"],
      ["an if/else where both arms return", "if (pick()) { return null; } else { return 0; }"],
      ["a switch with a returning default", "switch (1) { default: return null; }"],
      ["a try/finally that returns", "try { return null; } finally { }"],
    ];

    for (const [label, wrapped] of EXITED) {
      it(`does not set rethrows for a throw after ${label}`, () => {
        const ep = scanFile("x.ts", exiting(wrapped));
        expect(ep!.catches[0]!.rethrows).toBe(false);
      });
    }

    // The same wrappers on the branches side, plus three the rethrow list has no use for. This asks a
    // weaker question than `definitelyExits` does, and on purpose: "could this have exited", not
    // "must it have", which is why a labelled block, a `for...of` and a `while` are all on the list.
    //
    // The ordering is the whole trick and it is easy to get backwards. The flag is raised at the END
    // of each statement, after that statement's own branch check, or every deciding statement refuses
    // itself: measured at 78 routes accused.
    const BRANCH_EXITED: Array<[string, string]> = [
      ...EXITED,
      ["a labelled block", "outer: { return null; }"],
      ["a for...of that returns", "for (const q of items) { return q; }"],
      ["a while that returns", "while (go) { return null; }"],
    ];

    for (const [label, wrapped] of BRANCH_EXITED) {
      it(`does not credit an error test written after ${label}`, () => {
        const ep = scanFile(
          "x.ts",
          `export async function loader() {
             try { return await prisma.thing.findMany(); }
             catch (e) {
               ${wrapped}
               if (e instanceof Error) { return json({ a: 1 }); }
             }
           }`
        );
        expect(ep!.catches[0]!.branches).toBe(false);
      });
    }

    // The precision this gives up, pinned so it is a decision and not a surprise: a conditional exit
    // before the error test also stops the credit. No clause in the tree is this shape today.
    it("does not credit an error test written after a conditional return", () => {
      const ep = scanFile(
        "x.ts",
        `export async function loader() {
           try { return await prisma.thing.findMany(); }
           catch (e) {
             if (rare) { return null; }
             if (e instanceof Error) { return json({ a: 1 }); }
           }
         }`
      );
      expect(ep!.catches[0]!.branches).toBe(false);
    });

    it("still credits an error test with nothing exiting before it", () => {
      const ep = scanFile(
        "x.ts",
        `export async function loader() {
           try { return await prisma.thing.findMany(); }
           catch (e) {
             logger.error(e);
             if (e instanceof Error) { return json({ a: 1 }); }
           }
         }`
      );
      expect(ep!.catches[0]!.branches).toBe(true);
    });

    // Positive control: nothing before the throw exits, so the clause has no other way out.
    it("still sets rethrows when nothing before the throw returns", () => {
      const ep = scanFile("x.ts", exiting("logger.error(e);"));
      expect(ep!.catches[0]!.rethrows).toBe(true);
    });

    // Second positive control, for the no-return half specifically: a `return` the walk has already
    // cut as dead must not count against the rethrow.
    it("still sets rethrows when the only return is dead code after the throw", () => {
      const ep = scanFile(
        "x.ts",
        `export async function loader() {
           try { return await prisma.thing.findMany(); }
           catch (e) { throw e; return null; }
         }`
      );
      expect(ep!.catches[0]!.rethrows).toBe(true);
    });
  });

  // A bare `break` or `continue` targets the nearest enclosing construct of its kind rather than the
  // list the question is about, so counting one wherever it appeared accused a route of swallowing an
  // error it rethrows. The false-accusation direction, so both halves are pinned: what must stay
  // reachable, and what must still be cut.
  describe("break and continue inside the construct they target", () => {
    const clause = (body: string) => `
      export async function loader() {
        try {
          return await prisma.thing.findMany();
        } catch (e) {
          ${body}
        }
      }
    `;

    // Reachable, so the throw after them is a real rethrow. Each jump targets the construct it is
    // written in, and every one of these constructs falls through to the next statement.
    const FALLS_THROUGH: Array<[string, string]> = [
      [
        "a switch whose clauses all break",
        'switch (e.code) { case "P2025": handleNotFound(); break; default: handleOther(); break; }',
      ],
      ["a switch whose default is a bare break", "switch (e.code) { default: break; }"],
      ["a do body that breaks", "do { break; } while (false);"],
      ["a do body that continues", "do { continue; } while (false);"],
      [
        "a do body whose if/else both break",
        "do { if (pick()) { break; } else { break; } } while (false);",
      ],
    ];

    for (const [label, wrapped] of FALLS_THROUGH) {
      it(`still sets rethrows for a throw written after ${label}`, () => {
        const ep = scanFile("x.ts", clause(`${wrapped}\nthrow e;`));
        expect(ep!.catches[0]!.rethrows).toBe(true);
      });

      it(`still credits an error test written after ${label}`, () => {
        const ep = scanFile(
          "x.ts",
          clause(`${wrapped}\nif (e instanceof Error) { return json({ a: 1 }); }\nthrow e;`)
        );
        expect(ep!.catches[0]!.branches).toBe(true);
      });
    }

    // The clause the whole finding was about, end to end: sorting the error by code and then
    // rethrowing is a rethrow, which is `not-applicable`, and never a swallow.
    it("reads a switch on the error code followed by a rethrow as a rethrow", () => {
      const ep = scanFile(
        "x.ts",
        clause(
          'switch (e.code) { case "P2025": handleNotFound(); break; default: handleOther(); break; }\nthrow e;'
        )
      );
      expect(ep!.catches[0]).toMatchObject({ rethrows: true, throws: true, branches: false });
    });

    // Cut, so the throw after them is dead and must not be credited. The first two are the
    // over-correction control: a clause that returns and also breaks still exits, and reading the
    // break as "no exit" would take the whole `dead-throw-after-*` family back.
    const EXITS: Array<[string, string]> = [
      [
        "a switch clause that returns before it breaks",
        "switch (1) { default: { return null; } break; }",
      ],
      [
        "a switch whose every clause returns",
        "switch (e.code) { case 1: return null; default: return 0; }",
      ],
      ["a do body that returns before it breaks", "do { return null; break; } while (false);"],
    ];

    for (const [label, wrapped] of EXITS) {
      it(`does not set rethrows for a throw written after ${label}`, () => {
        const ep = scanFile("x.ts", clause(`${wrapped}\nthrow e;`));
        expect(ep!.catches[0]!.rethrows).toBe(false);
      });
    }

    // A `continue` in a switch clause targets the enclosing loop, so it is inherited rather than
    // dropped with the `break`. The labelled jumps beside it leave the `for` entirely, and the bare
    // `break` is the control that separates the three.
    const IN_LOOP: Array<[string, boolean]> = [
      ["break outer", false],
      ["continue outer", false],
      ["continue", false],
      ["break", true],
    ];

    for (const [jump, rethrows] of IN_LOOP) {
      it(`reads a switch clause that says ${jump} inside a labelled loop as rethrows=${rethrows}`, () => {
        const ep = scanFile(
          "x.ts",
          `export async function loader() {
             outer: for (const x of items) {
               try { await service.call(x); }
               catch (e) {
                 switch (e.code) { case 1: ${jump}; default: ${jump}; }
                 throw e;
               }
             }
             return null;
           }`
        );
        expect(ep!.catches[0]!.rethrows).toBe(rethrows);
      });
    }
  });

  // A clause whose try block cannot throw is not error handling. Crediting one was the largest hole
  // ever found here: 19 to 44 on the real tree and 224 routes raised. `dead-classifying-try` is the
  // tree-scale version.
  describe("a catch over a try block that cannot throw", () => {
    const guarding = (guarded: string) => `
      export async function loader({ request }) {
        try { ${guarded} } catch (e) {
          if (e instanceof Error) { return new Response(null, { status: 400 }); }
          throw e;
        }
        return await prisma.thing.findMany();
      }
    `;

    const INERT: Array<[string, string]> = [
      ["an empty block", ""],
      ["a literal expression statement", "0;"],
      ["a literal declaration", "const x = 1;"],
      ["arithmetic on literals", "const x = 1 + 2 * 3;"],
      ["a bare identifier read", "const x = someLocal;"],
    ];

    for (const [label, guarded] of INERT) {
      it(`is not read as error handling when the try holds only ${label}`, () => {
        const ep = scanFile("x.ts", guarding(guarded));
        expect(ep!.catches[0]!.guardCanRaise).toBe(false);
      });
    }

    // One per reason `canRaise` recognises, so the predicate is not passing the cases above by being
    // false for everything.
    const LIVE: Array<[string, string]> = [
      ["a call", "doThing();"],
      ["a construction", "new Thing();"],
      ["an await", "await later;"],
      ["a member access", "const x = thing.value;"],
      ["an element access", "const x = thing[0];"],
      ["a throw", "throw new Error('x');"],
      ["an iteration", "for (const item of items) { }"],
      ["an instanceof", "const x = thing instanceof Error;"],
    ];

    for (const [label, guarded] of LIVE) {
      it(`is read as error handling when the try holds ${label}`, () => {
        const ep = scanFile("x.ts", guarding(guarded));
        expect(ep!.catches[0]!.guardCanRaise).toBe(true);
      });
    }
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
    expect(ep!.catches[0]!.rethrows).toBe(false);
    expect(ep!.catches[0]!.branches).toBe(false);
  });

  it("sets branches for an `if` on the error", () => {
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
    expect(ep!.catches[0]!.branches).toBe(true);
    expect(ep!.catches[0]!.rethrows).toBe(false);
  });

  it("sets branches for an instanceof conditional that is the whole returned expression", () => {
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
    expect(ep!.catches[0]!.branches).toBe(true);
  });

  it("sets branches for a switch on the error", () => {
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
    expect(ep!.catches[0]!.branches).toBe(true);
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
    expect(ep!.catches).toEqual([]);
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
    // The `throw e` is guarded by an `if`, so it is not on the straight-line path and does not read as
    // a rethrow. The `if` itself decides, so the verdict the checks care about is unchanged.
    expect(ep!.catches[0]!.rethrows).toBe(false);
    expect(ep!.catches[0]!.branches).toBe(true);
  });

  it("leaves catches empty for a try with no catch", () => {
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
    expect(ep!.catches).toEqual([]);
  });

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
    expect(ep!.catches[0]!.rethrows).toBe(false);
    expect(ep!.catches[0]!.branches).toBe(false);
  });

  it("is empty when there is no try at all", () => {
    const ep = scanFile("plain.ts", `export async function loader() { return json({}); }`);
    expect(ep!.hasTryCatch).toBe(false);
    expect(ep!.catches).toEqual([]);
  });

  // Stopping at ANY function-like node excluded a per-item `.map()` boundary correctly and also
  // deleted the route's own catch whenever the body was wrapped in a single-shot callback. The real
  // distinction is per-item iteration versus everything else.
  describe("inline single-shot wrappers are attributed to the route", () => {
    it("attributes a catch wrapped in trace(async () => {...})", () => {
      const ep = scanFile(
        "x.ts",
        `
        export async function action({ request }) {
          return trace("update", async () => {
            try {
              await doWork(request);
              return json({ ok: true });
            } catch {
              return json({ error: "failed" }, { status: 500 });
            }
          });
        }
        `
      );
      expect(ep!.catches).toHaveLength(1);
    });

    it("attributes a catch inside a pgMutation callback passed as an object property", () => {
      const ep = scanFile(
        "x.ts",
        `
        export async function action({ request }) {
          const outcome = await mutateWithFallback({
            pgMutation: async (taskRun) => {
              try {
                await doWork(taskRun);
              } catch {
                return json({ error: "Internal Server Error" }, { status: 500 });
              }
            },
          });
          return outcome;
        }
        `
      );
      expect(ep!.catches).toHaveLength(1);
    });

    it("attributes a catch inside new ReadableStream({ start })", () => {
      const ep = scanFile(
        "x.ts",
        `
        export async function action({ request }) {
          const stream = new ReadableStream({
            async start(controller) {
              try {
                await doWork(controller);
              } catch {
                controller.error("failed");
              }
            },
          });
          return new Response(stream);
        }
        `
      );
      expect(ep!.catches).toHaveLength(1);
    });
  });

  describe("per-item iteration callbacks are not attributed to the route", () => {
    it("does not attribute a catch inside items.map(...)", () => {
      const ep = scanFile(
        "x.ts",
        `
        export async function action({ request }) {
          const items = await load(request);
          return items.map((item) => {
            try {
              return process(item);
            } catch {
              return null;
            }
          });
        }
        `
      );
      expect(ep!.catches).toEqual([]);
    });

    it("does not attribute a catch inside Promise.all(items.map(...))", () => {
      const ep = scanFile(
        "batch.process.ts",
        `
        export async function action({ request }) {
          const items = await loadItems(request);
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
        }
        `
      );
      expect(ep!.catches).toEqual([]);
      // A try/catch appeared somewhere in the body, which is still a real signal for triviality.
      expect(ep!.hasTryCatch).toBe(true);
    });

    it("does not attribute a catch inside items.forEach(...)", () => {
      const ep = scanFile(
        "x.ts",
        `
        export async function action({ request }) {
          const items = await load(request);
          items.forEach((item) => {
            try {
              process(item);
            } catch {
              return;
            }
          });
          return json({ ok: true });
        }
        `
      );
      expect(ep!.catches).toEqual([]);
    });

    // A refused catch keeps its evidence, so `error-classification` can judge what it does rather
    // than where it sits. Both flavours are pinned, the deciding per-item catch and the inert one.
    it("populates evidence for a refused per-item catch that decides", () => {
      const ep = scanFile(
        "x.ts",
        `
        export async function action({ request }) {
          const items = await load(request);
          return items.map(async (item) => {
            try {
              return await process(item);
            } catch (e) {
              if (e instanceof KnownError) { return new Response(e.code, { status: 400 }); }
              throw e;
            }
          });
        }
        `
      );
      expect(ep!.catches).toEqual([]);
      expect(ep!.callbackCatches).toHaveLength(1);
      expect(ep!.callbackCatches[0]).toMatchObject({ branches: true, guardCanRaise: true });
    });

    it("populates evidence for a refused per-item catch that only rethrows", () => {
      const ep = scanFile(
        "x.ts",
        `
        export async function action({ request }) {
          const items = await load(request);
          return items.map(async (item) => {
            try {
              return await process(item);
            } catch (e) {
              throw e;
            }
          });
        }
        `
      );
      expect(ep!.catches).toEqual([]);
      expect(ep!.callbackCatches).toHaveLength(1);
      expect(ep!.callbackCatches[0]).toMatchObject({ rethrows: true, branches: false });
    });
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
    expect(ep!.logCalls).toEqual([{ callee: "log.info", fields: [], inCatch: false }]);
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

describe("scanFile: per-catch evidence", () => {
  it("records one entry per catch clause, keeping a parse guard distinct from a broad catch", () => {
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
      rethrows: false,
      branches: false,
      throws: false,
      guardsParse: true,
      awaitsOnlyParse: true,
      guardCanRaise: true,
      guardMayRaise: true,
      tryStatementCount: 1,
    });
    expect(ep!.catches[1]).toMatchObject({
      guardsParse: false,
      tryStatementCount: 4,
    });
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
  });

  it("sees a parse in a try that outgrows a single statement", () => {
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
      rethrows: false,
      branches: false,
      throws: false,
      guardsParse: false,
      awaitsOnlyParse: false,
      guardCanRaise: true,
      guardMayRaise: true,
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
    // The loader's clause branches and does not rethrow; the action's does neither. What this test is
    // for is that the two clauses stay separate.
    expect(ep!.catches.filter((c) => !c.rethrows && c.branches)).toHaveLength(1);
    expect(ep!.catches.filter((c) => !c.rethrows && !c.branches)).toHaveLength(1);
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

describe("scanFile: branches requires the if/switch condition to examine the error", () => {
  it("does not set branches for an `if` on an unrelated variable", () => {
    const ep = scanFile(
      "retry-count.ts",
      `
      export async function action({ request }) {
        let attempt = 0;
        try {
          return json(await load(request));
        } catch (e) {
          if (attempt > 3) return json({}, { status: 503 });
          return json({}, { status: 500 });
        }
      }
      `
    );
    expect(ep!.catches[0]!.branches).toBe(false);
  });

  it("sets branches for an `if` whose condition references the caught error", () => {
    const ep = scanFile(
      "branch-if-e.ts",
      `
      export async function loader({ request }) {
        try {
          return json(await load(request));
        } catch (e) {
          if (e instanceof ApiError) return json({}, { status: e.status });
          return json({}, { status: 500 });
        }
      }
      `
    );
    expect(ep!.catches[0]!.branches).toBe(true);
  });

  it("sets branches for a `switch` on a property of the caught error", () => {
    const ep = scanFile(
      "branch-switch-error-code.ts",
      `
      export async function loader({ request }) {
        try {
          return json(await load(request));
        } catch (error) {
          switch (error.code) {
            case "P2025":
              return json({}, { status: 404 });
            default:
              return json({}, { status: 500 });
          }
        }
      }
      `
    );
    expect(ep!.catches[0]!.branches).toBe(true);
  });

  it("does not set branches for a `switch` on an unrelated discriminant", () => {
    const ep = scanFile(
      "branch-switch-unrelated.ts",
      `
      export async function action({ request }) {
        const mode = "strict";
        try {
          return json(await load(request));
        } catch (error) {
          switch (mode) {
            case "strict":
              return json({}, { status: 400 });
            default:
              return json({}, { status: 500 });
          }
        }
      }
      `
    );
    expect(ep!.catches[0]!.branches).toBe(false);
  });

  it("cannot set branches for a bindingless catch, even with an `if` inside it", () => {
    const ep = scanFile(
      "bindingless-if.ts",
      `
      export async function loader({ request }) {
        let attempt = 0;
        try {
          return json(await load(request));
        } catch {
          if (attempt > 3) return json({}, { status: 503 });
          return json({}, { status: 500 });
        }
      }
      `
    );
    expect(ep!.catches[0]!.branches).toBe(false);
  });
});

// `referencesBinding` once matched any identifier with the binding's text, including a property name,
// an object literal key and a name re-declared in a nested scope.
describe("scanFile: branches requires a genuine read of the binding, not a lookalike", () => {
  it("does not set branches for an `if` that only reads a same-named property", () => {
    const ep = scanFile(
      "branch-property-name.ts",
      `
      export async function loader({ request }) {
        try {
          return json(await load(request));
        } catch (error) {
          if (fallback.error) return json({}, { status: 500 });
          return json({}, { status: 500 });
        }
      }
      `
    );
    expect(ep!.catches[0]!.branches).toBe(false);
  });

  it("does not set branches for an `if` that only reads a same-named object literal key", () => {
    const ep = scanFile(
      "branch-object-key.ts",
      `
      export async function loader({ request }) {
        try {
          return json(await load(request));
        } catch (error) {
          if (buildOptions({ error: false }).ok) return json({}, { status: 500 });
          return json({}, { status: 500 });
        }
      }
      `
    );
    expect(ep!.catches[0]!.branches).toBe(false);
  });

  it("does not set branches for an `if` whose only reference is inside a callback that re-declares the name", () => {
    const ep = scanFile(
      "branch-shadowed-param.ts",
      `
      export async function loader({ request }) {
        try {
          return json(await load(request));
        } catch (error) {
          if (items.some(function (error) { return error.code === 1; })) {
            return json({}, { status: 500 });
          }
          return json({}, { status: 500 });
        }
      }
      `
    );
    expect(ep!.catches[0]!.branches).toBe(false);
  });

  it("does not set branches for an `if` whose only reference is inside a block that re-declares the name", () => {
    const ep = scanFile(
      "branch-shadowed-block.ts",
      `
      export async function loader({ request }) {
        try {
          return json(await load(request));
        } catch (error) {
          if (
            (() => {
              const error = 1;
              return error > 0;
            })()
          ) {
            return json({}, { status: 500 });
          }
          return json({}, { status: 500 });
        }
      }
      `
    );
    expect(ep!.catches[0]!.branches).toBe(false);
  });

  it("still sets branches for an `if` that genuinely reads the binding beside a lookalike", () => {
    const ep = scanFile(
      "branch-genuine-and-lookalike.ts",
      `
      export async function loader({ request }) {
        try {
          return json(await load(request));
        } catch (error) {
          if (fallback.error || error instanceof NotFound) return json({}, { status: 404 });
          return json({}, { status: 500 });
        }
      }
      `
    );
    expect(ep!.catches[0]!.branches).toBe(true);
  });
});

// The shadow check once only caught shadowing NESTED inside the condition, so a scope that WRAPS the
// if was invisible. `catchClauseEvidence` tracks shadowing as it descends instead: once a scope
// re-declares the binding, everything nested inside stays shadowed.
describe("scanFile: a binding shadowed by an enclosing scope, not just a nested one", () => {
  const swallow = (mutation: string) => `
    export async function loader() {
      try {
        return await prisma.thing.findMany();
      } catch (error) {
        ${mutation}
        return null;
      }
    }
  `;

  it("does not credit an if inside a for...of loop that re-declares the binding", () => {
    const ep = scanFile(
      "x.ts",
      swallow("for (const error of errors) { if (error.code === 1) { doThing(); } }")
    );
    expect(ep!.catches[0]!.branches).toBe(false);
  });

  it("does not credit an if inside a for...in loop that re-declares the binding", () => {
    const ep = scanFile(
      "x.ts",
      swallow("for (const error in errorsByKey) { if (error) { doThing(); } }")
    );
    expect(ep!.catches[0]!.branches).toBe(false);
  });

  it("does not credit an if inside a classic for loop that re-declares the binding", () => {
    const ep = scanFile(
      "x.ts",
      swallow("for (let error = 0; error < 10; error++) { if (error) { doThing(); } }")
    );
    expect(ep!.catches[0]!.branches).toBe(false);
  });

  it("does not credit an if inside a nested catch clause with the same binding name", () => {
    const ep = scanFile(
      "x.ts",
      swallow("try { doWork(); } catch (error) { if (error) { doThing(); } }")
    );
    expect(ep!.catches[0]!.branches).toBe(false);
  });

  it("does not credit an if inside a block whose own destructured const shadows the binding", () => {
    const ep = scanFile(
      "x.ts",
      swallow(`
        if (attempt > 0) {
          const { error } = computeSomething();
          if (error) { doThing(); }
        }
      `)
    );
    expect(ep!.catches[0]!.branches).toBe(false);
  });

  it("does not credit an if reading a destructured parameter inside the if's own condition", () => {
    const ep = scanFile(
      "x.ts",
      swallow("if (items.some(({ error }) => error > 0)) { doThing(); }")
    );
    expect(ep!.catches[0]!.branches).toBe(false);
  });

  it("does not credit an if shadowed by an array-destructured declaration", () => {
    const ep = scanFile(
      "x.ts",
      swallow("const [error] = getErrors();\n        if (error) { doThing(); }")
    );
    expect(ep!.catches[0]!.branches).toBe(false);
  });

  // Positive control: a genuine reference to the real binding, on the clause's own path, with an
  // arm that takes the error somewhere the other arm does not go.
  it("still credits an if that genuinely reads the outer binding directly", () => {
    const ep = scanFile("x.ts", swallow("if (error instanceof Error) { return badRequest(); }"));
    expect(ep!.catches[0]!.branches).toBe(true);
  });

  // Two shapes that read the real binding and are still not credited, for reasons that are not
  // shadowing: precision the straight-line rule gives up on purpose.
  it("does not credit an if whose arm does not take the error anywhere", () => {
    const ep = scanFile("x.ts", swallow("if (error instanceof Error) { doThing(); }"));
    expect(ep!.catches[0]!.branches).toBe(false);
  });

  it("does not credit an if nested inside a loop, even with a different loop variable", () => {
    const ep = scanFile(
      "x.ts",
      swallow("for (const item of items) { if (error.code === item) { return item; } }")
    );
    expect(ep!.catches[0]!.branches).toBe(false);
  });
});

// The ternary path once checked only that the condition tested the error, so rewriting `return X;` as
// `return e instanceof Error ? (X) : (X)` was worth 50 points a route for a change that decides
// nothing. `same-arms-ternary` is the tree-scale version.
describe("a ternary on the error has to send its arms somewhere different", () => {
  const returning = (value: string) => `
    export async function loader() {
      try {
        return await prisma.thing.findMany();
      } catch (error) {
        return ${value};
      }
    }
  `;

  it("does not credit a ternary whose arms are identical", () => {
    const ep = scanFile("x.ts", returning("error instanceof Error ? (json({})) : (json({}))"));
    expect(ep!.catches[0]!.branches).toBe(false);
  });

  it("does not credit a ternary whose arms differ only in whitespace", () => {
    const ep = scanFile("x.ts", returning("error instanceof Error ? (json( {} )) : (json({}))"));
    expect(ep!.catches[0]!.branches).toBe(false);
  });

  it("does not credit a ternary whose arms differ only in parentheses", () => {
    const ep = scanFile("x.ts", returning("error instanceof Error ? ((json({}))) : (json({}))"));
    expect(ep!.catches[0]!.branches).toBe(false);
  });

  it("still credits a ternary whose arms go somewhere different", () => {
    const ep = scanFile(
      "x.ts",
      returning("error instanceof Response ? error : json({}, { status: 500 })")
    );
    expect(ep!.catches[0]!.branches).toBe(true);
  });

  // The same three cases on the throw path, which read none of them: the walk sets `rethrows` and
  // cuts the path first, so a thrown ternary was never offered to `selectsAnErrorPath`.
  // `wrap-body-in-same-arms-throw-ternary` is the tree-scale version of the refusal.
  const throwing = (value: string) => `
    export async function loader() {
      try {
        return await prisma.thing.findMany();
      } catch (error) {
        throw ${value};
      }
    }
  `;

  it("credits a thrown ternary whose arms go somewhere different", () => {
    const ep = scanFile("x.ts", throwing("error instanceof Response ? error : new Error('x')"));
    expect(ep!.catches[0]!.branches).toBe(true);
  });

  it("does not credit a thrown ternary whose arms are identical", () => {
    const ep = scanFile("x.ts", throwing("error instanceof Error ? error : error"));
    expect(ep!.catches[0]!.branches).toBe(false);
  });

  it("does not credit a thrown ternary whose arms differ only in parentheses", () => {
    const ep = scanFile("x.ts", throwing("error instanceof Error ? ((error)) : (error)"));
    expect(ep!.catches[0]!.branches).toBe(false);
  });

  it("does not credit a thrown ternary that never reads the caught binding", () => {
    const ep = scanFile("x.ts", throwing("other instanceof Error ? error : new Error('x')"));
    expect(ep!.catches[0]!.branches).toBe(false);
  });

  // The throw still cuts the path, so a decision written after it is dead and stays uncredited.
  it("does not credit a thrown ternary written after the clause already threw", () => {
    const ep = scanFile(
      "x.ts",
      `export async function loader() {
        try {
          return await prisma.thing.findMany();
        } catch (error) {
          throw error;
          throw error instanceof Response ? error : new Error('x');
        }
      }`
    );
    expect(ep!.catches[0]!.branches).toBe(false);
  });

  // The same comparison on the `if` path, which had the exit test but not the arm test.
  it("does not credit an if/else whose two arms are identical", () => {
    const ep = scanFile(
      "x.ts",
      `export async function loader() {
         try { return await prisma.thing.findMany(); }
         catch (error) {
           if (error instanceof Error) { return json({}); } else { return json({}); }
         }
       }`
    );
    expect(ep!.catches[0]!.branches).toBe(false);
  });
});

// The liveness gap in the branch predicate: under a plain containment read, an arm holding an exit
// that can never run read as an arm that takes the error somewhere, worth 50 points a route.
// `dead-armed-instanceof-if` is the tree-scale version, global 19 to 27 and 80 routes raised.
describe("an arm whose only exit is dead decides nothing", () => {
  const swallow = (mutation: string) => `
    export async function loader() {
      try {
        return await prisma.thing.findMany();
      } catch (error) {
        ${mutation}
        return json({ error: "generic" }, { status: 500 });
      }
    }
  `;

  it("reads the unmutated clause as a swallow, as a baseline", () => {
    const ep = scanFile("x.ts", swallow(""));
    expect(ep!.catches[0]!.branches).toBe(false);
  });

  // The reported shape, plus three further spellings of the same no-op reaching the same
  // predicate by different routes: a dead loop body, a dead else arm, and a switch clause.
  const DEAD_ARMS: Array<[string, string]> = [
    ["an if (false) arm", "if (error instanceof Error) { if (false) { return null; } }"],
    ["a while (false) body", "if (error instanceof Error) { while (false) { throw error; } }"],
    [
      "a dead else arm beside an arm that goes nowhere",
      "if (error instanceof Error) { doThing(); } else { for (const k in {}) { return null; } }",
    ],
    [
      "a switch clause whose exit is dead",
      "switch (error.code) { case 'x': if (1 === 2) { throw error; } }",
    ],
  ];

  for (const [label, mutation] of DEAD_ARMS) {
    it(`does not credit ${label}`, () => {
      const ep = scanFile("x.ts", swallow(mutation));
      expect(ep!.catches[0]!.branches).toBe(false);
    });
  }

  // Positive controls: without these the fix could be "always false" and the four cases above would
  // still pass. `an arm guarded by a condition that does not fold` is also the pin on the rejected
  // alternative, asking the arm to `definitelyExits` rather than to hold a live exit, which refuses
  // all four shapes above and falsely accuses a real classifying clause in
  // `admin.api.v1.orgs.$organizationId.environments.staging.ts`, taking the global from 19 to 18.
  const LIVE_ARMS: Array<[string, string]> = [
    ["a plain returning arm", "if (error instanceof Error) { return badRequest(); }"],
    [
      "an arm guarded by a condition that does not fold",
      "if (error instanceof Error) { if (error.code === 'P2002') { return conflict(); } }",
    ],
    [
      "a live exit in the else arm only",
      "if (error instanceof Error) { doThing(); } else { return badRequest(); }",
    ],
    ["a switch clause that returns", "switch (error.code) { case 'P2002': return conflict(); }"],
  ];

  for (const [label, mutation] of LIVE_ARMS) {
    it(`still credits ${label}`, () => {
      const ep = scanFile("x.ts", swallow(mutation));
      expect(ep!.catches[0]!.branches).toBe(true);
    });
  }
});

// `export const { action, loader } = createActionApiRoute(...)` produced no entry point at all, so
// the route was absent from the denominator rather than parsed, failed or unmeasured. The two-step
// spelling already worked, so exactly half the shape was wired.
describe("scanFile: a destructured export declaration", () => {
  const BUILDER = `import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";`;

  it("finds an action destructured straight out of a builder call", () => {
    const ep = scanFile(
      "api.v1.things.ts",
      `${BUILDER}
       export const { action } = createActionApiRoute({ method: "POST" }, async () => json({}));`
    );
    expect(ep).not.toBeNull();
    expect(ep!.hasAction).toBe(true);
    expect(ep!.actionInitializerCallee).toBe("createActionApiRoute");
  });

  it("finds both halves of a destructured builder export", () => {
    const ep = scanFile(
      "api.v1.things.ts",
      `${BUILDER}
       export const { action, loader } = createActionApiRoute({}, async () => json({}));`
    );
    expect(ep!.hasAction).toBe(true);
    expect(ep!.hasLoader).toBe(true);
  });

  it("finds an action destructured from a local the builder produced", () => {
    const ep = scanFile(
      "api.v1.things.ts",
      `${BUILDER}
       const route = createActionApiRoute({}, async () => json({}));
       export const { action } = route;`
    );
    expect(ep).not.toBeNull();
    expect(ep!.actionInitializerCallee).toBe("createActionApiRoute");
  });

  // The exported name is the element name, so a rename decides what this file exports.
  it("reads the exported name rather than the property it came from", () => {
    const renamed = scanFile(
      "api.v1.things.ts",
      `${BUILDER}
       export const { loader: action } = createActionApiRoute({}, async () => json({}));`
    );
    expect(renamed!.hasAction).toBe(true);
    expect(renamed!.hasLoader).toBe(false);

    const hidden = scanFile(
      "api.v1.things.ts",
      `${BUILDER}
       export const { action: internal } = createActionApiRoute({}, async () => json({}));`
    );
    expect(hidden).toBeNull();
  });

  it("counts the statements of a handler reached through the binding pattern", () => {
    const ep = scanFile(
      "api.v1.things.ts",
      `${BUILDER}
       export const { action } = createActionApiRoute({}, async ({ request }) => {
         const body = await request.json();
         const saved = await prisma.thing.create({ data: body });
         return json(saved);
       });`
    );
    expect(ep!.statementCount).toBe(3);
  });
});

// C4b. A route whose body is in another module gives zero statements and zero callees, so the
// triviality rule read it as a redirect stub and every check reported not-applicable for it. The
// scan says so directly instead, and `score.ts` counts it apart from the routes nothing applied to.
describe("scanFile: a route that delegates its body to another module", () => {
  it("marks a re-export of an action from another module", () => {
    const ep = scanFile("webhooks.v1.stripe.ts", `export { action } from "./handler.server";`);
    expect(ep!.delegating).toBe(true);
  });

  it("marks an action aliased to an imported function", () => {
    const ep = scanFile(
      "webhooks.v1.stripe.ts",
      `import { handleWebhook } from "./handler.server";
       export const action = handleWebhook;`
    );
    expect(ep!.delegating).toBe(true);
  });

  it("marks a renamed re-export", () => {
    const ep = scanFile(
      "webhooks.v1.stripe.ts",
      `export { handleWebhook as action } from "./handler.server";`
    );
    expect(ep!.delegating).toBe(true);
  });

  it("does not mark a route whose body is in the file", () => {
    const ep = scanFile("api.v1.things.ts", LOADER);
    expect(ep!.delegating).toBe(false);
  });

  it("does not mark a route wrapped in a builder, whose options are still readable", () => {
    const ep = scanFile(
      "api.v1.things.ts",
      `import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
       import { handler } from "./handler.server";
       export const action = createActionApiRoute({ method: "POST" }, handler);`
    );
    expect(ep!.delegating).toBe(false);
  });

  // Half a route in the file is still half a route to judge.
  it("does not mark a route that delegates one export and writes the other", () => {
    const ep = scanFile(
      "api.v1.things.ts",
      `export { action } from "./handler.server";
       export async function loader() { return json({}); }`
    );
    expect(ep!.delegating).toBe(false);
  });
});

// C1b. What `auth-scope` reads: the options a builder was given, whether the handler filters by
// the caller's own id, and whether it runs the ability gate itself.
describe("scanFile: the signals auth-scope reads", () => {
  const PAT = `import { createActionPATApiRoute } from "~/services/routeBuilders/apiBuilder.server";`;

  it("records the top-level option keys of the builder call", () => {
    const ep = scanFile(
      "api.v1.orgs.ts",
      `${PAT}
       export const action = createActionPATApiRoute(
         { method: "POST", authorization: { action: "manage", resource: { type: "org" } } },
         async () => json({})
       );`
    );
    expect(ep!.actionBuilderOptions).toEqual(["method", "authorization"]);
  });

  it("keeps the loader's options and the action's options apart", () => {
    const ep = scanFile(
      "api.v1.orgs.ts",
      `${PAT}
       export const loader = createActionPATApiRoute({ authorization: {} }, async () => json({}));
       export const action = createActionPATApiRoute({ method: "POST" }, async () => json({}));`
    );
    expect(ep!.loaderBuilderOptions).toEqual(["authorization"]);
    expect(ep!.actionBuilderOptions).toEqual(["method"]);
  });

  it("sees a query filtered by the caller's id, in both builders' spellings", () => {
    const api = scanFile(
      "api.v1.orgs.ts",
      `${PAT}
       export const loader = createActionPATApiRoute({}, async ({ authentication }) => {
         return json(await prisma.org.findMany({
           where: { members: { some: { userId: authentication.userId } } },
         }));
       });`
    );
    expect(api!.loaderScopesByCaller).toBe(true);

    const dashboard = scanFile(
      "_app.orgs.$slug.apikeys/route.tsx",
      `import { dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
       export const loader = dashboardLoader({}, async ({ user }) => {
         return json(await presenter.call({ userId: user.id, slug: "x" }));
       });`
    );
    expect(dashboard!.loaderScopesByCaller).toBe(true);
  });

  // Round C ruling 1. The signal is per export because the exposure is per export. Entry-point-wide
  // it passed `_app.orgs.$organizationSlug.settings.team/route.tsx`, whose loader narrows itself to
  // the caller and whose action resolves the target org from the URL slug.
  it("attributes the caller filter to the export it was written in", () => {
    const ep = scanFile(
      "_app.orgs.$slug.settings.team/route.tsx",
      `import { dashboardAction, dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
       export const loader = dashboardLoader({}, async ({ user }) =>
         json(await presenter.call({ userId: user.id }))
       );
       export const action = dashboardAction({}, async ({ context, request }) =>
         json(await prisma.orgMember.deleteMany({ where: { organizationId: context.organizationId } }))
       );`
    );
    expect(ep!.loaderScopesByCaller).toBe(true);
    expect(ep!.actionScopesByCaller).toBe(false);
  });

  // Round D item 3. The predicate fired on any property at all whose value was a caller id, so one
  // dead statement cleared the check. Both halves are now required: an identity property name, and
  // an object that is handed to a call.
  it("does not read a dead object holding the caller id as a scope", () => {
    const arbitraryKey = scanFile(
      "api.v1.orgs.ts",
      `${PAT}
       export const loader = createActionPATApiRoute({}, async ({ user }) => {
         const unused = { anything: user.id };
         return json(await prisma.org.findMany({ where: { slug: "x" } }));
       });`
    );
    expect(arbitraryKey!.loaderScopesByCaller).toBe(false);

    const identityKey = scanFile(
      "api.v1.orgs.ts",
      `${PAT}
       export const loader = createActionPATApiRoute({}, async ({ user }) => {
         const unused = { userId: user.id };
         return json(await prisma.org.findMany({ where: { slug: "x" } }));
       });`
    );
    expect(identityKey!.loaderScopesByCaller).toBe(false);
  });

  it("reads the caller id through any depth of nesting inside a call argument", () => {
    const ep = scanFile(
      "api.v1.orgs.ts",
      `${PAT}
       export const loader = createActionPATApiRoute({}, async ({ user }) => {
         return json(await prisma.org.findMany({
           where: { OR: [{ members: { some: { userId: user.id } } }] },
         }));
       });`
    );
    expect(ep!.loaderScopesByCaller).toBe(true);
  });

  it("does not read a non-identity field off the caller as a scope", () => {
    const ep = scanFile(
      "api.v1.orgs.ts",
      `${PAT}
       export const loader = createActionPATApiRoute({}, async ({ user }) => {
         return json(await prisma.org.findMany({ where: { title: user.name } }));
       });`
    );
    expect(ep!.loaderScopesByCaller).toBe(false);
  });

  // Round E item 3. Neither of the two conditions above constrains the CALLEE, so a log line
  // carrying the caller's id satisfied a tenant-scoping security check. Cheaper to write than the
  // dead object, and unlike the dead object it survives review, because a log line is real code
  // somebody wants.
  it("does not read a caller id handed to a log call as a scope", () => {
    const logger = scanFile(
      "api.v1.orgs.ts",
      `${PAT}
       export const loader = createActionPATApiRoute({}, async ({ user }) => {
         logger.error("create failed", { userId: user.id });
         return json(await prisma.org.findMany({ where: { slug: "x" } }));
       });`
    );
    expect(logger!.loaderScopesByCaller).toBe(false);

    // A different logger family: `LOGGER_CALLEE` does not match `console.warn`, so this is the
    // second sink rather than a restatement of the first.
    const console_ = scanFile(
      "api.v1.orgs.ts",
      `${PAT}
       export const loader = createActionPATApiRoute({}, async ({ user }) => {
         console.warn("create failed", { userId: user.id });
         return json(await prisma.org.findMany({ where: { slug: "x" } }));
       });`
    );
    expect(console_!.loaderScopesByCaller).toBe(false);
  });

  // The refusal is made at the call, not at the property, so burying the id under the depth of
  // nesting a real filter has does not get it past.
  it("does not read a caller id nested inside a log call's payload as a scope", () => {
    const ep = scanFile(
      "api.v1.orgs.ts",
      `${PAT}
       export const loader = createActionPATApiRoute({}, async ({ user }) => {
         logger.info("looking up", { where: { OR: [{ userId: user.id }] } });
         return json(await prisma.org.findMany({ where: { slug: "x" } }));
       });`
    );
    expect(ep!.loaderScopesByCaller).toBe(false);
  });

  // The response body is the other sink that takes the same object and cannot narrow a read.
  it("does not read a caller id handed to a response serializer as a scope", () => {
    const ep = scanFile(
      "api.v1.orgs.ts",
      `${PAT}
       export const loader = createActionPATApiRoute({}, async ({ user }) => {
         return typedjson({ userId: user.id });
       });`
    );
    expect(ep!.loaderScopesByCaller).toBe(false);
  });

  // The direction that matters more than any of the above: refusing the log line must not accuse a
  // handler that also runs the query. This is the shape on the real tree today,
  // `engine.v1.dev.runs.$runFriendlyId.snapshots.$snapshotFriendlyId.attempts.start.ts`, which logs
  // the environment id and reads with it, and which must keep its pass.
  it("still reads a real query filter written beside a log call", () => {
    const ep = scanFile(
      "api.v1.orgs.ts",
      `${PAT}
       export const loader = createActionPATApiRoute({}, async ({ authentication }) => {
         const run = await runStore.findRun({ runtimeEnvironmentId: authentication.environment.id });
         if (!run) logger.error("no run", { environmentId: authentication.environment.id });
         return json(run);
       });`
    );
    expect(ep!.loaderScopesByCaller).toBe(true);
  });

  // A resource's owner is not the caller.
  it("does not read another object's userId as a scope", () => {
    const ep = scanFile(
      "api.v1.orgs.ts",
      `${PAT}
       export const loader = createActionPATApiRoute({}, async () => {
         return json(await prisma.org.findMany({ where: { userId: run.userId } }));
       });`
    );
    expect(ep!.loaderScopesByCaller).toBe(false);
  });
});

/**
 * The per-export split of `calleeNames`. `auth-boundary` reads it, so a name landing in the wrong
 * half is a wrong verdict on the one check where a false pass hides a security gap.
 */
describe("scanFile: callee names attributed per export", () => {
  it("keeps each export's callees out of the other's list", () => {
    const ep = scanFile(
      "api.v1.tokens.ts",
      `export async function loader({ request }) {
         const userId = await requireUserId(request);
         return json(await prisma.token.findMany({ where: { userId } }));
       }
       export async function action({ request }) {
         await deleteEverything(request);
         return json({ ok: true });
       }`
    );
    expect(ep!.loaderCalleeNames).toContain("requireUserId");
    expect(ep!.loaderCalleeNames).not.toContain("deleteEverything");
    expect(ep!.actionCalleeNames).toContain("deleteEverything");
    expect(ep!.actionCalleeNames).not.toContain("requireUserId");
  });

  it("attributes a same-file helper to the export that calls it", () => {
    const ep = scanFile(
      "api.v1.tokens.ts",
      `async function loadTokens(request) {
         const userId = await requireUserId(request);
         return prisma.token.findMany({ where: { userId } });
       }
       export async function loader({ request }) { return json(await loadTokens(request)); }
       export async function action({ request }) { return json(await request.json()); }`
    );
    expect(ep!.loaderCalleeNames).toContain("requireUserId");
    expect(ep!.actionCalleeNames).not.toContain("requireUserId");
  });

  it("attributes a helper both exports call to both of them", () => {
    const ep = scanFile(
      "api.v1.tokens.ts",
      `async function guarded(request) { return requireUserId(request); }
       export async function loader({ request }) { return json(await guarded(request)); }
       export async function action({ request }) { return json(await guarded(request)); }`
    );
    expect(ep!.loaderCalleeNames).toContain("requireUserId");
    expect(ep!.actionCalleeNames).toContain("requireUserId");
  });

  // One handler, both exports: `const { loader, action } = createActionApiRoute({ handler })`.
  it("attributes a handler serving both exports to both of them", () => {
    const ep = scanFile(
      "api.v1.tokens.ts",
      `export const { action, loader } = createActionApiRoute({}, async ({ authentication }) => {
         return json(await authenticateApiRequest(authentication));
       });`
    );
    expect(ep!.loaderCalleeNames).toContain("authenticateApiRequest");
    expect(ep!.actionCalleeNames).toContain("authenticateApiRequest");
  });

  // The union the split came from. `calleeNames` stays entry-point-wide for `sensitivity.ts`,
  // `triviality.ts` and `audit-trail`, so the two representations have to agree.
  it("every callee name is attributed to an export that exists", () => {
    const ep = scanFile(
      "api.v1.tokens.ts",
      `async function shared(request) { return audit(request); }
       export async function loader({ request }) { return json(await shared(request)); }
       export async function action({ request }) { return json(await mutate(request)); }`
    );
    const attributed = new Set([...ep!.loaderCalleeNames, ...ep!.actionCalleeNames]);
    expect([...new Set(ep!.calleeNames)].filter((n) => !attributed.has(n))).toEqual([]);
    for (const name of attributed) expect(ep!.calleeNames).toContain(name);
  });

  it("counts statements and a try per export as well as entry-point-wide", () => {
    const ep = scanFile(
      "api.v1.tokens.ts",
      `export const loader = () => redirect("/login");
       export async function action({ request }) {
         try { return json(await request.json()); } catch (e) { throw e; }
       }`
    );
    expect(ep!.loaderStatementCount).toBe(1);
    expect(ep!.loaderHasTryCatch).toBe(false);
    expect(ep!.actionHasTryCatch).toBe(true);
    expect(ep!.hasTryCatch).toBe(true);
    expect(ep!.statementCount).toBe(ep!.loaderStatementCount + ep!.actionStatementCount);
  });
});

// Round C ruling 2. A guard that answers with null instead of throwing is only a boundary if the
// route reads the answer, so the scan records which callees' results a condition looked at.
describe("scanFile: callees whose answer the body read", () => {
  it("records a resolver whose result a negated if tests", () => {
    const ep = scanFile(
      "invite-accept.tsx",
      `import { getUser } from "~/services/session.server";
       export async function loader({ request }) {
         const user = await getUser(request);
         if (!user) return redirect("/login");
         return json({ email: user.email });
       }`
    );
    expect(ep!.loaderCheckedCallees).toContain("getUser");
  });

  it("records one whose result a plain if tests", () => {
    const ep = scanFile(
      "login._index/route.tsx",
      `import { getUserId } from "~/services/session.server";
       export async function loader({ request }) {
         const userId = await getUserId(request);
         if (userId) throw redirect("/");
         return typedjson({});
       }`
    );
    expect(ep!.loaderCheckedCallees).toContain("getUserId");
  });

  it("records one whose result a ternary tests", () => {
    const ep = scanFile(
      "x.ts",
      `export async function loader({ request }) {
         const user = await getUser(request);
         return user ? json({ ok: true }) : redirect("/login");
       }`
    );
    expect(ep!.loaderCheckedCallees).toContain("getUser");
  });

  it("does not record a result that is bound and never tested", () => {
    const ep = scanFile(
      "x.ts",
      `export async function loader({ request }) {
         const user = await getUser(request);
         return json(await prisma.invite.findMany({ where: { email: user.email } }));
       }`
    );
    expect(ep!.loaderCheckedCallees).not.toContain("getUser");
  });

  it("does not record a result that is dropped entirely", () => {
    const ep = scanFile(
      "x.ts",
      `export async function loader({ request }) {
         await getUser(request);
         return json(await prisma.invite.findMany());
       }`
    );
    expect(ep!.loaderCheckedCallees).not.toContain("getUser");
  });

  it("does not record a callee just because a same-named local is tested elsewhere", () => {
    const ep = scanFile(
      "x.ts",
      `export async function loader({ request }) {
         const rows = await prisma.invite.findMany();
         if (rows.length === 0) return json([]);
         return json(rows);
       }`
    );
    expect(ep!.loaderCheckedCallees).toContain("findMany");
    expect(ep!.loaderCheckedCallees).not.toContain("getUser");
  });
});

/**
 * Contract only. Enumeration order is not controllable from a test: ext4 returns name-hash order, so
 * every name set constructed here already comes back sorted and the assertion cannot be made to fail
 * locally. It still holds the contract for a filesystem that enumerates in creation order.
 */
describe("routeModuleFiles", () => {
  it("returns the tree in name order", () => {
    const dir = mkdtempSync(join(tmpdir(), "obs-map-order-"));
    try {
      for (const name of ["zeta.ts", "alpha.ts", "middle.ts"]) {
        writeFileSync(join(dir, name), LOADER);
      }
      mkdirSync(join(dir, "beta"));
      writeFileSync(join(dir, "beta", "route.ts"), LOADER);

      const names = routeModuleFiles(dir).map((f) => f.relativeName);
      expect(names).toEqual([...names].sort());
      expect(names).toEqual(["alpha.ts", "beta/route.ts", "middle.ts", "zeta.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

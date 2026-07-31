import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanDirectory, scanFile } from "../src/scan.js";

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
    expect(ep!.statementCount).toBeGreaterThan(4);
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
    ).toThrow();
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
    expect(parseFailures).toEqual(["broken.ts"]);
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

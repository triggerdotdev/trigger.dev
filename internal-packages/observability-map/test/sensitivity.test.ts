import { classifySensitivity } from "../src/sensitivity.js";
import { scanFile } from "../src/scan.js";

const ep = (fileName: string, source: string) => scanFile(fileName, source)!;

describe("classifySensitivity", () => {
  it("flags a route whose filename says nothing but which calls a sensitive helper", () => {
    const e = ep(
      "@.ts",
      `import { clearImpersonation } from "~/models/admin.server";
       export async function loader({ request }) { return clearImpersonation(request, "/admin"); }`
    );
    const s = classifySensitivity(e);
    expect(s.sensitive).toBe(true);
    expect(s.reasons.some((r) => r.includes("clearImpersonation"))).toBe(true);
  });

  it("flags on the path when the filename is explicit", () => {
    const e = ep("api.v1.projects.$ref.envvars.ts", `export async function loader() { return 1; }`);
    expect(classifySensitivity(e).sensitive).toBe(true);
  });

  it("does not flag an ordinary read route", () => {
    const e = ep(
      "api.v1.timezones.ts",
      `import { json } from "@remix-run/server-runtime";
       export async function loader() { return json({ timezones: [] }); }`
    );
    expect(classifySensitivity(e).sensitive).toBe(false);
  });

  it("does not flag on a substring that merely contains a sensitive word", () => {
    const e = ep(
      "api.v1.authorship.ts",
      `export async function loader() { return { author: "x" }; }`
    );
    expect(classifySensitivity(e).sensitive).toBe(false);
  });
});

// Directory routes: `fileName` can be `dirName/route.tsx` rather than a flat dotted name. A naive
// `fileName.split(".")` treats "billing/route" as one non-matching segment because the slash never
// gets split, so it misses the directory name entirely. The classifier must derive real path
// segments (via the same route-path logic the remix adapter uses) so both shapes work alike.
describe("classifySensitivity: directory routes", () => {
  it("flags a single-segment directory route by its directory name", () => {
    const e = ep("billing/route.tsx", `export async function loader() { return 1; }`);
    const s = classifySensitivity(e);
    expect(s.sensitive).toBe(true);
    expect(s.reasons.some((r) => r.includes("billing"))).toBe(true);
  });

  it("flags a multi-segment directory route via a segment among dynamic params", () => {
    const e = ep(
      "_app.orgs.$slug.billing/route.tsx",
      `export async function loader() { return 1; }`
    );
    expect(classifySensitivity(e).sensitive).toBe(true);
  });

  it("does not flag a directory route on a substring that merely contains a sensitive word", () => {
    const e = ep("api.v1.authorship/route.tsx", `export async function loader() { return 1; }`);
    expect(classifySensitivity(e).sensitive).toBe(false);
  });
});

// calleeNames is scoped to the loader/action body, unlike importedNames which is file-wide. A
// sensitive symbol called only at module scope is invisible to calleeNames, so it is only caught
// when it also shows up as an import.
describe("classifySensitivity: calleeNames is body-scoped, importedNames is file-wide", () => {
  it("flags a sensitive symbol invoked only at module scope, via the import rather than the callee", () => {
    const e = ep(
      "api.v1.setup.ts",
      `import { setImpersonation } from "~/models/admin.server";
       setImpersonation(globalThis, "seed");
       export async function loader() { return 1; }`
    );
    const s = classifySensitivity(e);
    expect(s.sensitive).toBe(true);
    expect(s.reasons.some((r) => r.includes("setImpersonation"))).toBe(true);
  });

  it("flags a sensitive callee defined locally and invoked inside the loader, even without an import", () => {
    const e = ep(
      "api.v1.local-admin.ts",
      `async function createJWT() { return "x"; }
       export async function loader() { return createJWT(); }`
    );
    expect(classifySensitivity(e).sensitive).toBe(true);
  });

  it("does not flag a sensitive-named call made only at module scope outside the loader/action body", () => {
    const e = ep(
      "api.v1.module-scope.ts",
      `function createJWT() { return "x"; }
       createJWT();
       export async function loader() { return 1; }`
    );
    expect(classifySensitivity(e).sensitive).toBe(false);
  });
});

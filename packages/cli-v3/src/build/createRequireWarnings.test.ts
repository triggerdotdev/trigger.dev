import { build } from "esbuild";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ResolvedConfig } from "@trigger.dev/core/v3/build";
import { BuildManifest } from "@trigger.dev/core/v3/schemas";
import {
  collectCreateRequireWarningMessages,
  CreateRequireCollector,
  createRequireUsageToWarning,
  extensionInstalledPackageMatchers,
  packageNameForSpecifier,
  scanSource,
  scanSourceForCreateRequire,
  unavailableCreateRequireUsages,
} from "./createRequireWarnings.js";

describe("scanSourceForCreateRequire", () => {
  it("finds a direct createRequire invocation with a string literal", () => {
    const source = `import { createRequire } from "node:module";
const mssql = createRequire(import.meta.url)("mssql");
`;

    const results = scanSourceForCreateRequire(source);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      specifier: "mssql",
      line: 2,
      column: 14,
      lineText: `const mssql = createRequire(import.meta.url)("mssql");`,
    });
  });

  it("finds calls through a variable assigned from createRequire", () => {
    const source = `import { createRequire } from "module";
const req = createRequire(import.meta.url);
const pg = req("pg");
const client = req('ioredis');
`;

    const results = scanSourceForCreateRequire(source);

    expect(results.map((r) => r.specifier)).toEqual(["pg", "ioredis"]);
    expect(results[0]).toMatchObject({ line: 3, column: 11 });
  });

  it("finds calls through require.resolve on the created require", () => {
    const source = `import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const path = req.resolve("sharp");
`;

    expect(scanSourceForCreateRequire(source).map((r) => r.specifier)).toEqual(["sharp"]);
  });

  it("supports an aliased createRequire import", () => {
    const source = `import { createRequire as makeRequire } from "node:module";
const mod = makeRequire(import.meta.url)("bcrypt");
`;

    expect(scanSourceForCreateRequire(source).map((r) => r.specifier)).toEqual(["bcrypt"]);
  });

  it("supports member access on a module namespace", () => {
    const source = `import mod from "node:module";
const req = mod.createRequire(import.meta.url);
const pg = req("pg");
`;

    expect(scanSourceForCreateRequire(source).map((r) => r.specifier)).toEqual(["pg"]);
  });

  it("supports CJS destructuring of createRequire", () => {
    const source = `const { createRequire } = require("module");
const req = createRequire(__filename);
const lib = req("canvas");
`;

    expect(scanSourceForCreateRequire(source).map((r) => r.specifier)).toEqual(["canvas"]);
  });

  it("keeps subpath and scoped specifiers intact", () => {
    const source = `import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const a = req("mssql/lib/tedious");
const b = req("@aws-sdk/client-s3");
`;

    expect(scanSourceForCreateRequire(source).map((r) => r.specifier)).toEqual([
      "mssql/lib/tedious",
      "@aws-sdk/client-s3",
    ]);
  });

  it("ignores relative, absolute, and internal-import specifiers", () => {
    const source = `import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
req("./data.json");
req("../other.js");
req("/abs/path.js");
req("#internal/thing");
`;

    expect(scanSourceForCreateRequire(source)).toEqual([]);
  });

  it("ignores node builtins with and without the node: prefix", () => {
    const source = `import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
req("fs");
req("node:path");
req("fs/promises");
`;

    expect(scanSourceForCreateRequire(source)).toEqual([]);
  });

  it("ignores non-literal specifiers", () => {
    const source = `import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const name = "mssql";
req(name);
`;

    expect(scanSourceForCreateRequire(source)).toEqual([]);
  });

  it("ignores a createRequire result that is only assigned, never called", () => {
    const source = `import { createRequire } from "node:module";
globalThis.require = createRequire(import.meta.url);
`;

    expect(scanSourceForCreateRequire(source)).toEqual([]);
  });

  it("finds calls when the createRequire argument contains a nested call", () => {
    const source = `import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const mssql = createRequire(fileURLToPath(import.meta.url))("mssql");
const req = createRequire(fileURLToPath(import.meta.url));
const pg = req("pg");
`;

    expect(scanSourceForCreateRequire(source).map((r) => r.specifier)).toEqual(["mssql", "pg"]);
  });

  it("ignores hits inside comments", () => {
    const source = `import { createRequire } from "node:module";
// const mssql = createRequire(import.meta.url)("mssql");
/* const pg = createRequire(import.meta.url)("pg"); */
/**
 * Example: createRequire(import.meta.url)("sharp")
 */
const real = createRequire(import.meta.url)("bcrypt");
`;

    expect(scanSourceForCreateRequire(source).map((r) => r.specifier)).toEqual(["bcrypt"]);
  });

  it("ignores files that never import the module builtin", () => {
    const source = `function createRequire(config: string) {
  return (name: string) => registry.get(config, name);
}
const load = createRequire("defaults");
const plugin = load("mssql");
`;

    expect(scanSourceForCreateRequire(source)).toEqual([]);
  });

  it("ignores a local createRequire function even when the module builtin is imported for something else", () => {
    const source = `import { builtinModules } from "node:module";
function createRequire(config: string) {
  return (name: string) => registry.get(config, name);
}
const load = createRequire("defaults");
const plugin = load("mssql");
`;

    expect(scanSourceForCreateRequire(source)).toEqual([]);
  });

  it("does not register require names from commented-out assignments", () => {
    const source = `import { createRequire } from "node:module";
// const req = createRequire(import.meta.url);
declare function req(name: string): unknown;
const y = req("mssql");
`;

    expect(scanSourceForCreateRequire(source)).toEqual([]);
  });

  it("still finds calls after a closed inline block comment", () => {
    const source = `import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
/* driver */ const mssql = req("mssql");
`;

    expect(scanSourceForCreateRequire(source).map((r) => r.specifier)).toEqual(["mssql"]);
  });

  it("is not confused by // inside a string on the same line", () => {
    const source = `import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const api = "https://example.com"; const pg = req("pg");
`;

    expect(scanSourceForCreateRequire(source).map((r) => r.specifier)).toEqual(["pg"]);
  });

  it("ignores code embedded in template literals", () => {
    const source =
      'import { createRequire } from "node:module";\nconst req = createRequire(import.meta.url);\nconst snippet = `const x = req("fake-pkg");`;\n';

    expect(scanSourceForCreateRequire(source)).toEqual([]);
  });

  it("supports whitespace before the require parenthesis in CJS bindings", () => {
    const source = `const { createRequire } = require ("module");
const req = createRequire(__filename);
const lib = req("canvas");
`;

    expect(scanSourceForCreateRequire(source).map((r) => r.specifier)).toEqual(["canvas"]);
  });

  it("supports a type annotation on the assigned require variable", () => {
    const source = `import { createRequire } from "node:module";
const req: NodeRequire = createRequire(import.meta.url);
const mssql = req("mssql");
`;

    expect(scanSourceForCreateRequire(source).map((r) => r.specifier)).toEqual(["mssql"]);
  });

  it("supports two levels of nesting in the createRequire argument", () => {
    const source = `import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const mssql = createRequire(fileURLToPath(new URL(".", import.meta.url)))("mssql");
`;

    expect(scanSourceForCreateRequire(source).map((r) => r.specifier)).toEqual(["mssql"]);
  });

  it("supports bindings from a dynamic import of the module builtin", () => {
    const source = `const { createRequire } = await import("node:module");
const req = createRequire(import.meta.url);
const pg = req("pg");
`;

    expect(scanSourceForCreateRequire(source).map((r) => r.specifier)).toEqual(["pg"]);
  });

  it("supports a namespace bound from a dynamic import of the module builtin", () => {
    const source = `const mod = await import("node:module");
const mssql = mod.createRequire(import.meta.url)("mssql");
`;

    expect(scanSourceForCreateRequire(source).map((r) => r.specifier)).toEqual(["mssql"]);
  });

  it("supports declare-then-assign require variables", () => {
    const source = `import { createRequire } from "node:module";
let req;
req = createRequire(import.meta.url);
const pg = req("pg");
`;

    expect(scanSourceForCreateRequire(source).map((r) => r.specifier)).toEqual(["pg"]);
  });

  it("does not warn for call-shaped text inside string literals", () => {
    const source = `import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const msg = 'try req("mssql") for details';
const pg = req("pg");
`;

    expect(scanSourceForCreateRequire(source).map((r) => r.specifier)).toEqual(["pg"]);
  });

  it("strips a comment that follows a regex literal containing quotes", () => {
    const source = `import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const quote = /['"]/; /* old: req("bcrypt") */
const pg = req("pg");
`;

    expect(scanSourceForCreateRequire(source).map((r) => r.specifier)).toEqual(["pg"]);
  });

  it("follows require functions imported from other scanned files", () => {
    const util = `import { createRequire } from "node:module";
export const cjsRequire = createRequire(import.meta.url);
`;
    const task = `import { cjsRequire } from "./util.js";
const mssql = cjsRequire("mssql");
`;

    const { exportedRequireFns, specifiers } = scanSource(util);

    expect(exportedRequireFns).toEqual(["cjsRequire"]);
    expect(specifiers).toEqual([]);

    const taskResults = scanSourceForCreateRequire(task, new Set(exportedRequireFns));

    expect(taskResults.map((r) => r.specifier)).toEqual(["mssql"]);
  });

  it("returns nothing when the source doesn't mention createRequire", () => {
    const source = `import mssql from "mssql";
export const pool = mssql.connect();
`;

    expect(scanSourceForCreateRequire(source)).toEqual([]);
  });

  it("does not treat unrelated variables with similar names as require functions", () => {
    const source = `import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const reqCount = tally("metrics");
obj.req("not-a-require");
`;

    expect(scanSourceForCreateRequire(source)).toEqual([]);
  });
});

describe("CreateRequireCollector", () => {
  it("collects createRequire usages from bundle inputs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "create-require-collector-"));

    try {
      const entryPoint = join(dir, "entry.ts");
      await writeFile(
        entryPoint,
        `import { createRequire } from "node:module";
export const mssql = createRequire(import.meta.url)("mssql");
`
      );

      const collector = new CreateRequireCollector(dir);

      await build({
        entryPoints: [entryPoint],
        bundle: true,
        metafile: true,
        write: false,
        format: "esm",
        platform: "node",
        outdir: dir,
        absWorkingDir: dir,
        logLevel: "silent",
        plugins: [collector.plugin],
      });

      expect(collector.usages).toHaveLength(1);
      expect(collector.usages[0]).toMatchObject({
        specifier: "mssql",
        packageName: "mssql",
        file: "entry.ts",
        line: 2,
      });

      await build({
        entryPoints: [entryPoint],
        bundle: true,
        metafile: true,
        write: false,
        format: "esm",
        platform: "node",
        outdir: dir,
        absWorkingDir: dir,
        logLevel: "silent",
        plugins: [collector.plugin],
      });

      expect(collector.usages).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("collects usages of a require function imported from another module", async () => {
    const dir = await mkdtemp(join(tmpdir(), "create-require-collector-"));

    try {
      await writeFile(
        join(dir, "util.ts"),
        `import { createRequire } from "node:module";
export const cjsRequire = createRequire(import.meta.url);
`
      );

      const entryPoint = join(dir, "entry.ts");
      await writeFile(
        entryPoint,
        `import { cjsRequire } from "./util.js";
export const mssql = cjsRequire("mssql");
`
      );

      const collector = new CreateRequireCollector(dir);

      await build({
        entryPoints: [entryPoint],
        bundle: true,
        metafile: true,
        write: false,
        format: "esm",
        platform: "node",
        outdir: dir,
        absWorkingDir: dir,
        logLevel: "silent",
        plugins: [collector.plugin],
      });

      expect(collector.usages).toHaveLength(1);
      expect(collector.usages[0]).toMatchObject({
        specifier: "mssql",
        packageName: "mssql",
        file: "entry.ts",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("createRequireUsageToWarning", () => {
  const usage = {
    specifier: "mssql/lib/tedious",
    packageName: "mssql",
    file: "src/db.ts",
    line: 12,
    column: 20,
    lineText: `const mssql = createRequire(import.meta.url)("mssql/lib/tedious");`,
  };

  it("carries the concrete fix in a note", () => {
    const warning = createRequireUsageToWarning(usage, "deploy");

    expect(warning.location).toMatchObject({ file: "src/db.ts", line: 12, column: 20 });

    const note = warning.notes?.[0]?.text ?? "";
    expect(note).toContain("trigger.config.ts");
    expect(note).toContain(`additionalPackages({ packages: ["mssql"] })`);
    expect(note).toContain("https://trigger.dev/docs/config/extensions/additionalPackages");
  });

  it("explains that the failure is deploy-only when building for dev", () => {
    const warning = createRequireUsageToWarning(usage, "dev");

    expect(warning.text).toContain("works locally");
    expect(warning.text).toContain("deploys of this code will fail at runtime");
  });
});

describe("unavailableCreateRequireUsages", () => {
  const usageFor = (specifier: string, packageName: string) => ({
    specifier,
    packageName,
    file: "src/db.ts",
    line: 1,
    column: 0,
    lineText: "",
  });

  it("keeps usages that are neither installed nor configured as external", () => {
    const usages = [usageFor("mssql", "mssql")];

    expect(unavailableCreateRequireUsages(usages, new Set(), [])).toHaveLength(1);
  });

  it("drops usages whose package is in the resolved externals", () => {
    const usages = [usageFor("sharp", "sharp"), usageFor("mssql", "mssql")];

    const result = unavailableCreateRequireUsages(usages, new Set(["sharp"]), []);

    expect(result.map((u) => u.packageName)).toEqual(["mssql"]);
  });

  it("drops usages matching a configured external pattern", () => {
    const usages = [usageFor("mssql/lib/tedious", "mssql"), usageFor("pg", "pg")];

    const result = unavailableCreateRequireUsages(usages, new Set(), [
      new RegExp(`^mssql(?:/[^'"]*)?$`),
    ]);

    expect(result.map((u) => u.packageName)).toEqual(["pg"]);
  });
});

describe("extensionInstalledPackageMatchers", () => {
  const configWith = (extensions: unknown[]) =>
    ({ build: { extensions } }) as unknown as ResolvedConfig;

  it("collects matchers from installedPackagesForTarget and externalsForTarget", () => {
    const { matchers, incomplete } = extensionInstalledPackageMatchers(
      configWith([
        { name: "custom", installedPackagesForTarget: () => ["ffmpeg-static"] },
        { name: "prisma", externalsForTarget: () => ["@prisma/client"] },
      ])
    );

    expect(incomplete).toBe(false);
    expect(matchers.some((m) => m.test("ffmpeg-static"))).toBe(true);
    expect(matchers.some((m) => m.test("@prisma/client"))).toBe(true);
    expect(matchers.some((m) => m.test("mssql"))).toBe(false);
  });

  it("marks the result incomplete instead of throwing when an extension hook throws", () => {
    const { incomplete } = extensionInstalledPackageMatchers(
      configWith([
        {
          name: "boom",
          installedPackagesForTarget: () => {
            throw new Error("bad package entry");
          },
        },
      ])
    );

    expect(incomplete).toBe(true);
  });

  it("marks the result incomplete for an additionalPackages extension without the hook", () => {
    const { incomplete } = extensionInstalledPackageMatchers(
      configWith([{ name: "additionalPackages" }])
    );

    expect(incomplete).toBe(true);
  });
});

describe("collectCreateRequireWarningMessages", () => {
  const usage = {
    specifier: "mssql",
    packageName: "mssql",
    file: "src/db.ts",
    line: 1,
    column: 0,
    lineText: "",
  };

  const manifestWith = (externals: Array<{ name: string; version: string }>) =>
    ({ externals }) as unknown as BuildManifest;

  it("warns for a package missing from the manifest externals", () => {
    const messages = collectCreateRequireWarningMessages({
      usages: [usage],
      buildManifest: manifestWith([]),
      extensionPackages: { matchers: [], incomplete: false },
      target: "deploy",
    });

    expect(messages).toHaveLength(1);
  });

  it("suppresses packages present in the manifest externals", () => {
    const messages = collectCreateRequireWarningMessages({
      usages: [usage],
      buildManifest: manifestWith([{ name: "mssql", version: "10.0.0" }]),
      extensionPackages: { matchers: [], incomplete: false },
      target: "deploy",
    });

    expect(messages).toEqual([]);
  });

  it("stays silent in dev when extension-installed packages are unknown", () => {
    const messages = collectCreateRequireWarningMessages({
      usages: [usage],
      buildManifest: manifestWith([]),
      extensionPackages: { matchers: [], incomplete: true },
      target: "dev",
    });

    expect(messages).toEqual([]);
  });

  it("still warns on deploy when extension-installed packages are unknown", () => {
    const messages = collectCreateRequireWarningMessages({
      usages: [usage],
      buildManifest: manifestWith([]),
      extensionPackages: { matchers: [], incomplete: true },
      target: "deploy",
    });

    expect(messages).toHaveLength(1);
  });
});

describe("packageNameForSpecifier", () => {
  it("extracts the package name from plain, subpath, and scoped specifiers", () => {
    expect(packageNameForSpecifier("mssql")).toBe("mssql");
    expect(packageNameForSpecifier("mssql/lib/tedious")).toBe("mssql");
    expect(packageNameForSpecifier("@aws-sdk/client-s3")).toBe("@aws-sdk/client-s3");
    expect(packageNameForSpecifier("@aws-sdk/client-s3/dist/index.js")).toBe("@aws-sdk/client-s3");
  });
});

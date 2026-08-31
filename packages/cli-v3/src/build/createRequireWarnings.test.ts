import { build } from "esbuild";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CreateRequireCollector,
  createRequireUsageToWarning,
  packageNameForSpecifier,
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

describe("packageNameForSpecifier", () => {
  it("extracts the package name from plain, subpath, and scoped specifiers", () => {
    expect(packageNameForSpecifier("mssql")).toBe("mssql");
    expect(packageNameForSpecifier("mssql/lib/tedious")).toBe("mssql");
    expect(packageNameForSpecifier("@aws-sdk/client-s3")).toBe("@aws-sdk/client-s3");
    expect(packageNameForSpecifier("@aws-sdk/client-s3/dist/index.js")).toBe("@aws-sdk/client-s3");
  });
});

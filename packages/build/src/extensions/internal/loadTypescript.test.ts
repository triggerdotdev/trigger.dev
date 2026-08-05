import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadTypescript } from "./loadTypescript.js";

const packageRequire = createRequire(join(process.cwd(), "package.json"));
const projectDirs = new Set<string>();

function createProject(packages: Record<string, string>) {
  const projectDir = mkdtempSync(join(tmpdir(), "trigger-typescript-"));
  projectDirs.add(projectDir);
  const nodeModulesDir = join(projectDir, "node_modules");

  mkdirSync(nodeModulesDir);
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({ private: true }));

  for (const [installedName, sourceName] of Object.entries(packages)) {
    const target = dirname(packageRequire.resolve(`${sourceName}/package.json`));
    const destination = join(nodeModulesDir, installedName);

    mkdirSync(dirname(destination), { recursive: true });
    symlinkSync(target, destination, "junction");
  }

  return projectDir;
}

function createBrokenCompiler(projectDir: string, packageName = "typescript") {
  const packageDir = join(projectDir, "node_modules", packageName);

  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, "package.json"),
    JSON.stringify({ name: packageName, main: "index.cjs" })
  );
  writeFileSync(join(packageDir, "index.cjs"), 'throw new Error("broken compiler");');
}

describe("loadTypescript", () => {
  afterEach(() => {
    for (const projectDir of projectDirs) {
      rmSync(projectDir, { recursive: true, force: true });
    }

    projectDirs.clear();
  });

  it("loads the consumer's TypeScript 5 compiler", () => {
    const compiler = loadTypescript(createProject({ typescript: "typescript5" }));

    expect(compiler.version).toMatch(/^5\./);
    expect(typeof compiler.transpileModule).toBe("function");
  });

  it("loads the consumer's TypeScript 6 compiler", () => {
    const compiler = loadTypescript(createProject({ typescript: "typescript" }));

    expect(compiler.version).toMatch(/^6\./);
    expect(typeof compiler.transpileModule).toBe("function");
  });

  it("returns an actionable error for TypeScript 7 without the compatibility package", () => {
    const projectDir = createProject({ typescript: "typescript7" });
    const requireFromProject = createRequire(join(projectDir, "package.json"));

    expect(typeof requireFromProject("typescript").transpileModule).toBe("undefined");
    expect(() => loadTypescript(projectDir, ["typescript"])).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining("npm install --save-dev @typescript/typescript6"),
      })
    );
  });

  it("surfaces errors from an installed compiler package", () => {
    const projectDir = createProject({});
    createBrokenCompiler(projectDir);

    expect(() => loadTypescript(projectDir, ["typescript"])).toThrowError(
      `Failed to load "typescript" from ${projectDir}.`
    );
  });

  it("falls back when an earlier compiler package fails to load", () => {
    const projectDir = createProject({
      "@typescript/typescript6": "@typescript/typescript6",
    });
    createBrokenCompiler(projectDir);

    const compiler = loadTypescript(projectDir);

    expect(compiler.version).toMatch(/^6\./);
    expect(typeof compiler.transpileModule).toBe("function");
  });

  it("falls back to the TypeScript 6 compatibility package for TypeScript 7", () => {
    const compiler = loadTypescript(
      createProject({
        typescript: "typescript7",
        "@typescript/typescript6": "@typescript/typescript6",
      })
    );

    const output = compiler.transpileModule(
      `
        class Dependency {}
        function injectable<T extends new (...args: any[]) => object>(target: T) {}

        @injectable
        class Service {
          constructor(public dependency: Dependency) {}
        }
      `,
      {
        compilerOptions: {
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
        },
      }
    ).outputText;

    expect(compiler.version).toMatch(/^6\./);
    expect(output).toContain('__metadata("design:paramtypes", [Dependency])');
  });

  it("supports aliasing TypeScript to the compatibility package", () => {
    const compiler = loadTypescript(createProject({ typescript: "@typescript/typescript6" }));

    expect(compiler.version).toMatch(/^6\./);
    expect(typeof compiler.transpileModule).toBe("function");
  });
});

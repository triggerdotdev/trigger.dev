/**
 * Import Validation Tests
 *
 * These tests validate that the SDK can be imported correctly across
 * different module systems (ESM and CJS).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { execa, type Options as ExecaOptions } from "execa";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "../fixtures");

// Find the SDK package in the monorepo
const sdkDir = resolve(__dirname, "../../../../packages/trigger-sdk");

// Common execa options
const execaOpts: ExecaOptions = {
  env: {
    ...process.env,
    // Ensure Node.js can resolve workspace packages
    NODE_PATH: resolve(__dirname, "../../../../node_modules"),
  },
  timeout: 30_000,
};

describe("ESM Import Tests", () => {
  it("should import SDK using ESM syntax", async () => {
    const result = await execa("node", ["test.mjs"], {
      ...execaOpts,
      cwd: resolve(fixturesDir, "esm-import"),
    });

    expect(result.stdout).toContain("SUCCESS");
    expect(result.exitCode).toBe(0);
  });

  it("should validate superjson serialization in ESM", async () => {
    const result = await execa("node", ["superjson-test.mjs"], {
      ...execaOpts,
      cwd: resolve(fixturesDir, "esm-import"),
    });

    expect(result.stdout).toContain("SUCCESS");
    expect(result.exitCode).toBe(0);
  });
});

describe("CJS Require Tests", () => {
  it("should require SDK using CommonJS syntax", async () => {
    const result = await execa("node", ["test.cjs"], {
      ...execaOpts,
      cwd: resolve(fixturesDir, "cjs-require"),
    });

    expect(result.stdout).toContain("SUCCESS");
    expect(result.exitCode).toBe(0);
  });

  it("should work with --experimental-require-module flag on older Node", async () => {
    // This flag is needed for Node < 22.12.0 to require ESM modules
    // On newer Node.js, it's a no-op
    const result = await execa("node", ["--experimental-require-module", "test.cjs"], {
      ...execaOpts,
      cwd: resolve(fixturesDir, "cjs-require"),
    });

    expect(result.stdout).toContain("SUCCESS");
    expect(result.exitCode).toBe(0);
  });
});

describe("TypeScript Compilation Tests", () => {
  it("should typecheck SDK imports successfully", async () => {
    const result = await execa("npx", ["tsc", "--noEmit"], {
      ...execaOpts,
      cwd: resolve(fixturesDir, "typescript"),
    });

    expect(result.exitCode).toBe(0);
  });
});

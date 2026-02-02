/**
 * Bundler Compatibility Tests
 *
 * These tests validate that the SDK can be bundled correctly using
 * common bundlers like esbuild.
 */

import { describe, it, expect } from "vitest";
import * as esbuild from "esbuild";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "../fixtures");

describe("esbuild Bundling Tests", () => {
  it("should bundle ESM entrypoint without errors", async () => {
    const result = await esbuild.build({
      entryPoints: [resolve(fixturesDir, "esm-import/test.mjs")],
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node18",
      write: false,
      external: ["@trigger.dev/sdk", "@trigger.dev/sdk/*"],
      logLevel: "silent",
    });

    expect(result.errors).toHaveLength(0);
    expect(result.outputFiles).toHaveLength(1);
  });

  it("should bundle CJS entrypoint without errors", async () => {
    const result = await esbuild.build({
      entryPoints: [resolve(fixturesDir, "cjs-require/test.cjs")],
      bundle: true,
      format: "cjs",
      platform: "node",
      target: "node18",
      write: false,
      external: ["@trigger.dev/sdk", "@trigger.dev/sdk/*"],
      logLevel: "silent",
    });

    expect(result.errors).toHaveLength(0);
    expect(result.outputFiles).toHaveLength(1);
  });

  it("should bundle SDK inline (simulating production build)", async () => {
    // This simulates what happens when a user bundles their app with the SDK included
    const entryContent = `
      import { task, logger } from "@trigger.dev/sdk";

      export const myTask = task({
        id: "bundled-task",
        run: async (payload) => {
          logger.info("Processing", { payload });
          return { success: true };
        },
      });
    `;

    const result = await esbuild.build({
      stdin: {
        contents: entryContent,
        loader: "ts",
        resolveDir: resolve(__dirname, "../../"),
      },
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node18",
      write: false,
      // Don't externalize SDK - bundle it inline
      logLevel: "silent",
      metafile: true,
    });

    expect(result.errors).toHaveLength(0);
    expect(result.outputFiles).toHaveLength(1);

    // Verify the bundle contains the SDK code
    const bundleContent = result.outputFiles[0].text;
    expect(bundleContent).toBeTruthy();
    expect(bundleContent.length).toBeGreaterThan(1000); // Should be substantial
  });

  it("should handle tree-shaking correctly", async () => {
    // Import only specific functions to test tree-shaking
    const entryContent = `
      import { task } from "@trigger.dev/sdk";

      export const myTask = task({
        id: "tree-shake-task",
        run: async () => ({ done: true }),
      });
    `;

    const result = await esbuild.build({
      stdin: {
        contents: entryContent,
        loader: "ts",
        resolveDir: resolve(__dirname, "../../"),
      },
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node18",
      write: false,
      treeShaking: true,
      logLevel: "silent",
    });

    expect(result.errors).toHaveLength(0);
    expect(result.outputFiles).toHaveLength(1);
  });
});

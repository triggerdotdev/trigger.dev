import { nodeCompileCacheEnv } from "@trigger.dev/core/v3/build";
import type { BuildRuntime } from "@trigger.dev/core/v3/schemas";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fillCompileCache } from "./fillCompileCache.js";

const nodeMajor = Number(process.versions.node.split(".")[0]);
const runtimes: Record<number, BuildRuntime> = { 24: "node-24", 26: "node-26" };
const runtime = runtimes[nodeMajor];

describe.skipIf(!runtime)("fillCompileCache", () => {
  // Catches: the build writing the cache with settings the run worker doesn't read it with, which
  // only shows up as slower starts
  it("writes a cache that the run worker accepts for every module", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trigger-compile-cache-"));
    const compileCacheDir = join(dir, ".trigger", "compile-cache");

    try {
      await writeFile(join(dir, "chunk.mjs"), "export const add = (a, b) => a + b;");
      await writeFile(join(dir, "task.mjs"), "export const task = () => 1;");
      // Stands in for the run worker: a static chunk, a task imported later, then a clean exit
      await writeFile(
        join(dir, "worker.mjs"),
        `import nodeModule from "node:module";
import { add } from "./chunk.mjs";
await import("./task.mjs");
add(1, 2);
nodeModule.flushCompileCache?.();
process.exit(0);`
      );

      const fill = await fillCompileCache({
        runtime: runtime!,
        runWorkerPath: join(dir, "worker.mjs"),
        compileCacheDir,
        env: { PATH: process.env.PATH },
        cwd: dir,
      });

      expect(fill.exitCode, fill.stderr).toBe(0);

      const run = spawnSync(process.execPath, [join(dir, "worker.mjs")], {
        cwd: dir,
        env: {
          PATH: process.env.PATH,
          ...nodeCompileCacheEnv(runtime!, compileCacheDir, "read"),
          NODE_DEBUG_NATIVE: "COMPILE_CACHE",
        },
        encoding: "utf8",
      });

      const accepted = run.stderr
        .split("\n")
        .filter((line) => line.includes("was accepted"))
        .map((line) => line.match(/file:\/\/\S+\/([^/\s]+\.mjs)/)?.[1]);

      expect(run.status, run.stderr).toBe(0);
      expect(accepted.sort()).toEqual(["chunk.mjs", "task.mjs", "worker.mjs"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

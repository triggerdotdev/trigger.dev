import { describe, expect, it } from "vitest";
import { WARMUP_FLAG, warmupCommand } from "./warmupCommand.js";

const worker = "/app/.trigger/worker/managed-run-worker.mjs";

describe("warmupCommand", () => {
  // Catches: the warmup dropping the loader and conditions a run gets through NODE_OPTIONS, which it
  // has no env for, so it would load different modules than a run
  it("passes a node run's loader and conditions as flags", () => {
    expect(
      warmupCommand(
        {
          runtime: "node-24",
          workerEntryPoint: worker,
          loaderEntryPoint: "/app/.trigger/loader.mjs",
          customConditions: ["react-server"],
        },
        "/app"
      )
    ).toEqual([
      "node",
      "--trace-uncaught",
      "--no-warnings=ExperimentalWarning",
      "--import=file:///app/.trigger/loader.mjs",
      "--conditions=react-server",
      worker,
      WARMUP_FLAG,
      "/app",
    ]);
  });

  // Catches: the warmup compiling the bundle from scratch where a run reads the image's compile
  // cache, so it would touch different memory than a run
  it("reads the compile cache a run reads", () => {
    expect(
      warmupCommand(
        {
          runtime: "node-26",
          workerEntryPoint: worker,
          compileCacheDir: "/app/.trigger/compile-cache",
        },
        "/app"
      ).slice(0, 4)
    ).toEqual([
      "/usr/bin/env",
      "NODE_COMPILE_CACHE=/app/.trigger/compile-cache",
      "NODE_COMPILE_CACHE_READONLY=1",
      "node",
    ]);
  });

  // Catches: a compiled bun deploy warming the uncompiled worker, which a run never loads
  it("starts a compiled worker directly", () => {
    expect(
      warmupCommand(
        {
          runtime: "bun-1.4",
          workerEntryPoint: worker,
          compiledWorkerPath: "/app/.trigger/worker/run-worker",
        },
        "/app"
      )
    ).toEqual(["/app/.trigger/worker/run-worker", WARMUP_FLAG, "/app"]);
  });

  // Catches: node's --no-warnings=<type> form, which bun refuses at startup
  it("starts an uncompiled bun worker with bun's flags", () => {
    expect(warmupCommand({ runtime: "bun", workerEntryPoint: worker }, "/app")).toEqual([
      "bun",
      "--trace-uncaught",
      "--no-warnings",
      worker,
      WARMUP_FLAG,
      "/app",
    ]);
  });
});

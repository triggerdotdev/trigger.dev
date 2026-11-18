import { execPathForRuntime, nodeCompileCacheEnv } from "@trigger.dev/core/v3/build";
import type { BuildRuntime } from "@trigger.dev/core/v3/schemas";
import { fork } from "node:child_process";
import { mkdir } from "node:fs/promises";

export type FillCompileCacheOptions = {
  runtime: BuildRuntime;
  runWorkerPath: string;
  compileCacheDir: string;
  nodeOptions?: string;
  otelHookInclude?: string[];
  env: Record<string, string | undefined>;
  cwd?: string;
  timeoutMs?: number;
};

/**
 * Starts the run worker once with the compile cache turned on, so it imports the config and every
 * task file the way a run does and Node writes a cache entry for each module. Resolves with the
 * worker's exit code, or null if it timed out.
 */
export async function fillCompileCache({
  runtime,
  runWorkerPath,
  compileCacheDir,
  nodeOptions,
  otelHookInclude,
  env: $env,
  cwd,
  timeoutMs = 60_000,
}: FillCompileCacheOptions): Promise<{ exitCode: number | null; stderr: string }> {
  // The image copies this directory, so it has to exist even if the worker fails
  await mkdir(compileCacheDir, { recursive: true });

  return await new Promise((resolve) => {
    let stderr = "";

    const child = fork(runWorkerPath, [], {
      stdio: [/*stdin*/ "ignore", /*stdout*/ "ignore", /*stderr*/ "pipe", "ipc"],
      cwd,
      env: {
        ...$env,
        // The same instrumented packages as a run, so the loader produces the same modules
        OTEL_IMPORT_HOOK_INCLUDES: otelHookInclude?.join(","),
        NODE_OPTIONS: nodeOptions,
        ...nodeCompileCacheEnv(runtime, compileCacheDir, "write"),
        TRIGGER_FILL_COMPILE_CACHE: "1",
      },
      execArgv: ["--trace-uncaught", "--no-warnings=ExperimentalWarning"],
      execPath: execPathForRuntime(runtime),
      serialization: "json",
    });

    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ exitCode: null, stderr });
    }, timeoutMs);

    child.on("exit", (code) => {
      clearTimeout(timeout);
      resolve({ exitCode: code, stderr });
    });
  });
}

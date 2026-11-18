import { binaryForRuntime, isBunRuntime, nodeCompileCacheEnv } from "@trigger.dev/core/v3/build";
import type { WorkerManifest } from "@trigger.dev/core/v3/schemas";
import { pathToFileURL } from "node:url";

/** Starts the run worker in warmup mode; the next argument is the directory holding index.json. */
export const WARMUP_FLAG = "--trigger-warmup";

/**
 * The command that starts the deployed run worker in warmup mode, as the run controller would start
 * it for a run. It needs no env and no working directory, so a host can run it to prime a snapshot of
 * the image. The runtime binary is looked up on the image's PATH, as the image's entrypoint is.
 */
export function warmupCommand(
  workerManifest: Pick<
    WorkerManifest,
    | "runtime"
    | "workerEntryPoint"
    | "compiledWorkerPath"
    | "loaderEntryPoint"
    | "customConditions"
    | "compileCacheDir"
  >,
  cwd: string
): string[] {
  const args = [WARMUP_FLAG, cwd];

  // The compiled worker has its entry point and runtime flags built in
  if (workerManifest.compiledWorkerPath) {
    return [workerManifest.compiledWorkerPath, ...args];
  }

  if (isBunRuntime(workerManifest.runtime)) {
    return [
      binaryForRuntime(workerManifest.runtime),
      "--trace-uncaught",
      "--no-warnings",
      workerManifest.workerEntryPoint,
      ...args,
    ];
  }

  // A run reads the compile cache the image build filled, which is set through the env
  const compileCacheEnv = workerManifest.compileCacheDir
    ? Object.entries(
        nodeCompileCacheEnv(workerManifest.runtime, workerManifest.compileCacheDir, "read")
      ).map(([key, value]) => `${key}=${value}`)
    : [];

  // A run gets these through NODE_OPTIONS, which the warmup has no env for
  return [
    ...(compileCacheEnv.length > 0 ? ["/usr/bin/env", ...compileCacheEnv] : []),
    binaryForRuntime(workerManifest.runtime),
    "--trace-uncaught",
    "--no-warnings=ExperimentalWarning",
    ...(workerManifest.loaderEntryPoint
      ? [`--import=${pathToFileURL(workerManifest.loaderEntryPoint).href}`]
      : []),
    ...(workerManifest.customConditions ?? []).map((condition) => `--conditions=${condition}`),
    workerManifest.workerEntryPoint,
    ...args,
  ];
}

/**
 * secure-exec V8 sandbox — runs JavaScript in-process via V8 isolates.
 *
 * No external API key needed. ~14ms cold start, ~3MB per isolate.
 * A fresh runtime is created per execution — no warm/dispose lifecycle needed.
 */
import {
  NodeRuntime,
  createNodeDriver,
  createNodeRuntimeDriverFactory,
} from "secure-exec";

export async function runInSecureSandbox<T>(
  runner: (runtime: NodeRuntime) => Promise<T>
): Promise<T | { error: string }> {
  const runtime = new NodeRuntime({
    systemDriver: createNodeDriver({
      permissions: {
        fs: (req) => ({
          allow: req.path.startsWith("/root") || req.path.startsWith("/tmp"),
        }),
        network: (req) => ({
          allow: req.hostname === "127.0.0.1" || req.hostname === "localhost",
        }),
      },
    }),
    runtimeDriverFactory: createNodeRuntimeDriverFactory(),
    memoryLimit: 128,
    cpuTimeLimitMs: 60_000,
  });

  try {
    return await runner(runtime);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    runtime.dispose();
  }
}

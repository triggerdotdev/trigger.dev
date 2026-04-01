/**
 * secure-exec V8 sandbox for PR review — with Node filesystem + network access.
 *
 * Unlike the default secure-sandbox.ts (restricted fs/network), this sandbox
 * grants full filesystem and network access so the agent can read cloned repo
 * files and make HTTP requests from within sandboxed code.
 *
 * The sandbox receives a `cwd` (the cloned repo path) which is injected as
 * a global `__cwd` constant so sandboxed code can reference the repo root.
 *
 * 256MB memory, 30s CPU time limit.
 */
import {
  NodeRuntime,
  NodeFileSystem,
  createNodeDriver,
  createNodeRuntimeDriverFactory,
  allowAllFs,
  allowAllNetwork,
} from "secure-exec";

export async function runInPRReviewSandbox<T>(
  cwd: string,
  runner: (runtime: NodeRuntime) => Promise<T>
): Promise<T | { error: string }> {
  const runtime = new NodeRuntime({
    systemDriver: createNodeDriver({
      filesystem: new NodeFileSystem(),
      permissions: {
        ...allowAllFs,
        ...allowAllNetwork,
      },
    }),
    runtimeDriverFactory: createNodeRuntimeDriverFactory(),
    memoryLimit: 256,
    cpuTimeLimitMs: 30_000,
  });

  try {
    // Inject the repo cwd as a global so sandboxed code can use it
    await runtime.run(`globalThis.__cwd = ${JSON.stringify(cwd)};`);
    return await runner(runtime);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    runtime.dispose();
  }
}

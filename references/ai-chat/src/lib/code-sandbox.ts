/**
 * E2B sandboxes keyed by Trigger run id.
 *
 * - Warmed from `chat.task` `onTurnStart` (non-blocking) so the first `executeCode` tool call is faster.
 * - Disposed in task `onWait` when `wait.type === "token"` (input-stream suspend, same path as `wait.for` tokens).
 * - `onComplete` disposes any leftover sandbox if the run ends without hitting another token wait.
 *
 * No extra `chat.task` SDK hook is required for the suspend boundary — platform `onWait` is sufficient.
 */
import { chat } from "@trigger.dev/sdk/ai";
import { Sandbox } from "@e2b/code-interpreter";

const sandboxPromises = new Map<string, Promise<Sandbox>>();

/** Run id for the active chat turn — set from `onTurnStart` so tools can key the sandbox without `taskContext`. */
export const codeSandboxRun = chat.local<{ runId: string }>({ id: "codeSandboxRun" });

export function warmCodeSandbox(runId: string): void {
  codeSandboxRun.init({ runId });
  if (!process.env.E2B_API_KEY?.trim()) return;
  if (sandboxPromises.has(runId)) return;
  sandboxPromises.set(runId, Sandbox.create());
}

export async function runWithCodeSandbox<T>(
  runId: string,
  runner: (sandbox: Sandbox) => Promise<T>
): Promise<T | { error: string }> {
  if (!process.env.E2B_API_KEY?.trim()) {
    return { error: "Code sandbox not configured. Set E2B_API_KEY in the Trigger environment." };
  }

  let promise = sandboxPromises.get(runId);
  if (!promise) {
    promise = Sandbox.create();
    sandboxPromises.set(runId, promise);
  }

  try {
    const sandbox = await promise;
    return await runner(sandbox);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export async function disposeCodeSandboxForRun(runId: string): Promise<void> {
  const promise = sandboxPromises.get(runId);
  if (!promise) return;
  sandboxPromises.delete(runId);
  try {
    const sandbox = await promise;
    await sandbox.kill();
  } catch {
    /* best-effort cleanup */
  }
}

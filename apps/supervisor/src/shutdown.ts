import { ShutdownManager } from "@trigger.dev/core/v3/serverOnly";
import type { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";

/**
 * Runs `stop` once on the first SIGTERM or SIGINT, then exits. Not the core
 * singleton: it installs no signal handlers, and turns itself off under a TEST
 * env var, which would leave the signal swallowed and the process running.
 */
export function installShutdown(opts: {
  stop: () => Promise<void>;
  timeoutMs: number;
  logger: SimpleStructuredLogger;
}): void {
  new ShutdownManager(false).register("supervisor", () =>
    stopWithin(opts.stop, opts.timeoutMs, opts.logger)
  );
}

/** Resolves when `stop` settles or after `timeoutMs`, whichever is first. */
async function stopWithin(
  stop: () => Promise<void>,
  timeoutMs: number,
  logger: SimpleStructuredLogger
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const result = await Promise.race([stop().then(() => "stopped" as const), timedOut]);
    if (result === "timeout") {
      logger.warn("Shutdown did not finish in time, exiting anyway", { timeoutMs });
    }
  } finally {
    clearTimeout(timer);
  }
}

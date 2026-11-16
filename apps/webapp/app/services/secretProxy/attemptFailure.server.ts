import { json } from "@remix-run/server-runtime";
import { retrySettingsFromLockedConfig, type RunEngine } from "@internal/run-engine";
import { logger } from "~/services/logger.server";
import { recordSecretProxyFailure } from "./telemetry.server";

export async function failAttemptForSecretProxySigning(options: {
  engine: Pick<RunEngine, "runStore" | "completeRunAttempt">;
  run: { id: string; attemptNumber?: number | null };
  snapshotId: string;
  environmentId: string;
  workerId?: string;
  runnerId?: string;
}): Promise<never> {
  const message = "Run token signing failed";
  recordSecretProxyFailure("signing", "signing");
  try {
    const run = await options.engine.runStore.findRunOnPrimary(
      { id: options.run.id },
      { select: { lockedRetryConfig: true } }
    );
    await options.engine.completeRunAttempt({
      runId: options.run.id,
      snapshotId: options.snapshotId,
      environmentId: options.environmentId,
      workerId: options.workerId,
      runnerId: options.runnerId,
      forceRequeue: true,
      completion: {
        ok: false,
        id: options.run.id,
        error: { type: "STRING_ERROR", raw: message },
        retry: retrySettingsFromLockedConfig(
          run?.lockedRetryConfig,
          options.run.attemptNumber ?? null
        ),
      },
    });
  } catch (error) {
    recordSecretProxyFailure("signing", "requeue");
    logger.error("Failed to requeue attempt after secret proxy signing failure", {
      runId: options.run.id,
      error,
    });
    throw json({ error: message }, { status: 503 });
  }
  throw json({ error: message }, { status: 503, headers: { "x-should-retry": "false" } });
}

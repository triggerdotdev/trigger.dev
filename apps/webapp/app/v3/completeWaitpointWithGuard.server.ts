import { isWaitpointCompletionGuardArmedError } from "@internal/run-engine";
import { isRetryableInfrastructureError } from "@trigger.dev/database";
import { logger } from "~/services/logger.server";
import { engine } from "./runEngine.server";
import { isRunStoreInfraRetryEnabled } from "./runStoreInfraRetryFlag.server";

type WaitpointCompletionOutput = { value: string; type?: string; isError: boolean };

/**
 * Complete a waitpoint from a manual/API request with the durable write-ahead guard.
 *
 * We return the caller's normal 200 for a retryable connectivity failure ONLY when the engine confirms
 * the guard was durably armed before the failure (a WaitpointCompletionGuardArmedError): the guard then
 * replays the completion + fanout. A failure BEFORE the guard is persisted — including the guard's own
 * enqueue failing — is not that branded error, so it propagates and the caller does NOT report success
 * (there is no durable owner yet). We deliberately do not infer arming from the requested flag.
 * Validation, authorization, and any non-retryable error still propagate. Flag off: no guard is armed,
 * nothing is branded, every error propagates as before.
 */
export async function completeWaitpointWithGuard(
  args: {
    id: string;
    output?: WaitpointCompletionOutput;
  },
  // Injectable for tests (DI, not mocking): defaults to the real engine + flag poller.
  deps?: {
    isEnabled?: () => Promise<boolean>;
    completeWaitpoint?: (a: {
      id: string;
      output?: WaitpointCompletionOutput;
      armGuard: boolean;
    }) => Promise<unknown>;
  }
): Promise<void> {
  const armGuard = await (deps?.isEnabled ?? isRunStoreInfraRetryEnabled)();
  const complete = deps?.completeWaitpoint ?? ((a) => engine.completeWaitpoint(a));
  try {
    await complete({ id: args.id, output: args.output, armGuard });
  } catch (error) {
    if (!isWaitpointCompletionGuardArmedError(error)) {
      // Not proven armed (includes every pre-arm failure): propagate, never report success.
      throw error;
    }
    if (isRetryableInfrastructureError(error.cause)) {
      logger.warn(
        "completeWaitpoint: inline path failed after the guard was armed; the guard will deliver the completion",
        {
          waitpointId: args.id,
          error: error.cause instanceof Error ? error.cause.message : String(error.cause),
        }
      );
      return;
    }
    // Armed, but the failure is not retryable (e.g. validation): surface the original cause.
    throw error.cause;
  }
}

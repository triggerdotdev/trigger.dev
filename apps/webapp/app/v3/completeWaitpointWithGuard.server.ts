import { isRetryableInfrastructureError } from "@trigger.dev/database";
import { logger } from "~/services/logger.server";
import { engine } from "./runEngine.server";
import { isRunStoreInfraRetryEnabled } from "./runStoreInfraRetryFlag.server";

type WaitpointCompletionOutput = { value: string; type?: string; isError: boolean };

/**
 * Complete a waitpoint from a manual/API request with the durable write-ahead guard.
 *
 * When the flag is on, the guard is armed before the mutation and owns eventual completion. So if the
 * inline path fails after arming with a retryable/commit-unknown connectivity error (e.g. the shared
 * retry budget was drained by a fleet-wide blip), we swallow it and let the caller return its normal
 * 200: the guard replays the completion + fanout. Validation, authorization, and any other error
 * still propagate. With the flag off, no guard is armed and every error propagates as before.
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
    if (armGuard && isRetryableInfrastructureError(error)) {
      logger.warn(
        "completeWaitpoint: inline path failed after arming the guard; the guard will deliver the completion",
        {
          waitpointId: args.id,
          error: error instanceof Error ? error.message : String(error),
        }
      );
      return;
    }
    throw error;
  }
}

import type { ProdUsageManager } from "@trigger.dev/core/v3/workers";

type ExecutionIdentity = { run: { id: string }; attempt: { number: number } };

export function installUsageJwt(
  current: ExecutionIdentity | undefined,
  manager: ProdUsageManager | undefined,
  update: { runId: string; attemptNumber: number; token: string }
): boolean {
  if (current?.run.id !== update.runId || current.attempt.number !== update.attemptNumber) {
    return false;
  }
  return manager?.setJwt(update.token) === true;
}

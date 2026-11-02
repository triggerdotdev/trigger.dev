const RUN_TOKEN_ENV_KEY = "TRIGGER_RUN_TOKEN";

type ExecutionIdentity = { run: { id: string }; attempt: { number: number } };

/**
 * Installs a refreshed run token only into the attempt it was minted for. A reused task process may
 * already be running another run or attempt, and must keep that execution's credential.
 */
export function installRunToken(
  current: ExecutionIdentity | undefined,
  update: { runId: string; attemptNumber: number; token: string },
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (current?.run.id !== update.runId || current.attempt.number !== update.attemptNumber) {
    return false;
  }

  env[RUN_TOKEN_ENV_KEY] = update.token;
  return true;
}

/**
 * A warm-started process inherits the previous run's environment. When the next attempt carries no
 * run token, drop the inherited one so the SDK falls back instead of using another run's token.
 */
export function dropInheritedRunToken(
  executionEnv: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env
): void {
  if (!Object.hasOwn(executionEnv, RUN_TOKEN_ENV_KEY)) {
    delete env[RUN_TOKEN_ENV_KEY];
  }
}

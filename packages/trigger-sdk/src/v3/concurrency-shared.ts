/**
 * Concurrency helpers with no runtime dependencies, importable from the lean
 * browser and route-handler entrypoints (chat-client, chat-server) without
 * pulling the task runtime's module graph into those bundles.
 */

/**
 * Trigger-time named limits: strings only, like `queue`. They replace the task's
 * declared named limits for this run; the server resolves names to the run's gates.
 */
export function triggerConcurrencyBody(concurrency: string | string[] | undefined): {
  concurrency?: string[];
} {
  if (!concurrency) {
    return {};
  }
  const limits = Array.isArray(concurrency) ? concurrency : [concurrency];
  if (limits.length > 2) {
    throw new Error("The concurrency option accepts at most two named limits.");
  }
  if (limits.some((name) => typeof name !== "string" || name.length === 0)) {
    throw new Error("The concurrency option takes limit names: non-empty strings.");
  }
  for (const name of limits) {
    validateConcurrencyLimitName(name);
  }
  return { concurrency: limits };
}

export function validateConcurrencyLimitName(name: string): void {
  if (!/^[a-zA-Z0-9_-]{1,122}$/.test(name)) {
    throw new Error(
      `Concurrency limit "${name}": names are 1-122 characters using only letters, numbers, underscores and hyphens.`
    );
  }
}

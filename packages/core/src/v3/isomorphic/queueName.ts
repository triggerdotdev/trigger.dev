// Only allow alphanumeric characters, underscores, hyphens, and slashes (and only the first 128 characters)
export function sanitizeQueueName(queueName: string) {
  return queueName.replace(/[^a-zA-Z0-9_\-/]/g, "").substring(0, 128);
}

/** The names a concurrency limit can have: what `concurrencyLimit()` accepts for `name`. */
export const CONCURRENCY_LIMIT_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,122}$/;

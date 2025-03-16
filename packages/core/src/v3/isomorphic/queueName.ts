// Only allow alphanumeric characters, underscores, hyphens, and slashes (and only the first 128 characters)
export function sanitizeQueueName(queueName: string) {
  return queueName.replace(/[^a-zA-Z0-9_\-\/]/g, "").substring(0, 128);
}

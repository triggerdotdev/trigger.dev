import { isInfrastructureError, WebhookInfrastructureError } from "@internal/webhook-engine";
import { logger } from "~/services/logger.server";

/**
 * The message a webhook port returns for a failure, which ends up on the delivery a customer sees. A
 * failure of our infrastructure returns none: the delivery just stays pending until a retry lands, and
 * the real error, which can name internal hosts, is logged.
 */
export function webhookPortErrorMessage(error: unknown, port: string): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (!isInfrastructureError(error)) return message;
  logger.warn("webhook port failed on our infrastructure; the delivery will retry", {
    port,
    error: message,
  });
  return undefined;
}

// What a waitpoint store call rejects with when no node of the cluster answers: the connection's
// own two errors (waitpointStoreConnection.server.ts) and ioredis's for a command already sent.
const STORE_OUTAGE_MESSAGES = new Set([
  "Waitpoint cluster connection timed out",
  "Waitpoint cluster connection ended",
  "Cluster isn't ready and enableOfflineQueue options is false",
]);

// ioredis rejects with a new Error, without a cause, once a command runs out of redirections.
const REDIRECTIONS_EXHAUSTED = /^Too many Cluster redirections\. Last error: \w*Error: /;

/** Whether an error, or anything in its cause chain, is a waitpoint store outage. */
function isWaitpointStoreOutage(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    if (STORE_OUTAGE_MESSAGES.has(current.message.replace(REDIRECTIONS_EXHAUSTED, ""))) return true;
    current = current.cause;
  }
  return false;
}

/**
 * Runs a webhook port call. With standalone tokens on, a waitpoint store outage fails it as an
 * infrastructure failure, which the webhook engine retries; otherwise errors pass unchanged.
 */
export async function retryingStoreOutage<T>(
  standaloneTokens: boolean,
  call: () => Promise<T>
): Promise<T> {
  if (!standaloneTokens) return call();
  try {
    return await call();
  } catch (error) {
    if (!isWaitpointStoreOutage(error)) throw error;
    const infrastructure = new WebhookInfrastructureError((error as Error).message);
    infrastructure.cause = error;
    throw infrastructure;
  }
}

/** Whether a failed completion is retried; with standalone tokens on, a store outage is too. */
export function completionFailureIsInfrastructure(error: unknown, standaloneTokens: boolean) {
  return isInfrastructureError(error) || (standaloneTokens && isWaitpointStoreOutage(error));
}

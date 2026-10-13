import { isInfrastructureError } from "@internal/webhook-engine";
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

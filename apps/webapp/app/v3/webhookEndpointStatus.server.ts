import { webhookPrisma } from "~/db.server";
import { updateWebhookEndpointEnabled } from "./webhookEndpointStatus";

/**
 * Pause or resume an endpoint. Shared by the dashboard and the public API. Returns whether the
 * endpoint changed: one that is being deleted doesn't.
 */
export function setWebhookEndpointEnabled(endpointId: string, enabled: boolean) {
  return updateWebhookEndpointEnabled(webhookPrisma, endpointId, enabled);
}

import type { WebhookDatabase } from "@trigger.dev/database";

/**
 * Pause or resume an endpoint on `client`. A paused endpoint's ingress answers 404, so the
 * provider sees it as gone until it is enabled again.
 *
 * Only an active or paused endpoint changes: one that is being deleted stays that way. Returns
 * whether the endpoint changed.
 */
export async function updateWebhookEndpointEnabled(
  client: Pick<WebhookDatabase, "webhookEndpoint">,
  endpointId: string,
  enabled: boolean
) {
  const { count } = await client.webhookEndpoint.updateMany({
    where: { id: endpointId, status: { in: ["ACTIVE", "INACTIVE"] } },
    data: enabled
      ? { status: "ACTIVE", manuallyDeactivatedAt: null }
      : { status: "INACTIVE", manuallyDeactivatedAt: new Date() },
  });
  return count > 0;
}

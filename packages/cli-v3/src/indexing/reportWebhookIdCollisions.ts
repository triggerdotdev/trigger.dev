import { indexerToWorkerMessages, resourceCatalog } from "@trigger.dev/core/v3";
import { sendMessageInCatalog } from "@trigger.dev/core/v3/zodMessageHandler";

/**
 * If the indexer registered any duplicate webhook ids (across files), report
 * them to the parent via WEBHOOKS_FAILED_TO_INDEX and return true. Callers must
 * stop indexing (skip INDEX_COMPLETE) when this returns true.
 */
export async function reportWebhookIdCollisions(
  send: (message: unknown) => void
): Promise<boolean> {
  const collisions = resourceCatalog.listWebhookIdCollisions();

  if (collisions.length === 0) {
    return false;
  }

  await sendMessageInCatalog(
    indexerToWorkerMessages,
    "WEBHOOKS_FAILED_TO_INDEX",
    { collisions },
    async (msg) => {
      send(msg);
    }
  );

  return true;
}

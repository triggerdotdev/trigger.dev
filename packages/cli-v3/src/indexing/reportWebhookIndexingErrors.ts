import { indexerToWorkerMessages, resourceCatalog } from "@trigger.dev/core/v3";
import { sendMessageInCatalog } from "@trigger.dev/core/v3/zodMessageHandler";

/** Subscribers the server would refuse at deploy: an undefined endpoint, or a reused subscriber id. */
function subscriberProblems(): string[] {
  const endpointIds = new Set(
    resourceCatalog.listWebhookEndpointManifests().map((endpoint) => endpoint.id)
  );
  const idsByEndpoint = new Map<string, Set<string>>();
  const problems: string[] = [];

  for (const { endpointId, target } of resourceCatalog.listWebhookSubscribers()) {
    if (!endpointIds.has(endpointId)) {
      problems.push(
        `"${target.id}" subscribes to endpoint "${endpointId}", which isn't defined. Declare it with webhooks.endpoint.define() and export it.`
      );
      continue;
    }
    const ids = idsByEndpoint.get(endpointId) ?? new Set<string>();
    if (ids.has(target.id)) {
      problems.push(`endpoint "${endpointId}" has more than one subscriber with id "${target.id}"`);
    }
    ids.add(target.id);
    idsByEndpoint.set(endpointId, ids);
  }

  return problems;
}

/**
 * If the indexer found webhook declarations the server would refuse (a duplicate endpoint id, a
 * subscriber on an undefined endpoint, a reused subscriber id), report them to the parent via
 * WEBHOOKS_FAILED_TO_INDEX and return true. Callers must stop indexing (skip INDEX_COMPLETE) when
 * this returns true.
 */
export async function reportWebhookIndexingErrors(
  send: (message: unknown) => void
): Promise<boolean> {
  const collisions = resourceCatalog.listWebhookEndpointIdCollisions();
  const problems = subscriberProblems();

  if (collisions.length === 0 && problems.length === 0) {
    return false;
  }

  await sendMessageInCatalog(
    indexerToWorkerMessages,
    "WEBHOOKS_FAILED_TO_INDEX",
    { collisions, problems },
    async (msg) => {
      send(msg);
    }
  );

  return true;
}

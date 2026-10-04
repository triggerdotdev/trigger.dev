import { isWebhookEndpointFriendlyId } from "@trigger.dev/core/v3/isomorphic";

/**
 * Finds an endpoint by either of its ids in an environment: its `wh_` id, or its declared id (the
 * `id` passed to `webhooks.endpoint.define`), which names the declared, non-tenant instance. Declared
 * ids can't start with `wh_`, so the prefix decides which unique key is looked up. Scoped to the
 * environment so another environment's id doesn't resolve.
 */
export function webhookEndpointLookup(environmentId: string, endpointId: string) {
  return isWebhookEndpointFriendlyId(endpointId)
    ? { runtimeEnvironmentId: environmentId, friendlyId: endpointId }
    : {
        runtimeEnvironmentId: environmentId,
        declaredId: endpointId,
        endpointTenantId: "",
        endpointExternalRef: "",
      };
}

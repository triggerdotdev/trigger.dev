import type { Logger } from "@trigger.dev/core/logger";
import {
  FilterAst,
  WebhookDeliveryTargetResult,
  WebhookRoutingTarget,
  type WebhookEndpointContext,
} from "@trigger.dev/core/v3";
import type { WebhookEndpoint } from "@trigger.dev/database";

export type ParsedRoutingTarget = {
  target: WebhookRoutingTarget;
  filterAst: FilterAst | null;
};

/**
 * Parse an endpoint's stored `routingTargets`. A target that fails to parse is dropped and logged; a
 * corrupt filter AST fails open (the target routes everything), so a filter bug never swallows deliveries.
 */
export function parseRoutingTargets(
  endpoint: Pick<WebhookEndpoint, "id" | "routingTargets">,
  logger: Logger
): ParsedRoutingTarget[] {
  if (!Array.isArray(endpoint.routingTargets)) {
    logger.warn("webhook: routingTargets is not an array, routing nothing", {
      endpointId: endpoint.id,
    });
    return [];
  }

  const parsed: ParsedRoutingTarget[] = [];
  for (const raw of endpoint.routingTargets) {
    const target = WebhookRoutingTarget.safeParse(raw);
    if (!target.success) {
      logger.warn("webhook: corrupt routing target, skipping", { endpointId: endpoint.id });
      continue;
    }

    const rawAst =
      raw && typeof raw === "object" && "filterAst" in raw
        ? (raw as { filterAst?: unknown }).filterAst
        : undefined;
    let filterAst: FilterAst | null = null;
    if (rawAst != null) {
      const ast = FilterAst.safeParse(rawAst);
      if (ast.success) {
        filterAst = ast.data;
      } else {
        logger.warn("webhook: corrupt filterAst, routing all", {
          endpointId: endpoint.id,
          targetId: target.data.id,
        });
      }
    }

    parsed.push({ target: target.data, filterAst });
  }
  return parsed;
}

/** The `targets` column of a delivery row; entries that fail to parse are dropped. */
export function parseDeliveryTargets(value: unknown): WebhookDeliveryTargetResult[] {
  if (!Array.isArray(value)) return [];
  const results: WebhookDeliveryTargetResult[] = [];
  for (const entry of value) {
    const parsed = WebhookDeliveryTargetResult.safeParse(entry);
    if (parsed.success) results.push(parsed.data);
  }
  return results;
}

export function endpointContext(
  endpoint: Pick<
    WebhookEndpoint,
    "friendlyId" | "declaredId" | "endpointTenantId" | "endpointExternalRef" | "metadata"
  >
): WebhookEndpointContext {
  const metadata =
    endpoint.metadata && typeof endpoint.metadata === "object" && !Array.isArray(endpoint.metadata)
      ? (endpoint.metadata as Record<string, unknown>)
      : {};
  return {
    id: endpoint.friendlyId,
    declaredId: endpoint.declaredId,
    ...(endpoint.endpointTenantId ? { tenantId: endpoint.endpointTenantId } : {}),
    ...(endpoint.endpointExternalRef ? { externalRef: endpoint.endpointExternalRef } : {}),
    metadata,
  };
}

/** One line naming why a delivery routed nothing, for `WebhookDelivery.filterReason`. */
export function summarizeFilterReasons(results: WebhookDeliveryTargetResult[]): string {
  if (results.length === 0) return "the endpoint has no subscribers";
  if (results.length === 1) return results[0].reason ?? "filtered";
  return results.map((result) => `${result.id}: ${result.reason ?? "filtered"}`).join("; ");
}

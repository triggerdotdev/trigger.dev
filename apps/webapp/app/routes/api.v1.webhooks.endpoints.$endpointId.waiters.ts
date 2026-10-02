import { json } from "@remix-run/server-runtime";
import {
  CreateWebhookWaiterRequestBody,
  type CreateWebhookWaiterResponseBody,
  type WebhookWaiterErrorResponseBody,
} from "@trigger.dev/core/v3";
import { z } from "zod";
import { env } from "~/env.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { parseDelay } from "~/utils/delays";
import { resolveIdempotencyKeyTTL } from "~/utils/idempotencyKeys.server";
import { webhookIngressPathUrl } from "~/utils/webhookIngressUrl.server";
import { webhookEngine } from "~/v3/webhookEngine.server";
import { webhookLimitsForEnvironment } from "~/v3/webhookLimits.server";

const ParamsSchema = z.object({ endpointId: z.string() });

function waiterError(status: number, body: WebhookWaiterErrorResponseBody) {
  return json(body, { status });
}

/**
 * POST /api/v1/webhooks/endpoints/:endpointId/waiters registers a webhook waiter on an endpoint (its
 * declared id or `wh_` id). A waiter is a MANUAL waitpoint: wait on its id to suspend a run until a
 * matching delivery arrives, it times out, or it is cancelled. It only matches deliveries that arrive
 * after it was created.
 */
const { action, loader } = createActionApiRoute(
  {
    params: ParamsSchema,
    body: CreateWebhookWaiterRequestBody,
    maxContentLength: 1024 * 16,
    method: "POST",
    allowJWT: true,
    corsStrategy: "all",
    authorization: { action: "write", resource: () => ({ type: "waitpoints" }) },
  },
  async ({ params, body, authentication }) => {
    const environment = authentication.environment;

    if (env.WEBHOOK_ENABLED !== "1") {
      return waiterError(404, {
        error: "Webhooks aren't enabled on this instance",
        code: "webhook_endpoint_not_found",
      });
    }

    if (body.endpoint?.tenantId || body.endpoint?.externalRef) {
      return waiterError(422, {
        error: "Waiting on a dynamic endpoint instance is not supported yet",
        code: "invalid_request",
      });
    }

    const tags = typeof body.tags === "string" ? [body.tags] : (body.tags ?? []);

    let timeoutAt: Date | undefined;
    if (body.timeout) {
      timeoutAt = await parseDelay(body.timeout);
      if (!timeoutAt) {
        return waiterError(422, {
          error: `Invalid timeout "${body.timeout}": use a duration like "1h" or an ISO date`,
          code: "invalid_request",
        });
      }
    }

    const limits = await webhookLimitsForEnvironment(environment.id);
    const result = await webhookEngine.createWaiter({
      environmentId: environment.id,
      projectId: environment.projectId,
      endpoint: params.endpointId,
      match: body.match,
      filter: body.filter,
      timeoutAt,
      tags,
      idempotencyKey: body.idempotencyKey,
      idempotencyKeyExpiresAt: body.idempotencyKeyTTL
        ? resolveIdempotencyKeyTTL(body.idempotencyKeyTTL)
        : undefined,
      limits: {
        perEnvironment: limits.maxWaitersPerEnvironment,
        perEndpoint: limits.maxWaitersPerEndpoint,
      },
    });

    switch (result.outcome) {
      case "created":
        return json<CreateWebhookWaiterResponseBody>({
          id: result.id,
          ...(result.urlPath ? { url: webhookIngressPathUrl(result.urlPath) } : {}),
          expiresAt: result.expiresAt,
          isCached: result.isCached,
        });
      case "endpoint_not_found":
        return waiterError(404, {
          error: `No active webhook endpoint "${params.endpointId}" in this environment's current deployment`,
          code: "webhook_endpoint_not_found",
        });
      case "limit":
        return waiterError(422, {
          error: result.message,
          code: "webhook_waiter_limit",
          reason: result.reason,
        });
      case "filter_invalid":
        return waiterError(422, { error: result.error, code: "webhook_filter_invalid" });
      case "invalid":
        return waiterError(422, { error: result.error, code: "invalid_request" });
    }
  }
);

export { action, loader };

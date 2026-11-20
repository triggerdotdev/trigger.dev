import type { ClickHouse } from "@internal/clickhouse";
import { isWebhookEndpointFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { WebhookDetailPresenter } from "~/presenters/v3/WebhookDetailPresenter.server";
import { WebhookEndpointsListPresenter } from "~/presenters/v3/WebhookEndpointsListPresenter.server";
import { logger } from "~/services/logger.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { webhookIngressUrl } from "~/utils/webhookIngressUrl.server";
import { hasWebhooksAccess } from "~/v3/webhooksAccess.server";
import type { McpToolContext } from "../gate/types";
import type { McpToolDefinition } from "../registry.server";
import { defineReadTool, errorResult, resolveToolEnvironment, textResult } from "./define.server";
import { findWebhookEndpointResource } from "~/presenters/v3/ApiWebhookEndpointPresenter.server";
import { webhookEngine } from "~/v3/webhookEngine.server";
import {
  formatEndpointSearch,
  formatTaskWebhook,
  formatWaiters,
  type WebhookWaiterList,
} from "./format/webhooks";
import { ListWaitersInput, SearchEndpointsInput, TaskWebhookInput } from "./schemas/webhooks";

export type WebhooksReadDeps = {
  clickhouse: (organizationId: string) => Promise<ClickHouse>;
  listWaiters: (input: {
    endpointId: string;
    offset: number;
    limit: number;
  }) => Promise<WebhookWaiterList>;
  enabled: () => boolean;
};

type ResourceAuth = Parameters<typeof findWebhookEndpointResource>[0];

const auth = { action: "read", subject: "webhooks" } as const;

export const WEBHOOKS_NOT_AVAILABLE = "Webhooks are not available for this organization.";

export const WEBHOOKS_NOT_ENABLED = "Webhooks are not enabled on this server.";

export const WEBHOOKS_ENGINE_ERROR = "Could not reach the webhook engine. Try again later.";

export const webhooksEngineEnabled = () => env.WEBHOOK_ENABLED === "1";

export function logWebhookToolError(tool: string, error: unknown) {
  logger.error("MCP webhook tool failed", {
    tool,
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  });
}

export async function webhooksAvailable(ctx: McpToolContext): Promise<boolean> {
  const organizationId = ctx.subject?.organizationId;
  if (!organizationId) return false;
  const user = await $replica.user.findFirst({
    where: { id: ctx.identity.userId },
    select: { admin: true },
  });
  if (!user) return false;
  return hasWebhooksAccess({ admin: user.admin, isImpersonating: false }, organizationId);
}

export function createWebhooksReadTools(deps: WebhooksReadDeps): McpToolDefinition[] {
  return [
    defineReadTool({
      name: "search_webhook_endpoints",
      title: "Search Webhook Endpoints",
      description:
        "Search the project environment's webhook endpoints, including per-tenant instances, by subscriber (task or agent id), provider source, status (active by default, or inactive or disabled) and text in the declared id, tenant id or external ref. Returns up to 50 endpoints per page with a cursor for the next page, and the subscriber and source values you can filter by.",
      shape: SearchEndpointsInput.shape,
      auth,
      run: async (input, ctx) => {
        const environment = await resolveToolEnvironment(ctx);
        if (!environment) return errorResult("Not authorized");
        if (!(await webhooksAvailable(ctx))) return errorResult(WEBHOOKS_NOT_AVAILABLE);

        const clickhouse = await deps.clickhouse(environment.organizationId);
        const list = await new WebhookEndpointsListPresenter(clickhouse).call({
          organizationId: environment.organizationId,
          projectId: environment.projectId,
          environmentId: environment.id,
          subscribers: input.subscribers,
          sources: input.sources,
          statuses: input.statuses,
          search: input.search,
          cursor: input.cursor,
          includeActivity: false,
        });

        return textResult(
          formatEndpointSearch(
            list.endpoints.map((endpoint) => ({
              ...endpoint,
              ingestUrl: webhookIngressUrl(endpoint.opaqueId),
            })),
            list.pagination.next,
            list.filterOptions,
            list.hasFilters || Boolean(input.cursor)
          )
        );
      },
    }),
    defineReadTool({
      name: "get_task_webhook",
      title: "Get Task Webhook",
      description:
        "Get a webhook task (a task defined with webhook()) in the current version of the project environment: its file path, when it was created, and the endpoints it subscribes to, each with its status, source and the filter that decides which events reach the task. Header values in filters are hidden; the header names are shown.",
      shape: TaskWebhookInput.shape,
      auth,
      run: async (input, ctx) => {
        const environment = await resolveToolEnvironment(ctx);
        if (!environment) return errorResult("Not authorized");
        if (!(await webhooksAvailable(ctx))) return errorResult(WEBHOOKS_NOT_AVAILABLE);

        const clickhouse = await deps.clickhouse(environment.organizationId);
        const webhook = await new WebhookDetailPresenter($replica, clickhouse).findWebhook({
          environmentId: environment.id,
          environmentType: environment.type,
          webhookSlug: input.taskId,
        });
        if (!webhook) return errorResult("Webhook task not found");

        return textResult(formatTaskWebhook(webhook));
      },
    }),
    defineReadTool({
      name: "list_webhook_waiters",
      title: "List Webhook Waiters",
      description:
        "List the waiters on a webhook endpoint: runs paused until a matching event arrives, soonest expiry first. Each waiter's id is the waitpoint id the run is waiting on, with its match, filter and expiry. Returns up to 50 per page with a cursor for the next page. Header values in match and filter conditions are hidden; the header names are shown.",
      shape: ListWaitersInput.shape,
      auth,
      run: async (input, ctx) => {
        const environment = await resolveToolEnvironment(ctx);
        if (!environment) return errorResult("Not authorized");
        if (!deps.enabled()) return errorResult(WEBHOOKS_NOT_ENABLED);
        if (!(await webhooksAvailable(ctx))) return errorResult(WEBHOOKS_NOT_AVAILABLE);

        const friendlyId = isWebhookEndpointFriendlyId(input.endpointId)
          ? input.endpointId
          : (await findWebhookEndpointResource({ environment } as ResourceAuth, input.endpointId))
              ?.id;
        const clickhouse = await deps.clickhouse(environment.organizationId);
        const endpoint =
          friendlyId &&
          (await new WebhookDetailPresenter($replica, clickhouse).findEndpoint({
            environmentId: environment.id,
            endpointFriendlyId: friendlyId,
          }));
        if (!endpoint) return errorResult("Webhook endpoint not found");

        const offset = Number(input.cursor ?? 0);
        const limit = input.limit ?? 20;
        const list = await deps
          .listWaiters({ endpointId: endpoint.id, offset, limit })
          .catch((error: unknown) => {
            logWebhookToolError("list_webhook_waiters", error);
            return null;
          });
        if (!list) return errorResult("Could not list waiters. Try again later.");

        return textResult(formatWaiters(list, offset, limit));
      },
    }),
  ];
}

export const webhooksReadTools = createWebhooksReadTools({
  clickhouse: (organizationId) =>
    clickhouseFactory.getClickhouseForOrganization(organizationId, "standard"),
  listWaiters: (input) => webhookEngine.listWaiters(input),
  enabled: webhooksEngineEnabled,
});

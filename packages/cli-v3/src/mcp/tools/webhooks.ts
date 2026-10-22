import type {
  WebhookDeliveryListItem,
  WebhookDeliveryObject,
  WebhookDeliveryTargetObject,
} from "@trigger.dev/core/v3";
import { z } from "zod";
import { toolsMetadata } from "../config.js";
import { CommonProjectsInput } from "../schemas.js";
import { respondWithError, toolHandler } from "../utils.js";

const EndpointInput = CommonProjectsInput.extend({
  endpointId: z
    .string()
    .describe(
      "The webhook endpoint: its declared id (e.g. payments) or wh_ id. Use list_webhook_endpoints to find it."
    ),
});

const DELIVERY_STATUSES = [
  "pending",
  "processing",
  "succeeded",
  "failed",
  "filtered",
  "unmatched",
] as const;

const ListDeliveriesInput = CommonProjectsInput.extend({
  endpointId: z
    .string()
    .describe("Only this endpoint's deliveries: its declared id (e.g. payments) or wh_ id.")
    .optional(),
  status: z
    .array(z.enum(DELIVERY_STATUSES))
    .describe('Only deliveries with these statuses, e.g. ["failed", "filtered"].')
    .optional(),
  period: z
    .string()
    .describe('How far back to look, e.g. "1h", "1d" or "7d". Defaults to 7d.')
    .optional(),
  limit: z.number().int().min(1).max(100).describe("How many to return (default 20).").optional(),
  cursor: z
    .string()
    .describe("The cursor from a previous call, to get the next page of older deliveries.")
    .optional(),
});

const DeliveryInput = CommonProjectsInput.extend({
  deliveryId: z
    .string()
    .describe("The delivery id, starting with whd_. Use list_webhook_deliveries to find it."),
});

const ReplayInput = DeliveryInput.extend({
  targetId: z
    .string()
    .describe(
      "Replay to only this subscriber (its id on the endpoint, from the delivery's targets), even if its filter skipped the event. Omit to replay to every subscriber, re-checking their filters."
    )
    .optional(),
});

const SetSecretInput = EndpointInput.extend({
  secret: z.string().min(1).describe("The signing secret or public key the provider issued"),
});

function devOnlyError(devOnly: boolean | undefined, environment: string) {
  return devOnly && environment !== "dev"
    ? respondWithError(
        `This MCP server is only available for the dev environment. You tried to access the ${environment} environment. Remove the --dev-only flag to access other environments.`
      )
    : undefined;
}

export const listWebhookEndpointsTool = {
  name: toolsMetadata.list_webhook_endpoints.name,
  title: toolsMetadata.list_webhook_endpoints.title,
  description: toolsMetadata.list_webhook_endpoints.description,
  inputSchema: CommonProjectsInput.shape,
  handler: toolHandler(CommonProjectsInput.shape, async (input, { ctx }) => {
    const blocked = devOnlyError(ctx.options.devOnly, input.environment);
    if (blocked) return blocked;

    const projectRef = await ctx.getProjectRef({
      projectRef: input.projectRef,
      cwd: input.configPath,
    });
    const apiClient = await ctx.getApiClient({
      projectRef,
      environment: input.environment,
      scopes: ["read:webhooks"],
      branch: input.branch,
    });

    const result = await apiClient.listWebhookEndpoints();
    if (result.data.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No webhook endpoints in ${input.environment}. Endpoints are declared with webhooks.endpoint.define() and appear after the next dev session or deploy.`,
          },
        ],
      };
    }

    const lines = ["## Webhook endpoints\n"];
    for (const endpoint of result.data) {
      const tenant = endpoint.tenantId ? ` · tenant ${endpoint.tenantId}` : "";
      lines.push(`- **${endpoint.declaredId}** (${endpoint.id}) · ${endpoint.source}${tenant}`);
      lines.push(`  Status: ${endpoint.status} · secret ${endpoint.secretSet ? "set" : "not set"}`);
      lines.push(`  URL: ${endpoint.url}`);
    }

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }),
};

export const getWebhookEndpointDetailsTool = {
  name: toolsMetadata.get_webhook_endpoint_details.name,
  title: toolsMetadata.get_webhook_endpoint_details.title,
  description: toolsMetadata.get_webhook_endpoint_details.description,
  inputSchema: EndpointInput.shape,
  handler: toolHandler(EndpointInput.shape, async (input, { ctx }) => {
    const blocked = devOnlyError(ctx.options.devOnly, input.environment);
    if (blocked) return blocked;

    const projectRef = await ctx.getProjectRef({
      projectRef: input.projectRef,
      cwd: input.configPath,
    });
    const apiClient = await ctx.getApiClient({
      projectRef,
      environment: input.environment,
      scopes: ["read:webhooks"],
      branch: input.branch,
    });

    const endpoint = await apiClient.retrieveWebhookEndpoint(input.endpointId);
    const { setupPrompt, ...details } = endpoint;

    return {
      content: [
        { type: "text" as const, text: JSON.stringify(details, null, 2) },
        { type: "text" as const, text: setupPrompt },
      ],
    };
  }),
};

export const generateWebhookSecretTool = {
  name: toolsMetadata.generate_webhook_secret.name,
  title: toolsMetadata.generate_webhook_secret.title,
  description: toolsMetadata.generate_webhook_secret.description,
  inputSchema: EndpointInput.shape,
  handler: toolHandler(EndpointInput.shape, async (input, { ctx }) => {
    const blocked = devOnlyError(ctx.options.devOnly, input.environment);
    if (blocked) return blocked;

    const projectRef = await ctx.getProjectRef({
      projectRef: input.projectRef,
      cwd: input.configPath,
    });
    const apiClient = await ctx.getApiClient({
      projectRef,
      environment: input.environment,
      scopes: ["write:webhooks"],
      branch: input.branch,
    });

    const result = await apiClient.generateWebhookEndpointSecret(input.endpointId);

    return {
      content: [
        {
          type: "text" as const,
          text: `Generated a new signing secret for ${result.id}. It is shown once; give it to the provider and don't print, log or commit it.\n\n${result.secret}`,
        },
      ],
    };
  }),
};

export const setWebhookSecretTool = {
  name: toolsMetadata.set_webhook_secret.name,
  title: toolsMetadata.set_webhook_secret.title,
  description: toolsMetadata.set_webhook_secret.description,
  inputSchema: SetSecretInput.shape,
  handler: toolHandler(SetSecretInput.shape, async (input, { ctx }) => {
    const blocked = devOnlyError(ctx.options.devOnly, input.environment);
    if (blocked) return blocked;

    const projectRef = await ctx.getProjectRef({
      projectRef: input.projectRef,
      cwd: input.configPath,
    });
    const apiClient = await ctx.getApiClient({
      projectRef,
      environment: input.environment,
      scopes: ["write:webhooks"],
      branch: input.branch,
    });

    const result = await apiClient.setWebhookEndpointSecret(input.endpointId, {
      secret: input.secret,
    });

    return {
      content: [{ type: "text" as const, text: `Stored the signing secret for ${result.id}.` }],
    };
  }),
};

export const listWebhookDeliveriesTool = {
  name: toolsMetadata.list_webhook_deliveries.name,
  title: toolsMetadata.list_webhook_deliveries.title,
  description: toolsMetadata.list_webhook_deliveries.description,
  inputSchema: ListDeliveriesInput.shape,
  handler: toolHandler(ListDeliveriesInput.shape, async (input, { ctx }) => {
    const blocked = devOnlyError(ctx.options.devOnly, input.environment);
    if (blocked) return blocked;

    const projectRef = await ctx.getProjectRef({
      projectRef: input.projectRef,
      cwd: input.configPath,
    });
    const apiClient = await ctx.getApiClient({
      projectRef,
      environment: input.environment,
      scopes: ["read:webhooks"],
      branch: input.branch,
    });

    const result = await apiClient.listWebhookDeliveries({
      endpoint: input.endpointId,
      status: input.status,
      period: input.period ?? "7d",
      limit: input.limit ?? 20,
      after: input.cursor,
    });

    return {
      content: [
        { type: "text" as const, text: formatDeliveryList(result.data, result.pagination.next) },
      ],
    };
  }),
};

export const getWebhookDeliveryTool = {
  name: toolsMetadata.get_webhook_delivery.name,
  title: toolsMetadata.get_webhook_delivery.title,
  description: toolsMetadata.get_webhook_delivery.description,
  inputSchema: DeliveryInput.shape,
  handler: toolHandler(DeliveryInput.shape, async (input, { ctx }) => {
    const blocked = devOnlyError(ctx.options.devOnly, input.environment);
    if (blocked) return blocked;

    const projectRef = await ctx.getProjectRef({
      projectRef: input.projectRef,
      cwd: input.configPath,
    });
    const apiClient = await ctx.getApiClient({
      projectRef,
      environment: input.environment,
      scopes: ["read:webhooks"],
      branch: input.branch,
    });

    const delivery = await apiClient.retrieveWebhookDelivery(input.deliveryId);
    return { content: [{ type: "text" as const, text: formatDelivery(delivery) }] };
  }),
};

export const replayWebhookDeliveryTool = {
  name: toolsMetadata.replay_webhook_delivery.name,
  title: toolsMetadata.replay_webhook_delivery.title,
  description: toolsMetadata.replay_webhook_delivery.description,
  inputSchema: ReplayInput.shape,
  handler: toolHandler(ReplayInput.shape, async (input, { ctx }) => {
    const blocked = devOnlyError(ctx.options.devOnly, input.environment);
    if (blocked) return blocked;

    const projectRef = await ctx.getProjectRef({
      projectRef: input.projectRef,
      cwd: input.configPath,
    });
    const apiClient = await ctx.getApiClient({
      projectRef,
      environment: input.environment,
      scopes: ["write:webhooks", "trigger:tasks", "write:sessions"],
      branch: input.branch,
    });

    const result = await apiClient.replayWebhookDelivery(input.deliveryId, {
      targetId: input.targetId,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: `Replayed ${result.replayedFrom}${input.targetId ? ` to ${input.targetId}` : ""} as ${result.deliveryId}. Call get_webhook_delivery with ${result.deliveryId} once it has processed to see where it went.`,
        },
      ],
    };
  }),
};

const EVENT_CHARS = 4_000;

/** A page of deliveries, newest first, one line each. */
export function formatDeliveryList(
  deliveries: WebhookDeliveryListItem[],
  nextCursor: string | undefined
): string {
  if (deliveries.length === 0) {
    return nextCursor
      ? `No deliveries on this page. Call again with cursor "${nextCursor}" for older deliveries.`
      : "No deliveries match.";
  }

  const lines = ["## Webhook deliveries\n"];
  for (const d of deliveries) {
    const endpoint = d.endpoint ? ` · ${d.endpoint.declaredId}` : "";
    const test = d.isTest ? " · test" : "";
    lines.push(
      `- ${d.id} · ${d.status}${endpoint} · ${d.externalDeliveryId} · ${d.createdAt.toISOString()}${test}`
    );
  }
  if (nextCursor) lines.push(`\nMore deliveries: call again with cursor "${nextCursor}".`);
  return lines.join("\n");
}

/** One delivery: its outcome, where it went, and the event and headers it carried. */
export function formatDelivery(d: WebhookDeliveryObject): string {
  const lines = [`## Delivery ${d.id}\n`];
  lines.push(`Status: ${d.status}${d.isTest ? " (test)" : ""}`);
  if (d.endpoint) lines.push(`Endpoint: ${d.endpoint.declaredId} (${d.endpoint.id})`);
  lines.push(`External delivery id: ${d.externalDeliveryId}`);
  lines.push(`Received: ${d.createdAt.toISOString()}`);
  if (d.processedAt) lines.push(`Processed: ${d.processedAt.toISOString()}`);
  if (d.error) lines.push(`Error: ${d.error}`);
  if (d.filterReason) lines.push(`Filtered: ${d.filterReason}`);

  lines.push("\n### Targets");
  if (d.targets.length === 0) {
    lines.push("No subscribers or waiters to route to.");
  } else {
    for (const target of d.targets) lines.push(`- ${formatTarget(target)}`);
  }

  lines.push("\n### Event");
  if (d.event == null) {
    lines.push("Not captured.");
  } else {
    const json = JSON.stringify(d.event, null, 2);
    lines.push(
      "```json",
      json.length > EVENT_CHARS ? `${json.slice(0, EVENT_CHARS)}\n… (truncated)` : json,
      "```"
    );
  }

  const headers = Object.entries(d.headers ?? {});
  if (headers.length > 0) {
    lines.push("\n### Headers");
    for (const [name, value] of headers.sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`- ${name}: ${value}`);
    }
  }

  return lines.join("\n");
}

function formatTarget(t: WebhookDeliveryTargetObject): string {
  if (t.type === "waiter") {
    const w = t.waiters;
    const counts = w ? `${w.resumed} of ${w.matched} waiting runs resumed, ${w.failed} failed` : "";
    return `waiting runs · ${t.status}${counts ? ` · ${counts}` : ""}${t.error ? ` · ${t.error}` : ""}`;
  }
  const parts = [`${t.id} (${t.type})`, t.status];
  if (t.runId) parts.push(`run ${t.runId}`);
  if (t.sessionId) parts.push(`session ${t.sessionId}`);
  if (t.reason) parts.push(t.reason);
  if (t.error) parts.push(t.error);
  return parts.join(" · ");
}

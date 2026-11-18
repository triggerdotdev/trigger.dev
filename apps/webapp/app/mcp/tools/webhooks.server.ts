import {
  ApiWebhookDeliveryListPresenter,
  ApiWebhookDeliveryListSearchParams,
  findWebhookDeliveryResource,
} from "~/presenters/v3/ApiWebhookDeliveryPresenter.server";
import {
  ApiWebhookEndpointListPresenter,
  findWebhookEndpointResource,
} from "~/presenters/v3/ApiWebhookEndpointPresenter.server";
import { fenceUntrusted } from "../gate/fence.server";
import type { McpToolDefinition } from "../registry.server";
import { defineReadTool, errorResult, resolveToolEnvironment, textResult } from "./define.server";
import { fenceSetupPrompt, formatDelivery, formatDeliveryList } from "./format/webhooks";
import { CommonProjectsInput } from "./schemas/common";
import { DeliveryInput, EndpointInput, ListDeliveriesInput } from "./schemas/webhooks";

type ResourceAuth = Parameters<typeof findWebhookDeliveryResource>[0];

const auth = { action: "read", subject: "webhooks" } as const;

export const webhooksTools: McpToolDefinition[] = [
  defineReadTool({
    name: "list_webhook_endpoints",
    title: "List Webhook Endpoints",
    description:
      "List the hosted webhook endpoints in the project environment: each endpoint's id (wh_...), declared id, provider source, status, webhook URL and whether its signing secret is set. Use get_webhook_endpoint_details for an endpoint's subscribers and setup prompt.",
    shape: CommonProjectsInput.shape,
    auth,
    run: async (input, ctx) => {
      const environment = await resolveToolEnvironment(ctx);
      if (!environment) return errorResult("Not authorized");

      const result = await new ApiWebhookEndpointListPresenter().call(environment, {
        "filter[webhook]": undefined,
      });
      if (result.data.length === 0) {
        return textResult(
          `No webhook endpoints in ${input.environment}. Endpoints are declared with webhooks.endpoint.define() and appear after the next dev session or deploy.`
        );
      }

      const lines = ["## Webhook endpoints\n"];
      for (const endpoint of result.data) {
        const tenant = endpoint.tenantId
          ? ` · tenant ${fenceUntrusted(endpoint.tenantId, "webhook-endpoint")}`
          : "";
        lines.push(`- **${endpoint.declaredId}** (${endpoint.id}) · ${endpoint.source}${tenant}`);
        lines.push(
          `  Status: ${endpoint.status} · secret ${endpoint.secretSet ? "set" : "not set"}`
        );
        lines.push(`  URL: ${fenceUntrusted(endpoint.url, "webhook-endpoint")}`);
      }
      return textResult(lines.join("\n"));
    },
  }),
  defineReadTool({
    name: "get_webhook_endpoint_details",
    title: "Get Webhook Endpoint Details",
    description:
      "Get a hosted webhook endpoint's details, its subscribers (with the filters that decide which events they accept) and its setup prompt: step-by-step instructions for registering the endpoint with its provider and handling the signing secret. Follow the setup prompt when asked to connect or configure a webhook.",
    shape: EndpointInput.shape,
    auth,
    run: async (input, ctx) => {
      const environment = await resolveToolEnvironment(ctx);
      if (!environment) return errorResult("Not authorized");

      const endpoint = await findWebhookEndpointResource(
        { environment } as ResourceAuth,
        input.endpointId
      );
      if (!endpoint) return errorResult("Webhook endpoint not found");

      const { setupPrompt, ...details } = endpoint;
      return {
        content: [
          {
            type: "text",
            text: fenceUntrusted(JSON.stringify(details, null, 2), "webhook-endpoint"),
          },
          { type: "text", text: fenceSetupPrompt(setupPrompt, endpoint) },
        ],
      };
    },
  }),
  defineReadTool({
    name: "list_webhook_deliveries",
    title: "List Webhook Deliveries",
    description:
      "List recent webhook deliveries (the verified events providers sent), newest first, optionally for one endpoint and only some statuses: succeeded, failed, filtered (no subscriber's filter accepted it), pending or processing. Use this to find out whether a provider's event arrived, then get_webhook_delivery for where it went.",
    shape: ListDeliveriesInput.shape,
    auth,
    run: async (input, ctx) => {
      const environment = await resolveToolEnvironment(ctx);
      if (!environment) return errorResult("Not authorized");

      const search = ApiWebhookDeliveryListSearchParams.safeParse({
        "filter[endpoint]": input.endpointId,
        "filter[status]": input.status?.join(","),
        "filter[period]": input.period ?? "7d",
        "page[size]": input.limit ?? 20,
        "page[after]": input.cursor,
      });
      if (!search.success) return errorResult("Invalid query");

      const result = await new ApiWebhookDeliveryListPresenter().call(environment, search.data);
      return textResult(formatDeliveryList(result.data, result.pagination.next));
    },
  }),
  defineReadTool({
    name: "get_webhook_delivery",
    title: "Get Webhook Delivery",
    description:
      "Get one webhook delivery: its status and error, what happened at each subscriber (the run or session it triggered, or why its filter skipped the event), how many waiting runs it resumed, and the event body and headers it carried. Use this to debug why a webhook did or didn't trigger a task.",
    shape: DeliveryInput.shape,
    auth,
    run: async (input, ctx) => {
      const environment = await resolveToolEnvironment(ctx);
      if (!environment) return errorResult("Not authorized");

      const delivery = await findWebhookDeliveryResource(
        { environment } as ResourceAuth,
        input.deliveryId
      );
      if (!delivery) return errorResult("Webhook delivery not found");

      return textResult(formatDelivery(delivery));
    },
  }),
];

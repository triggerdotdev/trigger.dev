import { type WebhookEndpointDetailObject, type WebhookEndpointObject } from "@trigger.dev/core/v3";
import {
  type Prisma,
  type RuntimeEnvironment,
  type WebhookEndpointStatus,
} from "@trigger.dev/database";
import { z } from "zod";
import { boundedIn, webhookReplica } from "~/db.server";
import { type ApiAuthenticationResultSuccess } from "~/services/apiAuth.server";
import { webhookIngressUrl } from "~/utils/webhookIngressUrl.server";
import { webhookEndpointSubscribers } from "~/v3/webhookSetupPrompt";
import { buildWebhookSetupPrompt, webhookSetupPromptSelect } from "~/v3/webhookSetupPrompt.server";
import { BasePresenter } from "./basePresenter.server";

const DB_STATUS_TO_API: Record<WebhookEndpointStatus, WebhookEndpointObject["status"]> = {
  ACTIVE: "active",
  INACTIVE: "inactive",
  DELETING: "deleting",
};

// The columns needed to build the public API object.
const endpointSelect = {
  friendlyId: true,
  opaqueId: true,
  declaredId: true,
  source: true,
  status: true,
  secretProvisioning: true,
  signingSecretKey: true,
  endpointTenantId: true,
  endpointExternalRef: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.WebhookEndpointSelect;

type EndpointRow = Prisma.WebhookEndpointGetPayload<{ select: typeof endpointSelect }>;

function toApiEndpoint(endpoint: EndpointRow): WebhookEndpointObject {
  return {
    id: endpoint.friendlyId,
    declaredId: endpoint.declaredId,
    source: endpoint.source,
    status: DB_STATUS_TO_API[endpoint.status],
    secretProvisioning:
      (endpoint.secretProvisioning as WebhookEndpointObject["secretProvisioning"]) ?? "either",
    secretSet: endpoint.signingSecretKey != null && endpoint.signingSecretKey !== "",
    tenantId: endpoint.endpointTenantId === "" ? null : endpoint.endpointTenantId,
    externalRef: endpoint.endpointExternalRef === "" ? null : endpoint.endpointExternalRef,
    url: webhookIngressUrl(endpoint.opaqueId),
    createdAt: endpoint.createdAt,
    updatedAt: endpoint.updatedAt,
  };
}

export const ApiWebhookEndpointListSearchParams = z.object({
  "filter[webhook]": z
    .string()
    .optional()
    .transform((value) => (value ? value.split(",") : undefined)),
});
export type ApiWebhookEndpointListSearchParams = z.infer<typeof ApiWebhookEndpointListSearchParams>;

export class ApiWebhookEndpointListPresenter extends BasePresenter {
  public async call(
    environment: Pick<RuntimeEnvironment, "id">,
    searchParams: ApiWebhookEndpointListSearchParams
  ): Promise<{ data: WebhookEndpointObject[] }> {
    return this.trace("call", async () => {
      const endpoints = await webhookReplica.webhookEndpoint.findMany({
        where: {
          runtimeEnvironmentId: environment.id,
          ...(searchParams["filter[webhook]"]
            ? { declaredId: { in: boundedIn(searchParams["filter[webhook]"]) } }
            : {}),
        },
        select: endpointSelect,
        orderBy: [{ declaredId: "asc" }, { createdAt: "desc" }],
      });

      return { data: endpoints.map(toApiEndpoint) };
    });
  }
}

class ApiWebhookEndpointPresenter extends BasePresenter {
  public async call(
    environment: ApiAuthenticationResultSuccess["environment"],
    endpointFriendlyId: string
  ): Promise<WebhookEndpointDetailObject | undefined> {
    return this.trace("call", async () => {
      const endpoint = await webhookReplica.webhookEndpoint.findFirst({
        // friendlyId is globally unique; scope to the env so a foreign id 404s.
        where: { friendlyId: endpointFriendlyId, runtimeEnvironmentId: environment.id },
        select: { ...endpointSelect, ...webhookSetupPromptSelect },
      });
      if (!endpoint) return undefined;

      return {
        ...toApiEndpoint(endpoint),
        subscribers: webhookEndpointSubscribers(endpoint.routingTargets),
        setupPrompt: buildWebhookSetupPrompt(endpoint, environment),
      };
    });
  }
}

export function findWebhookEndpointResource(
  authentication: ApiAuthenticationResultSuccess,
  endpointId: string
): Promise<WebhookEndpointDetailObject | undefined> {
  return new ApiWebhookEndpointPresenter().call(authentication.environment, endpointId);
}

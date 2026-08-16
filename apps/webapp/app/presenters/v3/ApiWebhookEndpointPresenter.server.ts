import { type WebhookEndpointObject } from "@trigger.dev/core/v3";
import {
  type Prisma,
  type RuntimeEnvironment,
  type WebhookEndpointStatus,
} from "@trigger.dev/database";
import { z } from "zod";
import { boundedIn, webhookReplica } from "~/db.server";
import { type ApiAuthenticationResultSuccess } from "~/services/apiAuth.server";
import { webhookIngressUrl } from "~/utils/webhookIngressUrl.server";
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
  handlerWebhookId: true,
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
    webhook: endpoint.handlerWebhookId,
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
            ? { handlerWebhookId: { in: boundedIn(searchParams["filter[webhook]"]) } }
            : {}),
        },
        select: endpointSelect,
        orderBy: [{ handlerWebhookId: "asc" }, { createdAt: "desc" }],
      });

      return { data: endpoints.map(toApiEndpoint) };
    });
  }
}

export class ApiWebhookEndpointPresenter extends BasePresenter {
  public async call(
    environmentId: string,
    endpointFriendlyId: string
  ): Promise<WebhookEndpointObject | undefined> {
    return this.trace("call", async () => {
      const endpoint = await webhookReplica.webhookEndpoint.findFirst({
        // friendlyId is globally unique; scope to the env so a foreign id 404s.
        where: { friendlyId: endpointFriendlyId, runtimeEnvironmentId: environmentId },
        select: endpointSelect,
      });

      return endpoint ? toApiEndpoint(endpoint) : undefined;
    });
  }
}

export function findWebhookEndpointResource(
  authentication: ApiAuthenticationResultSuccess,
  endpointId: string
): Promise<WebhookEndpointObject | undefined> {
  return new ApiWebhookEndpointPresenter().call(authentication.environment.id, endpointId);
}

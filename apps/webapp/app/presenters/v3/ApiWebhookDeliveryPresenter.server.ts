import {
  type WebhookDeliveryListItem as ApiWebhookDeliveryListItem,
  type WebhookDeliveryObject,
  type WebhookDeliveryTargetApiStatus,
  type WebhookDeliveryTargetObject,
  type WebhookDeliveryTargetStatus,
} from "@trigger.dev/core/v3";
import { type WebhookDeliveryStatus } from "@trigger.dev/database";
import { z } from "zod";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { type ApiAuthenticationResultSuccess } from "~/services/apiAuth.server";
import { CoercedDate } from "~/utils/zod";
import { BasePresenter } from "./basePresenter.server";
import {
  type EnvironmentDeliveryListItem,
  WebhookDeliveriesListPresenter,
} from "./WebhookDeliveriesListPresenter.server";
import {
  WebhookDeliveryDetailPresenter,
  type WebhookDeliveryTargetView,
} from "./WebhookDeliveryDetailPresenter.server";

const DB_STATUS_TO_API: Record<WebhookDeliveryStatus, ApiWebhookDeliveryListItem["status"]> = {
  PENDING: "pending",
  PROCESSING: "processing",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  FILTERED: "filtered",
  UNMATCHED: "unmatched",
};

// API status -> DB status (for the filter).
const API_STATUS_TO_DB: Record<string, WebhookDeliveryStatus> = {
  pending: "PENDING",
  processing: "PROCESSING",
  succeeded: "SUCCEEDED",
  failed: "FAILED",
  filtered: "FILTERED",
  unmatched: "UNMATCHED",
};

const TARGET_STATUS_TO_API: Record<WebhookDeliveryTargetStatus, WebhookDeliveryTargetApiStatus> = {
  PENDING: "pending",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  FILTERED: "filtered",
};

function toApiListItem(d: EnvironmentDeliveryListItem): ApiWebhookDeliveryListItem {
  return {
    id: d.friendlyId,
    endpoint: d.endpoint,
    status: DB_STATUS_TO_API[d.status],
    externalDeliveryId: d.externalDeliveryId,
    isTest: d.isTest,
    createdAt: d.createdAt,
    processedAt: d.processedAt,
  };
}

function toApiTarget(t: WebhookDeliveryTargetView): WebhookDeliveryTargetObject {
  return {
    id: t.id,
    type: t.type,
    status: TARGET_STATUS_TO_API[t.status],
    reason: t.reason ?? null,
    error: t.error ?? null,
    runId: t.run?.friendlyId ?? null,
    sessionId: t.session?.friendlyId ?? null,
    waiters: t.waiters ?? null,
  };
}

export const ApiWebhookDeliveryListSearchParams = z.object({
  "page[size]": z.coerce.number().int().positive().min(1).max(100).optional(),
  "page[after]": z.string().optional(),
  "page[before]": z.string().optional(),
  /** Declared endpoint ids or `wh_` ids, comma-separated. */
  "filter[endpoint]": z
    .string()
    .optional()
    .transform((value) => (value ? value.split(",") : undefined)),
  "filter[status]": z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (!value) return undefined;
      const statuses = value.split(",");
      const invalid = statuses.filter((s) => !Object.hasOwn(API_STATUS_TO_DB, s));
      if (invalid.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid status values: ${invalid.join(
            ", "
          )}. Allowed: ${Object.keys(API_STATUS_TO_DB).join(", ")}.`,
        });
        return z.NEVER;
      }
      return Array.from(new Set(statuses.map((s) => API_STATUS_TO_DB[s])));
    }),
  "filter[period]": z.string().optional(),
  "filter[from]": CoercedDate,
  "filter[to]": CoercedDate,
});
export type ApiWebhookDeliveryListSearchParams = z.infer<typeof ApiWebhookDeliveryListSearchParams>;

export class ApiWebhookDeliveryListPresenter extends BasePresenter {
  public async call(
    environment: { id: string; projectId: string; organizationId: string },
    searchParams: ApiWebhookDeliveryListSearchParams
  ): Promise<{
    data: ApiWebhookDeliveryListItem[];
    pagination: { next?: string; previous?: string };
  }> {
    return this.trace("call", async () => {
      const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
        environment.organizationId,
        "standard"
      );

      const presenter = new WebhookDeliveriesListPresenter(this._replica, clickhouse);
      const result = await presenter.call({
        organizationId: environment.organizationId,
        projectId: environment.projectId,
        environmentId: environment.id,
        endpoints: searchParams["filter[endpoint]"],
        statuses: searchParams["filter[status]"],
        period: searchParams["filter[period]"],
        from: searchParams["filter[from]"]?.getTime(),
        to: searchParams["filter[to]"]?.getTime(),
        cursor: searchParams["page[after]"] ?? searchParams["page[before]"],
        direction: searchParams["page[before]"] ? "backward" : "forward",
        pageSize: searchParams["page[size]"],
      });

      return { data: result.deliveries.map(toApiListItem), pagination: result.pagination };
    });
  }
}

class ApiWebhookDeliveryPresenter extends BasePresenter {
  public async call(
    environment: { id: string; projectId: string; organizationId: string },
    deliveryFriendlyId: string
  ): Promise<WebhookDeliveryObject | undefined> {
    return this.trace("call", async () => {
      const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
        environment.organizationId,
        "standard"
      );

      const presenter = new WebhookDeliveryDetailPresenter(this._replica, clickhouse);
      const d = await presenter.call({
        organizationId: environment.organizationId,
        projectId: environment.projectId,
        environmentId: environment.id,
        deliveryFriendlyId,
      });

      if (!d) return undefined;

      return {
        id: d.friendlyId,
        endpoint: d.webhook
          ? { id: d.webhook.endpointFriendlyId, declaredId: d.webhook.slug }
          : null,
        status: DB_STATUS_TO_API[d.status],
        externalDeliveryId: d.externalDeliveryId,
        isTest: d.isTest,
        createdAt: d.createdAt,
        processedAt: d.processedAt,
        idempotencyKey: d.idempotencyKey,
        event: d.parsedEvent ?? null,
        headers: (d.headers as Record<string, string> | null) ?? null,
        rawBodyHash: d.rawBodyHash,
        error: d.errorMessage,
        filterReason: d.filterReason,
        targets: d.targets.map(toApiTarget),
        updatedAt: d.updatedAt,
      };
    });
  }
}

export function findWebhookDeliveryResource(
  authentication: ApiAuthenticationResultSuccess,
  deliveryId: string
): Promise<WebhookDeliveryObject | undefined> {
  const env = authentication.environment;
  return new ApiWebhookDeliveryPresenter().call(
    { id: env.id, projectId: env.projectId, organizationId: env.organizationId },
    deliveryId
  );
}

import {
  type WebhookDeliveryListItem as ApiWebhookDeliveryListItem,
  type WebhookDeliveryObject,
} from "@trigger.dev/core/v3";
import { type WebhookDeliveryStatus } from "@trigger.dev/database";
import { z } from "zod";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { type ApiAuthenticationResultSuccess } from "~/services/apiAuth.server";
import { CoercedDate } from "~/utils/zod";
import { BasePresenter } from "./basePresenter.server";
import { WebhookDeliveriesListPresenter } from "./WebhookDeliveriesListPresenter.server";
import { WebhookDeliveryDetailPresenter } from "./WebhookDeliveryDetailPresenter.server";
import { type WebhookDeliveryListItem } from "./WebhookDetailPresenter.server";

const DB_STATUS_TO_API: Record<WebhookDeliveryStatus, ApiWebhookDeliveryListItem["status"]> = {
  PENDING: "pending",
  PROCESSING: "processing",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  FILTERED: "filtered",
};

// API status -> DB status (for the filter).
const API_STATUS_TO_DB: Record<string, WebhookDeliveryStatus> = {
  pending: "PENDING",
  processing: "PROCESSING",
  succeeded: "SUCCEEDED",
  failed: "FAILED",
  filtered: "FILTERED",
};

function toApiListItem(d: WebhookDeliveryListItem): ApiWebhookDeliveryListItem {
  return {
    id: d.friendlyId,
    webhook: d.webhook?.slug ?? null,
    status: DB_STATUS_TO_API[d.status],
    externalDeliveryId: d.externalDeliveryId,
    runId: d.run?.friendlyId ?? null,
    createdAt: d.createdAt,
    processedAt: d.processedAt,
  };
}

export const ApiWebhookDeliveryListSearchParams = z.object({
  "page[size]": z.coerce.number().int().positive().min(1).max(100).optional(),
  "page[after]": z.string().optional(),
  "page[before]": z.string().optional(),
  "filter[webhook]": z
    .string()
    .optional()
    .transform((value) => (value ? value.split(",") : undefined)),
  "filter[status]": z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (!value) return undefined;
      const statuses = value.split(",");
      const invalid = statuses.filter(
        (s) => !Object.prototype.hasOwnProperty.call(API_STATUS_TO_DB, s)
      );
      if (invalid.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid status values: ${invalid.join(
            ", "
          )}. Allowed: pending, processing, succeeded, failed.`,
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
        webhooks: searchParams["filter[webhook]"],
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

export class ApiWebhookDeliveryPresenter extends BasePresenter {
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
        webhook: d.webhook?.slug ?? null,
        status: DB_STATUS_TO_API[d.status],
        externalDeliveryId: d.externalDeliveryId,
        runId: d.run?.friendlyId ?? null,
        createdAt: d.createdAt,
        processedAt: d.processedAt,
        idempotencyKey: d.idempotencyKey,
        event: d.parsedEvent ?? null,
        headers: (d.headers as Record<string, string> | null) ?? null,
        rawBodyHash: d.rawBodyHash,
        error: d.errorMessage,
        filterReason: d.filterReason,
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

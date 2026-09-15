import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson } from "remix-typedjson";
import { z } from "zod";
import { type WebhookDeliveryStatus } from "@trigger.dev/database";
import { $replica, webhookReplica } from "~/db.server";
import { WebhookDeliveriesListPresenter } from "~/presenters/v3/WebhookDeliveriesListPresenter.server";
import { resolveDeliveryRunTargets } from "~/presenters/v3/WebhookDetailPresenter.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { loadProjectEnvironmentFromRequest } from "~/services/loadProjectEnvironmentFromRequest.server";
import { requireUser } from "~/services/session.server";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { flag } from "~/v3/featureFlags.server";
import {
  type ListedWebhookDelivery,
  webhookDeliveriesRepository,
} from "~/services/webhookDeliveriesRepository/webhookDeliveriesRepository.server";

const deliveryIdsQueryParam = z
  .string()
  .optional()
  .transform((value) => {
    const ids =
      value
        ?.split(",")
        .map((id) => id.trim())
        .filter(Boolean) ?? [];
    return [...new Set(ids)].slice(0, 100);
  });

const SearchParamsSchema = z.object({
  webhookEndpointId: z.string().optional(),
  deliveryIds: deliveryIdsQueryParam,
  includeNewDeliveries: z
    .string()
    .optional()
    .transform((value) => value === "true"),
  since: z.coerce.number().optional(),
  to: z.coerce.number().optional(),
});

const KNOWN_DELIVERY_STATUSES: readonly WebhookDeliveryStatus[] = [
  "PENDING",
  "PROCESSING",
  "SUCCEEDED",
  "FAILED",
  "FILTERED",
];

/**
 * Parse the deliveries-list filters so the new-deliveries count applies the same ones the list is
 * showing (its badge must never count events the filtered list would exclude). Mirrors the top-level
 * list's param parsing: repeated or CSV `statuses`, repeated `webhooks`, `deliveryId`, `runId`, `test`.
 */
function parseListFilters(searchParams: URLSearchParams) {
  const statusValues = searchParams
    .getAll("statuses")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value): value is WebhookDeliveryStatus =>
      KNOWN_DELIVERY_STATUSES.includes(value as WebhookDeliveryStatus)
    );
  const webhooks = searchParams.getAll("webhooks").filter((value) => value.length > 0);
  const testParam = searchParams.get("test");
  return {
    statuses: statusValues.length > 0 ? statusValues : undefined,
    webhooks: webhooks.length > 0 ? webhooks : undefined,
    deliveryId: searchParams.get("deliveryId") ?? undefined,
    runId: searchParams.get("runId") ?? undefined,
    isTest: testParam === "only" ? true : testParam === "hide" ? false : undefined,
  };
}

export type LiveDeliveryFields = {
  friendlyId: string;
  status: ListedWebhookDelivery["status"];
  runId: string | null;
  run: { friendlyId: string } | null;
  session: { friendlyId: string; externalId: string | null } | null;
  errorMessage: string | null;
  processedAt: Date | null;
};

export function mapDeliveryToLiveFields(
  delivery: ListedWebhookDelivery,
  targets: {
    runFriendlyIdById: Map<string, string>;
    sessionByRunId: Map<string, { friendlyId: string; externalId: string | null }>;
  }
): LiveDeliveryFields {
  const runFriendlyId = delivery.runId ? targets.runFriendlyIdById.get(delivery.runId) : undefined;
  return {
    friendlyId: delivery.friendlyId,
    status: delivery.status,
    runId: delivery.runId,
    run: runFriendlyId ? { friendlyId: runFriendlyId } : null,
    session: delivery.runId ? (targets.sessionByRunId.get(delivery.runId) ?? null) : null,
    errorMessage: delivery.errorMessage,
    processedAt: delivery.processedAt,
  };
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const { webhookEndpointId, deliveryIds, includeNewDeliveries, since, to } =
    SearchParamsSchema.parse(Object.fromEntries(url.searchParams));

  const newDeliveriesSince = includeNewDeliveries && since !== undefined ? since : undefined;

  if (deliveryIds.length === 0 && newDeliveriesSince === undefined) {
    return typedjson({ deliveries: [] });
  }

  const { project, environment } = await loadProjectEnvironmentFromRequest(request, params);

  const user = await requireUser(request);
  if (!user.admin && !user.isImpersonating) {
    const org = await $replica.organization.findFirst({
      where: { id: project.organizationId },
      select: { featureFlags: true },
    });
    const enabled = await flag({
      key: FEATURE_FLAG.hasWebhooksAccess,
      defaultValue: false,
      overrides: (org?.featureFlags as Record<string, unknown>) ?? {},
    });
    if (!enabled) throw new Response("Not found", { status: 404 });
  }

  const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
    project.organizationId,
    "standard"
  );
  const repository = webhookDeliveriesRepository({ clickhouse, prisma: webhookReplica });

  const [deliveries, newDeliveriesResult] = await Promise.all([
    deliveryIds.length > 0
      ? repository
          .getDeliveriesByFriendlyIds({
            organizationId: project.organizationId,
            projectId: project.id,
            environmentId: environment.id,
            friendlyIds: deliveryIds,
          })
          .then(async (rows) => {
            const targets = await resolveDeliveryRunTargets($replica, rows);
            return rows.map((row) => mapDeliveryToLiveFields(row, targets));
          })
      : Promise.resolve([]),
    newDeliveriesSince !== undefined
      ? (async () => {
          const filters = parseListFilters(url.searchParams);
          const count = await new WebhookDeliveriesListPresenter(
            $replica,
            clickhouse
          ).countNewDeliveries({
            organizationId: project.organizationId,
            projectId: project.id,
            environmentId: environment.id,
            webhookEndpointId,
            ...filters,
            since: newDeliveriesSince,
            to,
          });
          return { count, since: newDeliveriesSince };
        })()
      : Promise.resolve(undefined),
  ]);

  if (newDeliveriesResult) {
    return typedjson({ deliveries, ...newDeliveriesResult });
  }

  return typedjson({ deliveries });
}

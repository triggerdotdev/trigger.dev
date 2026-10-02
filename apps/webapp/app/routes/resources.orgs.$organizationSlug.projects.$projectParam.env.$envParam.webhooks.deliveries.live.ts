import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson } from "remix-typedjson";
import { z } from "zod";
import { $replica, webhookReplica } from "~/db.server";
import { WebhookDeliveriesListPresenter } from "~/presenters/v3/WebhookDeliveriesListPresenter.server";
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

export type LiveDeliveryFields = {
  friendlyId: string;
  status: ListedWebhookDelivery["status"];
  errorMessage: string | null;
  processedAt: Date | null;
};

function mapDeliveryToLiveFields(delivery: ListedWebhookDelivery): LiveDeliveryFields {
  return {
    friendlyId: delivery.friendlyId,
    status: delivery.status,
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
          .then((rows) => rows.map(mapDeliveryToLiveFields))
      : Promise.resolve([]),
    newDeliveriesSince !== undefined
      ? (async () => {
          const count = await new WebhookDeliveriesListPresenter(
            $replica,
            clickhouse
          ).countNewDeliveries({
            organizationId: project.organizationId,
            projectId: project.id,
            environmentId: environment.id,
            webhookEndpointId,
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

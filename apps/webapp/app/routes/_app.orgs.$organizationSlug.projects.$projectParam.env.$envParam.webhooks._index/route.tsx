import {
  type MetaFunction,
  useNavigation,
  useRevalidator,
  useSearchParams,
} from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import type { WebhookDeliveryStatus } from "@trigger.dev/database";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody } from "~/components/layout/AppLayout";
import { DirectionSchema, ListPagination } from "~/components/ListPagination";
import { Button } from "~/components/primitives/Buttons";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { PulsingDot } from "~/components/primitives/PulsingDot";
import { DeliveriesTable } from "~/components/webhookDeliveries/v1/DeliveriesTable";
import { useDeliveriesLiveReload } from "~/components/webhookDeliveries/v1/useDeliveriesLiveReload";
import {
  type PossibleWebhook,
  WebhookDeliveryFilters,
} from "~/components/webhookDeliveries/v1/WebhookDeliveryFilters";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { type WebhookDeliveryListItem } from "~/presenters/v3/WebhookDetailPresenter.server";
import { $replica, webhookReplica } from "~/db.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { WebhookDeliveriesListPresenter } from "~/presenters/v3/WebhookDeliveriesListPresenter.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { requireUser } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { parseFiniteInt } from "~/utils/searchParams";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { flag } from "~/v3/featureFlags.server";

const VALID_DELIVERY_STATUSES = new Set<string>([
  "PENDING",
  "PROCESSING",
  "SUCCEEDED",
  "FAILED",
  "FILTERED",
]);

// Accepts repeated `statuses` params or a single CSV value; drops anything that
// isn't one of the four WebhookDeliveryStatus values.
function parseStatuses(searchParams: URLSearchParams): WebhookDeliveryStatus[] | undefined {
  const raw = searchParams
    .getAll("statuses")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => VALID_DELIVERY_STATUSES.has(value)) as WebhookDeliveryStatus[];

  return raw.length > 0 ? Array.from(new Set(raw)) : undefined;
}

function parseRepeated(searchParams: URLSearchParams, key: string): string[] | undefined {
  const values = searchParams.getAll(key).filter((value) => value.length > 0);
  return values.length > 0 ? values : undefined;
}

export const meta: MetaFunction = () => [{ title: "Deliveries | Webhooks | Trigger.dev" }];

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const userId = user.id;
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) throw new Response("Project not found", { status: 404 });
  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) throw new Response("Environment not found", { status: 404 });

  // Feature gate: enabled by a global FeatureFlag OR a per-org override; admins/impersonators
  // always pass. flag() resolves org override -> global -> default(false).
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

  const url = new URL(request.url);
  const periodParam = url.searchParams.get("period") ?? undefined;
  const from = parseFiniteInt(url.searchParams.get("from"));
  const to = parseFiniteInt(url.searchParams.get("to"));
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const directionRaw = url.searchParams.get("direction") ?? undefined;
  const direction = directionRaw ? DirectionSchema.parse(directionRaw) : undefined;

  const statuses = parseStatuses(url.searchParams);
  const webhooks = parseRepeated(url.searchParams, "webhooks");
  const deliveryId = url.searchParams.get("deliveryId") ?? undefined;
  const runId = url.searchParams.get("runId") ?? undefined;
  const testParam = url.searchParams.get("test");
  const isTest = testParam === "only" ? true : testParam === "hide" ? false : undefined;

  // Default to the last 7 days when no explicit window is set, matching the TimeFilter default.
  const hasExplicitWindow = Boolean(periodParam || from || to);
  const period = periodParam ?? (hasExplicitWindow ? undefined : "7d");

  const hasFilters = Boolean(
    statuses || webhooks || deliveryId || runId || testParam || hasExplicitWindow
  );

  // Distinct handler slugs (one row per handlerWebhookId) for the Webhook picker.
  const endpoints = await webhookReplica.webhookEndpoint.findMany({
    where: { runtimeEnvironmentId: environment.id },
    select: { handlerWebhookId: true, source: true },
    distinct: ["handlerWebhookId"],
  });
  const possibleWebhooks: PossibleWebhook[] = endpoints.map((e) => ({
    slug: e.handlerWebhookId,
    source: e.source,
  }));

  const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
    project.organizationId,
    "standard"
  );

  const presenter = new WebhookDeliveriesListPresenter($replica, clickhouse);
  const list = await presenter
    .call({
      organizationId: project.organizationId,
      projectId: project.id,
      environmentId: environment.id,
      webhooks,
      statuses,
      deliveryId,
      runId,
      isTest,
      period,
      from,
      to,
      cursor,
      direction,
    })
    .catch(() => ({ deliveries: [], pagination: {} }));

  return typedjson({
    deliveries: list.deliveries,
    pagination: list.pagination,
    possibleWebhooks,
    hasFilters,
  });
};

export default function Page() {
  const { deliveries, pagination, possibleWebhooks, hasFilters } =
    useTypedLoaderData<typeof loader>();

  const { visibleDeliveries, newDeliveriesButton } = useLiveDeliveries(deliveries);

  return (
    <>
      <NavBar>
        <PageTitle title="Webhook deliveries" />
      </NavBar>
      <PageBody scrollable={false}>
        <div className="grid h-full max-h-full grid-rows-[auto_1fr] overflow-hidden">
          <div className="flex items-start justify-between gap-x-2 p-2">
            <WebhookDeliveryFilters possibleWebhooks={possibleWebhooks} defaultPeriod="7d" />
            {/* The new-deliveries button sits inline, immediately left of the pager */}
            <div className="flex items-center gap-x-2">
              {newDeliveriesButton}
              <ListPagination list={{ pagination }} />
            </div>
          </div>
          {/* Sits directly in the 1fr row, like the runs, sessions and batches lists. No
              stickyHeader: that switches Table's container to overflow-visible, which stops it
              being the scroll container. The header is sticky either way (TableHeader always sets
              sticky top-0), and the other webhook tables only pass it because an ancestor scrolls. */}
          <DeliveriesTable deliveries={visibleDeliveries} showWebhook hasFilters={hasFilters} />
        </div>
      </PageBody>
    </>
  );
}

function useLiveDeliveries(deliveries: WebhookDeliveryListItem[]) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const [searchParams, setSearchParams] = useSearchParams();

  const { visibleDeliveries, showNewDeliveriesBanner, newDeliveriesCount, dismissNewDeliveries } =
    useDeliveriesLiveReload({
      deliveries,
      isLoading: navigation.state !== "idle",
      organizationSlug: organization.slug,
      projectSlug: project.slug,
      environmentSlug: environment.slug,
    });

  const onClickShowNewDeliveries = () => {
    dismissNewDeliveries();
    if (searchParams.has("cursor") || searchParams.has("direction")) {
      setSearchParams((prev) => {
        prev.delete("cursor");
        prev.delete("direction");
        return prev;
      });
      return;
    }
    revalidator.revalidate();
  };

  const newDeliveriesButton = showNewDeliveriesBanner ? (
    <span className="flex duration-150 animate-in fade-in-0">
      <Button
        variant="secondary/small"
        className="text-text-bright"
        onClick={onClickShowNewDeliveries}
        LeadingIcon={<PulsingDot className="h-2 w-2" />}
        tooltip="Refresh to see new deliveries"
        aria-label="New deliveries received. Refresh to see them."
      >
        {newDeliveriesCount >= 100
          ? "99+ new deliveries"
          : `${newDeliveriesCount} new ${newDeliveriesCount === 1 ? "delivery" : "deliveries"}`}
      </Button>
    </span>
  ) : null;

  return { visibleDeliveries, newDeliveriesButton };
}

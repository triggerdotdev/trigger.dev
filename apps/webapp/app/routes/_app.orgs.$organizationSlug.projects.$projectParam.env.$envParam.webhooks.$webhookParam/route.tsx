import { BookOpenIcon } from "@heroicons/react/24/solid";
import {
  Link,
  type MetaFunction,
  useNavigation,
  useRevalidator,
  useSearchParams,
} from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { type ReactNode, Suspense, useMemo, useState } from "react";
import { TypedAwait, typeddefer, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { WebhookIcon } from "~/assets/icons/WebhookIcon";
import { PageBody } from "~/components/layout/AppLayout";
import { DirectionSchema, ListPagination } from "~/components/ListPagination";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Card } from "~/components/primitives/charts/Card";
import { Chart, type ChartConfig } from "~/components/primitives/charts/ChartCompound";
import { CopyableText } from "~/components/primitives/CopyableText";
import { DateTime } from "~/components/primitives/DateTime";
import { Header2 } from "~/components/primitives/Headers";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import * as Property from "~/components/primitives/PropertyTable";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import { PulsingDot } from "~/components/primitives/PulsingDot";
import { Spinner } from "~/components/primitives/Spinner";
import { TabButton, TabContainer } from "~/components/primitives/Tabs";
import {
  RunsListErrorState,
  RunsListErrorStateNoop,
} from "~/components/runs/v3/RunsListErrorState";
import { RunsListQueryError } from "~/services/runsRepository/runsRepository.server";
import { TimeFilter, timeFilterFromTo } from "~/components/runs/v3/SharedFilters";
import { TaskRunsTable } from "~/components/runs/v3/TaskRunsTable";
import { DeliveriesTable } from "~/components/webhookDeliveries/v1/DeliveriesTable";
import { DeliveryStatusBadge } from "~/components/webhookDeliveries/v1/DeliveryStatus";
import { EndpointsTable } from "~/components/webhookEndpoints/v1/EndpointsTable";
import { WebhookComposer } from "~/components/webhookConsole/WebhookComposer";
import { AIChatIcon } from "~/assets/icons/AIChatIcon";
import { RunsIcon } from "~/assets/icons/RunsIcon";
import { $replica } from "~/db.server";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { NextRunListPresenter } from "~/presenters/v3/NextRunListPresenter.server";
import {
  WebhookDetailPresenter,
  type WebhookActivity,
  type WebhookDeliveriesList,
  type WebhookDetail,
} from "~/presenters/v3/WebhookDetailPresenter.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { requireUser } from "~/services/session.server";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { flag } from "~/v3/featureFlags.server";
import {
  docsPath,
  EnvironmentParamSchema,
  v3EnvironmentPath,
  v3WebhookDeliveryPath,
} from "~/utils/pathBuilder";
import { parseFiniteInt } from "~/utils/searchParams";
import { useDeliveriesLiveReload } from "~/components/webhookDeliveries/v1/useDeliveriesLiveReload";

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  const slug = (data as { webhook?: WebhookDetail | null } | undefined)?.webhook?.slug;
  return [{ title: slug ? `${slug} | Webhooks | Trigger.dev` : "Webhook | Trigger.dev" }];
};

const WebhookParamSchema = EnvironmentParamSchema.extend({
  webhookParam: z.string(),
});

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const userId = user.id;
  const { organizationSlug, projectParam, envParam, webhookParam } =
    WebhookParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response("Project not found", { status: 404 });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response("Environment not found", { status: 404 });
  }

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
  const hasExplicitWindow = Boolean(periodParam || from || to);
  const period = periodParam ?? (hasExplicitWindow ? undefined : "7d");
  const deliveriesCursor = url.searchParams.get("deliveriesCursor") ?? undefined;
  const deliveriesDirectionRaw = url.searchParams.get("deliveriesDirection") ?? undefined;
  const deliveriesDirection = deliveriesDirectionRaw
    ? DirectionSchema.parse(deliveriesDirectionRaw)
    : undefined;
  const runsCursor = url.searchParams.get("runsCursor") ?? undefined;
  const runsDirectionRaw = url.searchParams.get("runsDirection") ?? undefined;
  const runsDirection = runsDirectionRaw ? DirectionSchema.parse(runsDirectionRaw) : undefined;

  const [clickhouse, runsListClickhouse] = await Promise.all([
    clickhouseFactory.getClickhouseForOrganization(project.organizationId, "standard"),
    clickhouseFactory.getClickhouseForOrganization(project.organizationId, "runsList"),
  ]);

  const presenter = new WebhookDetailPresenter($replica, clickhouse);
  const webhook = await presenter.findWebhook({
    environmentId: environment.id,
    environmentType: environment.type,
    webhookSlug: webhookParam,
  });

  if (!webhook) {
    throw new Response("Webhook not found", { status: 404 });
  }

  const time = timeFilterFromTo({ period, from, to, defaultPeriod: "7d" });

  const runActivity = presenter
    .getRunActivity({
      organizationId: project.organizationId,
      projectId: project.id,
      environmentId: environment.id,
      webhookSlug: webhook.slug,
      from: time.from,
      to: time.to,
    })
    .catch(() => ({ data: [], statuses: [] }) satisfies WebhookActivity);

  const deliveryActivity = presenter
    .getDeliveryActivity({
      organizationId: project.organizationId,
      projectId: project.id,
      environmentId: environment.id,
      webhookEndpointId: webhook.endpoint.id,
      from: time.from,
      to: time.to,
    })
    .catch(() => ({ data: [], statuses: [] }) satisfies WebhookActivity);

  const runList = new NextRunListPresenter($replica, runsListClickhouse)
    .call(project.organizationId, environment.id, {
      userId,
      projectId: project.id,
      tasks: [webhook.slug],
      period,
      from,
      to,
      cursor: runsCursor,
      direction: runsDirection,
    })
    .catch((error) => {
      if (error instanceof RunsListQueryError) {
        throw error;
      }
      return null;
    });

  const deliveriesList = presenter
    .listDeliveries({
      organizationId: project.organizationId,
      projectId: project.id,
      environmentId: environment.id,
      webhookEndpointId: webhook.endpoint.id,
      period,
      from,
      to,
      hasExplicitWindow,
      cursor: deliveriesCursor,
      direction: deliveriesDirection,
    })
    .catch(() => null);

  const endpointsList = presenter
    .listEndpoints({
      organizationId: project.organizationId,
      projectId: project.id,
      environmentId: environment.id,
      handlerWebhookId: webhook.slug,
    })
    .catch(() => [] as Awaited<ReturnType<typeof presenter.listEndpoints>>);

  const composerEndpoints = presenter
    .listComposerEndpoints({ environmentId: environment.id, handlerWebhookId: webhook.slug })
    .catch(() => [] as Awaited<ReturnType<typeof presenter.listComposerEndpoints>>);

  return typeddefer({
    webhook,
    runActivity,
    deliveryActivity,
    runList,
    deliveriesList,
    endpointsList,
    composerEndpoints,
  });
};

type WebhookTab = "runs" | "deliveries" | "endpoints" | "console";

export default function Page() {
  const {
    webhook,
    runActivity,
    deliveryActivity,
    runList,
    deliveriesList,
    endpointsList,
    composerEndpoints,
  } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const tasksPath = v3EnvironmentPath(organization, project, environment);

  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<WebhookTab>(() => {
    const requested = searchParams.get("tab");
    return requested === "console" || requested === "runs" || requested === "endpoints"
      ? requested
      : "deliveries";
  });
  const tabLabel =
    tab === "deliveries"
      ? "Deliveries"
      : tab === "runs"
        ? "Runs"
        : tab === "console"
          ? "Console"
          : "Endpoints";

  return (
    <>
      <NavBar>
        <PageTitle
          backButton={{ to: tasksPath, text: "Tasks" }}
          title={
            <span className="flex items-center gap-1">
              <WebhookIcon className="size-4.5 text-webhooks" />
              <span>{webhook.slug}</span>
            </span>
          }
        />
        <PageAccessories>
          <LinkButton
            variant="docs/small"
            LeadingIcon={BookOpenIcon}
            to={docsPath("webhooks/overview")}
          >
            Webhooks docs
          </LinkButton>
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        <ResizablePanelGroup orientation="horizontal" className="max-h-full">
          <ResizablePanel id="webhook-main" min="300px">
            <div className="grid h-full grid-rows-[auto_1fr] overflow-hidden">
              {/* Top bar: tabs on the left, TimeFilter + pagination on the right.
                  h-10 matches the right-hand sidebar header height. */}
              <div className="flex h-10 items-end border-b border-grid-dimmed bg-background-bright pl-3 pr-2">
                <TabContainer className="-mb-px">
                  <TabButton
                    isActive={tab === "deliveries"}
                    layoutId="webhook-page-tabs"
                    onClick={() => setTab("deliveries")}
                  >
                    Deliveries
                  </TabButton>
                  <TabButton
                    isActive={tab === "runs"}
                    layoutId="webhook-page-tabs"
                    onClick={() => setTab("runs")}
                  >
                    Runs
                  </TabButton>
                  <TabButton
                    isActive={tab === "endpoints"}
                    layoutId="webhook-page-tabs"
                    onClick={() => setTab("endpoints")}
                  >
                    Endpoints
                  </TabButton>
                  <TabButton
                    isActive={tab === "console"}
                    layoutId="webhook-page-tabs"
                    onClick={() => setTab("console")}
                  >
                    Console
                  </TabButton>
                </TabContainer>
                {tab !== "endpoints" && tab !== "console" && (
                  <div className="ml-auto flex items-center gap-2 self-center">
                    <TimeFilter
                      defaultPeriod="7d"
                      labelName={tabLabel}
                      clearParams={[
                        "deliveriesCursor",
                        "deliveriesDirection",
                        "runsCursor",
                        "runsDirection",
                      ]}
                    />
                    {tab === "deliveries" ? (
                      <Suspense fallback={null}>
                        <TypedAwait resolve={deliveriesList} errorElement={null}>
                          {(list) =>
                            list ? (
                              <ListPagination
                                list={list}
                                cursorParam="deliveriesCursor"
                                directionParam="deliveriesDirection"
                              />
                            ) : null
                          }
                        </TypedAwait>
                      </Suspense>
                    ) : (
                      <Suspense fallback={null}>
                        <TypedAwait resolve={runList} errorElement={<RunsListErrorStateNoop />}>
                          {(list) =>
                            list ? (
                              <ListPagination
                                list={list}
                                cursorParam="runsCursor"
                                directionParam="runsDirection"
                              />
                            ) : null
                          }
                        </TypedAwait>
                      </Suspense>
                    )}
                  </div>
                )}
              </div>

              {tab === "endpoints" ? (
                // Endpoints aren't a time series, so no activity chart or time filter.
                <div className="h-full overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
                  <Suspense fallback={<TableLoading />}>
                    <TypedAwait resolve={endpointsList} errorElement={<TableLoading />}>
                      {(endpoints) => (
                        <EndpointsTable endpoints={endpoints} showTopBorder={false} stickyHeader />
                      )}
                    </TypedAwait>
                  </Suspense>
                </div>
              ) : tab === "console" ? (
                <div className="h-full overflow-hidden">
                  <Suspense fallback={<TableLoading />}>
                    <TypedAwait resolve={composerEndpoints} errorElement={<TableLoading />}>
                      {(endpoints) =>
                        endpoints.length === 0 ? (
                          <div className="flex h-full items-center justify-center p-4 text-center text-sm text-text-dimmed">
                            This webhook has no synced endpoints to send to yet.
                          </div>
                        ) : (
                          <WebhookComposer
                            endpoints={endpoints}
                            organizationSlug={organization.slug}
                            projectSlug={project.slug}
                            environmentSlug={environment.slug}
                            isDevEnvironment={environment.type === "DEVELOPMENT"}
                            environmentLabel={
                              environment.type.charAt(0) + environment.type.slice(1).toLowerCase()
                            }
                            redirectOnSuccess={false}
                          />
                        )
                      }
                    </TypedAwait>
                  </Suspense>
                </div>
              ) : (
                <ResizablePanelGroup orientation="vertical" className="max-h-full">
                  {/* Activity chart (one status-bucket chart per tab). */}
                  <ResizablePanel id="webhook-activity" min="220px" default="320px">
                    <div className="flex h-full flex-col overflow-hidden bg-background p-2">
                      <div className="grid min-h-0 flex-1 grid-cols-1 gap-2">
                        <ChartCard title={tabLabel}>
                          {tab === "deliveries" ? (
                            <Suspense fallback={<ActivityChartSkeleton />}>
                              <TypedAwait
                                resolve={deliveryActivity}
                                errorElement={<ActivityChartSkeleton />}
                              >
                                {(result) => <ActivityChart activity={result} />}
                              </TypedAwait>
                            </Suspense>
                          ) : (
                            <Suspense fallback={<ActivityChartSkeleton />}>
                              <TypedAwait
                                resolve={runActivity}
                                errorElement={<ActivityChartSkeleton />}
                              >
                                {(result) => <ActivityChart activity={result} />}
                              </TypedAwait>
                            </Suspense>
                          )}
                        </ChartCard>
                      </div>
                    </div>
                  </ResizablePanel>

                  <ResizableHandle id="webhook-activity-handle" />

                  {/* Table */}
                  <ResizablePanel id="webhook-content" min="160px">
                    <WebhookContentArea
                      tab={tab}
                      deliveriesList={deliveriesList}
                      runList={runList}
                      webhookEndpointId={webhook.endpoint.id}
                    />
                  </ResizablePanel>
                </ResizablePanelGroup>
              )}
            </div>
          </ResizablePanel>

          <ResizableHandle id="webhook-detail-handle" />
          <ResizablePanel
            id="webhook-detail"
            min="280px"
            default="380px"
            max="500px"
            isStaticAtRest
          >
            {tab === "console" ? (
              <ConsoleLiveFeed
                deliveriesList={deliveriesList}
                webhookEndpointId={webhook.endpoint.id}
              />
            ) : (
              <WebhookDetailSidebar webhook={webhook} onViewEndpoints={() => setTab("endpoints")} />
            )}
          </ResizablePanel>
        </ResizablePanelGroup>
      </PageBody>
    </>
  );
}

type LoaderData = ReturnType<typeof useTypedLoaderData<typeof loader>>;

function WebhookContentArea({
  tab,
  deliveriesList,
  runList,
  webhookEndpointId,
}: {
  tab: WebhookTab;
  webhookEndpointId: string;
} & Pick<LoaderData, "deliveriesList" | "runList">) {
  return (
    <div className="h-full overflow-hidden">
      {tab === "deliveries" ? (
        <Suspense fallback={<TableLoading />}>
          <TypedAwait resolve={deliveriesList} errorElement={<TableLoading />}>
            {(list) =>
              list ? (
                <div className="h-full overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
                  <LiveDeliveriesTable list={list} webhookEndpointId={webhookEndpointId} />
                </div>
              ) : (
                <TableLoading />
              )
            }
          </TypedAwait>
        </Suspense>
      ) : (
        <Suspense fallback={<TableLoading />}>
          <TypedAwait resolve={runList} errorElement={<RunsListErrorState />}>
            {(list) =>
              list ? (
                <div className="h-full overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
                  <TaskRunsTable
                    enableSmartColumns={false}
                    total={list.runs.length}
                    hasFilters={list.hasFilters}
                    filters={list.filters}
                    runs={list.runs}
                    variant="dimmed"
                    showTopBorder={false}
                    stickyHeader
                  />
                </div>
              ) : (
                <TableLoading />
              )
            }
          </TypedAwait>
        </Suspense>
      )}
    </div>
  );
}

function LiveDeliveriesTable({
  list,
  webhookEndpointId,
}: {
  list: WebhookDeliveriesList;
  webhookEndpointId: string;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const [searchParams, setSearchParams] = useSearchParams();

  const { visibleDeliveries, showNewDeliveriesBanner, newDeliveriesCount, dismissNewDeliveries } =
    useDeliveriesLiveReload({
      deliveries: list.deliveries,
      isLoading: navigation.state !== "idle",
      webhookEndpointId,
      organizationSlug: organization.slug,
      projectSlug: project.slug,
      environmentSlug: environment.slug,
    });

  const onClickShowNewDeliveries = () => {
    dismissNewDeliveries();
    if (searchParams.has("deliveriesCursor") || searchParams.has("deliveriesDirection")) {
      setSearchParams((prev) => {
        prev.delete("deliveriesCursor");
        prev.delete("deliveriesDirection");
        return prev;
      });
      return;
    }
    revalidator.revalidate();
  };

  return (
    <>
      {showNewDeliveriesBanner ? (
        <div className="flex justify-end px-2 py-1.5">
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
                : `${newDeliveriesCount} new ${
                    newDeliveriesCount === 1 ? "delivery" : "deliveries"
                  }`}
            </Button>
          </span>
        </div>
      ) : null}
      <DeliveriesTable
        deliveries={visibleDeliveries}
        hasFilters={list.hasFilters}
        showTopBorder={false}
        stickyHeader
      />
    </>
  );
}

function ConsoleLiveFeed({
  deliveriesList,
  webhookEndpointId,
}: {
  webhookEndpointId: string;
} & Pick<LoaderData, "deliveriesList">) {
  return (
    <div className="grid h-full grid-rows-[auto_1fr] overflow-hidden bg-background-bright">
      <div className="flex h-10 items-center justify-between gap-2 border-b border-grid-dimmed pl-3 pr-2">
        <Header2 className="truncate">Live deliveries</Header2>
        <span className="flex items-center gap-1.5 text-xs text-text-dimmed">
          <PulsingDot className="h-2 w-2" />
          Live
        </span>
      </div>
      <div className="overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        <Suspense fallback={<TableLoading />}>
          <TypedAwait resolve={deliveriesList} errorElement={<TableLoading />}>
            {(list) =>
              list ? (
                <ConsoleFeedList list={list} webhookEndpointId={webhookEndpointId} />
              ) : (
                <TableLoading />
              )
            }
          </TypedAwait>
        </Suspense>
      </div>
    </div>
  );
}

function ConsoleFeedList({
  list,
  webhookEndpointId,
}: {
  list: WebhookDeliveriesList;
  webhookEndpointId: string;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const navigation = useNavigation();
  const revalidator = useRevalidator();

  const { visibleDeliveries, showNewDeliveriesBanner, newDeliveriesCount, dismissNewDeliveries } =
    useDeliveriesLiveReload({
      deliveries: list.deliveries,
      isLoading: navigation.state !== "idle",
      webhookEndpointId,
      organizationSlug: organization.slug,
      projectSlug: project.slug,
      environmentSlug: environment.slug,
    });

  const onShowNew = () => {
    dismissNewDeliveries();
    revalidator.revalidate();
  };

  if (visibleDeliveries.length === 0) {
    return (
      <p className="px-3 py-8 text-center text-sm text-text-dimmed">
        No deliveries yet. Send an event to watch it arrive here.
      </p>
    );
  }

  return (
    <div className="flex flex-col">
      {showNewDeliveriesBanner ? (
        <button
          type="button"
          onClick={onShowNew}
          className="flex items-center justify-center gap-1.5 border-b border-grid-dimmed bg-charcoal-800 py-1.5 text-xs text-text-bright hover:bg-charcoal-700"
        >
          <PulsingDot className="h-2 w-2" />
          {newDeliveriesCount >= 100 ? "99+" : newDeliveriesCount} new
        </button>
      ) : null}
      {visibleDeliveries.map((delivery) => (
        <Link
          key={delivery.id}
          to={v3WebhookDeliveryPath(organization, project, environment, delivery.friendlyId)}
          className="flex flex-col gap-1 border-b border-grid-dimmed px-3 py-2 hover:bg-charcoal-800"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5">
              <span className="font-mono text-xs text-text-bright">{delivery.friendlyId}</span>
              {delivery.isTest ? (
                <span className="rounded-sm bg-charcoal-700 px-1 py-0.5 text-xxs font-semibold uppercase tracking-wide text-text-dimmed">
                  Test
                </span>
              ) : null}
            </span>
            <DeliveryStatusBadge
              status={delivery.status}
              className="shrink-0 text-xs text-text-dimmed"
            />
          </div>
          {delivery.session ? (
            <span className="flex items-center gap-1 text-xxs text-text-dimmed">
              <AIChatIcon className="size-3.5 text-sessions" />
              <span className="font-mono">{delivery.session.friendlyId}</span>
            </span>
          ) : delivery.run ? (
            <span className="flex items-center gap-1 text-xxs text-text-dimmed">
              <RunsIcon className="size-3.5 text-runs" />
              <span className="font-mono">{delivery.run.friendlyId}</span>
            </span>
          ) : null}
        </Link>
      ))}
    </div>
  );
}

function WebhookDetailSidebar({
  webhook,
  onViewEndpoints,
}: {
  webhook: WebhookDetail;
  onViewEndpoints: () => void;
}) {
  return (
    <div className="grid h-full grid-rows-[auto_1fr] overflow-hidden bg-background-bright">
      <div className="flex items-center gap-2 border-b border-grid-dimmed py-2 pl-3 pr-2">
        <Header2 className="flex min-w-0 flex-1 items-center gap-1.5">
          <WebhookIcon className="size-4.5 shrink-0 text-webhooks" />
          <span className="truncate">{webhook.slug}</span>
        </Header2>
      </div>
      <div className="overflow-y-auto px-3 py-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        <Property.Table>
          <Property.Item>
            <Property.Label>Source</Property.Label>
            <Property.Value>
              <span className="font-mono text-sm">{webhook.source}</span>
            </Property.Value>
          </Property.Item>
          <Property.Item>
            <Property.Label>Endpoints</Property.Label>
            <Property.Value>
              {/* The connect flow (ingress URL, secret, provider setup) lives on each
                  endpoint, so this handler view points there instead of holding it. */}
              <Button variant="secondary/small" onClick={onViewEndpoints}>
                View endpoints
              </Button>
            </Property.Value>
          </Property.Item>
          <Property.Item>
            <Property.Label>File path</Property.Label>
            <Property.Value>
              <CopyableText value={webhook.filePath} />
            </Property.Value>
          </Property.Item>
          <Property.Item>
            <Property.Label>Created</Property.Label>
            <Property.Value>
              <DateTime date={webhook.createdAt} />
            </Property.Value>
          </Property.Item>
        </Property.Table>
      </div>
    </div>
  );
}

const STATUS_COLOR: Record<string, string> = {
  // Run statuses
  COMPLETED: "#28BF5C",
  RUNNING: "#3B82F6",
  FAILED: "#E11D48",
  CANCELED: "#878C99",
  // Delivery statuses
  SUCCEEDED: "#28BF5C",
  PROCESSING: "#3B82F6",
  PENDING: "#878C99",
};

function ActivityChart({ activity }: { activity: WebhookActivity }) {
  const chartConfig: ChartConfig = useMemo(() => {
    const cfg: ChartConfig = {};
    for (const status of activity.statuses) {
      cfg[status] = {
        label: status.charAt(0) + status.slice(1).toLowerCase(),
        color: STATUS_COLOR[status] ?? "#9CA3AF",
      };
    }
    return cfg;
  }, [activity.statuses]);

  const { xAxisFormatter, xAxisTicks, tooltipLabelFormatter } = useMemo(
    () => buildTimeAxis(activity.data),
    [activity.data]
  );

  return (
    <Chart.Root
      config={chartConfig}
      data={activity.data}
      dataKey="bucket"
      series={activity.statuses}
      fillContainer
    >
      <Chart.Bar
        stackId="status"
        barRadius={0}
        xAxisProps={{
          tickFormatter: xAxisFormatter,
          ...(xAxisTicks ? { ticks: xAxisTicks, interval: 0 } : {}),
        }}
        tooltipLabelFormatter={tooltipLabelFormatter}
      />
    </Chart.Root>
  );
}

function ActivityChartSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 items-end gap-px rounded-sm">
      {Array.from({ length: 42 }).map((_, i) => (
        <div key={i} className="h-full flex-1 bg-charcoal-850" />
      ))}
    </div>
  );
}

function TableLoading() {
  return (
    <div className="flex h-full items-center justify-center">
      <Spinner className="size-6" />
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="h-full overflow-hidden px-0 pb-2 pt-3">
      <Card.Header>{title}</Card.Header>
      <div className="min-h-0 flex-1 px-2">{children}</div>
    </Card>
  );
}

function buildTimeAxis(data: WebhookActivity["data"]) {
  const range = data.length >= 2 ? data[data.length - 1].bucket - data[0].bucket : 0;
  const oneDay = 24 * 60 * 60 * 1000;
  const showTime = range <= oneDay;

  const xAxisFormatter = (value: number) => {
    const date = new Date(value);
    return showTime
      ? date.toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
          timeZone: "UTC",
        })
      : date.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          timeZone: "UTC",
        });
  };

  const xAxisTicks = showTime
    ? undefined
    : data.filter((d) => new Date(d.bucket).getUTCHours() === 0).map((d) => d.bucket);

  const bucketMs = data.length >= 2 ? data[1].bucket - data[0].bucket : 0;
  const isSubDayBucket = bucketMs > 0 && bucketMs < oneDay;

  const tooltipLabelFormatter = (_label: string, payload: { payload?: { bucket?: number } }[]) => {
    const ts = payload?.[0]?.payload?.bucket;
    if (typeof ts !== "number" || !Number.isFinite(ts)) return _label;
    const date = new Date(ts);
    return isSubDayBucket
      ? date.toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
          timeZone: "UTC",
        })
      : date.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
          timeZone: "UTC",
        });
  };

  return { xAxisFormatter, xAxisTicks, tooltipLabelFormatter };
}

import { BookOpenIcon, PaperAirplaneIcon } from "@heroicons/react/20/solid";
import { type ShouldRevalidateFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typeddefer, useTypedLoaderData } from "remix-typedjson";
import { WebhookIcon } from "~/assets/icons/WebhookIcon";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { DirectionSchema } from "~/components/ListPagination";
import { LinkButton } from "~/components/primitives/Buttons";
import { CopyableText } from "~/components/primitives/CopyableText";
import {
  DetailPageTitle,
  PropertyGroup,
  useDetailTab,
} from "~/components/primitives/detail/DetailPage";
import { DetailTabEmpty, DetailTableTab } from "~/components/primitives/detail/DetailSections";
import { NavBar, PageAccessories } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { TaskDetailView } from "~/components/tasks/TaskDetailView";
import { DeliveriesTab } from "~/components/webhookDeliveries/v1/DeliveriesTab";
import { parseDeliveryListFilters } from "~/components/webhookDeliveries/v1/deliveryListFilters";
import { EndpointStatusBadge } from "~/components/webhookEndpoints/v1/EndpointStatus";
import { $replica } from "~/db.server";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { loadTaskDetailPage, taskQueueAction } from "~/presenters/v3/TaskDetailPage.server";
import {
  type DeliveryActivity,
  WebhookDetailPresenter,
} from "~/presenters/v3/WebhookDetailPresenter.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { onlyDetailTabChanged } from "~/utils/detailTabRevalidation";
import { pageMeta } from "~/utils/pageTitle";
import { docsPath, v3EnvironmentPath, v3WebhookEndpointPath } from "~/utils/pathBuilder";
import { parseFiniteInt } from "~/utils/searchParams";
import { webhookIngressUrl } from "~/utils/webhookIngressUrl.server";
import { requireWebhooksAccess } from "~/v3/webhooksAccess.server";

export const meta = pageMeta<typeof loader>(({ data, params }) => [
  data?.task?.slug ?? params.webhookParam ?? "Webhook",
  "Tasks",
]);

/**
 * A webhook() task: the task page (Runs, Queue, the rail) with the deliveries its endpoints
 * received first, its endpoints as a tab, and each endpoint's URL and signing state in the rail.
 */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { user, project, environment, time, page } = await loadTaskDetailPage({
    request,
    params: { ...(params as Record<string, string>), taskParam: params.webhookParam },
    triggerSource: "WEBHOOK",
    defaultTab: "deliveries",
  });
  await requireWebhooksAccess(user, project.organizationId);

  const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
    project.organizationId,
    "standard"
  );
  const presenter = new WebhookDetailPresenter($replica, clickhouse);
  const endpoints = await presenter.findTaskEndpoints({
    environmentId: environment.id,
    webhookSlug: page.task.slug,
  });
  const endpointIds = endpoints.map((endpoint) => endpoint.id);

  const url = new URL(request.url);
  const deliveriesTabOpen = (url.searchParams.get("tab") ?? "deliveries") === "deliveries";
  const period = url.searchParams.get("period") ?? undefined;
  const from = parseFiniteInt(url.searchParams.get("from"));
  const to = parseFiniteInt(url.searchParams.get("to"));
  const scope = {
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
  };

  return typeddefer({
    ...page,
    endpoints: endpoints.map((endpoint) => ({
      ...endpoint,
      ingestUrl: webhookIngressUrl(endpoint.opaqueId),
    })),
    deliveryActivity: presenter
      .getDeliveryActivity({
        ...scope,
        webhookEndpointIds: endpointIds,
        from: time.from,
        to: time.to,
      })
      .catch((): DeliveryActivity => ({
        data: [],
        statuses: [],
        totals: {},
        lastDeliveryAt: null,
      })),
    deliveriesList: presenter
      .listDeliveries({
        ...scope,
        webhookEndpointIds: endpointIds,
        period: period ?? (from || to ? undefined : "7d"),
        from,
        to,
        hasExplicitWindow: Boolean(period || from || to),
        filters: parseDeliveryListFilters(url.searchParams),
        cursor: deliveriesTabOpen ? (url.searchParams.get("cursor") ?? undefined) : undefined,
        direction: DirectionSchema.catch("forward").parse(
          url.searchParams.get("direction") ?? undefined
        ),
      })
      .catch(() => null),
  });
};

/** The Queue tab's pause, resume and override buttons post here. */
export const action = taskQueueAction;

/** Every tab's data is already loaded: switching tabs doesn't run the loader again. */
export const shouldRevalidate: ShouldRevalidateFunction = (args) =>
  onlyDetailTabChanged(args) ? false : args.defaultShouldRevalidate;

type LoaderData = ReturnType<typeof useTypedLoaderData<typeof loader>>;
type Endpoint = LoaderData["endpoints"][number];

/** The page's tabs, in order; the first opens by default. */
const WEBHOOK_TABS = ["deliveries", "runs", "queue", "endpoints"] as const;

export default function Page() {
  const data = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const { endpoints } = data;
  const [, , isPending] = useDetailTab(WEBHOOK_TABS);

  const endpointPath = (endpoint: Endpoint, tab?: string) =>
    `${v3WebhookEndpointPath(organization, project, environment, endpoint.friendlyId)}${
      tab ? `?tab=${tab}` : ""
    }`;
  const sendTest =
    endpoints.length > 0 ? (
      <LinkButton
        variant="primary/small"
        to={endpointPath(endpoints[0], "test")}
        LeadingIcon={PaperAirplaneIcon}
      >
        Send test event
      </LinkButton>
    ) : undefined;

  return (
    <PageContainer>
      <NavTitle slug={data.task.slug} />
      <PageBody scrollable={false}>
        <TaskDetailView
          data={data}
          leadingTab={{
            id: "deliveries",
            label: "Deliveries",
            content: (
              <DeliveriesTab
                deliveriesList={data.deliveriesList}
                activity={data.deliveryActivity}
                webhookEndpointIds={endpoints.map((endpoint) => endpoint.id)}
                webhookTaskSlug={data.task.slug}
                isPending={isPending}
                endpoints={
                  endpoints.length > 1
                    ? Object.fromEntries(
                        endpoints.map((endpoint) => [
                          endpoint.id,
                          { label: endpointLabel(endpoint), path: endpointPath(endpoint) },
                        ])
                      )
                    : undefined
                }
                emptyAction={
                  sendTest ? (
                    <LinkButton
                      variant="secondary/small"
                      to={endpointPath(endpoints[0], "test")}
                      LeadingIcon={PaperAirplaneIcon}
                    >
                      Send test event
                    </LinkButton>
                  ) : undefined
                }
              />
            ),
          }}
          extraTab={{
            id: "endpoints",
            label: "Endpoints",
            count: String(endpoints.length),
            content: <EndpointsTab endpoints={endpoints} endpointPath={endpointPath} />,
          }}
          primaryAction={sendTest}
          railAfterDetails={<EndpointsRail endpoints={endpoints} endpointPath={endpointPath} />}
        />
      </PageBody>
    </PageContainer>
  );
}

function NavTitle({ slug }: { slug: string }) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  return (
    <NavBar>
      <DetailPageTitle
        title={slug}
        backButton={{ to: v3EnvironmentPath(organization, project, environment), text: "Tasks" }}
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
  );
}

function endpointLabel(endpoint: Pick<Endpoint, "declaredId" | "tenantId">) {
  return endpoint.tenantId ? `${endpoint.declaredId} · ${endpoint.tenantId}` : endpoint.declaredId;
}

// ---------- Endpoints ----------

/** The endpoints this task subscribes to. Each row opens the endpoint. */
function EndpointsTab({
  endpoints,
  endpointPath,
}: {
  endpoints: Endpoint[];
  endpointPath: (endpoint: Endpoint, tab?: string) => string;
}) {
  if (endpoints.length === 0) {
    return (
      <DetailTabEmpty
        title="No endpoints in this environment"
        description="Deploy the task with a webhook endpoint to get a URL for the provider."
      />
    );
  }

  return (
    <DetailTableTab>
      <Table showTopBorder={false} stickyHeader>
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Endpoint</TableHeaderCell>
            <TableHeaderCell>Status</TableHeaderCell>
            <TableHeaderCell>Source</TableHeaderCell>
            <TableHeaderCell>Signing secret</TableHeaderCell>
            <TableHeaderCell>Filter</TableHeaderCell>
            <TableHeaderCell>Webhook URL</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {endpoints.map((endpoint) => {
            const path = endpointPath(endpoint);
            return (
              <TableRow key={endpoint.id}>
                <TableCell to={path}>
                  <span className="flex items-center gap-1.5">
                    <WebhookIcon className="size-4 shrink-0 text-webhooks" />
                    <span className="font-mono text-xs text-text-bright">
                      {endpointLabel(endpoint)}
                    </span>
                  </span>
                </TableCell>
                <TableCell to={path}>
                  <EndpointStatusBadge status={endpoint.status} />
                </TableCell>
                <TableCell to={path}>
                  <span className="font-mono text-xs">{endpoint.source}</span>
                </TableCell>
                <TableCell to={path}>
                  <SigningState endpoint={endpoint} />
                </TableCell>
                <TableCell to={path}>
                  {endpoint.filter ? (
                    <code className="text-xs text-text-bright">{endpoint.filter}</code>
                  ) : (
                    <span className="text-text-dimmed">Every delivery</span>
                  )}
                </TableCell>
                <TableCell>
                  <CopyableText
                    value={endpoint.ingestUrl}
                    className="max-w-xs font-mono text-xs"
                    truncate
                  />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </DetailTableTab>
  );
}

/** Ready, or the warning that every delivery is rejected until a secret is set. */
function SigningState({ endpoint }: { endpoint: Endpoint }) {
  return endpoint.hasSigningSecret ? (
    <span className="flex items-center gap-1.5">
      <span className="size-2 rounded-full bg-success" />
      Ready
    </span>
  ) : (
    <SimpleTooltip
      content="Every delivery is rejected until the signing secret is set on the endpoint."
      button={
        <span className="flex items-center gap-1.5 text-warning">
          <span className="size-2 rounded-full bg-warning" />
          Not set
        </span>
      }
    />
  );
}

// ---------- Rail ----------

/** Where the provider sends to, per endpoint: the URL to paste, and whether it can verify yet. */
function EndpointsRail({
  endpoints,
  endpointPath,
}: {
  endpoints: Endpoint[];
  endpointPath: (endpoint: Endpoint, tab?: string) => string;
}) {
  return (
    <PropertyGroup title={endpoints.length === 1 ? "Endpoint" : "Endpoints"}>
      {endpoints.length === 0 ? (
        <Paragraph variant="small" className="text-text-dimmed">
          None in this environment yet.
        </Paragraph>
      ) : (
        endpoints.slice(0, 3).map((endpoint) => (
          <div key={endpoint.id} className="flex min-w-0 flex-col gap-1.5">
            <div className="flex min-w-0 items-center justify-between gap-2 text-sm">
              <LinkButton
                variant="minimal/small"
                to={endpointPath(endpoint)}
                LeadingIcon={WebhookIcon}
                leadingIconClassName="text-webhooks"
                className="-ml-1 min-w-0"
              >
                <span className="truncate font-mono text-xs">{endpointLabel(endpoint)}</span>
              </LinkButton>
              <span className="flex flex-none items-center gap-3 text-xs">
                <EndpointStatusBadge status={endpoint.status} />
              </span>
            </div>
            <CopyableText
              value={endpoint.ingestUrl}
              className="min-w-0 font-mono text-xs text-text-dimmed"
              truncate
            />
            <span className="text-xs">
              <SigningState endpoint={endpoint} />
            </span>
          </div>
        ))
      )}
      {endpoints.length > 3 ? (
        <Paragraph variant="extra-small" className="text-text-dimmed">
          And {endpoints.length - 3} more on the Endpoints tab.
        </Paragraph>
      ) : null}
    </PropertyGroup>
  );
}

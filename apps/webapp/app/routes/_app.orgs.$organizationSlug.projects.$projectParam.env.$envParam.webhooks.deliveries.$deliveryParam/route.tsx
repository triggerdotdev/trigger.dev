import { ArrowPathIcon, BookOpenIcon } from "@heroicons/react/20/solid";
import { Form, useNavigation, useRevalidator } from "@remix-run/react";
import { type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { AIChatIcon } from "~/assets/icons/AIChatIcon";
import { RunsIcon } from "~/assets/icons/RunsIcon";
import { WebhookIcon } from "~/assets/icons/WebhookIcon";
import { CodeBlock } from "~/components/code/CodeBlock";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { CopyableText } from "~/components/primitives/CopyableText";
import { DateTime } from "~/components/primitives/DateTime";
import {
  DetailHeader,
  DetailPage,
  DetailPageTitle,
  DetailProperty,
  DetailTabs,
  PropertyGroup,
  PropertyPair,
  PropertyRail,
  type DetailTab,
  useDetailTab,
} from "~/components/primitives/detail/DetailPage";
import { DetailTabEmpty, DetailTableTab } from "~/components/primitives/detail/DetailSections";
import { NavBar, PageAccessories } from "~/components/primitives/PageHeader";
import { Spinner } from "~/components/primitives/Spinner";
import { TextLink } from "~/components/primitives/TextLink";
import { RunError } from "~/components/runs/v3/RunError";
import { DeliveryHeadersTable } from "~/components/webhookDeliveries/v1/DeliveryHeadersTable";
import { DeliveryStatusBadge } from "~/components/webhookDeliveries/v1/DeliveryStatus";
import { DeliveryTargetsTable } from "~/components/webhookDeliveries/v1/DeliveryTargetsTable";
import { DeliveryTimeline } from "~/components/webhookDeliveries/v1/DeliveryTimeline";
import { $replica, webhookReplica } from "~/db.server";
import { env as serverEnv } from "~/env.server";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useInterval } from "~/hooks/useInterval";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import {
  WebhookDeliveryDetailPresenter,
  type WebhookDeliveryDetail,
} from "~/presenters/v3/WebhookDeliveryDetailPresenter.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { rbac } from "~/services/rbac.server";
import { requireUser } from "~/services/session.server";
import { webhookDeliveriesRepository } from "~/services/webhookDeliveriesRepository/webhookDeliveriesRepository.server";
import { formatBytes } from "~/utils/columnFormat";
import { pageMeta } from "~/utils/pageTitle";
import {
  docsPath,
  EnvironmentParamSchema,
  v3RunPath,
  v3SessionPath,
  v3WebhookDeliveryPath,
  v3WebhookEndpointPath,
  v3WebhooksPath,
} from "~/utils/pathBuilder";
import { isDeliveryStillBeingRecorded } from "~/v3/webhookDeliveryRecording";
import { matchedWaiterCount, routedSubscriberCount } from "~/v3/webhookDeliveryTargets";
import { webhookEngine } from "~/v3/webhookEngine.server";
import { webhookLimitsForEnvironment } from "~/v3/webhookLimits.server";
import { requireWebhooksAccess } from "~/v3/webhooksAccess.server";

const DeliveryParamSchema = EnvironmentParamSchema.extend({
  deliveryParam: z.string(),
});

const EVENT_DISPLAY_CAP = 128 * 1024;

export const meta = pageMeta<typeof loader>(({ data, params }) => [
  data?.delivery?.friendlyId ?? params.deliveryParam ?? "Delivery",
  "Deliveries",
]);

async function requireDeliveryScope(request: Request, params: LoaderFunctionArgs["params"]) {
  const user = await requireUser(request);
  const { organizationSlug, projectParam, envParam, deliveryParam } =
    DeliveryParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, user.id);
  if (!project) throw new Response("Project not found", { status: 404 });
  const environment = await findEnvironmentBySlug(project.id, envParam, user.id);
  if (!environment) throw new Response("Environment not found", { status: 404 });

  await requireWebhooksAccess(user, project.organizationId);

  return { user, project, environment, deliveryParam };
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { user, project, environment, deliveryParam } = await requireDeliveryScope(request, params);

  const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
    project.organizationId,
    "standard"
  );

  const delivery = await new WebhookDeliveryDetailPresenter($replica, clickhouse).call({
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    deliveryFriendlyId: deliveryParam,
  });

  const rawEventJson =
    delivery?.parsedEvent != null ? JSON.stringify(delivery.parsedEvent, null, 2) : null;
  const eventBytes = rawEventJson != null ? Buffer.byteLength(rawEventJson, "utf8") : 0;
  const eventTruncatedForDisplay = rawEventJson != null && rawEventJson.length > EVENT_DISPLAY_CAP;
  const eventJson = eventTruncatedForDisplay
    ? rawEventJson!.slice(0, EVENT_DISPLAY_CAP)
    : rawEventJson;

  const auth = await rbac.authenticateSession(request, {
    userId: user.id,
    organizationId: project.organizationId,
    projectId: project.id,
  });

  // A missing delivery is most often one that aged out of retention (a bookmarked or shared link),
  // so render a friendly retention-aware state rather than a hard 404.
  return typedjson({
    delivery: delivery ? { ...delivery, parsedEvent: null } : delivery,
    // A replay redirects here before its new delivery is saved, so a missing delivery that was
    // minted moments ago is on its way: the page waits for it and doesn't say it aged out.
    isBeingRecorded: !delivery && isDeliveryStillBeingRecorded(deliveryParam, new Date()),
    eventJson,
    eventBytes,
    eventTruncatedForDisplay,
    retentionDays: (await webhookLimitsForEnvironment(environment.id)).deliveryRetentionDays,
    canReplay:
      serverEnv.WEBHOOK_ENABLED === "1" &&
      auth.ok &&
      auth.ability.can("write", { type: "webhooks", envType: environment.type }),
  });
};

/**
 * Replay: run the delivery again from its stored event, as a new delivery to every current
 * subscriber (the API's replay). It starts runs, so it needs `trigger` on each subscriber's task.
 */
export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { user, project, environment, deliveryParam } = await requireDeliveryScope(request, params);
  const url = new URL(request.url);
  const here = `${url.pathname}${url.search}`;

  if (serverEnv.WEBHOOK_ENABLED !== "1") {
    return redirectWithErrorMessage(here, request, "Webhooks are turned off on this server");
  }

  const auth = await rbac.authenticateSession(request, {
    userId: user.id,
    organizationId: project.organizationId,
    projectId: project.id,
  });
  if (!auth.ok || !auth.ability.can("write", { type: "webhooks", envType: environment.type })) {
    return redirectWithErrorMessage(
      here,
      request,
      "You don't have permission to replay webhook deliveries."
    );
  }
  const ability = auth.ability;

  const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
    project.organizationId,
    "standard"
  );
  const original = await webhookDeliveriesRepository({
    clickhouse,
    prisma: webhookReplica,
  }).getDelivery({
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    friendlyId: deliveryParam,
  });
  if (!original) return redirectWithErrorMessage(here, request, "Delivery not found");

  const result = await webhookEngine.replayDelivery({
    id: original.id,
    createdAt: original.createdAt,
    authorize: (subscribers) =>
      subscribers.flatMap((subscriber) => {
        if (
          !ability.can("trigger", {
            type: "tasks",
            id: subscriber.taskId,
            envType: environment.type,
          })
        ) {
          return [subscriber.taskId];
        }
        if (
          subscriber.type === "session" &&
          !ability.can("write", { type: "sessions", envType: environment.type })
        ) {
          return [`sessions (for ${subscriber.id})`];
        }
        return [];
      }),
  });

  switch (result.outcome) {
    case "replayed": {
      const path = v3WebhookDeliveryPath(
        { slug: params.organizationSlug! },
        project,
        environment,
        result.deliveryFriendlyId
      );
      return redirectWithSuccessMessage(path, request, `Replayed as ${result.deliveryFriendlyId}`);
    }
    case "forbidden":
      return redirectWithErrorMessage(
        here,
        request,
        `Replaying needs permissions you don't have: ${[...new Set(result.denied)].join(", ")}`
      );
    case "queue_full":
      return redirectWithErrorMessage(
        here,
        request,
        "This environment has too many webhook deliveries waiting. Try again later."
      );
    default:
      return redirectWithErrorMessage(here, request, "This delivery can't be replayed");
  }
};

type LoaderData = ReturnType<typeof useTypedLoaderData<typeof loader>>;
type Delivery = NonNullable<LoaderData["delivery"]>;

/** The page's tabs, in order; the first opens by default. */
const DELIVERY_TABS = ["event", "headers", "targets"] as const;
type DeliveryTabId = (typeof DELIVERY_TABS)[number];

function formatDuration(createdAt: Date, processedAt: Date | null): string | null {
  if (!processedAt) return null;
  const ms = processedAt.getTime() - createdAt.getTime();
  if (ms < 0) return null;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function deliveryHeaders(delivery: Pick<WebhookDeliveryDetail, "headers">) {
  return delivery.headers != null &&
    typeof delivery.headers === "object" &&
    !Array.isArray(delivery.headers) &&
    Object.keys(delivery.headers).length > 0
    ? (delivery.headers as Record<string, string>)
    : null;
}

export default function Page() {
  const data = useTypedLoaderData<typeof loader>();
  const { delivery } = data;
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const revalidator = useRevalidator();

  const inFlight = delivery?.status === "PENDING" || delivery?.status === "PROCESSING";
  useInterval({
    interval: data.isBeingRecorded ? 1000 : 3000,
    disabled: !inFlight && !data.isBeingRecorded,
    callback: () => revalidator.revalidate(),
  });

  const endpointsPath = v3WebhooksPath(organization, project, environment);

  if (!delivery) {
    return (
      <PageContainer>
        <NavBar>
          <DetailPageTitle title="Delivery" backButton={{ to: endpointsPath, text: "Endpoints" }} />
        </NavBar>
        <PageBody>
          {data.isBeingRecorded ? (
            <DetailTabEmpty
              title="Saving this delivery"
              description="It was received moments ago. It shows here as soon as it's saved."
              action={<Spinner color="muted" className="size-4" />}
            />
          ) : (
            <DetailTabEmpty
              title="Delivery not available"
              description={`It couldn't be found. Deliveries are kept for ${data.retentionDays} days, so it may have aged out.`}
              action={
                <LinkButton variant="secondary/small" to={endpointsPath}>
                  Back to endpoints
                </LinkButton>
              }
            />
          )}
        </PageBody>
      </PageContainer>
    );
  }

  const endpointPath = delivery.webhook
    ? v3WebhookEndpointPath(organization, project, environment, delivery.webhook.endpointFriendlyId)
    : undefined;

  return (
    <PageContainer>
      <NavBar>
        <DetailPageTitle
          title={delivery.friendlyId}
          crumbs={[
            { to: endpointsPath, text: "Endpoints" },
            ...(delivery.webhook && endpointPath
              ? [{ to: endpointPath, text: delivery.webhook.slug }]
              : []),
          ]}
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
        <DeliveryDetail data={data} delivery={delivery} endpointPath={endpointPath} />
      </PageBody>
    </PageContainer>
  );
}

function DeliveryDetail({
  data,
  delivery,
  endpointPath,
}: {
  data: LoaderData;
  delivery: Delivery;
  endpointPath?: string;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const [tab, setTab] = useDetailTab<DeliveryTabId>(DELIVERY_TABS);

  // The page names one run or session only when the delivery reached exactly one target;
  // otherwise the Targets tab lists them all.
  const reachedOneTarget =
    routedSubscriberCount(delivery.targets) === 1 && matchedWaiterCount(delivery.targets) === 0;
  const runPath =
    reachedOneTarget && delivery.run
      ? v3RunPath(organization, project, environment, { friendlyId: delivery.run.friendlyId })
      : undefined;
  const sessionPath =
    reachedOneTarget && delivery.session
      ? v3SessionPath(organization, project, environment, {
          friendlyId: delivery.session.friendlyId,
        })
      : undefined;
  const headers = deliveryHeaders(delivery);
  const duration = formatDuration(delivery.createdAt, delivery.processedAt);

  const tabs: DetailTab<DeliveryTabId>[] = [
    { id: "event", label: "Event" },
    { id: "headers", label: "Headers", count: headers ? Object.keys(headers).length : 0 },
    { id: "targets", label: "Targets", count: delivery.targets.length },
  ];

  return (
    <DetailPage
      id="webhook-delivery"
      header={
        <DetailHeader
          icon={WebhookIcon}
          iconClassName="text-webhooks"
          title={delivery.friendlyId}
          mono
          friendlyId={delivery.friendlyId}
          badges={delivery.isTest ? <Badge variant="extra-small">Test</Badge> : undefined}
          status={<DeliveryStatusBadge status={delivery.status} />}
          meta={[
            ...(delivery.webhook
              ? [
                  <span key="endpoint">
                    On <span className="font-mono">{delivery.webhook.slug}</span>
                  </span>,
                ]
              : []),
            <DateTime key="created" date={delivery.createdAt} />,
            ...(duration ? [`Processed in ${duration}`] : []),
          ]}
          secondaryActions={
            sessionPath ? (
              <LinkButton
                variant="secondary/small"
                to={sessionPath}
                LeadingIcon={AIChatIcon}
                leadingIconClassName="text-sessions"
              >
                View session
              </LinkButton>
            ) : runPath ? (
              <LinkButton
                variant="secondary/small"
                to={runPath}
                LeadingIcon={RunsIcon}
                leadingIconClassName="text-runs"
              >
                View run
              </LinkButton>
            ) : null
          }
          primaryAction={<ReplayButton canReplay={data.canReplay} />}
        />
      }
      tabs={<DetailTabs tabs={tabs} activeTab={tab} onTabChange={setTab} layoutId="delivery-tab" />}
      rail={
        <DeliveryRail
          delivery={delivery}
          endpointPath={endpointPath}
          runPath={runPath}
          sessionPath={sessionPath}
          reachedOneTarget={reachedOneTarget}
          duration={duration}
        />
      }
    >
      {tab === "targets" ? (
        <DetailTableTab>
          <DeliveryTargetsTable targets={delivery.targets} />
        </DetailTableTab>
      ) : tab === "headers" ? (
        headers ? (
          <DetailTableTab>
            <DeliveryHeadersTable headers={headers} />
          </DetailTableTab>
        ) : (
          <DetailTabEmpty
            title="No headers"
            description="No request headers were captured for this delivery."
          />
        )
      ) : data.eventJson ? (
        <div className="flex h-full flex-col gap-2 overflow-y-auto p-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
          {data.eventTruncatedForDisplay ? (
            <Callout variant="info">
              This event is {formatBytes(data.eventBytes)}. Showing the first{" "}
              {formatBytes(EVENT_DISPLAY_CAP)} for display. The full payload was delivered to your
              task.
            </Callout>
          ) : null}
          <CodeBlock code={data.eventJson} language="json" showLineNumbers maxLines={1000} />
        </div>
      ) : (
        <DetailTabEmpty
          title="No event"
          description="No event payload was captured for this delivery."
        />
      )}
    </DetailPage>
  );
}

function ReplayButton({ canReplay }: { canReplay: boolean }) {
  const navigation = useNavigation();
  const isReplaying = navigation.state === "submitting" && navigation.formMethod === "POST";
  return (
    <Form method="post">
      <Button
        type="submit"
        variant="primary/small"
        LeadingIcon={ArrowPathIcon}
        disabled={!canReplay || isReplaying}
        tooltip={
          canReplay
            ? "Run it again from the stored event, as a new delivery to every current subscriber"
            : "You don't have permission to replay webhook deliveries."
        }
      >
        {isReplaying ? "Replaying…" : "Replay"}
      </Button>
    </Form>
  );
}

function DeliveryRail({
  delivery,
  endpointPath,
  runPath,
  sessionPath,
  reachedOneTarget,
  duration,
}: {
  delivery: Delivery;
  endpointPath?: string;
  runPath?: string;
  sessionPath?: string;
  reachedOneTarget: boolean;
  duration: string | null;
}) {
  return (
    <PropertyRail>
      <PropertyGroup title="Timeline">
        <DeliveryTimeline delivery={delivery} runPath={runPath} sessionPath={sessionPath} />
        {delivery.status === "FAILED" && delivery.errorMessage ? (
          <RunError error={{ type: "STRING_ERROR", raw: delivery.errorMessage }} />
        ) : null}
      </PropertyGroup>
      <PropertyGroup title="Details">
        <PropertyPair>
          <DetailProperty label="Status">
            <DeliveryStatusBadge status={delivery.status} />
          </DetailProperty>
          {delivery.filterReason ? (
            <DetailProperty label="Filter reason">
              <span className="text-text-dimmed">{delivery.filterReason}</span>
            </DetailProperty>
          ) : null}
          <DetailProperty label="Endpoint">
            {delivery.webhook ? (
              endpointPath ? (
                <TextLink to={endpointPath} className="inline-flex items-center gap-1 font-mono">
                  <WebhookIcon className="size-4 text-webhooks" />
                  {delivery.webhook.slug}
                </TextLink>
              ) : (
                <span className="inline-flex items-center gap-1 font-mono">
                  <WebhookIcon className="size-4 text-webhooks" />
                  {delivery.webhook.slug}
                </span>
              )
            ) : (
              <span className="text-text-dimmed">Unknown</span>
            )}
          </DetailProperty>
          {delivery.session && sessionPath ? (
            <DetailProperty label="Session">
              <TextLink to={sessionPath} className="inline-flex items-center gap-1 font-mono">
                <AIChatIcon className="size-4 text-sessions" />
                {delivery.session.friendlyId}
              </TextLink>
            </DetailProperty>
          ) : null}
          {reachedOneTarget ? (
            <DetailProperty label="Run">
              {delivery.run && runPath ? (
                <TextLink to={runPath} className="inline-flex items-center gap-1 font-mono">
                  <RunsIcon className="size-4 text-runs" />
                  {delivery.run.friendlyId}
                </TextLink>
              ) : (
                <span className="text-text-dimmed">None</span>
              )}
            </DetailProperty>
          ) : null}
        </PropertyPair>
        <PropertyPair>
          <DetailProperty label="External delivery ID">
            <OptionalCopy value={delivery.externalDeliveryId} />
          </DetailProperty>
          <DetailProperty label="Idempotency key">
            <OptionalCopy value={delivery.idempotencyKey} />
          </DetailProperty>
          <DetailProperty label="Raw body hash">
            <OptionalCopy value={delivery.rawBodyHash} />
          </DetailProperty>
        </PropertyPair>
        <PropertyPair>
          <DetailProperty label="Created">
            <DateTime date={delivery.createdAt} />
          </DetailProperty>
          <DetailProperty label="Processed">
            {delivery.processedAt ? (
              <DateTime date={delivery.processedAt} />
            ) : (
              <span className="text-text-dimmed">Not yet</span>
            )}
          </DetailProperty>
          {duration ? <DetailProperty label="Duration">{duration}</DetailProperty> : null}
        </PropertyPair>
      </PropertyGroup>
    </PropertyRail>
  );
}

function OptionalCopy({ value }: { value: string | null }) {
  return value ? (
    <CopyableText value={value} className="min-w-0 font-mono text-xs" truncate />
  ) : (
    <span className="text-text-dimmed">None</span>
  );
}

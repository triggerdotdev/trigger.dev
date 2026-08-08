import { BookOpenIcon } from "@heroicons/react/24/solid";
import { type MetaFunction, useRevalidator } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { type ReactNode, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { AIChatIcon } from "~/assets/icons/AIChatIcon";
import { RunsIcon } from "~/assets/icons/RunsIcon";
import { WebhookIcon } from "~/assets/icons/WebhookIcon";
import { CodeBlock } from "~/components/code/CodeBlock";
import { PageBody } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { CopyableText } from "~/components/primitives/CopyableText";
import { TextLink } from "~/components/primitives/TextLink";
import { DateTime } from "~/components/primitives/DateTime";
import { Header2 } from "~/components/primitives/Headers";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import * as Property from "~/components/primitives/PropertyTable";
import { TabButton, TabContainer } from "~/components/primitives/Tabs";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import { DeliveryStatusBadge } from "~/components/webhookDeliveries/v1/DeliveryStatus";
import { DeliveryTimeline } from "~/components/webhookDeliveries/v1/DeliveryTimeline";
import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useInterval } from "~/hooks/useInterval";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import {
  WebhookDeliveryDetailPresenter,
  type WebhookDeliveryDetail,
} from "~/presenters/v3/WebhookDeliveryDetailPresenter.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { requireUser } from "~/services/session.server";
import {
  docsPath,
  EnvironmentParamSchema,
  v3RunPath,
  v3SessionPath,
  v3WebhooksPath,
  v3WebhookTaskPath,
} from "~/utils/pathBuilder";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { flag } from "~/v3/featureFlags.server";

const DeliveryParamSchema = EnvironmentParamSchema.extend({
  deliveryParam: z.string(),
});

export const meta: MetaFunction<typeof loader> = ({ data }) => {
  const friendlyId = (data as { delivery?: WebhookDeliveryDetail } | undefined)?.delivery
    ?.friendlyId;
  return [
    { title: friendlyId ? `${friendlyId} | Deliveries | Trigger.dev` : "Delivery | Trigger.dev" },
  ];
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  const userId = user.id;
  const { organizationSlug, projectParam, envParam, deliveryParam } =
    DeliveryParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) throw new Response("Project not found", { status: 404 });
  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) throw new Response("Environment not found", { status: 404 });

  // Feature gate: same as the deliveries list. Global FeatureFlag OR per-org override;
  // admins/impersonators always pass.
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

  const presenter = new WebhookDeliveryDetailPresenter($replica, clickhouse);
  const delivery = await presenter.call({
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    deliveryFriendlyId: deliveryParam,
  });

  // A missing delivery is most often one that aged out of retention (a bookmarked or shared link),
  // so render a friendly retention-aware state rather than a hard 404.
  return typedjson({ delivery, retentionDays: env.WEBHOOK_PARTITION_RETENTION_DAYS });
};

/** Centred placeholder for a tab whose content was never captured. */
function EmptyTabMessage({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center">
      <Paragraph variant="base" className="text-center text-text-dimmed">
        {children}
      </Paragraph>
    </div>
  );
}

function formatDuration(createdAt: Date, processedAt: Date | null): string | null {
  if (!processedAt) return null;
  const ms = processedAt.getTime() - createdAt.getTime();
  if (ms < 0) return null;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export default function Page() {
  const { delivery, retentionDays } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const revalidator = useRevalidator();

  const inFlight = delivery?.status === "PENDING" || delivery?.status === "PROCESSING";
  useInterval({
    interval: 3000,
    pauseWhenHidden: true,
    disabled: !inFlight,
    callback: () => revalidator.revalidate(),
  });

  const deliveriesPath = v3WebhooksPath(organization, project, environment);

  if (!delivery) {
    return (
      <>
        <NavBar>
          <PageTitle backButton={{ to: deliveriesPath, text: "Deliveries" }} title="Delivery" />
        </NavBar>
        <PageBody>
          <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-16 text-center">
            <WebhookIcon className="size-8 text-text-dimmed" />
            <Header2>Delivery not available</Header2>
            <Paragraph variant="small" className="text-text-dimmed">
              This delivery couldn't be found. Deliveries are retained for {retentionDays} days, so
              it may have aged out.
            </Paragraph>
            <LinkButton variant="secondary/small" to={deliveriesPath}>
              Back to deliveries
            </LinkButton>
          </div>
        </PageBody>
      </>
    );
  }

  const runPath = delivery.run
    ? v3RunPath(organization, project, environment, { friendlyId: delivery.run.friendlyId })
    : undefined;
  const sessionPath = delivery.session
    ? v3SessionPath(organization, project, environment, { friendlyId: delivery.session.friendlyId })
    : undefined;
  const webhookPath = delivery.webhook
    ? v3WebhookTaskPath(organization, project, environment, delivery.webhook.slug)
    : undefined;

  const eventJson =
    delivery.parsedEvent != null ? JSON.stringify(delivery.parsedEvent, null, 2) : null;
  const headersJson =
    delivery.headers != null && Object.keys(delivery.headers as object).length > 0
      ? JSON.stringify(delivery.headers, null, 2)
      : null;
  const duration = formatDuration(delivery.createdAt, delivery.processedAt);

  const [tab, setTab] = useState<"event" | "headers">("event");

  return (
    <>
      <NavBar>
        <PageTitle
          backButton={{ to: deliveriesPath, text: "Deliveries" }}
          title={
            <span className="flex items-center gap-2">
              <WebhookIcon className="size-4.5 text-webhooks" />
              <span className="font-mono">{delivery.friendlyId}</span>
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
          <ResizablePanel id="delivery-event" min="300px">
            <div className="grid h-full grid-rows-[auto_1fr] overflow-hidden">
              <div className="flex h-10 items-end border-b border-grid-dimmed bg-background-bright pl-3 pr-2">
                <TabContainer className="-mb-px">
                  <TabButton
                    isActive={tab === "event"}
                    layoutId="delivery-page-tabs"
                    onClick={() => setTab("event")}
                  >
                    Event payload
                  </TabButton>
                  <TabButton
                    isActive={tab === "headers"}
                    layoutId="delivery-page-tabs"
                    onClick={() => setTab("headers")}
                  >
                    Request headers
                  </TabButton>
                </TabContainer>
              </div>
              <div className="overflow-y-auto p-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
                {tab === "event" ? (
                  eventJson ? (
                    <CodeBlock code={eventJson} language="json" showLineNumbers maxLines={1000} />
                  ) : (
                    <EmptyTabMessage>
                      No event payload was captured for this delivery.
                    </EmptyTabMessage>
                  )
                ) : headersJson ? (
                  <CodeBlock
                    code={headersJson}
                    language="json"
                    showLineNumbers={false}
                    maxLines={200}
                  />
                ) : (
                  <EmptyTabMessage>
                    No request headers were captured for this delivery.
                  </EmptyTabMessage>
                )}
              </div>
            </div>
          </ResizablePanel>

          <ResizableHandle id="delivery-detail-handle" />
          <ResizablePanel
            id="delivery-detail"
            min="280px"
            default="380px"
            max="500px"
            isStaticAtRest
          >
            <div className="grid h-full grid-rows-[auto_1fr] overflow-hidden bg-background-bright">
              <div className="flex h-10 items-center gap-2 border-b border-grid-dimmed pl-3 pr-2">
                <Header2 className="truncate">Delivery</Header2>
              </div>
              <div className="overflow-y-auto px-3 py-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
                <DeliveryTimeline delivery={delivery} runPath={runPath} sessionPath={sessionPath} />
                <Property.Table>
                  <Property.Item>
                    <Property.Label>ID</Property.Label>
                    <Property.Value>
                      <CopyableText
                        value={delivery.friendlyId}
                        className="font-mono text-sm"
                        truncate
                      />
                    </Property.Value>
                  </Property.Item>
                  <Property.Item>
                    <Property.Label>Status</Property.Label>
                    <Property.Value>
                      <DeliveryStatusBadge status={delivery.status} />
                    </Property.Value>
                  </Property.Item>
                  {delivery.filterReason ? (
                    <Property.Item>
                      <Property.Label>Filter reason</Property.Label>
                      <Property.Value>
                        <span className="text-text-dimmed">{delivery.filterReason}</span>
                      </Property.Value>
                    </Property.Item>
                  ) : null}
                  <Property.Item>
                    <Property.Label>Webhook</Property.Label>
                    <Property.Value>
                      {delivery.webhook ? (
                        webhookPath ? (
                          <TextLink to={webhookPath} className="inline-flex items-center gap-1">
                            <WebhookIcon className="size-4 text-webhooks" />
                            {delivery.webhook.slug}
                          </TextLink>
                        ) : (
                          <span className="inline-flex items-center gap-1">
                            <WebhookIcon className="size-4 text-webhooks" />
                            {delivery.webhook.slug}
                          </span>
                        )
                      ) : (
                        <span className="text-text-dimmed">Unknown</span>
                      )}
                    </Property.Value>
                  </Property.Item>
                  {delivery.session && sessionPath ? (
                    <Property.Item>
                      <Property.Label>Session</Property.Label>
                      <Property.Value>
                        <TextLink
                          to={sessionPath}
                          className="inline-flex items-center gap-1 font-mono text-sm"
                        >
                          <AIChatIcon className="size-4 text-sessions" />
                          {delivery.session.friendlyId}
                        </TextLink>
                      </Property.Value>
                    </Property.Item>
                  ) : null}
                  <Property.Item>
                    <Property.Label>Run</Property.Label>
                    <Property.Value>
                      {delivery.run && runPath ? (
                        <TextLink
                          to={runPath}
                          className="inline-flex items-center gap-1 font-mono text-sm"
                        >
                          <RunsIcon className="size-4 text-runs" />
                          {delivery.run.friendlyId}
                        </TextLink>
                      ) : (
                        <span className="text-text-dimmed">None</span>
                      )}
                    </Property.Value>
                  </Property.Item>
                  <Property.Item>
                    <Property.Label>External delivery ID</Property.Label>
                    <Property.Value>
                      {delivery.externalDeliveryId ? (
                        <CopyableText
                          value={delivery.externalDeliveryId}
                          className="font-mono text-sm"
                          truncate
                        />
                      ) : (
                        <span className="text-text-dimmed">None</span>
                      )}
                    </Property.Value>
                  </Property.Item>
                  <Property.Item>
                    <Property.Label>Idempotency key</Property.Label>
                    <Property.Value>
                      {delivery.idempotencyKey ? (
                        <CopyableText
                          value={delivery.idempotencyKey}
                          className="font-mono text-sm"
                          truncate
                        />
                      ) : (
                        <span className="text-text-dimmed">None</span>
                      )}
                    </Property.Value>
                  </Property.Item>
                  <Property.Item>
                    <Property.Label>Raw body hash</Property.Label>
                    <Property.Value>
                      {delivery.rawBodyHash ? (
                        <CopyableText
                          value={delivery.rawBodyHash}
                          className="font-mono text-sm"
                          truncate
                        />
                      ) : (
                        <span className="text-text-dimmed">None</span>
                      )}
                    </Property.Value>
                  </Property.Item>
                  <Property.Item>
                    <Property.Label>Created</Property.Label>
                    <Property.Value>
                      <DateTime date={delivery.createdAt} />
                    </Property.Value>
                  </Property.Item>
                  <Property.Item>
                    <Property.Label>Processed</Property.Label>
                    <Property.Value>
                      {delivery.processedAt ? (
                        <DateTime date={delivery.processedAt} />
                      ) : (
                        <span className="text-text-dimmed">None</span>
                      )}
                    </Property.Value>
                  </Property.Item>
                  {duration ? (
                    <Property.Item>
                      <Property.Label>Duration</Property.Label>
                      <Property.Value>{duration}</Property.Value>
                    </Property.Item>
                  ) : null}
                  {delivery.status === "FAILED" && delivery.errorMessage ? (
                    <Property.Item>
                      <Property.Label>Error</Property.Label>
                      <Property.Value>
                        <span className="text-sm text-error">{delivery.errorMessage}</span>
                      </Property.Value>
                    </Property.Item>
                  ) : null}
                </Property.Table>
              </div>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </PageBody>
    </>
  );
}

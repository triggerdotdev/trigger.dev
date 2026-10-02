import { BookOpenIcon, ExclamationTriangleIcon } from "@heroicons/react/20/solid";
import type { WebhookDeliveryStatus } from "@trigger.dev/database";
import { Fragment, type ReactNode, Suspense } from "react";
import { Bar, type TooltipProps } from "recharts";
import { TypedAwait } from "remix-typedjson";
import { ClientOnly } from "remix-utils/client-only";
import { WebhookIcon } from "~/assets/icons/WebhookIcon";
import {
  ActivityBarChart,
  ActivityBarChartBlankState,
  ACTIVITY_CHART_HEIGHT,
} from "~/components/metrics/ActivityBarChart";
import { LinkButton } from "~/components/primitives/Buttons";
import { CopyableText } from "~/components/primitives/CopyableText";
import { DateTime, formatDateTime } from "~/components/primitives/DateTime";
import { Header3 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Spinner } from "~/components/primitives/Spinner";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import TooltipPortal from "~/components/primitives/TooltipPortal";
import {
  DELIVERY_STATUS_COLOR,
  DeliveryStatusBadge,
} from "~/components/webhookDeliveries/v1/DeliveryStatus";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import type {
  EndpointActivity,
  EndpointActivityBucket,
  WebhookEndpointsListItem,
} from "~/presenters/v3/WebhookEndpointsListPresenter.server";
import { formatNumberCompact } from "~/utils/numberFormatter";
import { docsPath, v3WebhookEndpointPath } from "~/utils/pathBuilder";
import { CopySetupPromptButton } from "./CopySetupPromptButton";

export type EndpointsListRow = WebhookEndpointsListItem & { ingestUrl: string };

const STATUS_STYLE: Record<EndpointsListRow["status"], { color: string; label: string }> = {
  ACTIVE: { color: "#28BF5C", label: "Active" },
  INACTIVE: { color: "#878C99", label: "Inactive" },
  DISABLED: { color: "#F59E0B", label: "Disabled" },
};

const ACTIVITY_BARS: WebhookDeliveryStatus[] = [
  "SUCCEEDED",
  "FAILED",
  "PROCESSING",
  "PENDING",
  "FILTERED",
  "UNMATCHED",
];

const ACTIVITY_CELL_WIDTH = 146;

const COLUMNS = 8;

/**
 * The environment's endpoints, one row per endpoint instance, grouped under their declared endpoint.
 * A declared endpoint with several instances (tenant endpoints) gets a group header row.
 */
export function EndpointsListTable({
  endpoints,
  activity,
  hasFilters,
}: {
  endpoints: EndpointsListRow[];
  activity: Promise<EndpointActivity>;
  hasFilters: boolean;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const groups: Array<{ declaredId: string; rows: EndpointsListRow[] }> = [];
  for (const endpoint of endpoints) {
    const last = groups[groups.length - 1];
    if (last && last.declaredId === endpoint.declaredId) last.rows.push(endpoint);
    else groups.push({ declaredId: endpoint.declaredId, rows: [endpoint] });
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHeaderCell tooltip={<EndpointInfo />}>Endpoint</TableHeaderCell>
          <TableHeaderCell tooltip={<SourceInfo />}>Source</TableHeaderCell>
          <TableHeaderCell tooltip={<StatusInfo />}>Status</TableHeaderCell>
          <TableHeaderCell tooltip={<UrlInfo />}>URL</TableHeaderCell>
          <TableHeaderCell tooltip={<SigningSecretInfo />}>Signing secret</TableHeaderCell>
          <TableHeaderCell tooltip={<ActivityInfo />}>Activity (24h)</TableHeaderCell>
          <TableHeaderCell tooltip={<LastDeliveryInfo />}>Last delivery</TableHeaderCell>
          <TableHeaderCell alignment="right" tooltip={<SetupPromptInfo />}>
            AI setup
          </TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {endpoints.length === 0 ? (
          <TableBlankRow colSpan={COLUMNS}>
            <div className="flex items-center justify-center">
              <Paragraph className="w-auto">
                {hasFilters ? "No endpoints match these filters" : "No endpoints yet"}
              </Paragraph>
            </div>
          </TableBlankRow>
        ) : (
          groups.map((group) => (
            <Fragment key={group.declaredId}>
              {group.rows.length > 1 ? (
                <TableRow>
                  <TableCell colSpan={COLUMNS} className="bg-background-bright">
                    <span className="flex items-center gap-2 text-xs text-text-dimmed">
                      <WebhookIcon className="size-4 text-webhooks" />
                      <span className="font-mono text-text-bright">{group.declaredId}</span>
                      <span>{group.rows.length} instances</span>
                    </span>
                  </TableCell>
                </TableRow>
              ) : null}
              {group.rows.map((endpoint) => {
                const endpointPath = v3WebhookEndpointPath(
                  organization,
                  project,
                  environment,
                  endpoint.friendlyId
                );
                return (
                  <TableRow key={endpoint.id}>
                    <TableCell to={endpointPath}>
                      <span className="flex flex-col">
                        <span className="flex items-center gap-1.5">
                          <WebhookIcon className="size-4 flex-none text-webhooks" />
                          <span className="font-mono text-xs text-text-bright">
                            {endpoint.declaredId}
                          </span>
                        </span>
                        {endpoint.tenantId ? (
                          <span className="pl-5 text-xxs text-text-dimmed">
                            tenant {endpoint.tenantId}
                            {endpoint.externalRef ? ` · ${endpoint.externalRef}` : ""}
                          </span>
                        ) : null}
                      </span>
                    </TableCell>
                    <TableCell to={endpointPath}>
                      <span className="text-xs">{endpoint.source}</span>
                    </TableCell>
                    <TableCell to={endpointPath}>
                      <EndpointStatusLabel status={endpoint.status} />
                    </TableCell>
                    <TableCell className="max-w-[18rem]">
                      <CopyableText
                        value={endpoint.ingestUrl}
                        truncate
                        className="font-mono text-xs"
                      />
                    </TableCell>
                    <TableCell to={endpointPath}>
                      <SigningSecretState ready={endpoint.hasSigningSecret} />
                    </TableCell>
                    <TableCell to={endpointPath} actionClassName="py-1.5">
                      <div style={{ width: ACTIVITY_CELL_WIDTH, height: ACTIVITY_CHART_HEIGHT }}>
                        <ClientOnly fallback={<ActivityBarChartBlankState />}>
                          {() => (
                            <Suspense fallback={<ActivityBarChartBlankState />}>
                              <TypedAwait
                                resolve={activity}
                                errorElement={<FailedToLoadActivity />}
                              >
                                {(data) => {
                                  const buckets = data[endpoint.id]?.buckets;
                                  return buckets && buckets.some((bucket) => bucket.total > 0) ? (
                                    <EndpointActivityGraph buckets={buckets} />
                                  ) : (
                                    <ActivityBarChartBlankState />
                                  );
                                }}
                              </TypedAwait>
                            </Suspense>
                          )}
                        </ClientOnly>
                      </div>
                    </TableCell>
                    <TableCell to={endpointPath}>
                      <ClientOnly fallback={<Spinner color="blue" className="size-3" />}>
                        {() => (
                          <Suspense fallback={<Spinner color="blue" className="size-3" />}>
                            <TypedAwait resolve={activity} errorElement={<FailedToLoadActivity />}>
                              {(data) => {
                                const lastDeliveryAt = data[endpoint.id]?.lastDeliveryAt;
                                return lastDeliveryAt ? (
                                  <DateTime date={lastDeliveryAt} />
                                ) : (
                                  <span className="text-text-dimmed">None in 24h</span>
                                );
                              }}
                            </TypedAwait>
                          </Suspense>
                        )}
                      </ClientOnly>
                    </TableCell>
                    <TableCell alignment="right">
                      <CopySetupPromptButton
                        endpointFriendlyId={endpoint.friendlyId}
                        source={endpoint.source}
                        variant="minimal/small"
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </Fragment>
          ))
        )}
      </TableBody>
    </Table>
  );
}

const DELIVERY_STATUS_DESCRIPTIONS: Array<{ status: WebhookDeliveryStatus; description: string }> =
  [
    {
      status: "SUCCEEDED",
      description: "Every subscriber or waiting run that accepted it was triggered.",
    },
    {
      status: "FAILED",
      description:
        "At least one subscriber couldn't be triggered after every retry. Replay it from the delivery.",
    },
    { status: "PROCESSING", description: "Verified and being routed to subscribers now." },
    { status: "PENDING", description: "Verified and queued for routing." },
    { status: "FILTERED", description: "Verified, but no subscriber's filter accepted it." },
    {
      status: "UNMATCHED",
      description: "Verified, but no subscriber accepted it and no waiting run matched it.",
    },
  ];

function EndpointStatusLabel({ status }: { status: EndpointsListRow["status"] }) {
  const style = STATUS_STYLE[status];
  return (
    <span className="flex items-center gap-1.5">
      <span className="size-2 rounded-full" style={{ backgroundColor: style.color }} />
      <span>{style.label}</span>
    </span>
  );
}

function SigningSecretState({ ready }: { ready: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className={ready ? "size-2 rounded-full bg-success" : "size-2 rounded-full bg-warning"}
      />
      <span className={ready ? undefined : "text-warning"}>{ready ? "Ready" : "Needs secret"}</span>
    </span>
  );
}

function InfoPopover({ children, docs = true }: { children: ReactNode; docs?: boolean }) {
  return (
    <div className="flex max-w-xs flex-col gap-3 p-1">
      {children}
      {docs ? (
        <LinkButton
          to={docsPath("webhooks/overview")}
          variant="docs/small"
          LeadingIcon={BookOpenIcon}
          className="self-start"
        >
          Read docs
        </LinkButton>
      ) : null}
    </div>
  );
}

function InfoText({ children }: { children: ReactNode }) {
  return (
    <Paragraph variant="small" className="text-wrap! text-text-dimmed">
      {children}
    </Paragraph>
  );
}

function StateLegend({
  labelWidth = "6.5rem",
  items,
}: {
  labelWidth?: string;
  items: Array<{ key: string; label: ReactNode; description: string }>;
}) {
  return (
    <div className="flex flex-col divide-y divide-grid-dimmed">
      {items.map((item) => (
        <div
          key={item.key}
          className="grid gap-x-2 py-2 first:pt-0 last:pb-0"
          style={{ gridTemplateColumns: `${labelWidth} 1fr` }}
        >
          <div className="flex items-start">{item.label}</div>
          <Paragraph variant="extra-small" className="text-wrap! text-text-dimmed">
            {item.description}
          </Paragraph>
        </div>
      ))}
    </div>
  );
}

function SourceInfo() {
  return (
    <InfoPopover>
      <InfoText>
        The provider the endpoint receives from, such as stripe or github. It sets how deliveries
        are verified.
      </InfoText>
    </InfoPopover>
  );
}

function EndpointInfo() {
  return (
    <InfoPopover>
      <InfoText>
        One URL you register with a provider, declared in your code with webhooks.endpoint.define.
      </InfoText>
      <InfoText>
        Tasks, agents and waiting runs subscribe to an endpoint, so one provider webhook can feed
        several of them. Open an endpoint to see its subscribers and deliveries.
      </InfoText>
    </InfoPopover>
  );
}

function StatusInfo() {
  return (
    <InfoPopover>
      <StateLegend
        labelWidth="5rem"
        items={[
          {
            key: "active",
            label: <EndpointStatusLabel status="ACTIVE" />,
            description: "Declared in the current version and accepting deliveries.",
          },
          {
            key: "inactive",
            label: <EndpointStatusLabel status="INACTIVE" />,
            description:
              "No longer declared in your latest dev session or deploy. Its URL answers 404 until you declare it again.",
          },
          {
            key: "disabled",
            label: <EndpointStatusLabel status="DISABLED" />,
            description:
              "Turned off through the API. Its URL answers 404, and deploys leave it off until it's enabled again.",
          },
        ]}
      />
    </InfoPopover>
  );
}

function UrlInfo() {
  return (
    <InfoPopover docs={false}>
      <InfoText>
        Paste this into the provider's webhook settings. Each endpoint, environment and tenant gets
        its own URL.
      </InfoText>
      <InfoText>
        The URL only says where a delivery goes. The signature, checked against the signing secret,
        is what proves it came from the provider.
      </InfoText>
    </InfoPopover>
  );
}

function SigningSecretInfo() {
  return (
    <InfoPopover>
      <InfoText>
        Providers sign every delivery. Trigger.dev checks the signature against this endpoint's
        signing secret before it records or routes anything.
      </InfoText>
      <StateLegend
        items={[
          {
            key: "ready",
            label: <SigningSecretState ready />,
            description: "A secret is stored, so signed deliveries are accepted.",
          },
          {
            key: "needs",
            label: <SigningSecretState ready={false} />,
            description:
              "No secret yet, so every delivery is rejected. Some providers issue the secret (Stripe, Slack); for others you generate one here and give it to the provider (GitHub).",
          },
        ]}
      />
      <InfoText>
        Add or rotate it on the endpoint page, or copy the setup prompt and let an AI agent do it.
      </InfoText>
    </InfoPopover>
  );
}

function ActivityInfo() {
  return (
    <InfoPopover>
      <InfoText>
        Deliveries per hour over the last 24 hours, stacked by status. The number is the busiest
        hour.
      </InfoText>
      <StateLegend
        items={DELIVERY_STATUS_DESCRIPTIONS.map(({ status, description }) => ({
          key: status,
          label: <DeliveryStatusBadge status={status} />,
          description,
        }))}
      />
      <InfoText>Rejected requests, such as a bad signature, aren't recorded or counted.</InfoText>
    </InfoPopover>
  );
}

function LastDeliveryInfo() {
  return (
    <InfoPopover docs={false}>
      <InfoText>
        When the most recent delivery in the last 24 hours arrived, whatever its status. Open the
        endpoint for older deliveries.
      </InfoText>
    </InfoPopover>
  );
}

function SetupPromptInfo() {
  return (
    <InfoPopover>
      <InfoText>
        Copies a prompt for an AI coding agent, like Claude Code, that connects the endpoint to its
        provider.
      </InfoText>
      <InfoText>
        It includes the webhook URL, the events each subscriber's filter needs and how to handle the
        signing secret. The agent stores or generates the secret with the Trigger.dev MCP tools, so
        the secret itself is never in the prompt.
      </InfoText>
    </InfoPopover>
  );
}

function EndpointActivityGraph({ buckets }: { buckets: EndpointActivityBucket[] }) {
  const maxTotal = Math.max(...buckets.map((bucket) => bucket.total));

  return (
    <ActivityBarChart
      data={buckets}
      max={maxTotal}
      tooltip={<EndpointActivityTooltip />}
      peak={formatNumberCompact(maxTotal)}
      peakTooltip="Peak deliveries in a single hour"
    >
      {ACTIVITY_BARS.map((status) => (
        <Bar
          key={status}
          dataKey={status}
          stackId="a"
          fill={DELIVERY_STATUS_COLOR[status]}
          strokeWidth={0}
          isAnimationActive={false}
        />
      ))}
    </ActivityBarChart>
  );
}

const EndpointActivityTooltip = ({ active, payload }: TooltipProps<number, string>) => {
  if (!active || !payload || payload.length === 0) return null;

  const entry = payload[0].payload as EndpointActivityBucket;
  const date = entry.date instanceof Date ? entry.date : new Date(entry.date);
  const items = ACTIVITY_BARS.filter((status) => (entry[status] ?? 0) > 0);

  return (
    <TooltipPortal active={active}>
      <div className="rounded-sm border border-grid-bright bg-background-dimmed px-3 py-2">
        <Header3 className="border-b border-b-border-bright pb-2">
          {formatDateTime(date, "UTC", [], false, true)}
        </Header3>
        {items.length === 0 ? (
          <div className="mt-2 text-xs text-text-dimmed">No deliveries</div>
        ) : (
          <div className="mt-2 grid grid-cols-[1fr_auto] gap-2 text-xs text-text-bright">
            {items.map((status) => (
              <Fragment key={status}>
                <DeliveryStatusBadge status={status} />
                <p className="tabular-nums">{entry[status]}</p>
              </Fragment>
            ))}
          </div>
        )}
      </div>
    </TooltipPortal>
  );
};

function FailedToLoadActivity() {
  return (
    <SimpleTooltip
      button={<ExclamationTriangleIcon className="size-4 text-warning" />}
      content="We were unable to load the delivery activity, please try again later."
    />
  );
}

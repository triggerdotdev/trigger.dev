import { useLocation, useNavigation, useRevalidator, useSearchParams } from "@remix-run/react";
import type { WebhookDeliveryStatus } from "@trigger.dev/database";
import {
  type MutableRefObject,
  type ReactElement,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { WebhookIcon } from "~/assets/icons/WebhookIcon";
import { ListPagination } from "~/components/ListPagination";
import { Button } from "~/components/primitives/Buttons";
import { buildActivityTimeAxis } from "~/components/primitives/charts/activityTimeAxis";
import { ChartBlankState } from "~/components/primitives/charts/ChartBlankState";
import { Chart, type ChartConfig } from "~/components/primitives/charts/ChartCompound";
import { ChartSyncProvider } from "~/components/primitives/charts/ChartSyncContext";
import { RelativeDateTime } from "~/components/primitives/DateTime";
import { DeferredContent } from "~/components/primitives/detail/DeferredContent";
import {
  ChartSkeleton,
  DetailTabEmpty,
  DetailTabError,
  DetailTabLoading,
  DetailTableTab,
  SkeletonBone,
} from "~/components/primitives/detail/DetailSections";
import { PulsingDot } from "~/components/primitives/PulsingDot";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useZoomToTimeFilter } from "~/hooks/useZoomToTimeFilter";
import type {
  DeliveryActivity,
  WebhookDeliveriesList,
} from "~/presenters/v3/WebhookDetailPresenter.server";
import { formatNumber } from "~/utils/numberFormatter";
import { DeliveriesTable, type DeliveryEndpointLabel } from "./DeliveriesTable";
import { DeliveryFilters } from "./DeliveryFilters";
import { DELIVERY_STATUS_COLOR, DELIVERY_STATUS_LABEL } from "./DeliveryStatus";
import { useDeliveriesLiveReload } from "./useDeliveriesLiveReload";

const DELIVERY_SKELETON_COLUMNS = [
  { label: "Delivery" },
  { label: "Status" },
  { label: "External delivery ID" },
  { label: "Created" },
  { label: "Error" },
];

/**
 * A detail page's Deliveries tab, for one endpoint or every endpoint a webhook task subscribes
 * to: the delivery filters, a band with deliveries over time and how they turned out, then the
 * live deliveries table.
 */
export function DeliveriesTab({
  deliveriesList,
  activity,
  webhookEndpointIds,
  webhookTaskSlug,
  isPending,
  endpoints,
  emptyAction,
}: {
  deliveriesList: Promise<WebhookDeliveriesList | null>;
  activity: Promise<DeliveryActivity>;
  webhookEndpointIds: string[];
  /** On a webhook task's page: new deliveries are counted across the task's endpoints. */
  webhookTaskSlug?: string;
  /** The tab was just opened and its loader data hasn't landed. */
  isPending: boolean;
  /** Adds an Endpoint column, for a list across several endpoints. */
  endpoints?: Record<string, DeliveryEndpointLabel>;
  /** What an empty, unfiltered list offers, e.g. sending a test event. */
  emptyAction?: ReactNode;
}) {
  const location = useLocation();
  const [newDeliveriesCount, setNewDeliveriesCount] = useState(0);
  const showNewDeliveriesRef = useRef<() => void>(() => {});

  // The band and table keep their data while the same query reloads (live polling); a new period,
  // filter or page starts over with the skeleton.
  const params = new URLSearchParams(location.search);
  params.delete("tab");
  const retainKey = params.toString();
  const filtered = ["statuses", "mode", "deliveryId", "cursor"].some((key) => params.has(key));

  const tools = <DeliveryFilters />;
  const newDeliveries =
    newDeliveriesCount > 0 ? (
      <NewDeliveriesButton
        count={newDeliveriesCount}
        onClick={() => showNewDeliveriesRef.current()}
      />
    ) : null;
  const band = <DeliveriesBand activity={activity} retainKey={retainKey} />;
  const skeleton = (
    <DetailTableTab tools={tools} actions={newDeliveries} above={band}>
      <DetailTabLoading columns={DELIVERY_SKELETON_COLUMNS} rows={12} />
    </DetailTableTab>
  );

  if (isPending) return skeleton;

  return (
    <DeferredContent
      resolve={deliveriesList}
      retainKey={retainKey}
      fallback={skeleton}
      errorElement={
        <DetailTableTab tools={tools} above={band}>
          <DetailTabError
            title="Couldn't load deliveries"
            cause="The deliveries didn't load. Try again in a moment."
          />
        </DetailTableTab>
      }
    >
      {(list) =>
        !list ? (
          <DetailTableTab tools={tools} above={band}>
            <DetailTabError
              title="Couldn't load deliveries"
              cause="The deliveries didn't load. Try again in a moment."
            />
          </DetailTableTab>
        ) : (
          <DetailTableTab
            tools={tools}
            actions={
              <>
                {newDeliveries}
                <ListPagination list={list} />
              </>
            }
            above={band}
          >
            <LiveDeliveriesTable
              list={list}
              webhookEndpointIds={webhookEndpointIds}
              webhookTaskSlug={webhookTaskSlug}
              endpoints={endpoints}
              onNewDeliveriesCountChange={setNewDeliveriesCount}
              showNewDeliveriesRef={showNewDeliveriesRef}
              emptyState={
                list.deliveries.length === 0 && !filtered && emptyAction ? (
                  <DetailTabEmpty
                    title="No deliveries in this period"
                    description="Point the provider at the webhook URL, or send a test event."
                    action={emptyAction}
                  />
                ) : undefined
              }
            />
          </DetailTableTab>
        )
      }
    </DeferredContent>
  );
}

// ---------- Band ----------

function DeliveriesBand({
  activity,
  retainKey,
}: {
  activity: Promise<DeliveryActivity>;
  retainKey: string;
}) {
  const zoomToTimeFilter = useZoomToTimeFilter();

  const loading = (
    <>
      <div className="flex min-w-0 flex-col gap-1.5 px-3 pb-2 pt-2.5">
        <div className="flex h-5 items-baseline gap-2">
          <span className="text-xs text-text-dimmed">Deliveries</span>
          <SkeletonBone className="h-3 w-10" />
        </div>
        <div className="min-h-0 flex-1">
          <ChartSkeleton bars={42} />
        </div>
      </div>
      <div className="hidden min-w-0 flex-col gap-2 border-l border-grid-bright px-3 pb-2 pt-2.5 @2xl:flex">
        <span className="h-5 text-xs text-text-dimmed">Outcomes</span>
        {[0, 1, 2].map((row) => (
          <SkeletonBone key={row} className="h-3 w-full" />
        ))}
      </div>
    </>
  );

  return (
    // The outcomes panel only shows when the main column has room for it beside the chart.
    <div className="@container flex-none border-b border-grid-bright">
      <div className="grid h-40 grid-cols-1 @2xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <DeferredContent
          resolve={activity}
          retainKey={retainKey}
          fallback={loading}
          errorElement={loading}
        >
          {(result) => {
            const total = sumTotals(result.totals);
            return (
              <>
                <div className="flex min-w-0 flex-col gap-1.5 px-3 pb-2 pt-2.5">
                  <div className="flex h-5 items-baseline gap-2">
                    <span className="text-xs text-text-dimmed">Deliveries</span>
                    <span className="text-sm font-medium tabular-nums text-text-bright">
                      {formatNumber(total)}
                    </span>
                  </div>
                  <div className="min-h-0 flex-1">
                    {total > 0 ? (
                      <ChartSyncProvider onZoom={zoomToTimeFilter}>
                        <DeliveriesByStatusChart activity={result} />
                      </ChartSyncProvider>
                    ) : (
                      <ChartBlankState icon={WebhookIcon} message="No deliveries in this period" />
                    )}
                  </div>
                </div>
                <DeliveryOutcomes activity={result} total={total} />
              </>
            );
          }}
        </DeferredContent>
      </div>
    </div>
  );
}

function sumTotals(totals: DeliveryActivity["totals"]) {
  return Object.values(totals).reduce((sum, count) => sum + (count ?? 0), 0);
}

function DeliveriesByStatusChart({ activity }: { activity: DeliveryActivity }) {
  const chartConfig: ChartConfig = useMemo(() => {
    const cfg: ChartConfig = {};
    for (const status of activity.statuses) {
      cfg[status] = { label: DELIVERY_STATUS_LABEL[status], color: DELIVERY_STATUS_COLOR[status] };
    }
    return cfg;
  }, [activity.statuses]);

  const { tickFormatter, tooltipLabelFormatter } = useMemo(
    () => buildActivityTimeAxis(activity.data),
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
        xAxisProps={{ tickFormatter }}
        tooltipLabelFormatter={tooltipLabelFormatter}
      />
    </Chart.Root>
  );
}

/** How the period's deliveries turned out: one bar per status, longest first. */
function DeliveryOutcomes({ activity, total }: { activity: DeliveryActivity; total: number }) {
  const rows = activity.statuses
    .map((status) => ({ status, count: activity.totals[status] ?? 0 }))
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count);

  return (
    <div className="hidden min-w-0 flex-col gap-2 border-l border-grid-bright px-3 pb-2 pt-2.5 @2xl:flex">
      <div className="flex h-5 items-baseline justify-between gap-2 text-xs text-text-dimmed">
        <span>Outcomes</span>
        {activity.lastDeliveryAt ? (
          <span className="truncate">
            Last <RelativeDateTime date={activity.lastDeliveryAt} capitalize={false} />
          </span>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <span className="text-xs text-text-faint">Nothing received in this period</span>
      ) : (
        <ul className="flex min-h-0 flex-col gap-1.5 overflow-y-auto scrollbar-none">
          {rows.map((row) => (
            <OutcomeRow key={row.status} status={row.status} count={row.count} total={total} />
          ))}
        </ul>
      )}
    </div>
  );
}

function OutcomeRow({
  status,
  count,
  total,
}: {
  status: WebhookDeliveryStatus;
  count: number;
  total: number;
}) {
  const percent = total === 0 ? 0 : (count / total) * 100;
  return (
    <li className="grid grid-cols-[5.5rem_minmax(0,1fr)_auto] items-center gap-2 text-xs">
      <span className="flex items-center gap-1.5 text-text-dimmed">
        <span
          className="size-2 flex-none rounded-full"
          style={{ backgroundColor: DELIVERY_STATUS_COLOR[status] }}
        />
        {DELIVERY_STATUS_LABEL[status]}
      </span>
      <span className="h-1.5 overflow-hidden rounded-full bg-background-deep">
        <span
          className="block h-full rounded-full"
          style={{
            width: `${Math.max(percent, 2)}%`,
            backgroundColor: DELIVERY_STATUS_COLOR[status],
          }}
        />
      </span>
      <span className="tabular-nums text-text-bright">
        {formatNumber(count)}
        <span className="ml-1.5 inline-block w-9 text-right text-text-faint">
          {percent < 1 ? "<1" : Math.round(percent)}%
        </span>
      </span>
    </li>
  );
}

// ---------- Table ----------

function NewDeliveriesButton({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <span className="flex duration-150 animate-in fade-in-0">
      <Button
        variant="secondary/small"
        className="text-text-bright"
        onClick={onClick}
        LeadingIcon={<PulsingDot className="h-2 w-2" />}
        tooltip="Refresh to see new deliveries"
        aria-label="New deliveries received. Refresh to see them."
      >
        {count >= 100
          ? "99+ new deliveries"
          : `${count} new ${count === 1 ? "delivery" : "deliveries"}`}
      </Button>
    </span>
  );
}

/**
 * The deliveries, with live status updates. Deliveries that arrived since load are surfaced to the
 * toolbar's button via `onNewDeliveriesCountChange` and `showNewDeliveriesRef`. `emptyState`
 * stands in for the table, and arrivals are still watched for behind it, so an endpoint's first
 * delivery shows up without a reload.
 */
function LiveDeliveriesTable({
  list,
  webhookEndpointIds,
  webhookTaskSlug,
  endpoints,
  onNewDeliveriesCountChange,
  showNewDeliveriesRef,
  emptyState,
}: {
  list: WebhookDeliveriesList;
  webhookEndpointIds: string[];
  webhookTaskSlug?: string;
  endpoints?: Record<string, DeliveryEndpointLabel>;
  onNewDeliveriesCountChange: (count: number) => void;
  showNewDeliveriesRef: MutableRefObject<() => void>;
  emptyState?: ReactElement;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const [searchParams, setSearchParams] = useSearchParams();

  const { visibleDeliveries, newDeliveriesCount, dismissNewDeliveries } = useDeliveriesLiveReload({
    deliveries: list.deliveries,
    isLoading: navigation.state !== "idle",
    webhookEndpointIds,
    webhookTaskSlug,
    organizationSlug: organization.slug,
    projectSlug: project.slug,
    environmentSlug: environment.slug,
  });

  // Keep the toolbar button's action current, mirror the count up, and clear it on unmount (the
  // table re-suspends on a filter change, or another tab is picked).
  useEffect(() => {
    showNewDeliveriesRef.current = () => {
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
  }, [dismissNewDeliveries, revalidator, searchParams, setSearchParams, showNewDeliveriesRef]);
  useEffect(() => {
    onNewDeliveriesCountChange(newDeliveriesCount);
  }, [newDeliveriesCount, onNewDeliveriesCountChange]);
  useEffect(() => () => onNewDeliveriesCountChange(0), [onNewDeliveriesCountChange]);

  if (emptyState) return emptyState;

  return (
    <DeliveriesTable
      deliveries={visibleDeliveries}
      hasFilters={list.hasFilters}
      endpoints={endpoints}
      showTopBorder={false}
      stickyHeader
    />
  );
}

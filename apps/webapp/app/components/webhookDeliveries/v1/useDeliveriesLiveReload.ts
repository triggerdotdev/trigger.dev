import { useLocation } from "@remix-run/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTypedFetcher } from "remix-typedjson";
import { useInterval } from "~/hooks/useInterval";
import { type EndpointDeliveryListItem } from "~/presenters/v3/WebhookDetailPresenter.server";
import {
  type LiveDeliveryFields,
  type loader as liveDeliveriesLoader,
} from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.webhooks.deliveries.live";
import { DELIVERY_FILTER_PARAMS } from "./deliveryListFilters";
import { isLiveCountTick, liveCountScope } from "./liveCountScope";

const DELIVERIES_POLL_INTERVAL_MS = 3000;

const IN_FLIGHT_STATUSES = new Set(["PENDING", "PROCESSING"]);

type ListedDelivery = EndpointDeliveryListItem;
type LivePollFetcherData =
  | { deliveries: LiveDeliveryFields[] }
  | { deliveries: LiveDeliveryFields[]; count: number; since: number }
  | undefined;

function hasNewDeliveriesCountFields(
  data: LivePollFetcherData
): data is NonNullable<LivePollFetcherData> & { count: number; since: number } {
  return data !== undefined && "count" in data && "since" in data;
}

function maxCreatedAtMs(deliveries: ListedDelivery[]): number | undefined {
  if (deliveries.length === 0) return undefined;

  return deliveries.reduce<number>((maxTimestamp, delivery) => {
    return Math.max(maxTimestamp, new Date(delivery.createdAt).getTime());
  }, 0);
}

function patchVisibleDeliveriesWithLiveUpdates(
  currentDeliveries: ListedDelivery[],
  liveDeliveries: LiveDeliveryFields[]
) {
  const updatesById = new Map(liveDeliveries.map((delivery) => [delivery.friendlyId, delivery]));

  return currentDeliveries.map((delivery) => {
    const update = updatesById.get(delivery.friendlyId);
    if (!update) return delivery;

    return {
      ...delivery,
      status: update.status,
      errorMessage: update.errorMessage,
      processedAt: update.processedAt,
    };
  });
}

function useNewDeliveriesDetection({
  deliveries,
  isLoading,
  everyTicks,
}: {
  deliveries: ListedDelivery[];
  isLoading: boolean;
  /** New deliveries are counted on every nth poll tick. */
  everyTicks: number;
}) {
  const pollTickRef = useRef(0);
  const [knownNewestDeliveryMs, setKnownNewestDeliveryMs] = useState(
    () => maxCreatedAtMs(deliveries) ?? Date.now()
  );
  const [newDeliveriesCount, setNewDeliveriesCount] = useState(0);

  const shouldPollForNewDeliveries = !isLoading && newDeliveriesCount < 100;

  const resetNewDeliveriesTracking = useCallback(() => {
    setKnownNewestDeliveryMs(maxCreatedAtMs(deliveries) ?? Date.now());
    setNewDeliveriesCount(0);
    pollTickRef.current = 0;
  }, [deliveries]);

  const dismissNewDeliveries = useCallback(() => {
    setNewDeliveriesCount(0);
    setKnownNewestDeliveryMs(Date.now());
    pollTickRef.current = 0;
  }, []);

  const checkNewDeliveriesOnTick = useCallback(() => {
    pollTickRef.current += 1;
    return shouldPollForNewDeliveries && isLiveCountTick(pollTickRef.current, everyTicks);
  }, [shouldPollForNewDeliveries, everyTicks]);

  return {
    knownNewestDeliveryMs,
    newDeliveriesCount,
    setNewDeliveriesCount,
    shouldPollForNewDeliveries,
    dismissNewDeliveries,
    checkNewDeliveriesOnTick,
    resetNewDeliveriesTracking,
  };
}

export function useDeliveriesLiveReload({
  deliveries,
  isLoading,
  webhookEndpointIds,
  webhookTaskSlug,
  organizationSlug,
  projectSlug,
  environmentSlug,
}: {
  deliveries: ListedDelivery[];
  isLoading: boolean;
  /** Omit to poll across every endpoint in the environment (the cross-endpoint deliveries list). */
  webhookEndpointIds?: string[];
  /**
   * On a webhook task's page. Its endpoint ids are sent like any other page's; only when the task
   * subscribes to more endpoints than fit in a URL does the server look them up.
   */
  webhookTaskSlug?: string;
  organizationSlug: string;
  projectSlug: string;
  environmentSlug: string;
}) {
  const location = useLocation();
  // Strings and numbers, so a new array with the same ids doesn't rebuild the poll.
  const scope = liveCountScope({ webhookEndpointIds, webhookTaskSlug });
  const endpointIdsParam = scope.kind === "endpoints" ? scope.ids : "";
  const taskSlugParam = scope.kind === "task" ? scope.slug : "";
  // An empty list is no endpoints, not every endpoint: there is nothing that could arrive.
  const hasNoEndpoints = scope.kind === "none";
  const deliveriesPollFetcher = useTypedFetcher<typeof liveDeliveriesLoader>();
  const deliveriesPollFetcherStateRef = useRef(deliveriesPollFetcher.state);
  // oxlint-disable-next-line react/refs -- This ref intentionally coordinates an imperative integration outside React state.
  deliveriesPollFetcherStateRef.current = deliveriesPollFetcher.state;

  const [visibleDeliveries, setVisibleDeliveries] = useState(deliveries);

  const {
    knownNewestDeliveryMs,
    newDeliveriesCount,
    setNewDeliveriesCount,
    shouldPollForNewDeliveries,
    dismissNewDeliveries,
    checkNewDeliveriesOnTick,
    resetNewDeliveriesTracking,
  } = useNewDeliveriesDetection({
    deliveries,
    isLoading,
    everyTicks: scope.kind === "none" ? 1 : scope.everyTicks,
  });

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally synchronizes local state after an external or lifecycle change.
    setVisibleDeliveries(deliveries);
    resetNewDeliveriesTracking();
  }, [deliveries, location.search, resetNewDeliveriesTracking]);

  useEffect(() => {
    const data = deliveriesPollFetcher.data;
    if (!data?.deliveries.length) return;

    // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally synchronizes local state after an external or lifecycle change.
    setVisibleDeliveries((current) =>
      patchVisibleDeliveriesWithLiveUpdates(current, data.deliveries)
    );
  }, [deliveriesPollFetcher.data]);

  useEffect(() => {
    const data = deliveriesPollFetcher.data;
    if (!hasNewDeliveriesCountFields(data)) return;

    if (data.since === knownNewestDeliveryMs) {
      setNewDeliveriesCount(data.count);
    }
  }, [deliveriesPollFetcher.data, knownNewestDeliveryMs, setNewDeliveriesCount]);

  const activeDeliveryIdsParam = useMemo(
    () =>
      visibleDeliveries
        .filter((delivery) => IN_FLIGHT_STATUSES.has(delivery.status))
        .map((delivery) => delivery.friendlyId)
        .join(","),
    [visibleDeliveries]
  );
  const hasActiveDeliveries = activeDeliveryIdsParam.length > 0;

  const deliveriesResourcesBasePath = useMemo(
    () =>
      `/resources/orgs/${organizationSlug}/projects/${projectSlug}/env/${environmentSlug}/webhooks/deliveries`,
    [organizationSlug, projectSlug, environmentSlug]
  );

  const loadDeliveriesPoll = useCallback(
    (checkForNewDeliveries: boolean) => {
      if (deliveriesPollFetcherStateRef.current !== "idle") return;

      if (!hasActiveDeliveries && !checkForNewDeliveries) return;

      const searchParams = new URLSearchParams();
      if (taskSlugParam) {
        searchParams.set("webhookTask", taskSlugParam);
      } else if (endpointIdsParam) {
        searchParams.set("webhookEndpointIds", endpointIdsParam);
      }
      if (hasActiveDeliveries) {
        searchParams.set("deliveryIds", activeDeliveryIdsParam);
      }

      if (checkForNewDeliveries) {
        searchParams.set("includeNewDeliveries", "true");
        searchParams.set("since", String(knownNewestDeliveryMs));
        const current = new URLSearchParams(location.search);
        const to = current.get("to");
        if (to) searchParams.set("to", to);
        // Count only deliveries the filtered list would show after a refresh.
        for (const param of DELIVERY_FILTER_PARAMS) {
          for (const value of current.getAll(param)) searchParams.append(param, value);
        }
      }

      deliveriesPollFetcher.load(`${deliveriesResourcesBasePath}/live?${searchParams.toString()}`);
    },
    [
      activeDeliveryIdsParam,
      hasActiveDeliveries,
      location.search,
      knownNewestDeliveryMs,
      endpointIdsParam,
      taskSlugParam,
      deliveriesPollFetcher,
      deliveriesResourcesBasePath,
    ]
  );

  const watchForNewDeliveries = shouldPollForNewDeliveries && !hasNoEndpoints;
  const shouldPoll = !isLoading && (hasActiveDeliveries || watchForNewDeliveries);

  useInterval({
    interval: DELIVERIES_POLL_INTERVAL_MS,
    onLoad: true,
    disabled: !shouldPoll,
    callback: () => {
      loadDeliveriesPoll(checkNewDeliveriesOnTick() && !hasNoEndpoints);
    },
  });

  return {
    visibleDeliveries,
    newDeliveriesCount,
    dismissNewDeliveries,
  };
}

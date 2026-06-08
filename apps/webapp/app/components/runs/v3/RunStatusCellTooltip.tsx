import { useFetcher } from "@remix-run/react";
import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import type { NextRunListItem } from "~/presenters/v3/NextRunListPresenter.server";
import type { loader as childStatusesLoader } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.children-statuses";
import { isFinalRunStatus } from "~/v3/taskStatus";
import {
  allTaskRunStatuses,
  descriptionForTaskRunStatus,
  TaskRunStatusCombo,
} from "./TaskRunStatus";

const TOOLTIP_OPEN_DELAY_MS = 400;
const TOOLTIP_POLL_INTERVAL_MS = 3000;

type ChildStatusEntry = { status: NextRunListItem["status"]; count: number };

// Compare status/count pairs so unchanged polling responses don't
// re-render or re-animate the tooltip.
function childStatusesKey(statuses: ChildStatusEntry[]) {
  return [...statuses]
    .sort((a, b) => a.status.localeCompare(b.status))
    .map((entry) => `${entry.status}:${entry.count}`)
    .join("|");
}

function areChildStatusesEqual(previous: ChildStatusEntry[] | undefined, next: ChildStatusEntry[]) {
  if (previous === undefined) return false;
  return childStatusesKey(previous) === childStatusesKey(next);
}

function hasActiveChildStatuses(statuses: ChildStatusEntry[] | undefined) {
  if (statuses === undefined) return false;

  return statuses.some((entry) => entry.count > 0 && !isFinalRunStatus(entry.status));
}

function shouldPollWhileTooltipOpen(
  statuses: ChildStatusEntry[] | undefined,
  rootHasFinished: boolean
) {
  if (statuses === undefined) return true;
  // Empty child statuses while the root is still running can mean
  // children have not been created yet, so keep polling.
  if (statuses.length === 0) return !rootHasFinished;

  // All current children may be final while the root is still running — more
  // dependents can still be created.
  return hasActiveChildStatuses(statuses) || !rootHasFinished;
}

function ChildStatusBreakdown({
  orderedChildStatuses,
}: {
  orderedChildStatuses: { status: NextRunListItem["status"]; count: number }[];
}) {
  return (
    <div className="flex min-w-[10rem] flex-col gap-1 p-1">
      <p className="mb-1 text-xs text-text-dimmed">Child run statuses</p>
      <AnimatePresence initial={false} mode="popLayout">
        {orderedChildStatuses.map((entry) => (
          <motion.div
            key={entry.status}
            layout
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="flex items-center justify-between gap-2"
          >
            <TaskRunStatusCombo status={entry.status} />
            <motion.span
              key={entry.count}
              layout
              initial={{ opacity: 0.6, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.15, ease: "easeOut" }}
              className="text-xs tabular-nums text-text-bright"
            >
              {entry.count}
            </motion.span>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

function useChildRunStatusesTooltip({
  friendlyId,
  hasFinished,
  childrenStatusesBasePath,
}: {
  friendlyId: string;
  hasFinished: boolean;
  childrenStatusesBasePath: string;
}) {
  const fetcher = useFetcher<typeof childStatusesLoader>({
    key: `child-statuses-${friendlyId}`,
  });
  const fetcherStateRef = useRef(fetcher.state);
  fetcherStateRef.current = fetcher.state;

  const [childStatuses, setChildStatuses] = useState<ChildStatusEntry[] | undefined>();
  const isOpenRef = useRef(false);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval>>();
  const prevHasFinishedRef = useRef(hasFinished);

  const childrenStatusesUrl = useMemo(
    () => `${childrenStatusesBasePath}/children-statuses?runIds=${encodeURIComponent(friendlyId)}`,
    [childrenStatusesBasePath, friendlyId]
  );

  const loadChildStatuses = useCallback(() => {
    if (fetcherStateRef.current !== "idle") return;
    fetcher.load(childrenStatusesUrl);
  }, [childrenStatusesUrl, fetcher]);

  // Keep the latest loader callback available to the polling interval
  // without recreating the interval on every render.
  const loadChildStatusesRef = useRef(loadChildStatuses);
  loadChildStatusesRef.current = loadChildStatuses;

  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = undefined;
    }
  }, []);

  const startPolling = useCallback(() => {
    if (pollIntervalRef.current) return;

    pollIntervalRef.current = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      loadChildStatusesRef.current();
    }, TOOLTIP_POLL_INTERVAL_MS);
  }, []);

  useEffect(() => {
    if (!fetcher.data?.runs) return;

    const entry = fetcher.data.runs.find((run) => run.friendlyId === friendlyId);
    if (!entry) return;

    setChildStatuses((previous) =>
      areChildStatusesEqual(previous, entry.statuses) ? previous : entry.statuses
    );

    if (isOpenRef.current && !shouldPollWhileTooltipOpen(entry.statuses, hasFinished)) {
      stopPolling();
    }
  }, [fetcher.data, friendlyId, hasFinished, stopPolling]);

  const onOpenChange = useCallback(
    (open: boolean) => {
      isOpenRef.current = open;
      if (open) {
        loadChildStatuses();
        startPolling();
      } else {
        stopPolling();
      }
    },
    [loadChildStatuses, startPolling, stopPolling]
  );

  useEffect(() => {
    prevHasFinishedRef.current = hasFinished;
    stopPolling();
    setChildStatuses(undefined);
    if (isOpenRef.current) {
      loadChildStatuses();
      startPolling();
    }
    // Only reset when the hovered run changes, not when hasFinished toggles.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- friendlyId
  }, [friendlyId]);

  useEffect(() => {
    if (!isOpenRef.current) return;
    if (prevHasFinishedRef.current === hasFinished) return;

    prevHasFinishedRef.current = hasFinished;
    loadChildStatuses();
  }, [hasFinished, loadChildStatuses]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  return {
    childStatuses,
    onOpenChange,
  };
}

export function RunStatusCellTooltip({
  friendlyId,
  status,
  hasFinished,
  childrenStatusesBasePath,
}: {
  friendlyId: string;
  status: NextRunListItem["status"];
  hasFinished: boolean;
  childrenStatusesBasePath: string;
}) {
  const { childStatuses, onOpenChange } = useChildRunStatusesTooltip({
    friendlyId,
    hasFinished,
    childrenStatusesBasePath,
  });

  const orderedChildStatuses = useMemo(() => {
    const childStatusesMap = new Map(
      (childStatuses ?? []).map((entry) => [entry.status, entry.count])
    );

    return allTaskRunStatuses
      .map((s) => ({
        status: s,
        count: childStatusesMap.get(s) ?? 0,
      }))
      .filter((entry) => entry.count > 0);
  }, [childStatuses]);

  const hasChildStatuses = orderedChildStatuses.length > 0;

  return (
    <SimpleTooltip
      asChild
      delayDuration={TOOLTIP_OPEN_DELAY_MS}
      onOpenChange={onOpenChange}
      content={
        hasChildStatuses ? (
          <ChildStatusBreakdown orderedChildStatuses={orderedChildStatuses} />
        ) : (
          descriptionForTaskRunStatus(status)
        )
      }
      disableHoverableContent
      button={
        <span className="inline-flex min-w-full items-center">
          <TaskRunStatusCombo status={status} />
        </span>
      }
    />
  );
}

import { useLocation, useNavigation, useRevalidator } from "@remix-run/react";
import { type MutableRefObject, useEffect } from "react";
import { Button } from "~/components/primitives/Buttons";
import { PulsingDot } from "~/components/primitives/PulsingDot";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useSearchParams } from "~/hooks/useSearchParam";
import type { NextRunList } from "~/presenters/v3/NextRunListPresenter.server";
import { useRunsLiveReload } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs._index/useRunsLiveReload";
import { TaskRunsTable } from "./TaskRunsTable";

/**
 * Compact "N new runs" button, shown in a task page's header to the left of the
 * time filter when the live-reload hook has detected newer runs.
 */
export function NewRunsButton({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <span className="flex duration-150 animate-in fade-in-0">
      <Button
        variant="secondary/small"
        className="text-text-bright"
        onClick={onClick}
        LeadingIcon={<PulsingDot className="h-2 w-2" />}
        tooltip="Refresh to see new runs"
        aria-label="New runs created. Refresh to see new runs."
      >
        {count >= 100 ? "99+ new runs" : `${count} new ${count === 1 ? "run" : "runs"}`}
      </Button>
    </span>
  );
}

/**
 * Runs table with live updating, shared by the standard and scheduled task
 * landing pages. Mirrors the Runs list page: active rows are patched in place
 * (status/timing/cost). The "N new runs" count is surfaced to the top-bar
 * button via `onNewRunsCountChange` (count drives visibility) and
 * `showNewRunsRef` (the latest click action), since the button lives outside
 * this deferred boundary. The task lives in the route path rather than a
 * `tasks` filter, so we pass `taskSlug` to scope new-run detection to this task.
 */
export function TaskRunsList({
  list,
  taskSlug,
  onNewRunsCountChange,
  showNewRunsRef,
}: {
  list: NextRunList;
  taskSlug: string;
  onNewRunsCountChange: (count: number) => void;
  showNewRunsRef: MutableRefObject<() => void>;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const navigation = useNavigation();
  const location = useLocation();
  const { has, replace } = useSearchParams();
  const revalidator = useRevalidator();

  // Loading a new version of this same page (time filter / pagination change).
  const isLoading =
    navigation.state === "loading" &&
    navigation.location !== undefined &&
    navigation.location.pathname === location.pathname &&
    navigation.location.search !== location.search;

  const { visibleRuns, newRunsCount, dismissNewRuns, childrenStatusesBasePath } = useRunsLiveReload(
    {
      runs: list.runs,
      hasAnyRuns: list.hasAnyRuns,
      isLoading,
      organizationSlug: organization.slug,
      projectSlug: project.slug,
      environmentSlug: environment.slug,
      taskSlug,
    }
  );

  // Surface the banner to the top-bar button rendered by the page: keep the
  // ref's action current, mirror the count up, and clear it when this boundary
  // unmounts (e.g. the table re-suspends on a filter change).
  useEffect(() => {
    showNewRunsRef.current = () => {
      const isPaginated = has("cursor") || has("direction");
      dismissNewRuns();
      if (isPaginated) {
        replace({ cursor: undefined, direction: undefined });
        return;
      }
      revalidator.revalidate();
    };
  }, [dismissNewRuns, has, replace, revalidator, showNewRunsRef]);
  useEffect(() => {
    onNewRunsCountChange(newRunsCount);
  }, [newRunsCount, onNewRunsCountChange]);
  useEffect(() => () => onNewRunsCountChange(0), [onNewRunsCountChange]);

  return (
    <div className="h-full overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
      <TaskRunsTable
        total={visibleRuns.length}
        hasFilters={list.hasFilters}
        filters={list.filters}
        runs={visibleRuns}
        childrenStatusesBasePath={childrenStatusesBasePath}
        isLoading={isLoading}
        variant="dimmed"
        showTopBorder={false}
        stickyHeader
      />
    </div>
  );
}

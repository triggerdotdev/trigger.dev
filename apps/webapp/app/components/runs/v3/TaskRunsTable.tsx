import {
  ArrowPathIcon,
  ClockIcon,
  CpuChipIcon,
  RectangleStackIcon,
  StopCircleIcon,
} from "@heroicons/react/20/solid";
import { BeakerIcon, BookOpenIcon, CheckIcon } from "@heroicons/react/24/solid";
import { useLocation } from "@remix-run/react";
import { formatDuration, formatDurationMilliseconds } from "@trigger.dev/core/v3";
import { useCallback, useRef } from "react";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Checkbox } from "~/components/primitives/Checkbox";
import { Dialog, DialogTrigger } from "~/components/primitives/Dialog";
import { Header3 } from "~/components/primitives/Headers";
import { useSelectedItems } from "~/components/primitives/SelectedItemsProvider";
import { useEnvironments } from "~/hooks/useEnvironments";
import { useFeatures } from "~/hooks/useFeatures";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useUser } from "~/hooks/useUser";
import { RunListAppliedFilters, RunListItem } from "~/presenters/v3/RunListPresenter.server";
import { formatCurrencyAccurate, formatNumber } from "~/utils/numberFormatter";
import { docsPath, v3RunSpanPath, v3TestPath } from "~/utils/pathBuilder";
import { EnvironmentLabel } from "../../environments/EnvironmentLabel";
import { DateTime } from "../../primitives/DateTime";
import { Paragraph } from "../../primitives/Paragraph";
import { Spinner } from "../../primitives/Spinner";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableCellMenu,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "../../primitives/Table";
import { CancelRunDialog } from "./CancelRunDialog";
import { LiveTimer } from "./LiveTimer";
import { ReplayRunDialog } from "./ReplayRunDialog";
import { TaskRunStatusCombo } from "./TaskRunStatus";
import { RunTag } from "./RunTag";

type RunsTableProps = {
  total: number;
  hasFilters: boolean;
  filters: RunListAppliedFilters;
  showJob?: boolean;
  runs: RunListItem[];
  isLoading?: boolean;
  allowSelection?: boolean;
};

export function TaskRunsTable({
  total,
  hasFilters,
  filters,
  runs,
  isLoading = false,
  allowSelection = false,
}: RunsTableProps) {
  const user = useUser();
  const organization = useOrganization();
  const project = useProject();
  const checkboxes = useRef<(HTMLInputElement | null)[]>([]);
  const { selectedItems, has, hasAll, select, deselect, toggle } = useSelectedItems(allowSelection);
  const { isManagedCloud } = useFeatures();

  const showCompute = user.admin && isManagedCloud;

  const navigateCheckboxes = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>, index: number) => {
      //indexes are out by one because of the header row
      if (event.key === "ArrowUp" && index > 0) {
        checkboxes.current[index - 1]?.focus();

        if (event.shiftKey) {
          const oldItem = runs.at(index - 1);
          const newItem = runs.at(index - 2);
          const itemsIds = [oldItem?.id, newItem?.id].filter(Boolean);
          select(itemsIds);
        }
      } else if (event.key === "ArrowDown" && index < checkboxes.current.length - 1) {
        checkboxes.current[index + 1]?.focus();

        if (event.shiftKey) {
          const oldItem = runs.at(index - 1);
          const newItem = runs.at(index);
          const itemsIds = [oldItem?.id, newItem?.id].filter(Boolean);
          select(itemsIds);
        }
      }
    },
    [checkboxes, runs]
  );

  return (
    <Table>
      <TableHeader>
        <TableRow>
          {allowSelection && (
            <TableHeaderCell className="pl-2 pr-0">
              {runs.length > 0 && (
                <Checkbox
                  checked={hasAll(runs.map((r) => r.id))}
                  onChange={(element) => {
                    const ids = runs.map((r) => r.id);
                    const checked = element.currentTarget.checked;
                    if (checked) {
                      select(ids);
                    } else {
                      deselect(ids);
                    }
                  }}
                  ref={(r) => {
                    checkboxes.current[0] = r;
                  }}
                  onKeyDown={(event) => navigateCheckboxes(event, 0)}
                />
              )}
            </TableHeaderCell>
          )}
          <TableHeaderCell alignment="right">Run #</TableHeaderCell>
          <TableHeaderCell>Env</TableHeaderCell>
          <TableHeaderCell>Task ID</TableHeaderCell>
          <TableHeaderCell>Version</TableHeaderCell>
          <TableHeaderCell>Status</TableHeaderCell>
          <TableHeaderCell>Started</TableHeaderCell>
          <TableHeaderCell
            colSpan={3}
            tooltip={
              <div className="flex max-w-xs flex-col gap-4 p-1">
                <div>
                  <div className="mb-0.5 flex items-center gap-1.5">
                    <RectangleStackIcon className="size-4 text-text-dimmed" />
                    <Header3>Queued duration</Header3>
                  </div>
                  <Paragraph variant="small" className="!text-wrap text-text-dimmed">
                    The amount of time from when the run was created to it starting to run.
                  </Paragraph>
                </div>
                <div>
                  <div className="mb-0.5 flex items-center gap-1.5">
                    <ClockIcon className="size-4 text-blue-500" /> <Header3>Run duration</Header3>
                  </div>
                  <Paragraph variant="small" className="!text-wrap text-text-dimmed">
                    The total amount of time from the run starting to it finishing. This includes
                    all time spent waiting.
                  </Paragraph>
                </div>
                <div>
                  <div className="mb-0.5 flex items-center gap-1.5">
                    <CpuChipIcon className="size-4 text-success" />
                    <Header3>Compute duration</Header3>
                  </div>
                  <Paragraph variant="small" className="!text-wrap text-text-dimmed">
                    The amount of compute time used in the run. This does not include time spent
                    waiting.
                  </Paragraph>
                </div>
              </div>
            }
          >
            Duration
          </TableHeaderCell>
          {showCompute && (
            <>
              <TableHeaderCell>Compute</TableHeaderCell>
            </>
          )}
          <TableHeaderCell>Test</TableHeaderCell>
          <TableHeaderCell>Created at</TableHeaderCell>
          <TableHeaderCell
            tooltip={
              <div className="max-w-xs p-1">
                <Paragraph variant="small" className="!text-wrap text-text-dimmed" spacing>
                  When you want to trigger a task now, but have it run at a later time, you can use
                  the delay option.
                </Paragraph>
                <Paragraph variant="small" className="!text-wrap text-text-dimmed" spacing>
                  Runs that are delayed and have not been enqueued yet will display in the dashboard
                  with a “Delayed” status.
                </Paragraph>
                <LinkButton
                  to={docsPath("v3/triggering")}
                  variant="tertiary/small"
                  LeadingIcon={BookOpenIcon}
                >
                  Read docs
                </LinkButton>
              </div>
            }
          >
            Delayed until
          </TableHeaderCell>
          <TableHeaderCell
            tooltip={
              <div className="max-w-xs p-1">
                <Paragraph variant="small" className="!text-wrap text-text-dimmed" spacing>
                  You can set a TTL (time to live) when triggering a task, which will automatically
                  expire the run if it hasn’t started within the specified time.
                </Paragraph>
                <Paragraph variant="small" className="!text-wrap text-text-dimmed" spacing>
                  All runs in development have a default ttl of 10 minutes. You can disable this by
                  setting the ttl option.
                </Paragraph>
                <LinkButton
                  to={docsPath("v3/triggering")}
                  variant="tertiary/small"
                  LeadingIcon={BookOpenIcon}
                >
                  Read docs
                </LinkButton>
              </div>
            }
          >
            TTL
          </TableHeaderCell>
          <TableHeaderCell
            tooltip={
              <div className="max-w-xs p-1">
                <Paragraph variant="small" className="!text-wrap text-text-dimmed" spacing>
                  You can add tags to a run and then filter runs using them.
                </Paragraph>
                <Paragraph variant="small" className="!text-wrap text-text-dimmed" spacing>
                  You can add tags when triggering a run or inside the run function.
                </Paragraph>
                <LinkButton
                  to={docsPath("v3/tags")}
                  variant="tertiary/small"
                  LeadingIcon={BookOpenIcon}
                >
                  Read docs
                </LinkButton>
              </div>
            }
          >
            Tags
          </TableHeaderCell>
          <TableHeaderCell>
            <span className="sr-only">Go to page</span>
          </TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {total === 0 && !hasFilters ? (
          <TableBlankRow colSpan={14}>
            {!isLoading && <NoRuns title="No runs found" />}
          </TableBlankRow>
        ) : runs.length === 0 ? (
          <BlankState isLoading={isLoading} filters={filters} />
        ) : (
          runs.map((run, index) => {
            const path = v3RunSpanPath(organization, project, run, { spanId: run.spanId });
            return (
              <TableRow key={run.id}>
                {allowSelection && (
                  <TableCell className="pl-2 pr-0">
                    <Checkbox
                      checked={has(run.id)}
                      onChange={(element) => {
                        toggle(run.id);
                      }}
                      ref={(r) => {
                        checkboxes.current[index + 1] = r;
                      }}
                      onKeyDown={(event) => navigateCheckboxes(event, index + 1)}
                    />
                  </TableCell>
                )}
                <TableCell to={path} alignment="right">
                  {formatNumber(run.number)}
                </TableCell>
                <TableCell to={path}>
                  <EnvironmentLabel
                    environment={run.environment}
                    userName={run.environment.userName}
                  />
                </TableCell>
                <TableCell to={path}>{run.taskIdentifier}</TableCell>
                <TableCell to={path}>{run.version ?? "–"}</TableCell>
                <TableCell to={path}>
                  <TaskRunStatusCombo status={run.status} />
                </TableCell>
                <TableCell to={path}>
                  {run.startedAt ? <DateTime date={run.startedAt} /> : "–"}
                </TableCell>
                <TableCell to={path} className="w-[1%]" actionClassName="pr-0 tabular-nums">
                  <div className="flex items-center gap-1">
                    <RectangleStackIcon className="size-4 text-text-dimmed" />
                    {run.startedAt ? (
                      formatDuration(new Date(run.createdAt), new Date(run.startedAt), {
                        style: "short",
                      })
                    ) : run.isCancellable ? (
                      <LiveTimer startTime={new Date(run.createdAt)} />
                    ) : (
                      formatDuration(new Date(run.createdAt), new Date(run.updatedAt), {
                        style: "short",
                      })
                    )}
                  </div>
                </TableCell>
                <TableCell to={path} className="w-[1%]" actionClassName="px-4 tabular-nums">
                  <div className="flex items-center gap-1">
                    <ClockIcon className="size-4 text-blue-500" />
                    {run.startedAt && run.finishedAt ? (
                      formatDuration(new Date(run.startedAt), new Date(run.finishedAt), {
                        style: "short",
                      })
                    ) : run.startedAt ? (
                      <LiveTimer startTime={new Date(run.startedAt)} />
                    ) : (
                      "–"
                    )}
                  </div>
                </TableCell>
                <TableCell to={path} actionClassName="pl-0 tabular-nums">
                  <div className="flex items-center gap-1">
                    <CpuChipIcon className="size-4 text-success" />
                    {run.usageDurationMs > 0
                      ? formatDurationMilliseconds(run.usageDurationMs, {
                          style: "short",
                        })
                      : "–"}
                  </div>
                </TableCell>
                {showCompute && (
                  <TableCell to={path} className="tabular-nums">
                    {run.costInCents > 0 ? formatCurrencyAccurate(run.costInCents / 100) : "–"}
                  </TableCell>
                )}
                <TableCell to={path}>
                  {run.isTest ? <CheckIcon className="h-4 w-4 text-charcoal-400" /> : "–"}
                </TableCell>
                <TableCell to={path}>
                  {run.createdAt ? <DateTime date={run.createdAt} /> : "–"}
                </TableCell>
                <TableCell to={path}>
                  {run.delayUntil ? <DateTime date={run.delayUntil} /> : "–"}
                </TableCell>
                <TableCell to={path}>{run.ttl ?? "–"}</TableCell>
                <TableCell to={path}>
                  <div className="flex gap-1">
                    {run.tags.map((tag) => <RunTag key={tag} tag={tag} />) || "–"}
                  </div>
                </TableCell>
                <RunActionsCell run={run} path={path} />
              </TableRow>
            );
          })
        )}
        {isLoading && (
          <TableBlankRow
            colSpan={14}
            className="absolute left-0 top-0 flex h-full w-full items-center justify-center gap-2 bg-charcoal-900/90"
          >
            <Spinner /> <span className="text-text-dimmed">Loading…</span>
          </TableBlankRow>
        )}
      </TableBody>
    </Table>
  );
}

function RunActionsCell({ run, path }: { run: RunListItem; path: string }) {
  const location = useLocation();

  if (!run.isCancellable && !run.isReplayable) return <TableCell to={path}>{""}</TableCell>;

  return (
    <TableCellMenu isSticky>
      {run.isCancellable && (
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="small-menu-item" LeadingIcon={StopCircleIcon}>
              Cancel run
            </Button>
          </DialogTrigger>
          <CancelRunDialog
            runFriendlyId={run.friendlyId}
            redirectPath={`${location.pathname}${location.search}`}
          />
        </Dialog>
      )}
      {run.isReplayable && (
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="small-menu-item" LeadingIcon={ArrowPathIcon}>
              Replay run
            </Button>
          </DialogTrigger>
          <ReplayRunDialog
            runFriendlyId={run.friendlyId}
            failedRedirect={`${location.pathname}${location.search}`}
          />
        </Dialog>
      )}
    </TableCellMenu>
  );
}

function NoRuns({ title }: { title: string }) {
  return (
    <div className="flex items-center justify-center">
      <Paragraph className="w-auto">{title}</Paragraph>
    </div>
  );
}

function BlankState({ isLoading, filters }: Pick<RunsTableProps, "isLoading" | "filters">) {
  const organization = useOrganization();
  const project = useProject();
  const envs = useEnvironments();
  if (isLoading) return <TableBlankRow colSpan={14}></TableBlankRow>;

  const { environments, tasks, from, to, ...otherFilters } = filters;

  if (
    filters.environments.length === 1 &&
    filters.tasks.length === 1 &&
    filters.from === undefined &&
    filters.to === undefined &&
    Object.values(otherFilters).every((filterArray) => filterArray.length === 0)
  ) {
    const environment = envs?.find((env) => env.id === filters.environments[0]);
    return (
      <TableBlankRow colSpan={14}>
        <div className="py-14">
          <Paragraph className="w-auto" variant="base/bright" spacing>
            There are no runs for {filters.tasks[0]}
            {environment ? (
              <>
                {" "}
                in{" "}
                <EnvironmentLabel
                  environment={environment}
                  userName={environment.userName}
                  size="large"
                />
              </>
            ) : null}
          </Paragraph>
          <div className="flex items-center justify-center gap-2">
            <LinkButton
              to={v3TestPath(organization, project)}
              variant="primary/small"
              LeadingIcon={BeakerIcon}
              className="inline-flex"
            >
              Create a test run
            </LinkButton>
            <Paragraph variant="small">or</Paragraph>
            <LinkButton
              to={docsPath("v3/triggering")}
              variant="primary/small"
              LeadingIcon={BookOpenIcon}
              className="inline-flex"
            >
              Triggering a task docs
            </LinkButton>
          </div>
        </div>
      </TableBlankRow>
    );
  }

  return (
    <TableBlankRow colSpan={14}>
      <div className="flex flex-col items-center justify-center gap-2">
        <Paragraph className="w-auto" variant="small">
          No runs currently match your filters. Try refreshing or modifying your filters.
        </Paragraph>
        <Button
          LeadingIcon={ArrowPathIcon}
          variant="tertiary/small"
          onClick={() => {
            window.location.reload();
          }}
        >
          Refresh
        </Button>
      </div>
    </TableBlankRow>
  );
}

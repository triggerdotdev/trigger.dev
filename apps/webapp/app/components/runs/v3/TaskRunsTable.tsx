import {
  ArrowPathIcon,
  ArrowRightIcon,
  ClockIcon,
  CpuChipIcon,
  NoSymbolIcon,
  RectangleStackIcon,
} from "@heroicons/react/20/solid";
import { BeakerIcon, BookOpenIcon, CheckIcon } from "@heroicons/react/24/solid";
import { useLocation } from "@remix-run/react";
import { formatDuration, formatDurationMilliseconds } from "@trigger.dev/core/v3";
import { useCallback, useRef } from "react";
import { TaskIconSmall } from "~/assets/icons/TaskIcon";
import { MachineLabelCombo } from "~/components/MachineLabelCombo";
import { MachineTooltipInfo } from "~/components/MachineTooltipInfo";
import { Badge } from "~/components/primitives/Badge";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Checkbox } from "~/components/primitives/Checkbox";
import { Dialog, DialogTrigger } from "~/components/primitives/Dialog";
import { Header3 } from "~/components/primitives/Headers";
import { PopoverMenuItem } from "~/components/primitives/Popover";
import { useSelectedItems } from "~/components/primitives/SelectedItemsProvider";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { TruncatedCopyableValue } from "~/components/primitives/TruncatedCopyableValue";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useFeatures } from "~/hooks/useFeatures";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import {
  type NextRunListAppliedFilters,
  type NextRunListItem,
} from "~/presenters/v3/NextRunListPresenter.server";
import { formatCurrencyAccurate } from "~/utils/numberFormatter";
import { docsPath, v3RunSpanPath, v3TestPath,v3TestTaskPath } from "~/utils/pathBuilder";
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
  type TableVariant,
} from "../../primitives/Table";
import { CancelRunDialog } from "./CancelRunDialog";
import { LiveTimer } from "./LiveTimer";
import { ReplayRunDialog } from "./ReplayRunDialog";
import { RunTag } from "./RunTag";
import {
  descriptionForTaskRunStatus,
  filterableTaskRunStatuses,
  TaskRunStatusCombo,
} from "./TaskRunStatus";

type RunsTableProps = {
  total: number;
  hasFilters: boolean;
  filters: NextRunListAppliedFilters;
  showJob?: boolean;
  runs: NextRunListItem[];
  isLoading?: boolean;
  allowSelection?: boolean;
  variant?: TableVariant;
};

export function TaskRunsTable({
  total,
  hasFilters,
  filters,
  runs,
  isLoading = false,
  allowSelection = false,
  variant = "dimmed",
}: RunsTableProps) {
  const organization = useOrganization();
  const project = useProject();
  const checkboxes = useRef<(HTMLInputElement | null)[]>([]);
  const { has, hasAll, select, deselect, toggle } = useSelectedItems(allowSelection);
  const { isManagedCloud } = useFeatures();

  const showCompute = isManagedCloud;

  const navigateCheckboxes = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>, index: number) => {
      //indexes are out by one because of the header row
      if (event.key === "ArrowUp" && index > 0) {
        checkboxes.current[index - 1]?.focus();

        if (event.shiftKey) {
          const oldItem = runs.at(index - 1);
          const newItem = runs.at(index - 2);
          const itemsIds = [oldItem?.friendlyId, newItem?.friendlyId].filter(Boolean);
          select(itemsIds);
        }
      } else if (event.key === "ArrowDown" && index < checkboxes.current.length - 1) {
        checkboxes.current[index + 1]?.focus();

        if (event.shiftKey) {
          const oldItem = runs.at(index - 1);
          const newItem = runs.at(index);
          const itemsIds = [oldItem?.friendlyId, newItem?.friendlyId].filter(Boolean);
          select(itemsIds);
        }
      }
    },
    [checkboxes, runs]
  );

  return (
    <Table variant={variant} className="max-h-full overflow-y-auto">
      <TableHeader>
        <TableRow>
          {allowSelection && (
            <TableHeaderCell className="pl-3 pr-0">
              {runs.length > 0 && (
                <Checkbox
                  checked={hasAll(runs.map((r) => r.friendlyId))}
                  onChange={(element) => {
                    const ids = runs.map((r) => r.friendlyId);
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
          <TableHeaderCell>ID</TableHeaderCell>
          <TableHeaderCell>Task</TableHeaderCell>
          <TableHeaderCell>Version</TableHeaderCell>
          <TableHeaderCell
            tooltip={
              <div className="flex flex-col divide-y divide-grid-dimmed">
                {filterableTaskRunStatuses.map((status) => (
                  <div
                    key={status}
                    className="grid grid-cols-[8rem_1fr] gap-x-2 py-2 first:pt-1 last:pb-1"
                  >
                    <div className="mb-0.5 flex items-center gap-1.5 whitespace-nowrap">
                      <TaskRunStatusCombo status={status} />
                    </div>
                    <Paragraph variant="extra-small" className="!text-wrap text-text-dimmed">
                      {descriptionForTaskRunStatus(status)}
                    </Paragraph>
                  </div>
                ))}
              </div>
            }
          >
            Status
          </TableHeaderCell>
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
          <TableHeaderCell className="pl-4" tooltip={<MachineTooltipInfo />}>
            Machine
          </TableHeaderCell>
          <TableHeaderCell>Queue</TableHeaderCell>
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
                  variant="docs/small"
                  LeadingIcon={BookOpenIcon}
                  className="mt-3"
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
                  variant="docs/small"
                  LeadingIcon={BookOpenIcon}
                  className="mt-3"
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
                  variant="docs/small"
                  LeadingIcon={BookOpenIcon}
                  className="mt-3"
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
          <TableBlankRow colSpan={15}>
            {!isLoading && <NoRuns title="No runs found" />}
          </TableBlankRow>
        ) : runs.length === 0 ? (
          <BlankState isLoading={isLoading} filters={filters} />
        ) : (
          runs.map((run, index) => {
            const path = v3RunSpanPath(organization, project, run.environment, run, {
              spanId: run.spanId,
            });
            return (
              <TableRow key={run.id}>
                {allowSelection && (
                  <TableCell className="pl-3 pr-0">
                    <Checkbox
                      checked={has(run.friendlyId)}
                      onChange={(element) => {
                        toggle(run.friendlyId);
                      }}
                      ref={(r) => {
                        checkboxes.current[index + 1] = r;
                      }}
                      onKeyDown={(event) => navigateCheckboxes(event, index + 1)}
                    />
                  </TableCell>
                )}
                <TableCell to={path} isTabbableCell>
                  <TruncatedCopyableValue value={run.friendlyId} />
                </TableCell>
                <TableCell to={path}>
                  <span className="flex items-center gap-x-1">
                    {run.taskIdentifier}
                    {run.rootTaskRunId === null ? <Badge variant="extra-small">Root</Badge> : null}
                  </span>
                </TableCell>
                <TableCell to={path}>{run.version ?? "–"}</TableCell>
                <TableCell to={path}>
                  <SimpleTooltip
                    content={descriptionForTaskRunStatus(run.status)}
                    disableHoverableContent
                    button={<TaskRunStatusCombo status={run.status} />}
                  />
                </TableCell>
                <TableCell to={path}>
                  {run.startedAt ? <DateTime date={run.startedAt} /> : "–"}
                </TableCell>
                <TableCell to={path} className="w-[1%]" actionClassName="pr-0 tabular-nums">
                  <div className="flex items-center gap-1">
                    <RectangleStackIcon className="size-4 text-text-dimmed" />
                    {run.isPending ? (
                      "–"
                    ) : run.startedAt ? (
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
                    {run.costInCents > 0
                      ? formatCurrencyAccurate((run.costInCents + run.baseCostInCents) / 100)
                      : "–"}
                  </TableCell>
                )}
                <TableCell to={path}>
                  <MachineLabelCombo preset={run.machinePreset} />
                </TableCell>
                <TableCell to={path}>
                  <span className="flex items-center gap-1">
                    {run.queue.type === "task" ? (
                      <SimpleTooltip
                        button={<TaskIconSmall className="size-[1.125rem] text-blue-500" />}
                        content={`This queue was automatically created from your "${run.queue.name}" task`}
                      />
                    ) : (
                      <SimpleTooltip
                        button={<RectangleStackIcon className="size-[1.125rem] text-purple-500" />}
                        content={`This is a custom queue you added in your code.`}
                      />
                    )}
                    <span>{run.queue.name}</span>
                  </span>
                </TableCell>
                <TableCell to={path}>
                  {run.isTest ? <CheckIcon className="size-4 text-charcoal-400" /> : "–"}
                </TableCell>
                <TableCell to={path}>
                  {run.createdAt ? <DateTime date={run.createdAt} /> : "–"}
                </TableCell>
                <TableCell to={path}>
                  {run.delayUntil ? <DateTime date={run.delayUntil} /> : "–"}
                </TableCell>
                <TableCell to={path}>{run.ttl ?? "–"}</TableCell>
                <TableCell to={path} actionClassName="py-1" className="pr-16">
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
            colSpan={15}
            className="absolute left-0 top-0 flex h-full w-full items-center justify-center gap-2 bg-charcoal-900/90"
          >
            <Spinner /> <span className="text-text-dimmed">Loading…</span>
          </TableBlankRow>
        )}
      </TableBody>
    </Table>
  );
}

function RunActionsCell({ run, path }: { run: NextRunListItem; path: string }) {
  const location = useLocation();

  if (!run.isCancellable && !run.isReplayable) return <TableCell to={path}>{""}</TableCell>;

  return (
    <TableCellMenu
      isSticky
      popoverContent={
        <>
          <PopoverMenuItem
            to={path}
            icon={ArrowRightIcon}
            leadingIconClassName="text-blue-500"
            title="View run"
          />
          {run.isCancellable && (
            <Dialog>
              <DialogTrigger
                asChild
                className="size-6 rounded-sm p-1 text-text-dimmed transition hover:bg-charcoal-700 hover:text-text-bright"
              >
                <Button
                  variant="small-menu-item"
                  LeadingIcon={NoSymbolIcon}
                  leadingIconClassName="text-error"
                  fullWidth
                  textAlignLeft
                  className="w-full px-1.5 py-[0.9rem]"
                >
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
              <DialogTrigger
                asChild
                className="h-6 w-6 rounded-sm p-1 text-text-dimmed transition hover:bg-charcoal-700 hover:text-text-bright"
              >
                <Button
                  variant="small-menu-item"
                  LeadingIcon={ArrowPathIcon}
                  leadingIconClassName="text-success"
                  fullWidth
                  textAlignLeft
                  className="w-full px-1.5 py-[0.9rem]"
                >
                  Replay run…
                </Button>
              </DialogTrigger>
              <ReplayRunDialog
                runFriendlyId={run.friendlyId}
                failedRedirect={`${location.pathname}${location.search}`}
              />
            </Dialog>
          )}
        </>
      }
      hiddenButtons={
        <>
          {run.isCancellable && (
            <SimpleTooltip
              button={
                <Dialog>
                  <DialogTrigger
                    asChild
                    className="size-6 rounded-sm p-1 text-text-bright transition hover:bg-charcoal-700"
                  >
                    <NoSymbolIcon className="size-3" />
                  </DialogTrigger>
                  <CancelRunDialog
                    runFriendlyId={run.friendlyId}
                    redirectPath={`${location.pathname}${location.search}`}
                  />
                </Dialog>
              }
              content="Cancel run"
              side="left"
              disableHoverableContent
            />
          )}
          {run.isCancellable && run.isReplayable && (
            <div className="mx-0.5 h-6 w-px bg-grid-dimmed" />
          )}
          {run.isReplayable && (
            <SimpleTooltip
              button={
                <Dialog>
                  <DialogTrigger
                    asChild
                    className="h-6 w-6 rounded-sm p-1 text-text-bright transition hover:bg-charcoal-700"
                  >
                    <ArrowPathIcon className="size-3" />
                  </DialogTrigger>
                  <ReplayRunDialog
                    runFriendlyId={run.friendlyId}
                    failedRedirect={`${location.pathname}${location.search}`}
                  />
                </Dialog>
              }
              content="Replay run…"
              side="left"
              disableHoverableContent
            />
          )}
        </>
      }
    />
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
  const environment = useEnvironment();
  if (isLoading) return <TableBlankRow colSpan={15}></TableBlankRow>;

  const { tasks, from, to, ...otherFilters } = filters;
  const singleTaskFromFilters = filters.tasks.length === 1 ? filters.tasks[0] : null;
  const testPath = singleTaskFromFilters ? v3TestTaskPath(organization, project, environment, {taskIdentifier: singleTaskFromFilters}) : v3TestPath(organization, project, environment);

  if (
    filters.tasks.length === 1 &&
    filters.from === undefined &&
    filters.to === undefined &&
    Object.values(otherFilters).every((filterArray) => filterArray.length === 0)
  ) {
    return (
      <TableBlankRow colSpan={15}>
        <Paragraph className="w-auto" variant="base/bright" spacing>
          There are no runs for {filters.tasks[0]}
        </Paragraph>
        <div className="mt-6 flex items-center justify-center gap-2">
          <LinkButton
            to={testPath}
            variant="tertiary/medium"
            LeadingIcon={BeakerIcon}
            className="inline-flex"
          >
            Create a test run
          </LinkButton>
          <Paragraph variant="small">or</Paragraph>
          <LinkButton
            to={docsPath("v3/triggering")}
            variant="tertiary/medium"
            LeadingIcon={BookOpenIcon}
            className="inline-flex"
          >
            Triggering a task docs
          </LinkButton>
        </div>
      </TableBlankRow>
    );
  }

  return (
    <TableBlankRow colSpan={15}>
      <div className="flex flex-col items-center justify-center gap-6">
        <Paragraph className="w-auto" variant="base/bright">
          No runs match your filters. Try refreshing, modifying your filters or run a test.
        </Paragraph>
        <div className="flex items-center gap-2">
          <Button
            LeadingIcon={ArrowPathIcon}
            variant="tertiary/medium"
            onClick={() => {
              window.location.reload();
            }}
          >
            Refresh
          </Button>
          <Paragraph>or</Paragraph>
          <LinkButton
            LeadingIcon={BeakerIcon}
            variant="tertiary/medium"
            to={testPath}
          >
            Run a test
          </LinkButton>
        </div>
      </div>
    </TableBlankRow>
  );
}

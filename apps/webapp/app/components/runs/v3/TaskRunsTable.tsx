import { StopIcon } from "@heroicons/react/24/outline";
import { BeakerIcon, BookOpenIcon, CheckIcon } from "@heroicons/react/24/solid";
import { User } from "@trigger.dev/database";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { RunListAppliedFilters, RunListItem } from "~/presenters/v3/RunListPresenter.server";
import { docsPath, v3RunPath, v3TestPath } from "~/utils/pathBuilder";
import { EnvironmentLabel } from "../../environments/EnvironmentLabel";
import { DateTime } from "../../primitives/DateTime";
import { Paragraph } from "../../primitives/Paragraph";
import { Spinner } from "../../primitives/Spinner";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableCellChevron,
  TableCellMenu,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "../../primitives/Table";
import { formatDuration } from "@trigger.dev/core/v3";
import { TaskRunStatusCombo } from "./TaskRunStatus";
import { useEnvironments } from "~/hooks/useEnvironments";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { ArrowPathIcon, StopCircleIcon } from "@heroicons/react/20/solid";
import { Dialog, DialogTrigger } from "~/components/primitives/Dialog";
import { CancelRunDialog } from "./CancelRunDialog";
import { useLocation } from "@remix-run/react";
import { ReplayRunDialog } from "./ReplayRunDialog";

type RunsTableProps = {
  total: number;
  hasFilters: boolean;
  filters: RunListAppliedFilters;
  showJob?: boolean;
  runs: RunListItem[];
  isLoading?: boolean;
  currentUser: User;
};

export function TaskRunsTable({
  total,
  hasFilters,
  filters,
  runs,
  isLoading = false,
  currentUser,
}: RunsTableProps) {
  const organization = useOrganization();
  const project = useProject();

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHeaderCell>Run</TableHeaderCell>
          <TableHeaderCell>Task ID</TableHeaderCell>
          <TableHeaderCell>Version</TableHeaderCell>
          <TableHeaderCell>Env</TableHeaderCell>
          <TableHeaderCell>Status</TableHeaderCell>
          <TableHeaderCell>Started</TableHeaderCell>
          <TableHeaderCell>Duration</TableHeaderCell>
          <TableHeaderCell>Test</TableHeaderCell>
          <TableHeaderCell>Created at</TableHeaderCell>
          <TableHeaderCell>
            <span className="sr-only">Go to page</span>
          </TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {total === 0 && !hasFilters ? (
          <TableBlankRow colSpan={9}>
            {!isLoading && <NoRuns title="No runs found" />}
          </TableBlankRow>
        ) : runs.length === 0 ? (
          <BlankState isLoading={isLoading} filters={filters} />
        ) : (
          runs.map((run) => {
            const path = v3RunPath(organization, project, run);
            const usernameForEnv =
              currentUser.id !== run.environment.userId ? run.environment.userName : undefined;
            return (
              <TableRow key={run.id}>
                <TableCell to={path}>#{run.number}</TableCell>
                <TableCell to={path}>{run.taskIdentifier}</TableCell>
                <TableCell to={path}>{run.version ?? "–"}</TableCell>
                <TableCell to={path}>
                  <EnvironmentLabel environment={run.environment} userName={usernameForEnv} />
                </TableCell>
                <TableCell to={path}>
                  <TaskRunStatusCombo status={run.status} />
                </TableCell>
                <TableCell to={path}>
                  {run.startedAt ? <DateTime date={run.startedAt} /> : "–"}
                </TableCell>
                <TableCell to={path}>
                  {formatDuration(run.startedAt, run.completedAt, {
                    style: "short",
                  })}
                </TableCell>
                <TableCell to={path}>
                  {run.isTest ? (
                    <CheckIcon className="h-4 w-4 text-charcoal-400" />
                  ) : (
                    <StopIcon className="h-4 w-4 text-charcoal-850" />
                  )}
                </TableCell>
                <TableCell to={path}>
                  {run.createdAt ? <DateTime date={run.createdAt} /> : "–"}
                </TableCell>
                <RunActionsCell run={run} path={path} />
              </TableRow>
            );
          })
        )}
        {isLoading && (
          <TableBlankRow
            colSpan={8}
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
  if (isLoading) return <TableBlankRow colSpan={9}></TableBlankRow>;

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
      <TableBlankRow colSpan={9}>
        <div className="py-14">
          <Paragraph className="w-auto" variant="base/bright" spacing>
            There are no runs for {filters.tasks[0]}
            {environment ? (
              <>
                {" "}
                in <EnvironmentLabel environment={environment} size="large" />
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
    <TableBlankRow colSpan={9}>
      <NoRuns title="No runs match your filters" />
    </TableBlankRow>
  );
}

import { StopIcon } from "@heroicons/react/24/outline";
import { CheckIcon } from "@heroicons/react/24/solid";
import { useJob } from "~/hooks/useJob";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { RunList } from "~/presenters/RunListPresenter.server";
import { formatDuration } from "~/utils";
import { JobForPath, OrgForPath, ProjectForPath, jobRunDashboardPath } from "~/utils/pathBuilder";
import { EnvironmentLabel } from "../environments/EnvironmentLabel";
import { Callout } from "../primitives/Callout";
import { DateTime } from "../primitives/DateTime";
import { Spinner } from "../primitives/Spinner";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableCellChevron,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "../primitives/Table";
import { RunStatus } from "./RunStatuses";
import { JobRunStatus, RuntimeEnvironmentType } from "@trigger.dev/database";

type RunTableItem = {
  id: string;
  number: number;
  environment: {
    type: RuntimeEnvironmentType;
  };
  status: JobRunStatus;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date | null;
  version: string;
  isTest: boolean;
};

type RunsTableProps = {
  total: number;
  hasFilters: boolean;
  runs: RunTableItem[];
  isLoading?: boolean;
  runsParentPath: string;
};

export function RunsTable({
  total,
  hasFilters,
  runs,
  isLoading = false,
  runsParentPath,
}: RunsTableProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHeaderCell>Run</TableHeaderCell>
          <TableHeaderCell>Env</TableHeaderCell>
          <TableHeaderCell>Status</TableHeaderCell>
          <TableHeaderCell>Started</TableHeaderCell>
          <TableHeaderCell>Duration</TableHeaderCell>
          <TableHeaderCell>Test</TableHeaderCell>
          <TableHeaderCell>Version</TableHeaderCell>
          <TableHeaderCell>Created at</TableHeaderCell>
          <TableHeaderCell>
            <span className="sr-only">Go to page</span>
          </TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {total === 0 && !hasFilters ? (
          <TableBlankRow colSpan={8}>
            <NoRuns title="No Runs found for this Job" />
          </TableBlankRow>
        ) : runs.length === 0 ? (
          <TableBlankRow colSpan={8}>
            <NoRuns title="No Runs match your filters" />
          </TableBlankRow>
        ) : (
          runs.map((run) => {
            const path = `${runsParentPath}/${run.id}/trigger`;
            return (
              <TableRow key={run.id}>
                <TableCell to={path}>#{run.number}</TableCell>
                <TableCell to={path}>
                  <EnvironmentLabel environment={run.environment} />
                </TableCell>
                <TableCell to={path}>
                  <RunStatus status={run.status} />
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
                    <CheckIcon className="h-4 w-4 text-slate-400" />
                  ) : (
                    <StopIcon className="h-4 w-4 text-slate-850" />
                  )}
                </TableCell>
                <TableCell to={path}>{run.version}</TableCell>
                <TableCell to={path}>
                  {run.createdAt ? <DateTime date={run.createdAt} /> : "–"}
                </TableCell>
                <TableCellChevron to={path} isSticky />
              </TableRow>
            );
          })
        )}
        {isLoading && (
          <TableBlankRow
            colSpan={8}
            className="absolute left-0 top-0 flex h-full w-full items-center justify-center gap-2 bg-slate-900/90"
          >
            <Spinner /> <span className="text-dimmed">Loading…</span>
          </TableBlankRow>
        )}
      </TableBody>
    </Table>
  );
}
function NoRuns({ title }: { title: string }) {
  return (
    <div className="flex items-center justify-center">
      <Callout variant="warning" className="w-auto">
        {title}
      </Callout>
    </div>
  );
}

import { StopIcon } from "@heroicons/react/24/outline";
import { CheckIcon } from "@heroicons/react/24/solid";
import { JobRunStatus, RuntimeEnvironmentType } from "@trigger.dev/database";
import { formatDuration, formatDurationMilliseconds } from "~/utils";
import { EnvironmentLabel } from "../environments/EnvironmentLabel";
import { DateTime } from "../primitives/DateTime";
import { Paragraph } from "../primitives/Paragraph";
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

type RunTableItem = {
  id: string;
  number: number | null;
  environment: {
    type: RuntimeEnvironmentType;
  };
  job: { title: string; slug: string };
  status: JobRunStatus;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date | null;
  executionDuration: number;
  version: string;
  isTest: boolean;
};

type RunsTableProps = {
  total: number;
  hasFilters: boolean;
  showJob?: boolean;
  runs: RunTableItem[];
  isLoading?: boolean;
  runsParentPath: string;
};

export function RunsTable({
  total,
  hasFilters,
  runs,
  isLoading = false,
  showJob = false,
  runsParentPath,
}: RunsTableProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHeaderCell>Run</TableHeaderCell>
          {showJob && <TableHeaderCell>Job</TableHeaderCell>}
          <TableHeaderCell>Env</TableHeaderCell>
          <TableHeaderCell>Status</TableHeaderCell>
          <TableHeaderCell>Started</TableHeaderCell>
          <TableHeaderCell>Duration</TableHeaderCell>
          <TableHeaderCell>Exec Time</TableHeaderCell>
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
          <TableBlankRow colSpan={showJob ? 10 : 9}>
            <NoRuns title="No Runs found" />
          </TableBlankRow>
        ) : runs.length === 0 ? (
          <TableBlankRow colSpan={showJob ? 10 : 9}>
            <NoRuns title="No Runs match your filters" />
          </TableBlankRow>
        ) : (
          runs.map((run) => {
            const path = showJob
              ? `${runsParentPath}/jobs/${run.job.slug}/runs/${run.id}/trigger`
              : `${runsParentPath}/${run.id}/trigger`;
            return (
              <TableRow key={run.id}>
                <TableCell to={path}>
                  {typeof run.number === "number" ? `#${run.number}` : "-"}
                </TableCell>
                {showJob && <TableCell to={path}>{run.job.slug}</TableCell>}
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
                  {formatDurationMilliseconds(run.executionDuration, {
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
      <Paragraph className="w-auto">{title}</Paragraph>
    </div>
  );
}

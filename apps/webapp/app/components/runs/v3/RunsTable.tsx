import { StopIcon } from "@heroicons/react/24/outline";
import { CheckIcon } from "@heroicons/react/24/solid";
import { JobRunStatus, RuntimeEnvironmentType, User } from "@trigger.dev/database";
import { formatDuration, formatDurationMilliseconds } from "~/utils";
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
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "../../primitives/Table";
import { RunStatus } from "../RunStatuses";
import { RunListItem } from "~/presenters/v3/RunListPresenter.server";
import { v3RunPath } from "~/utils/pathBuilder";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";

type RunsTableProps = {
  total: number;
  hasFilters: boolean;
  showJob?: boolean;
  runs: RunListItem[];
  isLoading?: boolean;
  currentUser: User;
};

export function RunsTable({
  total,
  hasFilters,
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
          <TableHeaderCell>Task</TableHeaderCell>
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
          <TableBlankRow colSpan={9}>
            {!isLoading && <NoRuns title="No runs found" />}
          </TableBlankRow>
        ) : runs.length === 0 ? (
          <TableBlankRow colSpan={9}>
            {!isLoading && <NoRuns title="No runs match your filters" />}
          </TableBlankRow>
        ) : (
          runs.map((run) => {
            const path = v3RunPath(organization, project, run);
            const usernameForEnv =
              currentUser.id !== run.environment.userId ? run.environment.userName : undefined;
            return (
              <TableRow key={run.id}>
                <TableCell to={path}>
                  {typeof run.number === "number" ? `#${run.number}` : "-"}
                </TableCell>
                <TableCell to={path}>{run.taskIdentifier}</TableCell>
                <TableCell to={path}>
                  <EnvironmentLabel environment={run.environment} userName={usernameForEnv} />
                </TableCell>
                <TableCell to={path}>{run.status ?? "Enqueued"}</TableCell>
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
                <TableCell to={path}>{run.version ?? "–"}</TableCell>
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

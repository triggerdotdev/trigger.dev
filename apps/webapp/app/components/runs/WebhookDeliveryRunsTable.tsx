import { StopIcon } from "@heroicons/react/24/outline";
import { CheckIcon } from "@heroicons/react/24/solid";
import { type RuntimeEnvironmentType } from "@trigger.dev/database";
import { EnvironmentLabel } from "../environments/EnvironmentLabel";
import { DateTime } from "../primitives/DateTime";
import { Paragraph } from "../primitives/Paragraph";
import { Spinner } from "../primitives/Spinner";
import {
  Table,
  TableBlankRow,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "../primitives/Table";
import { RunStatus } from "./RunStatuses";
import { formatDuration } from "@trigger.dev/core/v3/utils/durations";

type RunTableItem = {
  id: string;
  number: number;
  environment: {
    type: RuntimeEnvironmentType;
  };
  error: string | null;
  createdAt: Date | null;
  deliveredAt: Date | null;
  verified: boolean;
};

type RunsTableProps = {
  total: number;
  hasFilters: boolean;
  runs: RunTableItem[];
  isLoading?: boolean;
  runsParentPath: string;
};

export function WebhookDeliveryRunsTable({
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
          <TableHeaderCell>Last Error</TableHeaderCell>
          <TableHeaderCell>Started</TableHeaderCell>
          <TableHeaderCell>Duration</TableHeaderCell>
          <TableHeaderCell>Verified</TableHeaderCell>
          <TableHeaderCell>Created at</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {total === 0 && !hasFilters ? (
          <TableBlankRow colSpan={8}>
            <NoRuns title="No runs found for this job" />
          </TableBlankRow>
        ) : runs.length === 0 ? (
          <TableBlankRow colSpan={8}>
            <NoRuns title="No runs match your filters" />
          </TableBlankRow>
        ) : (
          runs.map((run) => {
            return (
              <TableRow key={run.id}>
                <TableCell>#{run.number}</TableCell>
                <TableCell>
                  <EnvironmentLabel environment={run.environment} />
                </TableCell>
                <TableCell>
                  <RunStatus
                    status={
                      !run.deliveredAt
                        ? "STARTED"
                        : run.error || !run.verified
                        ? "FAILURE"
                        : "SUCCESS"
                    }
                  />
                </TableCell>
                <TableCell>{run.error?.slice(0, 30) ?? "–"}</TableCell>
                <TableCell>{run.createdAt ? <DateTime date={run.createdAt} /> : "–"}</TableCell>
                <TableCell>
                  {formatDuration(run.createdAt, run.deliveredAt, {
                    style: "short",
                  })}
                </TableCell>
                <TableCell>
                  {run.verified ? (
                    <CheckIcon className="h-4 w-4 text-charcoal-400" />
                  ) : (
                    <StopIcon className="h-4 w-4 text-charcoal-850" />
                  )}
                </TableCell>
                <TableCell>{run.createdAt ? <DateTime date={run.createdAt} /> : "–"}</TableCell>
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
function NoRuns({ title }: { title: string }) {
  return (
    <div className="flex items-center justify-center">
      <Paragraph className="w-auto">{title}</Paragraph>
    </div>
  );
}

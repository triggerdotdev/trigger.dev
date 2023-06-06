import { BeakerIcon, StopIcon } from "@heroicons/react/24/outline";
import { CheckIcon, ChevronRightIcon } from "@heroicons/react/24/solid";
import { Link } from "@remix-run/react";
import type { ReactNode } from "react";
import { useJob } from "~/hooks/useJob";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { RunList } from "~/presenters/RunListPresenter.server";
import { formatDateTime, formatDuration } from "~/utils";
import { cn } from "~/utils/cn";
import { runPath } from "~/utils/pathBuilder";
import {
  EnvironmentLabel,
  environmentTitle,
} from "../environments/EnvironmentLabel";
import { Spinner } from "../primitives/Spinner";
import { RunStatus } from "./RunStatuses";
import {
  Table,
  TableBlankRow,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "../primitives/Table";

export function RunsTable({
  total,
  hasFilters,
  runs,
  isLoading = false,
}: {
  total: number;
  hasFilters: boolean;
  runs: RunList["runs"];
  isLoading?: boolean;
}) {
  const organization = useOrganization();
  const project = useProject();
  const job = useJob();

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
          <TableHeaderCell>
            <span className="sr-only">Go to page</span>
          </TableHeaderCell>
        </TableRow>
      </TableHeader>
      <tbody className="relative divide-y divide-slate-850">
        {total === 0 && !hasFilters ? (
          <TableBlankRow colSpan={8}>
            <NoRuns title="No runs found for this Workflow" />
          </TableBlankRow>
        ) : runs.length === 0 ? (
          <TableBlankRow colSpan={8}>
            <NoRuns title="No runs match your filters" />
          </TableBlankRow>
        ) : (
          runs.map((run) => {
            const path = runPath(organization, project, job, run);
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
                  {run.startedAt
                    ? formatDateTime(run.startedAt, "medium")
                    : "–"}
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
                <TableCell to={path} alignment="right">
                  <ChevronRightIcon className="h-4 w-4 text-slate-700 transition group-hover:text-bright" />
                </TableCell>
              </TableRow>
            );
          })
        )}
        {isLoading && (
          <tr className="absolute left-0 top-0 h-full w-full bg-slate-800/90">
            <td
              colSpan={6}
              className="flex h-full items-center justify-center gap-2 text-white"
            >
              <Spinner /> Loading…
            </td>
          </tr>
        )}
      </tbody>
    </Table>
  );
}

// function HeaderCell({
//   title,
//   alignment = "left",
// }: {
//   title: string;
//   alignment?: "left" | "right";
// }) {
//   return (
//     <th
//       scope="col"
//       className={cn(
//         "px-4 py-3 text-xs font-semibold uppercase text-slate-400",
//         alignment === "left" ? "text-left" : "text-right"
//       )}
//     >
//       {title}
//     </th>
//   );
// }

// function Cell({
//   children,
//   to,
//   alignment = "left",
// }: {
//   children: React.ReactNode;
//   to: string;
//   alignment?: "left" | "right";
// }) {
//   return (
//     <td className="cursor-pointer transition group-hover:bg-slate-850/50">
//       <Link
//         to={to}
//         className={cn(
//           "flex w-full whitespace-nowrap px-4 py-3 text-left text-xs text-slate-400",
//           alignment === "left"
//             ? "justify-start text-left"
//             : "justify-end text-right"
//         )}
//       >
//         {children}
//       </Link>
//     </td>
//   );
// }

// function BlankRow({ children }: { children: ReactNode }) {
//   return (
//     <tr>
//       <td colSpan={6} className="py-6 text-center text-sm">
//         {children}
//       </td>
//     </tr>
//   );
// }

export function NoRuns({ title }: { title: string }) {
  return (
    <div className="flex items-center justify-center">
      THERE ARE NO RUNS HERE, {":("}
    </div>
  );
}
